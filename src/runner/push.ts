// Phone notifications through ntfy (https://ntfy.sh, or a server you run): the
// ntfy app on a phone gets them even when Lantern is closed. Sent when a bot
// needs approval, when a routine finishes, and when a long task finishes.

import { isNothingNew } from "../lib/agent";
import { agentListeners } from "../lib/events";
import { httpRequest, secrets } from "../lib/platform";
import { messagesOf, useApp } from "../lib/store";

/** A chat reply this slow probably means you stepped away, so it earns a push. */
const LONG_RUN_MS = 60_000;

export async function sendPush(title: string, message: string, priority: 3 | 4 = 3): Promise<void> {
  const push = useApp.getState().settings.push;
  if (!push?.server || !push.topic) return;
  const token = await secrets.get("push:ntfy");
  const res = await httpRequest({
    method: "POST",
    url: push.server.replace(/\/+$/, ""),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ topic: push.topic, title, message: push.hideText ? "Open Lantern to see it." : message.slice(0, 1000) || "(no text)", priority, tags: ["lantern"] }),
    timeoutMs: 15000,
  });
  if (res.status >= 400) throw new Error(`ntfy answered ${res.status}: ${res.body.slice(0, 200)}`);
}

export function startPush() {
  agentListeners.add((e) => {
    const s = useApp.getState();
    const bot = s.bots.find((b) => b.id === e.botId);
    const conv = s.conversations.find((c) => c.id === e.conversationId);
    // Telegram chats answer in Telegram; requests between bots report to the bot that asked.
    if (!bot || conv?.channel || conv?.from) return;
    if (e.type === "approval") {
      void sendPush(`${bot.name} needs your approval`, e.summary, 4).catch((err) => console.warn("push failed:", err));
      return;
    }
    if (e.type !== "run-end" || e.outcome === "stopped") return;
    if (!e.routineId && Date.now() - e.startedAt < LONG_RUN_MS) return;
    const last = [...messagesOf(e.conversationId)].reverse().find((m) => m.role === "assistant");
    const routine = e.routineId ? s.routines.find((r) => r.id === e.routineId) : undefined;
    if (routine?.quiet && !last?.error && isNothingNew(last?.content ?? "")) return;
    const text = last?.error ? `Error: ${last.error}` : (last?.content ?? "Finished");
    void sendPush(routine ? `${bot.name} · ${routine.name}` : bot.name, text).catch((err) => console.warn("push failed:", err));
  });
}
