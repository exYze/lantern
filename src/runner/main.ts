// Lantern runner: runs bots on the hub so they keep working with every app
// closed. It's a headless Lantern device of its hub: it syncs the shared
// environment like any app, runs chats devices hand it, runs routines and
// webhook/email triggers, and streams its work back to whoever is watching.
//
//   LANTERN_RUNNER_DATA     data folder (default ./runner-data)
//   LANTERN_HUB_SOCKET      the hub's API socket (production), or
//   LANTERN_HUB_URL         the hub's URL (development, e.g. http://127.0.0.1:8780)
//   LANTERN_RUNNER_TOKEN    device token from `lantern-hub runner-token`
//                           (or LANTERN_RUNNER_TOKEN_FILE, default <data>/token)

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { stopRun } from "../lib/agent";
import { agentListeners } from "../lib/events";
import { hubApi, saveHubConnection, type HubConnection } from "../lib/hub";
import { db, initPlatform, secrets, setBackend } from "../lib/platform";
import { startScheduler } from "../lib/routines";
import { C, loadAll, loadMessages, patchMessage, useApp } from "../lib/store";
import { startSync } from "../lib/sync";
import type { RunDoc } from "../lib/types";
import { createBackend } from "./backend";
import { startLiveRelay } from "./live";
import { startMailWatch } from "./mail-watch";
import { startPush } from "./push";
import { startRequests } from "./requests";
import { startTelegram } from "./telegram";

declare const __LANTERN_VERSION__: string;
const VERSION = typeof __LANTERN_VERSION__ === "string" ? __LANTERN_VERSION__ : "dev";

const env = process.env;
const dataDir = env.LANTERN_RUNNER_DATA || "./runner-data";
const hubSocket = env.LANTERN_HUB_SOCKET || undefined;
const hubOrigin = hubSocket ? "http://lantern-hub.socket" : (env.LANTERN_HUB_URL || "http://127.0.0.1:8780").replace(/\/+$/, "");

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

function readToken(): string {
  if (env.LANTERN_RUNNER_TOKEN) return env.LANTERN_RUNNER_TOKEN.trim();
  const file = env.LANTERN_RUNNER_TOKEN_FILE || join(dataDir, "token");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`No runner token: set LANTERN_RUNNER_TOKEN or put one in ${file} (create it with \`lantern-hub runner-token\`).`);
  }
}

const backend = createBackend({
  dataDir,
  hubSocket,
  hubOrigin,
  info: { os: "hub", arch: process.arch, mobile: false, version: VERSION, shell: null, secretBackend: "runner-file", hostname: hostname() },
  notify: async (title, body) => {
    await hubApi("/api/v1/notify", { body: { title, body }, timeoutMs: 10000 }).catch((e) => log("notify failed:", (e as Error).message));
  },
});

/** Routine times are wall-clock times in the user's zone, not the server's. */
function applyTimezone() {
  const tz = useApp.getState().settings.timezone;
  if (tz && process.env.TZ !== tz) {
    process.env.TZ = tz;
    log(`time zone: ${tz}`);
  }
}

/** Clears runs left over from before a restart: they can't continue, so they're marked interrupted. */
async function settleLeftovers() {
  for (const run of await db.list<RunDoc>(C.runs)) {
    const list = await loadMessages(run.conversationId);
    for (const m of list) {
      const stuck = m.status === "streaming" || m.toolCalls?.some((c) => ["pending", "awaiting-approval", "reviewing", "running"].includes(c.status));
      if (!stuck) continue;
      patchMessage(
        run.conversationId,
        m.id,
        {
          status: m.status === "streaming" ? "stopped" : m.status,
          toolCalls: m.toolCalls?.map((c) => (["pending", "awaiting-approval", "reviewing", "running"].includes(c.status) ? { ...c, status: "error" as const, result: c.result ?? "Interrupted: the hub restarted." } : c)),
        },
        true,
      );
    }
    await db.delete(C.runs, run.id);
  }
}

async function heartbeat() {
  try {
    await hubApi("/api/v1/runner", { body: { version: VERSION, busy: Object.keys(useApp.getState().running) }, timeoutMs: 10000 });
  } catch (e) {
    log("heartbeat failed:", (e as Error).message);
  }
}

async function main() {
  setBackend(backend);
  await initPlatform();
  await secrets.set("hub:token", readToken(), true);

  // The runner is a device of its hub; find out which one.
  const probe: HubConnection = { url: hubOrigin, hubId: "", name: "", deviceId: "", cursor: 0, merged: true };
  useApp.setState({ hub: probe });
  const [me, info] = await Promise.all([hubApi<{ id: string }>("/api/v1/me"), hubApi<{ hubId: string; name: string }>("/api/v1/info")]);
  const saved = await db.get<HubConnection>("local", "hub");
  const conn = saved && saved.deviceId === me.id && saved.hubId === info.hubId ? { ...saved, url: hubOrigin } : { ...probe, hubId: info.hubId, name: info.name, deviceId: me.id };
  await saveHubConnection(conn);
  log(`Lantern runner ${VERSION} for ${info.name} (device ${me.id})`);

  await loadAll();
  await startSync();
  applyTimezone();
  useApp.subscribe((s, prev) => s.settings !== prev.settings && applyTimezone());
  await settleLeftovers();

  // Devices see which chats are running here through these records.
  agentListeners.add((e) => {
    if (e.type === "run-start") {
      const doc: RunDoc = { id: e.conversationId, conversationId: e.conversationId, botId: e.botId, startedAt: Date.now() };
      void db.put(C.runs, doc.id, doc);
      log(`run started: ${e.conversationId}`);
    } else if (e.type === "run-end") {
      void db.delete(C.runs, e.conversationId);
      log(`run ${e.outcome}: ${e.conversationId}`);
    }
  });

  startLiveRelay();
  startRequests();
  startScheduler();
  startPush();
  startMailWatch();
  startTelegram();
  void heartbeat();
  setInterval(() => void heartbeat(), 30_000);
  log("ready");
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping`);
  for (const id of Object.keys(useApp.getState().running)) stopRun(id);
  // Give stopped runs a moment to store their final state and sync it.
  await new Promise((r) => setTimeout(r, 1500));
  backend.flush();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log("unhandled rejection:", e));

main().catch((e) => {
  console.error("Lantern runner failed to start:", e);
  backend.flush();
  process.exit(1);
});
