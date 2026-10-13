// Starts "when an email arrives" routines: every two minutes the runner looks
// for new mail in each such routine's bot inbox and queues a trigger event for
// each new message. Mail already there when the routine was made never counts.

import { hubMail } from "../lib/hub";
import { emailSecretKey, mailAccount } from "../lib/mail";
import { db, secrets } from "../lib/platform";
import { C, saveRoutine, useApp } from "../lib/store";
import type { Routine, TriggerEvent } from "../lib/types";
import { uid } from "../lib/util";

// LANTERN_MAIL_CHECK_MS shortens the wait for tests.
const EVERY_MS = Number(process.env.LANTERN_MAIL_CHECK_MS) || 2 * 60_000;
/** At most this many new emails start runs per check; the rest wait for the next one. */
const PER_CHECK = 5;

let checking = false;

async function check(routine: Routine) {
  const bot = useApp.getState().bots.find((b) => b.id === routine.botId);
  if (!bot?.email || !(await secrets.get(emailSecretKey(bot.id)))) return;
  const account = await mailAccount(bot);
  const trigger = routine.trigger?.kind === "email" ? routine.trigger : { kind: "email" as const };
  if (trigger.lastUid === undefined) {
    // First look: remember where the inbox is now, so only new mail starts runs.
    const r = await hubMail.list(account, { limit: 1 });
    await saveRoutine({ ...routine, trigger: { kind: "email", lastUid: Math.max(0, (r.uidNext ?? 1) - 1, r.messages[0]?.uid ?? 0) } });
    return;
  }
  const r = await hubMail.list(account, { sinceUid: trigger.lastUid, limit: PER_CHECK });
  const fresh = r.messages.filter((m) => m.uid > trigger.lastUid!).sort((a, b) => a.uid - b.uid);
  let last = trigger.lastUid;
  for (const m of fresh) {
    const full = await hubMail.read(account, m.uid);
    const event: TriggerEvent = {
      id: uid("evt"),
      routineId: routine.id,
      source: "email",
      receivedAt: Date.now(),
      email: { uid: m.uid, from: full.from, subject: full.subject, date: full.date, text: full.text },
    };
    await db.put(C.events, event.id, event);
    last = m.uid;
  }
  if (last !== trigger.lastUid) {
    const latest = useApp.getState().routines.find((x) => x.id === routine.id) ?? routine;
    await saveRoutine({ ...latest, trigger: { kind: "email", lastUid: last } });
  }
}

async function checkAll() {
  if (checking) return;
  checking = true;
  try {
    for (const r of useApp.getState().routines) {
      if (!r.enabled || r.trigger?.kind !== "email") continue;
      await check(r).catch((e) => console.warn(`mail check for routine ${r.name} failed:`, (e as Error).message));
    }
  } finally {
    checking = false;
  }
}

export function startMailWatch() {
  setTimeout(() => void checkAll(), Math.min(10_000, EVERY_MS));
  setInterval(() => void checkAll(), EVERY_MS);
}
