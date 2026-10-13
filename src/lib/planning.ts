// Plans, goals and summaries of long chats, kept on the conversation so every
// device (and the hub's runner) sees them.
//
// - A plan is a short checklist the bot keeps up to date while it works.
// - A goal keeps the bot going: when it stops talking with the goal unfinished,
//   it's nudged to continue, a few times at most, until it calls finish_goal.
// - When a chat outgrows the context budget, its older part is summarized once
//   instead of being dropped, so the bot keeps what mattered.

import { complete, type OAMessage } from "./llm";
import { updateConversation, useApp } from "./store";
import type { ToolContext, ToolDef } from "./tools";
import type { ChatMessage, Conversation, PlanItem, Provider } from "./types";
import { clip } from "./util";

/** How many times one run nudges the bot toward an unfinished goal. */
export const MAX_GOAL_NUDGES = 6;

const conv = (id: string) => useApp.getState().conversations.find((c) => c.id === id);

const STATUSES = new Set<PlanItem["status"]>(["todo", "doing", "done", "skipped"]);

export const PLANNING_TOOLS: ToolDef[] = [
  {
    name: "update_plan",
    group: "planning",
    risk: "internal",
    description:
      "Write or update your plan for this task: a short checklist the user sees above the chat. Send the whole list each time, marking items doing, done or skipped as you go. Use it for work with several steps.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "done", "skipped"] } },
            required: ["text", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    summarize: () => "Update the plan",
    async run(a, ctx) {
      const items: PlanItem[] = (Array.isArray(a.items) ? a.items : [])
        .slice(0, 30)
        .map((it: any) => ({ text: String(it?.text ?? "").slice(0, 200), status: STATUSES.has(it?.status) ? it.status : "todo" }))
        .filter((it) => it.text.trim());
      await updateConversation(ctx.conversationId, { plan: { items, updatedAt: Date.now() } });
      const done = items.filter((i) => i.status === "done").length;
      return `Plan saved: ${done} of ${items.length} done.`;
    },
  },
  {
    name: "set_goal",
    group: "planning",
    risk: "internal",
    description:
      "Set a goal for this chat when the user wants something seen through. You'll keep working until you call finish_goal (with done, or blocked if you need the user). Make a plan with update_plan too.",
    parameters: { type: "object", properties: { objective: { type: "string", description: "What done looks like, in one sentence" } }, required: ["objective"], additionalProperties: false },
    summarize: (a) => `Goal: ${typeof a.objective === "string" ? a.objective : ""}`,
    async run(a, ctx) {
      const objective = String(a.objective ?? "").trim().slice(0, 300);
      if (!objective) throw new Error("objective is required");
      await updateConversation(ctx.conversationId, { goal: { objective, status: "active", setAt: Date.now() } });
      return `Goal set: ${objective}. Keep working until it's done, then call finish_goal.`;
    },
  },
  {
    name: "finish_goal",
    group: "planning",
    risk: "internal",
    description: "End this chat's goal: done when it's achieved, or blocked when you can't go on without the user (say what you need in the note).",
    parameters: {
      type: "object",
      properties: { status: { type: "string", enum: ["done", "blocked"] }, note: { type: "string" } },
      required: ["status"],
      additionalProperties: false,
    },
    summarize: (a) => (a.status === "blocked" ? "Stop: blocked on the goal" : "Goal done"),
    async run(a, ctx: ToolContext) {
      const goal = conv(ctx.conversationId)?.goal;
      if (!goal) return "There's no goal set.";
      const status = a.status === "blocked" ? "blocked" : "done";
      await updateConversation(ctx.conversationId, { goal: { ...goal, status, note: typeof a.note === "string" ? a.note.slice(0, 500) : undefined } });
      return status === "done" ? "Goal marked done. Tell the user what you achieved." : "Goal paused. Tell the user what you need from them.";
    },
  },
];

/** The plan and goal, for the system prompt. */
export function planLines(c: Conversation | undefined): string[] {
  const lines: string[] = [];
  if (c?.goal?.status === "active") lines.push("", "# Goal", `The user wants this seen through: ${c.goal.objective}`, "Keep going until it's done, then call finish_goal.");
  if (c?.plan?.items.length) {
    lines.push("", "# Your plan");
    for (const it of c.plan.items) lines.push(`- [${it.status === "done" ? "x" : it.status === "doing" ? "~" : it.status === "skipped" ? "-" : " "}] ${it.text}`);
  }
  if (c?.summary) lines.push("", "# Earlier in this chat", "The older part of this chat was summarized to save space:", c.summary.text);
  return lines;
}

/** The nudge that keeps a bot going toward an unfinished goal. */
export function goalNudge(c: Conversation): string {
  const open = c.plan?.items.filter((i) => i.status === "todo" || i.status === "doing").map((i) => i.text) ?? [];
  return [
    `Keep going toward the goal: ${c.goal!.objective}`,
    open.length ? `Still open in your plan: ${open.join("; ")}.` : "",
    "When it's done, call finish_goal with status done. If you can't continue without the user, call finish_goal with status blocked and say what you need.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ------------------------------------------------------------------ long chats

const SUMMARY_PROMPT = `You keep the running summary of a long chat between a user and an AI assistant that uses tools.
Write a summary that lets the assistant carry on without the old messages: what the user wants and prefers, decisions made, facts learned, files and paths touched, commands run and how they went, and what's still open.
Merge the earlier summary (if any) with the new messages. Be concrete and brief: short bullet points, at most 400 words. Write only the summary.`;

const estimate = (s: string | null | undefined) => Math.ceil((s ?? "").length / 3.5);

export function messageCost(m: ChatMessage): number {
  let n = 4 + estimate(m.content);
  for (const a of m.attachments ?? []) n += a.kind === "text" ? estimate(a.data) : 800;
  for (const c of m.toolCalls ?? []) n += estimate(c.arguments) + estimate(c.result) + 10;
  return n;
}

export function transcript(messages: ChatMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "tool") continue;
    if (m.role === "user") {
      const files = m.attachments?.length ? ` [attached: ${m.attachments.map((a) => a.name).join(", ")}]` : "";
      out.push(`User: ${m.content}${files}`);
    } else {
      if (m.content.trim()) out.push(`Assistant: ${m.content}`);
      for (const c of m.toolCalls ?? []) out.push(`[tool ${c.name} ${clip(c.arguments, 300)} → ${clip(c.result ?? c.status, 400)}]`);
    }
  }
  return out.join("\n");
}

/** Messages the bot still sees in full: the ones after the summary. */
export function afterSummary(messages: ChatMessage[], c: Conversation | undefined): ChatMessage[] {
  const through = c?.summary?.through;
  if (!through) return messages;
  const i = messages.findIndex((m) => m.id === through);
  return i === -1 ? messages : messages.slice(i + 1);
}

/**
 * When the unsummarized part of a chat no longer fits the budget, summarizes its
 * older messages (keeping roughly the newest 60% of the budget word for word).
 * Fails quietly: the chat then falls back to leaving out the oldest messages.
 */
export async function summarizeIfLong(conversationId: string, messages: ChatMessage[], budgetTokens: number, provider: Provider, model: string, signal?: AbortSignal): Promise<void> {
  const c = conv(conversationId);
  const recent = afterSummary(messages, c);
  const total = recent.reduce((n, m) => n + messageCost(m), 0);
  if (total <= budgetTokens) return;
  let kept = 0;
  let cut = recent.length;
  for (let i = recent.length - 1; i >= 0; i--) {
    kept += messageCost(recent[i]);
    if (kept > budgetTokens * 0.6) break;
    cut = i;
  }
  // Cut just before a message from the user, so a tool call is never split from its result.
  while (cut < recent.length && recent[cut].role !== "user") cut++;
  if (cut <= 0 || cut >= recent.length) return;
  const old = recent.slice(0, cut);
  const prompt: OAMessage[] = [
    { role: "system", content: SUMMARY_PROMPT },
    { role: "user", content: `${c?.summary ? `Earlier summary:\n${c.summary.text}\n\n` : ""}New messages:\n${clip(transcript(old), 80_000)}` },
  ];
  try {
    const text = await complete(provider, model, prompt, { maxTokens: 1500, signal });
    if (text.trim()) await updateConversation(conversationId, { summary: { text: text.trim(), through: old[old.length - 1].id, at: Date.now() } });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    console.warn("couldn't summarize the chat:", e);
  }
}
