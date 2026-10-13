// One interface over the native (Tauri) backend, with a browser fallback so the
// UI can run in a plain browser during development (`npm run dev`), and a third
// backend the hub's runner plugs in to run bots without any app open.

import { Channel, invoke } from "@tauri-apps/api/core";
import { htmlToText } from "./html";
import { uid } from "./util";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Storage, secrets, HTTP and notifications for a runtime that is neither the app nor a browser (the hub runner). */
export interface Backend {
  info: PlatformInfo;
  db: {
    put(collection: string, id: string, data: unknown): Promise<void>;
    get<T>(collection: string, id: string): Promise<T | null>;
    list<T>(collection: string): Promise<T[]>;
    delete(collection: string, id: string): Promise<void>;
    clear(collection: string): Promise<void>;
    search<T>(prefix: string, query: string, limit: number): Promise<SearchHit<T>[]>;
  };
  secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  httpRequest(req: HttpReq): Promise<HttpRes>;
  httpStream(req: HttpReq, h: StreamHandlers): Promise<number>;
  notify(title: string, body: string): Promise<void>;
}

let backend: Backend | null = null;

export function setBackend(b: Backend) {
  backend = b;
  platform = b.info;
}

/** True when this code runs in the hub's runner rather than an app. */
export const isRunner = () => backend !== null;

/** Whether the user is looking at Lantern right now (the runner never has a screen). */
export function appVisible(): boolean {
  if (backend || typeof document === "undefined") return false;
  return !document.hidden;
}

/** Calls `fn` when the app comes back to the foreground or the network returns. */
export function onResume(fn: () => void) {
  if (backend || typeof window === "undefined") return;
  window.addEventListener("online", fn);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) fn();
  });
}

export interface PlatformInfo {
  os: string;
  arch: string;
  mobile: boolean;
  version: string;
  shell: string | null;
  secretBackend: string;
  /** The computer's name (desktop), used to label it on the hub. */
  hostname?: string | null;
}

export let platform: PlatformInfo = {
  os: "web",
  arch: "",
  mobile: false,
  version: "0.6.0",
  shell: null,
  secretBackend: "browser-storage",
};

export async function initPlatform(): Promise<PlatformInfo> {
  if (backend) {
    platform = backend.info;
  } else if (isTauri) {
    platform = await invoke<PlatformInfo>("platform_info");
  } else {
    platform = { ...platform, mobile: /Android|iPhone|iPad/i.test(navigator.userAgent) };
  }
  return platform;
}

export const capabilities = {
  get shell() {
    return isTauri && !platform.mobile;
  },
  get mcpStdio() {
    return isTauri && !platform.mobile;
  },
  get files() {
    return isTauri;
  },
};

function notAvailable(what: string): never {
  throw new Error(`${what} is not available in the browser build. Use the desktop or mobile app.`);
}

// ---------------------------------------------------------------- storage

interface WebDoc {
  collection: string;
  id: string;
  data: unknown;
  seq: number;
  updatedAt: number;
}

let idb: Promise<IDBDatabase> | null = null;
function openIdb(): Promise<IDBDatabase> {
  idb ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("lantern", 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("docs", { keyPath: ["collection", "id"] });
      store.createIndex("collection", "collection");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idb;
}

function idbReq<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function webStore(mode: IDBTransactionMode) {
  return (await openIdb()).transaction("docs", mode).objectStore("docs");
}

let webSeq = Date.now();

export interface SearchHit<T = unknown> {
  collection: string;
  id: string;
  data: T;
}

/** Notified after local writes so the hub sync can pick them up. Writes made
 *  with `quiet` (e.g. changes arriving from the hub) are not reported. */
export const changeListeners: {
  doc: ((collection: string, id: string) => void) | null;
  secret: ((key: string) => void) | null;
} = { doc: null, secret: null };

export const db = {
  async put(collection: string, id: string, data: unknown, quiet = false): Promise<void> {
    if (backend) {
      await backend.db.put(collection, id, data);
    } else if (isTauri) {
      await invoke("db_put", { collection, id, data });
    } else {
      const store = await webStore("readwrite");
      const existing = await idbReq<WebDoc | undefined>(store.get([collection, id]));
      const doc: WebDoc = { collection, id, data, seq: existing?.seq ?? webSeq++, updatedAt: Date.now() };
      await idbReq(store.put(doc));
    }
    if (!quiet) changeListeners.doc?.(collection, id);
  },
  async get<T>(collection: string, id: string): Promise<T | null> {
    if (backend) return backend.db.get<T>(collection, id);
    if (isTauri) return invoke<T | null>("db_get", { collection, id });
    const doc = await idbReq<WebDoc | undefined>((await webStore("readonly")).get([collection, id]));
    return (doc?.data as T) ?? null;
  },
  async list<T>(collection: string): Promise<T[]> {
    if (backend) return backend.db.list<T>(collection);
    if (isTauri) return invoke<T[]>("db_list", { collection });
    const docs = await idbReq<WebDoc[]>((await webStore("readonly")).index("collection").getAll(collection));
    return docs.sort((a, b) => a.seq - b.seq).map((d) => d.data as T);
  },
  async delete(collection: string, id: string, quiet = false): Promise<void> {
    if (backend) {
      await backend.db.delete(collection, id);
    } else if (isTauri) {
      await invoke("db_delete", { collection, id });
    } else {
      await idbReq((await webStore("readwrite")).delete([collection, id]));
    }
    if (!quiet) changeListeners.doc?.(collection, id);
  },
  async clear(collection: string, quiet = false): Promise<void> {
    const listener = quiet ? null : changeListeners.doc;
    const ids = listener ? (await db.list<{ id?: string }>(collection)).map((d) => d?.id).filter((id): id is string => !!id) : [];
    if (backend) {
      await backend.db.clear(collection);
    } else if (isTauri) {
      await invoke("db_clear", { collection });
    } else {
      const store = await webStore("readwrite");
      const keys = await idbReq(store.index("collection").getAllKeys(collection));
      await Promise.all(keys.map((k) => idbReq(store.delete(k))));
    }
    for (const id of ids) listener?.(collection, id);
  },
  async search<T>(prefix: string, query: string, limit = 50): Promise<SearchHit<T>[]> {
    if (backend) return backend.db.search<T>(prefix, query, limit);
    if (isTauri) return invoke<SearchHit<T>[]>("db_search", { prefix, query, limit });
    const all = await idbReq<WebDoc[]>((await webStore("readonly")).getAll());
    const q = query.toLowerCase();
    return all
      .filter((d) => d.collection.startsWith(prefix) && JSON.stringify(d.data).toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((d) => ({ collection: d.collection, id: d.id, data: d.data as T }));
  },
};

// ---------------------------------------------------------------- secrets

export const secrets = {
  async set(key: string, value: string, quiet = false): Promise<void> {
    if (backend) await backend.secrets.set(key, value);
    else if (isTauri) await invoke("secret_set", { key, value });
    else localStorage.setItem(`lantern.secret.${key}`, value);
    if (!quiet) changeListeners.secret?.(key);
  },
  async get(key: string): Promise<string | null> {
    if (backend) return backend.secrets.get(key);
    if (isTauri) return invoke<string | null>("secret_get", { key });
    return localStorage.getItem(`lantern.secret.${key}`);
  },
  async delete(key: string, quiet = false): Promise<void> {
    if (backend) await backend.secrets.delete(key);
    else if (isTauri) await invoke("secret_delete", { key });
    else localStorage.removeItem(`lantern.secret.${key}`);
    if (!quiet) changeListeners.secret?.(key);
  },
};

// ---------------------------------------------------------------- http

export interface HttpReq {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  timeoutMs?: number;
}

export interface HttpRes {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface StreamHandlers {
  onResponse?: (status: number, headers: Record<string, string>) => void;
  onChunk: (text: string) => void;
  signal?: AbortSignal;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

export function abortError(): Error {
  const e = new Error("Stopped");
  e.name = "AbortError";
  return e;
}

export async function httpRequest(req: HttpReq): Promise<HttpRes> {
  if (backend) return backend.httpRequest(req);
  if (isTauri) return invoke<HttpRes>("http_request", { request: req });
  const ctrl = new AbortController();
  const timer = req.timeoutMs ? setTimeout(() => ctrl.abort(), req.timeoutMs) : undefined;
  try {
    const res = await fetch(req.url, {
      method: req.method ?? "GET",
      headers: req.headers,
      body: req.bodyBase64 ? (base64ToBytes(req.bodyBase64) as BodyInit) : req.body,
      signal: ctrl.signal,
    });
    return { status: res.status, headers: headersToObject(res.headers), body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

type StreamEvent =
  | { event: "response"; data: { status: number; headers: Record<string, string> } }
  | { event: "chunk"; data: string }
  | { event: "done" }
  | { event: "error"; data: string };

/** Streams a response body as text. Resolves with the HTTP status when the body ends. */
export async function httpStream(req: HttpReq, h: StreamHandlers): Promise<number> {
  if (h.signal?.aborted) throw abortError();
  if (backend) return backend.httpStream(req, h);
  if (!isTauri) {
    const res = await fetch(req.url, { method: req.method ?? "GET", headers: req.headers, body: req.body, signal: h.signal });
    h.onResponse?.(res.status, headersToObject(res.headers));
    if (!res.body) return res.status;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      h.onChunk(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) h.onChunk(tail);
    return res.status;
  }

  const id = uid("req");
  return new Promise<number>((resolve, reject) => {
    let status = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      h.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      void invoke("http_cancel", { id });
      finish(() => reject(abortError()));
    };
    h.signal?.addEventListener("abort", onAbort);

    const channel = new Channel<StreamEvent>();
    channel.onmessage = (ev) => {
      if (settled) return;
      switch (ev.event) {
        case "response":
          status = ev.data.status;
          h.onResponse?.(ev.data.status, ev.data.headers);
          break;
        case "chunk":
          h.onChunk(ev.data);
          break;
        case "done":
          finish(() => resolve(status));
          break;
        case "error":
          finish(() => reject(new Error(ev.data)));
          break;
      }
    };
    invoke("http_stream", { id, request: req, onEvent: channel }).catch((e) => finish(() => reject(new Error(String(e)))));
  });
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  title?: string | null;
  text: string;
  truncated: boolean;
}

export async function webFetch(url: string, maxChars = 40000): Promise<FetchedPage> {
  if (isTauri) return invoke<FetchedPage>("web_fetch", { url, maxChars });
  const res = await httpRequest({ url, headers: { Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5" }, timeoutMs: 45000 });
  const contentType = res.headers["content-type"] ?? "";
  const isHtml = contentType.includes("html") || (!contentType && res.body.trimStart().startsWith("<"));
  const page = isHtml ? htmlToText(res.body) : { title: null, text: res.body };
  return { url, status: res.status, contentType, title: page.title, text: page.text.slice(0, maxChars), truncated: page.text.length > maxChars };
}

// ---------------------------------------------------------------- files

export interface ReadResult {
  path: string;
  content: string;
  startLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface BytesResult {
  path: string;
  name: string;
  size: number;
  base64: string;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
}

export interface GrepRequest {
  root: string;
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export const fs = {
  // `confine`: every path must stay inside `root` (an isolated subagent's folder).
  read(root: string, path: string, offset?: number, limit?: number, confine?: boolean) {
    if (!isTauri) notAvailable("Reading files");
    return invoke<ReadResult>("fs_read", { root, path, offset, limit, confine });
  },
  write(root: string, path: string, content: string, confine?: boolean) {
    if (!isTauri) notAvailable("Writing files");
    return invoke<string>("fs_write", { root, path, content, confine });
  },
  edit(root: string, path: string, edits: { oldText: string; newText: string; replaceAll?: boolean }[], confine?: boolean) {
    if (!isTauri) notAvailable("Editing files");
    return invoke<string>("fs_edit", { root, path, edits, confine });
  },
  list(root: string, path?: string, confine?: boolean) {
    if (!isTauri) notAvailable("Listing files");
    return invoke<DirEntry[]>("fs_list", { root, path, confine });
  },
  find(root: string, pattern: string, path?: string, limit?: number, confine?: boolean) {
    if (!isTauri) notAvailable("Finding files");
    return invoke<string[]>("fs_find", { root, pattern, path, limit, confine });
  },
  grep(request: GrepRequest, confine?: boolean) {
    if (!isTauri) notAvailable("Searching files");
    return invoke<string>("fs_grep", { request, confine });
  },
  delete(root: string, path: string, confine?: boolean) {
    if (!isTauri) notAvailable("Deleting files");
    return invoke<string>("fs_delete", { root, path, confine });
  },
  /** A whole file as base64 (documents, images, slide decks). */
  readBytes(root: string, path: string, confine?: boolean) {
    if (!isTauri) notAvailable("Reading files");
    return invoke<BytesResult>("fs_read_bytes", { root, path, confine });
  },
  writeBytes(root: string, path: string, base64: string, confine?: boolean) {
    if (!isTauri) notAvailable("Writing files");
    return invoke<string>("fs_write_bytes", { root, path, base64, confine });
  },
  async defaultWorkspace(): Promise<string> {
    if (!isTauri) return "";
    return invoke<string>("default_workspace");
  },
};

// ---------------------------------------------------------------- shell

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export async function shellRun(
  command: string,
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal },
): Promise<ShellResult> {
  if (!capabilities.shell) notAvailable("Running shell commands");
  const id = uid("req");
  const onAbort = () => void invoke("shell_cancel", { id });
  opts.signal?.addEventListener("abort", onAbort);
  try {
    return await invoke<ShellResult>("shell_run", {
      request: { id, command, cwd: opts.cwd, timeoutMs: opts.timeoutMs, env: opts.env ?? {} },
    });
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------- MCP stdio

export type McpEvent = { event: "message"; data: string } | { event: "stderr"; data: string } | { event: "exit"; data: number | null };

export const mcpStdio = {
  async spawn(
    id: string,
    command: string,
    args: string[],
    env: Record<string, string>,
    cwd: string | undefined,
    onEvent: (e: McpEvent) => void,
  ): Promise<void> {
    if (!capabilities.mcpStdio) notAvailable("Local MCP servers");
    const channel = new Channel<McpEvent>();
    channel.onmessage = onEvent;
    await invoke("mcp_spawn", { id, command, args, env, cwd, onEvent: channel });
  },
  send(id: string, message: string): Promise<void> {
    return invoke("mcp_send", { id, message });
  },
  kill(id: string): Promise<void> {
    return isTauri ? invoke("mcp_kill", { id }) : Promise.resolve();
  },
};

// ---------------------------------------------------------------- OS integration

export async function notify(title: string, body: string): Promise<void> {
  try {
    if (backend) {
      await backend.notify(title, body);
      return;
    }
    if (isTauri) {
      const n = await import("@tauri-apps/plugin-notification");
      let granted = await n.isPermissionGranted();
      if (!granted) granted = (await n.requestPermission()) === "granted";
      if (granted) n.sendNotification({ title, body });
      return;
    }
    if ("Notification" in window) {
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission === "granted") new Notification(title, { body });
    }
  } catch (e) {
    console.warn("notification failed", e);
  }
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}
