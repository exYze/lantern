// Lifecycle events from bot runs, for code that reacts to them without being
// part of the run: the hub runner's live view, Telegram replies and phone pushes.

export type RunOutcome = "ok" | "error" | "stopped";

export type AgentEvent =
  | { type: "run-start"; conversationId: string; botId: string }
  | { type: "run-end"; conversationId: string; botId: string; outcome: RunOutcome; routineId?: string; startedAt: number }
  | { type: "approval"; conversationId: string; botId: string; callId: string; summary: string };

export const agentListeners = new Set<(e: AgentEvent) => void>();

export function emitAgentEvent(e: AgentEvent) {
  for (const listener of agentListeners) {
    try {
      listener(e);
    } catch (err) {
      console.error("agent event listener failed", err);
    }
  }
}
