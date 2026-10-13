// Streams replies the runner is writing to every device watching, as `live`
// events through the hub. Only stored messages sync; these fill the gap while
// a reply is still being written.

import { hubApi } from "../lib/hub";
import { useApp } from "../lib/store";
import type { ChatMessage, ToolCall } from "../lib/types";
import { clip } from "../lib/util";

const THROTTLE_MS = 150;
const RESULT_CHARS = 2000;

/** Tool output can be huge; devices get the full text once the message is stored. */
function slimCall(c: ToolCall): ToolCall {
  return {
    ...c,
    result: c.result === undefined ? undefined : clip(c.result, RESULT_CHARS),
    subagent: c.subagent && { ...c.subagent, steps: c.subagent.steps.map((s) => ({ ...s, content: clip(s.content, RESULT_CHARS), toolCalls: s.toolCalls?.map(slimCall) })) },
  };
}

export function slimMessage(m: ChatMessage): ChatMessage {
  return { ...m, attachments: undefined, toolCalls: m.toolCalls?.map(slimCall) };
}

export function startLiveRelay() {
  const pending = new Map<string, ChatMessage>();
  const inFlight = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const send = async (key: string) => {
    timers.delete(key);
    const msg = pending.get(key);
    if (!msg || inFlight.has(key)) return;
    pending.delete(key);
    inFlight.add(key);
    try {
      await hubApi("/api/v1/live", { body: { message: slimMessage(msg) }, timeoutMs: 10000 });
    } catch {
      // Live updates are best effort; the stored message arrives through sync anyway.
    } finally {
      inFlight.delete(key);
      if (pending.has(key)) schedule(key);
    }
  };
  const schedule = (key: string) => {
    if (!timers.has(key)) timers.set(key, setTimeout(() => void send(key), THROTTLE_MS));
  };

  useApp.subscribe((s, prev) => {
    if (s.messages === prev.messages) return;
    for (const convId of Object.keys(s.running)) {
      const now = s.messages[convId];
      const before = prev.messages[convId];
      if (!now || now === before) continue;
      const old = new Map((before ?? []).map((m) => [m.id, m]));
      for (const m of now) {
        if (m.role === "tool" || old.get(m.id) === m) continue;
        pending.set(m.id, m);
        schedule(m.id);
      }
    }
  });
}
