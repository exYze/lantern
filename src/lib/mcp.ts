// Minimal Model Context Protocol client: stdio (desktop) and Streamable HTTP.

import { accessToken } from "./oauth";
import { httpRequest, mcpStdio, platform, secrets } from "./platform";
import { SseParser } from "./sse";
import type { McpServer } from "./types";

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 60_000;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: any;
}

interface Transport {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

export function secretKey(serverId: string, kind: "env" | "header", key: string): string {
  return `mcp:${serverId}:${kind}:${key}`;
}

async function resolveSecrets(server: McpServer, kind: "env" | "header"): Promise<Record<string, string>> {
  const keys = (kind === "env" ? server.envKeys : server.headerKeys) ?? [];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = await secrets.get(secretKey(server.id, kind, k));
    if (v != null) out[k] = v;
  }
  return out;
}

class StdioTransport implements Transport {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private stderr: string[] = [];
  private exited = false;

  constructor(
    private readonly id: string,
    private readonly onNotification: (msg: JsonRpcResponse) => void,
    private readonly workspace: string,
  ) {}

  async start(server: McpServer) {
    const env = await resolveSecrets(server, "env");
    await mcpStdio.spawn(this.id, server.command ?? "", server.args ?? [], env, this.workspace || undefined, (e) => {
      if (e.event === "message") this.onLine(e.data);
      else if (e.event === "stderr") this.stderr = [...this.stderr.slice(-30), e.data];
      else {
        this.exited = true;
        const tail = this.stderr.slice(-5).join("\n");
        for (const p of this.pending.values()) p.reject(new Error(`MCP server exited (code ${e.data ?? "?"})${tail ? `:\n${tail}` : ""}`));
        this.pending.clear();
      }
    });
  }

  private onLine(line: string) {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // servers sometimes log to stdout
    }
    if (msg.method && msg.id !== undefined) {
      // Server → client request. Answer roots/list; refuse anything else politely.
      const reply =
        msg.method === "roots/list"
          ? { jsonrpc: "2.0", id: msg.id, result: { roots: this.workspace ? [{ uri: fileUri(this.workspace), name: "workspace" }] : [] } }
          : msg.method === "ping"
            ? { jsonrpc: "2.0", id: msg.id, result: {} }
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported by Lantern" } };
      void mcpStdio.send(this.id, JSON.stringify(reply));
      return;
    }
    if (msg.method) {
      this.onNotification(msg);
      return;
    }
    const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id as number);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<any> {
    if (this.exited) return Promise.reject(new Error("MCP server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        this.pending.delete(id);
        void this.notify("notifications/cancelled", { requestId: id, reason: "Stopped by user" });
        done(() => reject(new Error("Stopped")));
      };
      signal?.addEventListener("abort", onAbort);
      this.pending.set(id, { resolve: (v) => done(() => resolve(v)), reject: (e) => done(() => reject(e)) });
      mcpStdio.send(this.id, JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })).catch((e) => {
        this.pending.delete(id);
        done(() => reject(new Error(String(e))));
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return mcpStdio.send(this.id, JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }));
  }

  close(): Promise<void> {
    return mcpStdio.kill(this.id);
  }
}

class HttpTransport implements Transport {
  private nextId = 1;
  private sessionId: string | null = null;
  private negotiatedVersion: string | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    /** For signed-in servers: a fresh access token (forced to renew after a 401). */
    private readonly token?: (force: boolean) => Promise<string>,
  ) {}

  private async post(body: unknown, expectReply: boolean, retried = false): Promise<JsonRpcResponse | null> {
    const headers: Record<string, string> = {
      ...this.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.token) headers.Authorization = `Bearer ${await this.token(retried)}`;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.negotiatedVersion) headers["MCP-Protocol-Version"] = this.negotiatedVersion;
    const res = await httpRequest({ method: "POST", url: this.url, headers, body: JSON.stringify(body), timeoutMs: REQUEST_TIMEOUT_MS });
    const sid = res.headers["mcp-session-id"];
    if (sid) this.sessionId = sid;
    // A rejected token: renew it once and try again.
    if (res.status === 401 && this.token && !retried) return this.post(body, expectReply, true);
    if (res.status === 401 && !this.token) throw new Error("This server wants you to sign in: use Sign in on the Plugins page, or add its key as a header.");
    if (res.status >= 400) throw new Error(`MCP HTTP ${res.status}: ${res.body.slice(0, 300)}`);
    if (!expectReply) return null;
    const id = (body as { id?: number }).id;
    if ((res.headers["content-type"] ?? "").includes("text/event-stream")) {
      const parser = new SseParser();
      const events = [...parser.feed(res.body), ...parser.end()];
      for (const e of events) {
        try {
          const msg = JSON.parse(e) as JsonRpcResponse;
          if (msg.id === id) return msg;
        } catch {
          /* ignore */
        }
      }
      throw new Error("MCP server sent no response");
    }
    return JSON.parse(res.body) as JsonRpcResponse;
  }

  async request(method: string, params?: unknown): Promise<any> {
    const msg = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params: params ?? {} }, true);
    if (msg?.error) throw new Error(msg.error.message);
    if (method === "initialize") this.negotiatedVersion = msg?.result?.protocolVersion ?? PROTOCOL_VERSION;
    return msg?.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params: params ?? {} }, false);
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await httpRequest({ method: "DELETE", url: this.url, headers: { ...this.headers, "Mcp-Session-Id": this.sessionId } }).catch(() => {});
  }
}

function fileUri(path: string): string {
  const p = path.replace(/\\/g, "/");
  return "file://" + (p.startsWith("/") ? "" : "/") + encodeURI(p);
}

export class McpClient {
  tools: McpTool[] = [];
  serverName = "";
  private transport: Transport | null = null;

  constructor(
    readonly server: McpServer,
    private readonly workspace: string,
  ) {}

  async connect(): Promise<void> {
    if (this.server.transport === "stdio") {
      const t = new StdioTransport(`mcp-${this.server.id}`, (n) => this.onNotification(n), this.workspace);
      await t.start(this.server);
      this.transport = t;
    } else {
      const server = this.server;
      this.transport = new HttpTransport(server.url ?? "", await resolveSecrets(server, "header"), server.oauth ? (force) => accessToken(server, force) : undefined);
    }
    const init = await this.transport.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: "Lantern", version: platform.version },
    });
    this.serverName = init?.serverInfo?.name ?? this.server.name;
    await this.transport.notify("notifications/initialized");
    await this.refreshTools();
  }

  private onNotification(n: JsonRpcResponse) {
    if (n.method === "notifications/tools/list_changed") void this.refreshTools();
  }

  async refreshTools(): Promise<void> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.transport!.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
    } while (cursor);
    this.tools = tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const r = await this.transport!.request("tools/call", { name, arguments: args }, signal);
    const parts: string[] = [];
    for (const c of r?.content ?? []) {
      if (c.type === "text") parts.push(c.text);
      else if (c.type === "image") parts.push(`[image ${c.mimeType ?? ""}]`);
      else if (c.type === "audio") parts.push(`[audio ${c.mimeType ?? ""}]`);
      else if (c.type === "resource") parts.push(c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`);
      else if (c.type === "resource_link") parts.push(`[resource ${c.uri}]`);
    }
    if (!parts.length && r?.structuredContent) parts.push(JSON.stringify(r.structuredContent, null, 2));
    const text = parts.join("\n") || "(no output)";
    return r?.isError ? `Error: ${text}` : text;
  }

  async close(): Promise<void> {
    await this.transport?.close().catch(() => {});
    this.transport = null;
  }
}

// ------------------------------------------------------------ connection pool

const clients = new Map<string, Promise<McpClient>>();
export const mcpStatus = new Map<string, { ok: boolean; error?: string; toolCount?: number }>();

/** Connects (once) and returns a client; failed connections are retried on the next call. */
export function getMcpClient(server: McpServer, workspace: string): Promise<McpClient> {
  const key = `${server.id}:${JSON.stringify([server.command, server.args, server.url, server.envKeys, server.headerKeys, server.oauth?.clientId])}`;
  let p = clients.get(key);
  if (!p) {
    const client = new McpClient(server, workspace);
    p = client.connect().then(
      () => {
        mcpStatus.set(server.id, { ok: true, toolCount: client.tools.length });
        return client;
      },
      async (e) => {
        clients.delete(key);
        await client.close();
        mcpStatus.set(server.id, { ok: false, error: String(e?.message ?? e) });
        throw e;
      },
    );
    clients.set(key, p);
  }
  return p;
}

export async function disconnectMcp(serverId: string): Promise<void> {
  for (const [key, p] of clients) {
    if (key.startsWith(serverId + ":")) {
      clients.delete(key);
      await p.then((c) => c.close()).catch(() => {});
    }
  }
  mcpStatus.delete(serverId);
}

export function mcpToolName(serverName: string, toolName: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return `mcp__${slug(serverName).slice(0, 20)}__${slug(toolName)}`.slice(0, 64);
}
