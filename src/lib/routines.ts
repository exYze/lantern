// Runs routines (scheduled prompts) while the app is open. Runs missed by more
// than an hour while the app was closed are skipped rather than replayed. With a
// Lantern Hub, devices agree through a lease so each run happens only once.

import { sendUserMessage } from "./agent";
import { hubLease } from "./hub";
import { CATCH_UP_WINDOW_MS, nextRun } from "./schedule";
import { createConversation, saveRoutine, toast, useApp } from "./store";
import type { Routine } from "./types";

const active = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

export function startScheduler() {
  if (timer) return;
  const now = Date.now();
  for (const r of useApp.getState().routines) {
    if (!r.enabled) continue;
    if (!r.nextRunAt || r.nextRunAt < now - CATCH_UP_WINDOW_MS) {
      void saveRoutine({ ...r, nextRunAt: nextRun(r.schedule, now) });
    }
  }
  timer = setInterval(tick, 20_000);
  setTimeout(tick, 3_000);
}

function tick() {
  const now = Date.now();
  for (const r of useApp.getState().routines) {
    if (r.enabled && r.nextRunAt && r.nextRunAt <= now && !active.has(r.id)) void runRoutine(r);
  }
}

async function claimRun(routine: Routine): Promise<boolean> {
  try {
    return await hubLease(`routine:${routine.id}:${routine.nextRunAt ?? 0}`);
  } catch {
    // Hub unreachable: run here rather than miss the routine.
    return true;
  }
}

export function isRoutineActive(id: string): boolean {
  return active.has(id);
}

export async function runRoutine(routine: Routine, manual = false): Promise<void> {
  if (active.has(routine.id)) return;
  const state = useApp.getState();
  const bot = state.bots.find((b) => b.id === routine.botId);
  if (!bot) {
    await saveRoutine({ ...routine, enabled: false });
    return;
  }
  active.add(routine.id);
  try {
    // With a hub, every device sees the routine come due; only the first to claim the run does it.
    if (!manual && useApp.getState().hub && !(await claimRun(routine))) return;
    let convId = routine.conversationId && state.conversations.some((c) => c.id === routine.conversationId) ? routine.conversationId : undefined;
    if (!convId) convId = (await createConversation(bot.id, `Routine · ${routine.name}`, routine.id)).id;
    const now = Date.now();
    const isOnce = routine.schedule.kind === "once";
    const updated: Routine = {
      ...routine,
      conversationId: convId,
      lastRunAt: now,
      nextRunAt: manual ? routine.nextRunAt : nextRun(routine.schedule, now),
      enabled: isOnce && !manual ? false : routine.enabled,
    };
    await saveRoutine(updated);
    const outcome = await sendUserMessage(convId, `**Routine “${routine.name}”:** ${routine.prompt}`, [], { routineId: routine.id });
    const latest = useApp.getState().routines.find((r) => r.id === routine.id);
    if (latest) await saveRoutine({ ...latest, lastStatus: outcome === "error" ? "error" : "ok" });
  } catch (e) {
    toast(`Routine “${routine.name}” failed: ${(e as Error).message}`, "error");
  } finally {
    active.delete(routine.id);
  }
}
