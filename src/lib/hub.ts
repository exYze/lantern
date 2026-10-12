// Lantern Hub client: connecting and pairing, the authenticated API, and bot
// tools (files, terminal) that run in the hub's shared workspace.

import { db, httpRequest, platform, secrets, type DirEntry, type GrepRequest, type ReadResult, type ShellResult } from "./platform";
import { useApp } from "./store";
import type { Bot } from "./types";
import { uid } from "./util";

/** Baked in at build time from `.env.local` (never committed); users can change it in Settings → Hub. */
export const DEFAULT_HUB_URL = String(import.meta.env.VITE_LANTERN_HUB_URL ?? "").trim();

const TOKEN_KEY = "hub:token";
const LOCAL = "local";

export interface HubToolInfo {
  workspace: string;
  shell: string;
  os: string;
  user: string;
  /** The hub can run commands in bubblewrap sandboxes (unknown on hubs before 0.3). */
  sandbox?: boolean;
  /** When this device last asked; refreshed now and then in case the hub was upgraded. */
  fetchedAt?: number;
}

/** A bubblewrap sandbox on the hub: `dir` is the only writable (and visible) part of the workspace. */
export interface HubSandbox {
  dir: string;
  network: boolean;
}

export interface HubConnection {
  url: string;
  hubId: string;
  name: string;
  deviceId: string;
  /** Sync position: the last hub revision this device has applied. */
  cursor: number;
  /** The first sync (a two-way merge of existing data) has finished. */
  merged: boolean;
  tools?: HubToolInfo;
}

export interface HubInfo {
  app: string;
  name: string;
  version: string;
  hubId: string;
  canAutoPair: boolean;
}

export interface HubDevice {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeen: number;
  pairedVia: string;
}

export class HubError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function normalizeHubUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "").replace(/\/api(\/v1)?$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

export function deviceName(): string {
  if (platform.hostname) return platform.hostname;
  const names: Record<string, string> = { android: "Android device", ios: "iPhone", macos: "Mac", windows: "Windows PC", linux: "Linux PC", web: "Browser" };
  return names[platform.os] ?? platform.os;
}

export function hubConnection(): HubConnection | null {
  return useApp.getState().hub;
}

export async function loadHubConnection(): Promise<HubConnection | null> {
  const conn = await db.get<HubConnection>(LOCAL, "hub");
  return conn?.url && conn.deviceId ? conn : null;
}

export async function saveHubConnection(conn: HubConnection | null): Promise<void> {
  if (conn) await db.put(LOCAL, "hub", conn, true);
  else await db.delete(LOCAL, "hub", true);
  useApp.setState({ hub: conn });
}

async function parse<T>(res: { status: number; body: string }): Promise<T> {
  let data: any = null;
  try {
    data = res.body ? JSON.parse(res.body) : null;
  } catch {
    // Not JSON: a proxy error page or similar.
  }
  if (res.status >= 200 && res.status < 300) return data as T;
  const message = data?.error ?? (res.status === 404 ? "This address isn't a Lantern Hub (or it's an older version)." : `The hub answered with HTTP ${res.status}.`);
  throw new HubError(message, res.status);
}

function friendlyNetworkError(url: string, e: unknown): Error {
  const msg = (e as Error)?.message ?? String(e);
  return new Error(`Can't reach the hub at ${url}. Check that this device is on your Tailscale network (or the same network as the hub). (${msg})`);
}

/** Reads the hub's public info; used before pairing. */
export async function fetchHubInfo(url: string): Promise<HubInfo> {
  let res;
  try {
    res = await httpRequest({ url: `${url}/api/v1/info`, timeoutMs: 15000 });
  } catch (e) {
    throw friendlyNetworkError(url, e);
  }
  const info = await parse<HubInfo>(res);
  if (info?.app !== "lantern-hub") throw new Error(`${url} isn't a Lantern Hub.`);
  return info;
}

/** Pairs this device. Without a code it works only for the hub owner's Tailscale devices. */
export async function pairWithHub(url: string, code?: string): Promise<HubConnection> {
  let res;
  try {
    res = await httpRequest({
      method: "POST",
      url: `${url}/api/v1/pair`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code?.trim() || undefined, name: deviceName(), platform: platform.os }),
      timeoutMs: 20000,
    });
  } catch (e) {
    throw friendlyNetworkError(url, e);
  }
  const paired = await parse<{ deviceId: string; token: string; hubId: string; name: string }>(res);
  await secrets.set(TOKEN_KEY, paired.token, true);
  const conn: HubConnection = { url, hubId: paired.hubId, name: paired.name, deviceId: paired.deviceId, cursor: 0, merged: false };
  await saveHubConnection(conn);
  return conn;
}

/** Calls the hub API as this device. */
export async function hubApi<T>(path: string, opts: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const conn = hubConnection();
  if (!conn) throw new Error("This device isn't connected to a Lantern Hub.");
  const token = await secrets.get(TOKEN_KEY);
  if (!token) throw new HubError("This device's hub key is missing. Connect it again in Settings → Hub.", 401);
  let res;
  try {
    res = await httpRequest({
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      url: conn.url + path,
      headers: { Authorization: `Bearer ${token}`, ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      timeoutMs: opts.timeoutMs ?? 30000,
    });
  } catch (e) {
    throw friendlyNetworkError(conn.url, e);
  }
  return parse<T>(res);
}

export async function hubToken(): Promise<string | null> {
  return secrets.get(TOKEN_KEY);
}

/** Forgets the hub on this device. Local data stays. */
export async function forgetHub(): Promise<void> {
  await secrets.delete(TOKEN_KEY, true);
  await saveHubConnection(null);
}

export const hubDevices = {
  list: () => hubApi<HubDevice[]>("/api/v1/devices"),
  remove: (id: string) => hubApi<{ removed: boolean }>(`/api/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  pairCode: () => hubApi<{ code: string; expiresAt: number }>("/api/v1/pair-codes", { method: "POST", body: {} }),
};

/** Claims `key` for this device (e.g. one routine run); false if another device has it. */
export async function hubLease(key: string, ttlMs = 3_600_000): Promise<boolean> {
  return (await hubApi<{ granted: boolean }>("/api/v1/lease", { body: { key, ttlMs } })).granted;
}

// ---------------------------------------------------------------- tools on the hub

/** True when this bot's file and terminal tools run on the hub. */
export function usesHub(bot: Bot): boolean {
  const { hub, settings } = useApp.getState();
  return !!hub && (bot.computer ?? settings.computer ?? "hub") === "hub";
}

async function hubTool<T>(request: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
  try {
    return await hubApi<T>("/api/v1/tools", { body: request, timeoutMs });
  } catch (e) {
    // 422 = the tool itself failed (missing file, bad pattern…): report it like a local tool error.
    if (e instanceof HubError && e.status === 422) throw new Error(e.message);
    throw e;
  }
}

const TOOL_INFO_MAX_AGE = 30 * 60_000;

export async function hubToolInfo(): Promise<HubToolInfo> {
  const cached = hubConnection()?.tools;
  if (cached && cached.sandbox !== undefined && Date.now() - (cached.fetchedAt ?? 0) < TOOL_INFO_MAX_AGE) return cached;
  try {
    const tools = { ...(await hubTool<HubToolInfo>({ op: "info" }, 15000)), fetchedAt: Date.now() };
    const latest = hubConnection();
    if (latest) await saveHubConnection({ ...latest, tools });
    return tools;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}

export const hubFs = {
  read: (root: string, path: string, offset?: number, limit?: number, confine?: boolean) => hubTool<ReadResult>({ op: "fs_read", root, path, offset, limit, confine }),
  write: (root: string, path: string, content: string, confine?: boolean) => hubTool<string>({ op: "fs_write", root, path, content, confine }),
  edit: (root: string, path: string, edits: { oldText: string; newText: string; replaceAll?: boolean }[], confine?: boolean) =>
    hubTool<string>({ op: "fs_edit", root, path, edits, confine }),
  list: (root: string, path?: string, confine?: boolean) => hubTool<DirEntry[]>({ op: "fs_list", root, path, confine }),
  find: (root: string, pattern: string, path?: string, limit?: number, confine?: boolean) => hubTool<string[]>({ op: "fs_find", root, pattern, path, limit, confine }),
  grep: (request: GrepRequest, confine?: boolean) => hubTool<string>({ op: "fs_grep", request, confine }),
  delete: (root: string, path: string, confine?: boolean) => hubTool<string>({ op: "fs_delete", root, path, confine }),
};

export async function hubShellRun(
  command: string,
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal; sandbox?: HubSandbox },
): Promise<ShellResult> {
  const id = uid("sh");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const onAbort = () => void hubTool({ op: "shell_cancel", id }, 15000).catch(() => {});
  opts.signal?.addEventListener("abort", onAbort);
  try {
    return await hubTool<ShellResult>({ op: "shell_run", request: { id, command, cwd: opts.cwd, timeoutMs, env: opts.env ?? {}, sandbox: opts.sandbox } }, timeoutMs + 30_000);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
