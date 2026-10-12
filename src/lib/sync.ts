// Keeps this device's data in step with the Lantern Hub so every device shares
// one environment: bots, chats, memories, skills, routines, plugins, model
// servers, settings and secrets.
//
// Local-first: the app keeps reading and writing its own database. Each local
// write is queued in a persistent outbox and pushed to the hub; changes from
// other devices arrive over a live event stream (with a periodic pull as a
// fallback) and are applied without being echoed back. The last write wins.

import { forgetHub, hubApi, HubError, hubToken, loadHubConnection, saveHubConnection, type HubConnection } from "./hub";
import { changeListeners, db, httpStream, secrets } from "./platform";
import { SseParser } from "./sse";
import { C, refreshFromDb, useApp } from "./store";
import { DEVICE_SETTINGS, type Bot, type McpServer, type Provider, type Settings } from "./types";

const LIST_COLLECTIONS = [C.providers, C.bots, C.conversations, C.skills, C.memories, C.mcp, C.routines];
const SECRET = "secret";
const OUTBOX = "sync:outbox";
const SEP = "\u001f";
const MAX_BATCH_BYTES = 4_000_000;

export type SyncStatus = "off" | "connecting" | "online" | "offline" | "error";

export interface SyncState {
  status: SyncStatus;
  lastSyncAt?: number;
  error?: string;
  pending: number;
}

interface Change {
  c: string;
  id: string;
  d?: unknown;
  del?: boolean;
}

export function isSyncedDoc(collection: string, id: string): boolean {
  return LIST_COLLECTIONS.includes(collection) || collection.startsWith("msg:") || (collection === C.meta && id === "settings");
}

/** The hub token and other per-device keys never leave the device. */
export function isSyncedSecret(key: string): boolean {
  return !key.startsWith("hub:");
}

/** Strips device-only fields before settings leave this device. */
export function settingsForHub(settings: Partial<Settings>): Partial<Settings> {
  const out: Record<string, unknown> = { ...settings };
  for (const k of DEVICE_SETTINGS) delete out[k];
  return out as Partial<Settings>;
}

/** Applies synced settings while keeping this device's own fields. */
export function settingsFromHub(remote: Partial<Settings>, local: Partial<Settings>): Partial<Settings> {
  const out: Record<string, unknown> = { ...settingsForHub(remote) };
  for (const k of DEVICE_SETTINGS) if (local[k] !== undefined) out[k] = local[k];
  // Settings from the hub mean this environment is already set up.
  out.onboarded = true;
  return out as Partial<Settings>;
}

/** Every secret key the app's data refers to (secrets can't be listed from OS keychains). */
export function knownSecretKeys(providers: Provider[], bots: Bot[], mcp: McpServer[]): string[] {
  const keys: string[] = [];
  for (const p of providers) if (p.hasKey) keys.push(`provider:${p.id}`);
  for (const b of bots) for (const n of b.secretNames ?? []) keys.push(`bot:${b.id}:${n}`);
  for (const s of mcp) {
    for (const k of s.envKeys ?? []) keys.push(`mcp:${s.id}:env:${k}`);
    for (const k of s.headerKeys ?? []) keys.push(`mcp:${s.id}:header:${k}`);
  }
  return keys;
}

// ------------------------------------------------------------------ engine

let conn: HubConnection | null = null;
let outbox = new Map<string, { c: string; id: string; v: number }>();
let version = 0;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pullTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stream: AbortController | null = null;
let backoff = 2000;
let pushing = false;
let pulling = false;
let pullAgain = false;
let started = false;
/** Bumped whenever sync stops, so work started for an old connection doesn't touch the new state. */
let generation = 0;

const keyOf = (c: string, id: string) => `${c}${SEP}${id}`;

function setSync(patch: Partial<SyncState>) {
  useApp.setState((s) => ({ sync: { ...s.sync, ...patch, pending: outbox.size } }));
}

function enqueue(c: string, id: string) {
  const k = keyOf(c, id);
  outbox.set(k, { c, id, v: ++version });
  void db.put(OUTBOX, k, { c, id }, true);
  setSync({});
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void push().catch(handleError), 400);
}

function onDocChange(collection: string, id: string) {
  if (conn && isSyncedDoc(collection, id)) enqueue(collection, id);
}

function onSecretChange(key: string) {
  if (conn && isSyncedSecret(key)) enqueue(SECRET, key);
}

/** Starts syncing if this device is connected to a hub. Safe to call again after pairing. */
export async function startSync(): Promise<void> {
  if (conn) stopSync();
  const loaded = await loadHubConnection();
  useApp.setState({ hub: loaded });
  if (!loaded) {
    setSync({ status: "off", error: undefined });
    return;
  }
  conn = loaded.merged ? loaded : { ...loaded, cursor: 0 };
  outbox = new Map();
  for (const e of await db.list<{ c: string; id: string }>(OUTBOX)) outbox.set(keyOf(e.c, e.id), { ...e, v: ++version });
  changeListeners.doc = onDocChange;
  changeListeners.secret = onSecretChange;
  if (!started) {
    started = true;
    window.addEventListener("online", () => pullSoon(0));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pullSoon(0);
    });
  }
  pollTimer ??= setInterval(() => pullSoon(0), 60_000);
  setSync({ status: "connecting", error: undefined });
  await syncNow();
  openStream();
}

/** Stops syncing (e.g. after disconnecting). Local data is kept. */
export function stopSync() {
  generation++;
  changeListeners.doc = null;
  changeListeners.secret = null;
  stream?.abort();
  stream = null;
  for (const t of [pushTimer, pullTimer, reconnectTimer]) if (t) clearTimeout(t);
  if (pollTimer) clearInterval(pollTimer);
  pushTimer = pullTimer = reconnectTimer = pollTimer = null;
  conn = null;
  outbox = new Map();
  setSync({ status: "off", error: undefined, lastSyncAt: undefined });
}

export async function disconnectHub(): Promise<void> {
  stopSync();
  await db.clear(OUTBOX, true);
  await forgetHub();
}

/** Pulls everything new, then pushes local changes. */
export async function syncNow(): Promise<void> {
  if (!conn) return;
  try {
    await pull();
    await push();
    if (conn) setSync({ status: "online", error: undefined, lastSyncAt: Date.now() });
  } catch (e) {
    handleError(e);
  }
}

function handleError(e: unknown) {
  if (!conn) return;
  if (e instanceof HubError && e.status === 401) {
    // This device was removed from the hub, or its key is gone: stop and say so.
    stopSync();
    setSync({ status: "error", error: e.message });
    return;
  }
  setSync({ status: "offline", error: (e as Error)?.message ?? String(e) });
}

function pullSoon(delay = 250) {
  if (!conn) return;
  if (pullTimer) clearTimeout(pullTimer);
  pullTimer = setTimeout(() => void syncNow(), delay);
}

async function saveConn() {
  // Keep fields other modules cache on the connection (e.g. the hub's tool info).
  if (conn) await saveHubConnection({ ...useApp.getState().hub, ...conn });
}

async function pull(): Promise<void> {
  if (pulling) {
    pullAgain = true;
    return;
  }
  pulling = true;
  const gen = generation;
  try {
    do {
      pullAgain = false;
      const remoteKeys = new Set<string>();
      for (;;) {
        if (!conn) return;
        const page = await hubApi<{ changes: (Change & { rev: number })[]; cursor: number; more: boolean; hubId: string }>(
          `/api/v1/changes?since=${conn.cursor}&limit=500`,
          { timeoutMs: 60000 },
        );
        if (gen !== generation || !conn) return;
        if (page.hubId !== conn.hubId) {
          // The hub was reset or replaced: merge everything again.
          conn = { ...conn, hubId: page.hubId, cursor: 0, merged: false };
          await saveConn();
          remoteKeys.clear();
          continue;
        }
        if (!conn.merged) for (const ch of page.changes) remoteKeys.add(keyOf(ch.c, ch.id));
        await applyRemote(page.changes);
        if (gen !== generation || !conn) return;
        conn = { ...conn, cursor: page.cursor };
        if (!page.more) break;
        await saveConn();
      }
      if (conn && !conn.merged) await finishFirstSync(remoteKeys);
      await saveConn();
    } while (pullAgain);
  } finally {
    pulling = false;
  }
}

async function applyRemote(changes: Change[]): Promise<void> {
  const touched = new Set<string>();
  for (const ch of changes) {
    // A local edit that hasn't been pushed yet wins; it will overwrite the hub copy.
    if (outbox.has(keyOf(ch.c, ch.id))) continue;
    if (ch.c === SECRET) {
      if (!isSyncedSecret(ch.id)) continue;
      const value = (ch.d as { v?: string } | undefined)?.v;
      if (ch.del || typeof value !== "string") await secrets.delete(ch.id, true);
      else await secrets.set(ch.id, value, true);
      continue;
    }
    if (!isSyncedDoc(ch.c, ch.id)) continue;
    if (ch.del || ch.d == null) {
      await db.delete(ch.c, ch.id, true);
    } else if (ch.c === C.meta) {
      await db.put(ch.c, ch.id, settingsFromHub(ch.d as Partial<Settings>, useApp.getState().settings), true);
    } else {
      await db.put(ch.c, ch.id, ch.d, true);
    }
    touched.add(ch.c);
  }
  if (touched.size) await refreshFromDb(touched);
}

/** First sync with a hub: push everything this device has that the hub doesn't. */
async function finishFirstSync(remoteKeys: Set<string>) {
  const add = (c: string, id: string) => {
    if (!remoteKeys.has(keyOf(c, id))) enqueue(c, id);
  };
  for (const c of LIST_COLLECTIONS) {
    for (const doc of await db.list<{ id?: string }>(c)) if (doc?.id) add(c, doc.id);
  }
  for (const conv of await db.list<{ id: string }>(C.conversations)) {
    for (const m of await db.list<{ id?: string }>(C.messages(conv.id))) if (m?.id) add(C.messages(conv.id), m.id);
  }
  if (await db.get(C.meta, "settings")) add(C.meta, "settings");
  const [providers, bots, mcp] = await Promise.all([db.list<Provider>(C.providers), db.list<Bot>(C.bots), db.list<McpServer>(C.mcp)]);
  for (const k of knownSecretKeys(providers, bots, mcp)) if (await secrets.get(k)) add(SECRET, k);
  if (conn) conn = { ...conn, merged: true };
}

async function readLocal(c: string, id: string): Promise<Change> {
  if (c === SECRET) {
    const v = await secrets.get(id);
    return v == null ? { c, id, del: true } : { c, id, d: { v } };
  }
  const data = await db.get<unknown>(c, id);
  if (data == null) return { c, id, del: true };
  return { c, id, d: c === C.meta ? settingsForHub(data as Settings) : data };
}

async function push(): Promise<void> {
  if (pushing || !conn) return;
  pushing = true;
  const gen = generation;
  try {
    while (conn && gen === generation && outbox.size) {
      const batch: Change[] = [];
      const sent = new Map<string, number>();
      let bytes = 0;
      for (const [k, e] of outbox) {
        const change = await readLocal(e.c, e.id);
        const size = change.d === undefined ? 64 : JSON.stringify(change.d).length;
        if (batch.length && (bytes + size > MAX_BATCH_BYTES || batch.length >= 500)) break;
        batch.push(change);
        sent.set(k, e.v);
        bytes += size;
      }
      await hubApi("/api/v1/push", { body: { changes: batch }, timeoutMs: 120000 });
      if (gen !== generation) return;
      for (const [k, v] of sent) {
        // Changed again while we were sending? Keep it queued for the next round.
        if (outbox.get(k)?.v === v) {
          outbox.delete(k);
          await db.delete(OUTBOX, k, true);
        }
      }
      setSync({ lastSyncAt: Date.now() });
    }
  } finally {
    pushing = false;
  }
}

// ------------------------------------------------------------------ live updates

function openStream() {
  if (!conn) return;
  stream?.abort();
  const ctrl = new AbortController();
  stream = ctrl;
  const url = `${conn.url}/api/v1/events`;
  void (async () => {
    const token = await hubToken();
    if (!token || ctrl.signal.aborted) return;
    const parser = new SseParser();
    let status = 0;
    try {
      await httpStream(
        { url, headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } },
        {
          signal: ctrl.signal,
          onResponse: (s) => {
            status = s;
            if (s === 200) {
              backoff = 2000;
              setSync({ status: "online", error: undefined });
            }
          },
          onChunk: (text) => parser.feed(text).forEach(handleEvent),
        },
      );
      if (status === 401) {
        handleError(new HubError("This device was removed from the hub. Connect it again in Settings → Hub.", 401));
        return;
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setSync({ status: "offline", error: (e as Error)?.message });
    }
    if (ctrl.signal.aborted || stream !== ctrl) return;
    // The stream ended (network change, hub restart): reconnect with backoff and catch up.
    reconnectTimer = setTimeout(() => {
      pullSoon(0);
      openStream();
    }, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  })();
}

/** `hello` (on connect) and `change` events both mean "there may be something to pull". */
function handleEvent(data: string) {
  try {
    // Skip the echo of this device's own push.
    if ((JSON.parse(data) as { device?: string }).device === conn?.deviceId) return;
  } catch {
    // Unknown payload: pulling is always safe.
  }
  pullSoon();
}
