// The runner's stand-in for the app's native layer: documents and secrets in
// files under its data folder, and HTTP with Node (the hub itself is reached
// over its Unix socket, like `tailscale serve` does).

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { abortError, type Backend, type HttpReq, type HttpRes, type PlatformInfo, type SearchHit, type StreamHandlers } from "../lib/platform";

interface Doc {
  data: unknown;
  seq: number;
  updatedAt: number;
}

/** Documents kept in memory and saved as one JSON file per collection (a second after the last change). */
export class FileDb {
  private cols = new Map<string, Map<string, Doc>>();
  private dirty = new Set<string>();
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const entries = JSON.parse(readFileSync(join(dir, name), "utf8")) as [string, Doc][];
        const col = new Map(entries);
        for (const d of col.values()) this.seq = Math.max(this.seq, d.seq);
        this.cols.set(decodeURIComponent(name.slice(0, -5)), col);
      } catch (e) {
        console.error(`runner: skipping unreadable ${name}:`, e);
      }
    }
  }

  private col(c: string): Map<string, Doc> {
    let m = this.cols.get(c);
    if (!m) this.cols.set(c, (m = new Map()));
    return m;
  }

  private touch(c: string) {
    this.dirty.add(c);
    this.timer ??= setTimeout(() => this.flush(), 1000);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const c of this.dirty) {
      const file = join(this.dir, `${encodeURIComponent(c)}.json`);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.col(c)]), { mode: 0o600 });
      renameSync(tmp, file);
    }
    this.dirty.clear();
  }

  async put(c: string, id: string, data: unknown) {
    const existing = this.col(c).get(id);
    this.col(c).set(id, { data, seq: existing?.seq ?? ++this.seq, updatedAt: Date.now() });
    this.touch(c);
  }

  async get<T>(c: string, id: string): Promise<T | null> {
    return (this.cols.get(c)?.get(id)?.data as T) ?? null;
  }

  async list<T>(c: string): Promise<T[]> {
    return [...(this.cols.get(c)?.values() ?? [])].sort((a, b) => a.seq - b.seq).map((d) => d.data as T);
  }

  async delete(c: string, id: string) {
    if (this.cols.get(c)?.delete(id)) this.touch(c);
  }

  async clear(c: string) {
    if (this.cols.get(c)?.size) {
      this.cols.set(c, new Map());
      this.touch(c);
    }
  }

  async search<T>(prefix: string, query: string, limit: number): Promise<SearchHit<T>[]> {
    const q = query.toLowerCase();
    const hits: (SearchHit<T> & { at: number })[] = [];
    for (const [collection, docs] of this.cols) {
      if (!collection.startsWith(prefix)) continue;
      for (const [id, d] of docs) if (JSON.stringify(d.data).toLowerCase().includes(q)) hits.push({ collection, id, data: d.data as T, at: d.updatedAt });
    }
    return hits.sort((a, b) => b.at - a.at).slice(0, limit);
  }
}

/** Secrets in one file only the runner's user can read. */
class FileSecrets {
  private values: Record<string, string> = {};
  constructor(private readonly file: string) {
    if (existsSync(file)) this.values = JSON.parse(readFileSync(file, "utf8"));
  }
  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.values), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
  async get(key: string) {
    return this.values[key] ?? null;
  }
  async set(key: string, value: string) {
    this.values[key] = value;
    this.save();
  }
  async delete(key: string) {
    if (key in this.values) {
      delete this.values[key];
      this.save();
    }
  }
}

function lowerHeaders(h: http.IncomingHttpHeaders | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
  else for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

/** One HTTP exchange with the hub over its Unix socket; streams the body to `h` when given. */
function socketRequest(socketPath: string, req: HttpReq, h?: StreamHandlers): Promise<HttpRes> {
  return new Promise((resolve, reject) => {
    if (h?.signal?.aborted) return reject(abortError());
    const u = new URL(req.url);
    const body = req.bodyBase64 ? Buffer.from(req.bodyBase64, "base64") : req.body;
    const r = http.request(
      {
        socketPath,
        path: u.pathname + u.search,
        method: req.method ?? "GET",
        headers: { Host: "lantern-hub", ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}), ...req.headers },
      },
      (res) => {
        const headers = lowerHeaders(res.headers);
        h?.onResponse?.(res.statusCode ?? 0, headers);
        res.setEncoding("utf8");
        let text = "";
        res.on("data", (chunk: string) => (h ? h.onChunk(chunk) : (text += chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers, body: text }));
        res.on("error", reject);
      },
    );
    if (req.timeoutMs) r.setTimeout(req.timeoutMs, () => r.destroy(new Error(`timed out after ${req.timeoutMs} ms`)));
    h?.signal?.addEventListener("abort", () => r.destroy(abortError()), { once: true });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

async function fetchRequest(req: HttpReq): Promise<HttpRes> {
  const res = await fetch(req.url, {
    method: req.method ?? "GET",
    headers: req.headers,
    body: req.bodyBase64 ? Buffer.from(req.bodyBase64, "base64") : req.body,
    signal: req.timeoutMs ? AbortSignal.timeout(req.timeoutMs) : undefined,
  });
  return { status: res.status, headers: lowerHeaders(res.headers), body: await res.text() };
}

async function fetchStream(req: HttpReq, h: StreamHandlers): Promise<number> {
  const res = await fetch(req.url, { method: req.method ?? "GET", headers: req.headers, body: req.body, signal: h.signal });
  h.onResponse?.(res.status, lowerHeaders(res.headers));
  if (!res.body) return res.status;
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) h.onChunk(decoder.decode(chunk, { stream: true }));
  const tail = decoder.decode();
  if (tail) h.onChunk(tail);
  return res.status;
}

export interface BackendOptions {
  dataDir: string;
  info: PlatformInfo;
  /** The hub's Unix socket; requests to `hubOrigin` go there. */
  hubSocket?: string;
  hubOrigin: string;
  notify: (title: string, body: string) => Promise<void>;
}

export function createBackend(o: BackendOptions): Backend & { flush(): void } {
  const files = new FileDb(join(o.dataDir, "db"));
  const secretStore = new FileSecrets(join(o.dataDir, "secrets.json"));
  const toHub = (url: string) => !!o.hubSocket && url.startsWith(o.hubOrigin);
  return {
    info: o.info,
    db: files,
    secrets: secretStore,
    httpRequest: (req) => (toHub(req.url) ? socketRequest(o.hubSocket!, req) : fetchRequest(req)),
    httpStream: async (req, h) => (toHub(req.url) ? (await socketRequest(o.hubSocket!, req, h)).status : fetchStream(req, h)),
    notify: o.notify,
    flush: () => files.flush(),
  };
}
