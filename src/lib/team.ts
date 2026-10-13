// Bots working together: one bot asks another for help and waits for its answer,
// or hands it a whole task and hears back when it's done. The bot that's asked
// works in a chat of its own, with its own tools, memories and approvals, so the
// user can open that chat and follow along.

import { makeTitle, runAgent, stopRun } from "./agent";
import { notify } from "./platform";
import { appendMessage, createConversation, messagesOf, useApp } from "./store";
import type { ToolContext, ToolDef } from "./tools";
import type { Bot } from "./types";
import { uid } from "./util";

/** How many bots deep a request may go (A asks B asks C). */
const MAX_DEPTH = 3;

export function teamFor(bot: Bot): Bot[] {
  return useApp.getState().bots.filter((b) => b.id !== bot.id);
}

export const ASK_BOT_TOOL: ToolDef = {
  name: "ask_bot",
  group: "bots",
  risk: "internal",
  description:
    "Ask another of the user's bots (listed under Your team) for help. It works in its own chat with its own tools and memories, then answers you. Write to it like a colleague: the goal, what you already know, and what you need back. Set `wait` to false to hand off a whole task instead: it works on its own and its result is posted in this chat when it's done.",
  parameters: {
    type: "object",
    properties: {
      bot: { type: "string", description: "The other bot's name" },
      message: { type: "string", description: "What you need from it, with all the context it needs" },
      wait: { type: "boolean", description: "Wait for its answer (default true). false hands the task off." },
    },
    required: ["bot", "message"],
    additionalProperties: false,
  },
  summarize: (a) => `${a.wait === false ? "Hand off to" : "Ask"} ${typeof a.bot === "string" ? a.bot : "a bot"}`,
  run: (a, ctx) => askBot(a, ctx),
};

export function findTeammate(from: Bot, name: string): Bot | undefined {
  const n = name.trim().toLowerCase();
  const team = teamFor(from);
  return team.find((b) => b.name.toLowerCase() === n) ?? team.find((b) => b.name.toLowerCase().startsWith(n));
}

/** Refuses requests that would go in circles or too deep. */
export function checkChain(chain: string[], target: Bot): void {
  if (chain.includes(target.id)) {
    throw new Error(`${target.name} is already part of this request (it asked you, directly or through another bot), so asking it again would go in circles. Answer with what you have.`);
  }
  if (chain.length >= MAX_DEPTH) throw new Error("This request already went through several bots. Answer with what you have instead of asking another one.");
}

function lastAnswer(conversationId: string): { text: string; error?: string } {
  const last = [...messagesOf(conversationId)].reverse().find((m) => m.role === "assistant" && (m.content.trim() || m.error));
  return { text: last?.content.trim() ?? "", error: last?.error };
}

async function askBot(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const name = typeof args.bot === "string" ? args.bot : "";
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!name.trim() || !message) throw new Error("Both `bot` and `message` are required.");
  const target = findTeammate(ctx.bot, name);
  if (!target) throw new Error(`No bot named "${name}". Your team: ${teamFor(ctx.bot).map((b) => b.name).join(", ") || "nobody yet"}.`);
  const chain = ctx.chain ?? [ctx.bot.id];
  checkChain(chain, target);

  const conv = await createConversation(target.id, `From ${ctx.bot.name}: ${makeTitle(message)}`, undefined, { from: { botId: ctx.bot.id, conversationId: ctx.conversationId } });
  await appendMessage({ id: uid("msg"), conversationId: conv.id, role: "user", content: message, fromBotId: ctx.bot.id, createdAt: Date.now() });
  ctx.onProgress?.({ asked: { botId: target.id, conversationId: conv.id } }, true);

  if (args.wait === false) {
    const callerConv = ctx.conversationId;
    const caller = ctx.bot;
    void runAgent(conv.id, { chain, here: true }).then(async (outcome) => {
      const answer = lastAnswer(conv.id);
      const text = outcome === "ok" ? answer.text || "(It finished without a reply.)" : outcome === "stopped" ? "It was stopped before it finished." : `It ran into a problem: ${answer.error ?? "unknown error"}`;
      await appendMessage({ id: uid("msg"), conversationId: callerConv, role: "user", content: `**${target.name} finished the task you handed off:**\n\n${text}`, fromBotId: target.id, createdAt: Date.now() });
      if (useApp.getState().settings.notifications) void notify(`${target.name} finished a task for ${caller.name}`, text.slice(0, 160));
    });
    return `Handed off to ${target.name}. It's working in its own chat ("${conv.title}"), and its result will be posted here when it's done. Tell the user you've handed it off.`;
  }

  const onAbort = () => stopRun(conv.id);
  ctx.signal.addEventListener("abort", onAbort);
  try {
    const outcome = await runAgent(conv.id, { chain, here: true });
    const answer = lastAnswer(conv.id);
    if (outcome === "stopped") return `${target.name} was stopped before it answered.`;
    if (outcome === "error") throw new Error(`${target.name} couldn't finish: ${answer.error ?? "unknown error"}`);
    return `${target.name} answered:\n\n${answer.text || "(no reply)"}`;
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}
