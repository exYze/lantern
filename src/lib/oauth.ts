// One-click sign-in for remote MCP servers (Notion, Linear, Sentry, Zapier…),
// following the MCP authorization spec: find the server's authorization server
// (RFC 9728, RFC 8414), register Lantern as a client when the server allows it
// (RFC 7591), and sign in with the authorization-code flow and PKCE.
//
// The sign-in page sends you back to your Lantern Hub (`<hub>/oauth/callback`),
// which every paired device can reach, and the app picks up the code from
// there. That works the same on desktop and phone, with nothing listening on
// your device. Tokens are stored like your other secrets, so the hub's runner
// can use them too, and they're refreshed when they run out.

import { hubApi, hubConnection, hubLease, HubError } from "./hub";
import { httpRequest, openExternal, secrets } from "./platform";
import { useApp } from "./store";
import type { McpServer, OAuthClient } from "./types";

export const tokenKey = (serverId: string) => `mcp:${serverId}:oauth`;
export const clientSecretKey = (serverId: string) => `mcp:${serverId}:oauth-client`;

interface Tokens {
  access_token: string;
  refresh_token?: string;
  /** When the access token runs out (ms). */
  expires_at?: number;
  token_type?: string;
}

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function getJson(url: string): Promise<any | null> {
  try {
    const r = await httpRequest({ url, headers: { Accept: "application/json" }, timeoutMs: 15000 });
    return r.status < 300 ? JSON.parse(r.body) : null;
  } catch {
    return null;
  }
}

export interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string;
  resource: string;
}

/** Finds where to sign in for an MCP server. */
export async function discover(serverUrl: string): Promise<Discovery> {
  const u = new URL(serverUrl);
  // The server's 401 names its metadata; otherwise look in the well-known places.
  let metadataUrl: string | undefined;
  try {
    const r = await httpRequest({
      method: "POST",
      url: serverUrl,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Lantern", version: "1" } } }),
      timeoutMs: 15000,
    });
    metadataUrl = (r.headers["www-authenticate"] ?? "").match(/resource_metadata="([^"]+)"/)?.[1];
  } catch {
    /* fall back to well-known */
  }
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  const prm = (metadataUrl && (await getJson(metadataUrl))) || (await getJson(`${u.origin}/.well-known/oauth-protected-resource${path}`)) || (await getJson(`${u.origin}/.well-known/oauth-protected-resource`));
  const issuer: string = prm?.authorization_servers?.[0] ?? u.origin;
  const iu = new URL(issuer);
  const ip = iu.pathname === "/" ? "" : iu.pathname.replace(/\/$/, "");
  const as =
    (await getJson(`${iu.origin}/.well-known/oauth-authorization-server${ip}`)) ||
    (await getJson(`${iu.origin}/.well-known/openid-configuration${ip}`)) ||
    (ip ? await getJson(`${iu.origin}${ip}/.well-known/openid-configuration`) : null) ||
    (ip ? await getJson(`${iu.origin}/.well-known/oauth-authorization-server`) : null);
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error(`${u.host} doesn't offer sign-in (no OAuth metadata). Add its API key as a header instead.`);
  const scopes: string[] = prm?.scopes_supported ?? [];
  return {
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
    scopes: scopes.length ? scopes.join(" ") : undefined,
    resource: prm?.resource ?? serverUrl,
  };
}

export function redirectUri(): string {
  const hub = hubConnection();
  if (!hub) throw new Error("Signing in to apps needs a Lantern Hub: the sign-in page sends you back to it. Connect one in Settings → Hub.");
  return `${hub.url}/oauth/callback`;
}

async function register(endpoint: string): Promise<{ clientId: string; clientSecret?: string }> {
  const r = await httpRequest({
    method: "POST",
    url: endpoint,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Lantern",
      client_uri: "https://exyze.github.io/lantern/",
      redirect_uris: [redirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    timeoutMs: 20000,
  });
  const j = (() => {
    try {
      return JSON.parse(r.body);
    } catch {
      return null;
    }
  })();
  if (r.status >= 300 || !j?.client_id) throw new Error(`The app wouldn't register Lantern (${r.status}): ${j?.error_description ?? j?.error ?? r.body.slice(0, 200)}`);
  return { clientId: j.client_id, clientSecret: j.client_secret };
}

async function tokenRequest(client: OAuthClient, serverId: string, form: Record<string, string>): Promise<Tokens> {
  const secret = client.hasClientSecret ? await secrets.get(clientSecretKey(serverId)) : null;
  const body = new URLSearchParams({ ...form, client_id: client.clientId, ...(secret ? { client_secret: secret } : {}), ...(client.resource ? { resource: client.resource } : {}) });
  const r = await httpRequest({
    method: "POST",
    url: client.tokenEndpoint,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    timeoutMs: 20000,
  });
  let j: any = null;
  try {
    j = JSON.parse(r.body);
  } catch {
    // GitHub-style form answers.
    j = Object.fromEntries(new URLSearchParams(r.body));
  }
  if (r.status >= 300 || !j?.access_token) throw new Error(`Sign-in failed (${r.status}): ${j?.error_description ?? j?.error ?? r.body.slice(0, 200)}`);
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    token_type: j.token_type,
    expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined,
  };
}

/** Waits for the hub to receive the sign-in code (up to five minutes). */
async function waitForCode(state: string, signal?: AbortSignal): Promise<string> {
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    if (signal?.aborted) throw new Error("Sign-in cancelled.");
    try {
      const r = await hubApi<{ code?: string; error?: string; errorDescription?: string }>(`/api/v1/oauth/${encodeURIComponent(state)}`, { timeoutMs: 10000 });
      if (r.code) return r.code;
      throw new Error(`The app refused the sign-in: ${r.errorDescription ?? r.error ?? "no reason given"}`);
    } catch (e) {
      if (!(e instanceof HubError && e.status === 404)) throw e;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("The sign-in wasn't finished within five minutes.");
}

/**
 * Signs in to a remote MCP server: opens its sign-in page in your browser and
 * waits for you to come back. Returns the server with its sign-in details saved.
 */
export async function signIn(server: McpServer, opts: { clientId?: string; clientSecret?: string; signal?: AbortSignal } = {}): Promise<McpServer> {
  if (!server.url) throw new Error("This server has no URL.");
  const found = await discover(server.url);
  let client: OAuthClient;
  if (opts.clientId?.trim()) {
    client = { ...found, clientId: opts.clientId.trim(), hasClientSecret: !!opts.clientSecret };
    if (opts.clientSecret) await secrets.set(clientSecretKey(server.id), opts.clientSecret);
  } else if (server.oauth?.clientId && server.oauth.tokenEndpoint === found.tokenEndpoint) {
    client = { ...found, clientId: server.oauth.clientId, hasClientSecret: server.oauth.hasClientSecret };
  } else if (found.registrationEndpoint) {
    const reg = await register(found.registrationEndpoint);
    if (reg.clientSecret) await secrets.set(clientSecretKey(server.id), reg.clientSecret);
    client = { ...found, clientId: reg.clientId, hasClientSecret: !!reg.clientSecret };
  } else {
    throw new Error(`${new URL(server.url).host} needs its own client ID: create an OAuth app in its developer settings with the redirect URL ${redirectUri()}, then enter the ID in the server's settings.`);
  }

  const verifier = random(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
  const state = random(24);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: client.resource ?? server.url,
  });
  if (client.scopes) params.set("scope", client.scopes);
  await openExternal(`${client.authorizationEndpoint}${client.authorizationEndpoint.includes("?") ? "&" : "?"}${params}`);
  const code = await waitForCode(state, opts.signal);
  const tokens = await tokenRequest(client, server.id, { grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: verifier });
  await secrets.set(tokenKey(server.id), JSON.stringify(tokens));
  return { ...server, oauth: client };
}

export async function signOut(server: McpServer): Promise<void> {
  await secrets.delete(tokenKey(server.id));
}

export async function isSignedIn(server: McpServer): Promise<boolean> {
  return !!(await secrets.get(tokenKey(server.id)));
}

async function readTokens(serverId: string): Promise<Tokens | null> {
  const raw = await secrets.get(tokenKey(serverId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Tokens;
  } catch {
    return null;
  }
}

/**
 * A usable access token for a server: refreshed first when it has run out (or
 * `force`). Devices agree through a hub lease so only one of them refreshes.
 */
export async function accessToken(server: McpServer, force = false): Promise<string> {
  const client = server.oauth;
  if (!client) throw new Error(`${server.name} isn't set up for sign-in.`);
  let tokens = await readTokens(server.id);
  if (!tokens) throw new Error(`Sign in to ${server.name} on the Plugins page first.`);
  const stale = force || (tokens.expires_at !== undefined && tokens.expires_at - 60_000 < Date.now());
  if (!stale) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error(`Your sign-in to ${server.name} ran out. Sign in again on the Plugins page.`);
  const leased = useApp.getState().hub ? await hubLease(`oauth:${server.id}`, 30_000).catch(() => true) : true;
  if (!leased) {
    // Another device or the runner is refreshing it: use theirs when it arrives.
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const fresh = await readTokens(server.id);
      if (fresh && fresh.access_token !== tokens.access_token) return fresh.access_token;
    }
  }
  try {
    const next = await tokenRequest(client, server.id, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    tokens = { ...next, refresh_token: next.refresh_token ?? tokens.refresh_token };
    await secrets.set(tokenKey(server.id), JSON.stringify(tokens));
    return tokens.access_token;
  } catch (e) {
    throw new Error(`Couldn't renew the sign-in to ${server.name} (${(e as Error).message}). Sign in again on the Plugins page.`);
  }
}
