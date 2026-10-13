// Handles what devices ask of the runner: run a chat, stop it, answer an
// approval, or start a routine now. Requests arrive as synced documents and
// are deleted once handled.

import { runAgent, stopRun } from "../lib/agent";
import { agentListeners } from "../lib/events";
import { db } from "../lib/platform";
import { answerForm } from "../lib/forms";
import { runRoutine } from "../lib/routines";
import { answerApproval, C, collectionWatchers, loadMessages, useApp } from "../lib/store";
import type { RunnerRequest } from "../lib/types";

/** Requests older than this were sent by a device that was offline for a long time; drop them. */
const MAX_AGE_MS = 24 * 3600_000;

const handled = new Set<string>();
/** Chats asked to run again while a run was already going. */
const again = new Set<string>();

/** Reads a chat fresh from storage, so messages devices added since are included. */
async function reload(conversationId: string) {
  useApp.setState((s) => {
    const { [conversationId]: _, ...messages } = s.messages;
    return { messages };
  });
  await loadMessages(conversationId);
}

export async function runChat(conversationId: string) {
  if (useApp.getState().running[conversationId]) {
    again.add(conversationId);
    return;
  }
  if (!useApp.getState().conversations.some((c) => c.id === conversationId)) return;
  await reload(conversationId);
  await runAgent(conversationId);
}

let busy = false;

async function processRequests() {
  if (busy) return;
  busy = true;
  try {
    for (const r of await db.list<RunnerRequest>(C.requests)) {
      if (handled.has(r.id)) continue;
      handled.add(r.id);
      await db.delete(C.requests, r.id);
      if (Date.now() - r.at > MAX_AGE_MS) continue;
      switch (r.kind) {
        case "run":
          if (r.conversationId) void runChat(r.conversationId);
          break;
        case "stop":
          if (r.conversationId) {
            again.delete(r.conversationId);
            stopRun(r.conversationId);
          }
          break;
        case "approve":
          if (r.toolCallId && r.answer) answerApproval(r.toolCallId, r.answer);
          break;
        case "answer":
          if (r.toolCallId) answerForm(r.toolCallId, r.answers ?? null);
          break;
        case "routine": {
          const routine = useApp.getState().routines.find((x) => x.id === r.routineId);
          if (routine) void runRoutine(routine, true);
          break;
        }
      }
    }
  } finally {
    busy = false;
  }
}

export function startRequests() {
  collectionWatchers.add((touched) => {
    if (touched.has(C.requests)) void processRequests();
  });
  agentListeners.add((e) => {
    if (e.type === "run-end" && again.delete(e.conversationId)) setTimeout(() => void runChat(e.conversationId), 50);
  });
  setInterval(() => void processRequests(), 15_000);
  void processRequests();
}
