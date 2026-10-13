// Runs routines: on a schedule, when their webhook is called, or when mail
// arrives. While the hub's runner is online it runs them all, so they happen
// with every app closed; otherwise open apps run scheduled ones, agreeing
// through a hub lease so each run happens only once. Scheduled runs missed by
// more than an hour are skipped rather than replayed.

import { sendUserMessage } from "./agent";
import { hubLease } from "./hub";
import { isRunner } from "./platform";
import { requestRoutine, runnerOnline } from "./remote";
import { CATCH_UP_WINDOW_MS, describeSchedule, nextRun } from "./schedule";
import { C, collectionWatchers, createConversation, saveRoutine, toast, useApp } from "./store";
import { db } from "./platform";
import type { Routine, TriggerEvent } from "./types";
import { routinePrompt } from "./webhook";

const active = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

export const triggerKind = (r: Routine) => r.trigger?.kind ?? "schedule";

export function describeRoutineTrigger(r: Routine): string {
  switch (triggerKind(r)) {
    case "webhook":
      return "When its webhook is called";
    case "email":
      return "When an email arrives";
    default:
      return describeSchedule(r.schedule);
  }
}

/** Whether this device should run routines itself (the hub's runner does when it's online). */
function runsRoutinesHere(): boolean {
  return isRunner() || !runnerOnline();
}

export function startScheduler() {
  if (timer) return;
  const now = Date.now();
  for (const r of useApp.getState().routines) {
    if (!r.enabled || triggerKind(r) !== "schedule") continue;
    if (!r.nextRunAt || r.nextRunAt < now - CATCH_UP_WINDOW_MS) {
      void saveRoutine({ ...r, nextRunAt: nextRun(r.schedule, now) });
    }
  }
  timer = setInterval(tick, 20_000);
  setTimeout(tick, 3_000);
  collectionWatchers.add((touched) => {
    if (touched.has(C.events)) void processEvents();
  });
}

function tick() {
  if (!runsRoutinesHere()) return;
  const now = Date.now();
  for (const r of useApp.getState().routines) {
    if (r.enabled && triggerKind(r) === "schedule" && r.nextRunAt && r.nextRunAt <= now && !active.has(r.id)) void runRoutine(r);
  }
  void processEvents();
}

async function claim(key: string): Promise<boolean> {
  if (!useApp.getState().hub) return true;
  try {
    return await hubLease(key);
  } catch {
    // Hub unreachable: run here rather than miss it.
    return true;
  }
}

let processing = false;

/** Starts routines for webhook calls and emails waiting in the `events` collection. */
export async function processEvents(): Promise<void> {
  if (processing || !runsRoutinesHere()) return;
  processing = true;
  try {
    for (const event of await db.list<TriggerEvent>(C.events)) {
      // One run at a time per routine: later events wait for the next pass.
      if (active.has(event.routineId)) continue;
      if (!(await claim(`event:${event.id}`)) || active.has(event.routineId)) continue;
      await db.delete(C.events, event.id);
      const routine = useApp.getState().routines.find((r) => r.id === event.routineId);
      if (routine?.enabled) void runRoutine(routine, false, event);
    }
  } finally {
    processing = false;
  }
}

export function isRoutineActive(id: string): boolean {
  return active.has(id);
}

export async function runRoutine(routine: Routine, manual = false, event?: TriggerEvent): Promise<void> {
  if (manual && !isRunner() && runnerOnline()) {
    await requestRoutine(routine.id);
    toast(`“${routine.name}” is starting on your hub.`, "info");
    return;
  }
  if (active.has(routine.id) && !event) return;
  const state = useApp.getState();
  const bot = state.bots.find((b) => b.id === routine.botId);
  if (!bot) {
    await saveRoutine({ ...routine, enabled: false });
    return;
  }
  active.add(routine.id);
  try {
    // With a hub, every device sees the routine come due; only the first to claim the run does it.
    if (!manual && !event && !(await claim(`routine:${routine.id}:${routine.nextRunAt ?? 0}`))) return;
    let convId = routine.conversationId && state.conversations.some((c) => c.id === routine.conversationId) ? routine.conversationId : undefined;
    if (!convId) convId = (await createConversation(bot.id, `Routine · ${routine.name}`, routine.id)).id;
    const now = Date.now();
    const scheduled = triggerKind(routine) === "schedule";
    const isOnce = scheduled && routine.schedule.kind === "once";
    const updated: Routine = {
      ...routine,
      conversationId: convId,
      lastRunAt: now,
      nextRunAt: manual || !scheduled ? routine.nextRunAt : nextRun(routine.schedule, now),
      enabled: isOnce && !manual ? false : routine.enabled,
    };
    await saveRoutine(updated);
    const via = event?.source;
    const outcome = await sendUserMessage(convId, routinePrompt(routine, event), [], { routineId: routine.id, via });
    const latest = useApp.getState().routines.find((r) => r.id === routine.id);
    if (latest) await saveRoutine({ ...latest, lastStatus: outcome === "error" ? "error" : "ok" });
  } catch (e) {
    toast(`Routine “${routine.name}” failed: ${(e as Error).message}`, "error");
  } finally {
    active.delete(routine.id);
  }
}
