// Subagents: a bot hands a self-contained task to a helper that works on its own
// with the bot's tools and reports back. Several run in parallel. An isolated
// subagent gets its own empty folder; on the hub its commands run in a sandbox.

import { executeToolCall, nowLine, resolveModel, sandboxLine, toOATool, type CallEnv } from "./agent";
import { hubFs, hubToolInfo, type HubSandbox } from "./hub";
import { chatCompletion, LlmError, type OAMessage } from "./llm";
import { fs, platform } from "./platform";
import { useApp } from "./store";
import { platformLabel, skillsForBot, type ToolContext, type ToolDef } from "./tools";
import type { SubagentRun, SubagentStep, ToolCall } from "./types";
import { clip, uid } from "./util";

export const MAX_PARALLEL_SUBAGENTS = 3;
/** Tool results kept in the chat transcript of a subagent (the subagent itself sees them in full). */
const SHOWN_RESULT_CHARS = 4000;
/** What a subagent may not do: talk to the user's long-term state, schedule things, or start more subagents. */
const WITHHELD = new Set(["delegate_task", "remember", "forget", "create_skill", "create_routine", "list_routines", "delete_routine", "search_conversations"]);

export const DELEGATE_TOOL: ToolDef = {
  name: "delegate_task",
  group: "subagents",
  risk: "internal",
  description:
    "Hand a self-contained task to a subagent: a helper that works on its own with your tools (files, terminal, web…) and reports back. Use it for side tasks that take many steps, or for several independent tasks at once: call it several times in one turn and they run in parallel. The subagent can't see this conversation, so put everything it needs in `task`. Its actions still need the user's approval like yours. Set `isolated` to give it its own empty folder (sandboxed on the hub) instead of your workspace, e.g. for untrusted code or downloads; it gets no secrets then.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short name for the task, 2-6 words" },
      task: { type: "string", description: "Complete instructions: the goal, the context it needs, and what to report back" },
      isolated: { type: "boolean", description: "Work in a new empty folder (a sandbox on the hub) instead of your workspace" },
    },
    required: ["title", "task"],
    additionalProperties: false,
  },
  summarize: (a) => `Subagent: ${typeof a.title === "string" && a.title.trim() ? a.title.trim() : "task"}`,
  run: (a, ctx) => runSubagent(a, ctx),
};

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "task"
  );
}

/** The tools a subagent gets from its parent's. */
export function subagentTools(parent: ToolDef[], opts: { isolated: boolean; canRunCommands: boolean }): ToolDef[] {
  return parent.filter(
    (t) =>
      !WITHHELD.has(t.name) &&
      // Plugins run with the parent's folder and secrets, so they'd break isolation.
      !(opts.isolated && t.group === "mcp") &&
      !(t.group === "shell" && !opts.canRunCommands),
  );
}

export function subagentPrompt(opts: {
  botName: string;
  workspace: string;
  remoteOs?: string;
  shell?: string;
  tools: ToolDef[];
  isolated: boolean;
  sandbox?: HubSandbox;
  secretNames: string[];
  skills: { name: string; description: string }[];
}): string {
  const names = new Set(opts.tools.map((t) => t.name));
  const lines = [
    `You are a subagent of ${opts.botName}: a helper it started to carry out one task on its own. You can't talk to the user and nobody will answer questions, so make reasonable assumptions and mention them.`,
    `${opts.botName} sees only your final message. When you're done, reply with a complete, concise report: what you did, what you found, and the paths of files you created.`,
    "",
    "# Environment",
    nowLine(),
  ];
  const usesFiles = names.has("read_file") || names.has("shell");
  if (usesFiles) {
    lines.push(opts.remoteOs ? `- Your files and terminal are on the user's Lantern Hub server (${opts.remoteOs}).` : `- You are running on ${platformLabel()}.`);
    lines.push(`- Workspace folder: ${opts.workspace} — relative paths resolve here.${opts.isolated ? " It's your own folder: you can't reach files outside it." : ""}`);
  }
  if (names.has("shell")) {
    lines.push(`- Shell: ${opts.shell ?? "system shell"}. Commands run non-interactively in the workspace.`);
    if (opts.sandbox) lines.push(sandboxLine(opts.sandbox));
  } else if (opts.isolated) {
    lines.push("- There's no terminal: commands can't be sandboxed here.");
  }
  if (opts.secretNames.length && names.has("shell")) {
    lines.push(`- Secrets available to shell commands as environment variables: ${opts.secretNames.map((n) => "$" + n).join(", ")}. Never print their values.`);
  }
  if (opts.skills.length && names.has("load_skill")) {
    lines.push("", "# Skills", "Before a step that matches one of these, call `load_skill` with its name and follow it:");
    for (const s of opts.skills) lines.push(`- ${s.name}: ${s.description}`);
  }
  lines.push(
    "",
    "# How to work",
    "- Use your tools; don't ask for permission in text. The app asks the user to approve risky actions. If one is declined, don't retry it.",
    "- Read files before editing them, and check your work when you can.",
    "- Reply in Markdown.",
  );
  return lines.join("\n");
}

const estimate = (s: string | null | undefined) => Math.ceil((s ?? "").length / 3.5);

/** Shrinks the oldest tool outputs until the conversation fits the budget. */
export function fitHistory(messages: OAMessage[], budgetTokens: number): OAMessage[] {
  const size = (m: OAMessage) => 4 + estimate(typeof m.content === "string" ? m.content : "") + (m.tool_calls ?? []).reduce((n, c) => n + estimate(c.function.arguments) + 10, 0);
  let total = messages.reduce((n, m) => n + size(m), 0);
  const out = messages.map((m) => ({ ...m }));
  for (const m of out) {
    if (total <= budgetTokens) break;
    if (m.role !== "tool" || typeof m.content !== "string" || m.content.length <= 600) continue;
    const before = size(m);
    m.content = `${m.content.slice(0, 500)}\n[… older output trimmed to save space]`;
    total -= before - size(m);
  }
  return out;
}

async function runSubagent(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const title = (typeof args.title === "string" && args.title.trim()) || "Subtask";
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) throw new Error("Missing required argument: task");
  const isolated = args.isolated === true;
  const { bot, signal } = ctx;
  const settings = useApp.getState().settings;
  const { provider, model } = resolveModel(bot);

  const hubInfo = ctx.remote ? await hubToolInfo().catch(() => undefined) : undefined;
  let workspace = ctx.workspace;
  let sandbox = ctx.sandbox;
  let confine = !!ctx.confine;
  if (isolated) {
    workspace = `${ctx.workspace.replace(/[\\/]+$/, "")}/subagents/${slug(title)}-${uid("").slice(-6)}`;
    confine = true;
    // On the hub: a sandbox of its own. On a device there's no sandbox, so it gets no terminal.
    sandbox = ctx.remote && hubInfo?.sandbox ? { dir: workspace, network: ctx.sandbox?.network ?? true } : undefined;
  }
  const canRunCommands = !isolated || !!sandbox;
  const tools = subagentTools(ctx.tools ?? [], { isolated, canRunCommands });
  const env = isolated ? {} : ctx.env;
  const subCtx: ToolContext = { ...ctx, workspace, confine, sandbox, env, tools, onProgress: undefined };

  if (isolated && tools.some((t) => t.group === "files")) {
    // Creates the folder and leaves a note of what it was for.
    const files = ctx.remote ? hubFs : fs;
    await files.write(workspace, "TASK.md", `# ${title}\n\n${task}\n`, true);
  }

  const run: SubagentRun = { title, model, isolated, sandboxed: !!sandbox, network: sandbox?.network ?? true, folder: workspace, steps: [] };
  const show = (persist = false) => ctx.onProgress?.({ subagent: { ...run, steps: run.steps.map((s) => ({ ...s })) } }, persist);
  show(true);

  const system = subagentPrompt({
    botName: bot.name,
    workspace,
    remoteOs: ctx.remote ? hubInfo?.os ?? "Linux" : undefined,
    shell: (ctx.remote ? hubInfo?.shell : platform.shell) ?? undefined,
    tools,
    isolated,
    sandbox,
    secretNames: isolated ? [] : bot.secretNames,
    skills: skillsForBot(bot),
  });
  const secretValues = Object.values(env).filter((v) => v.length >= 4);
  const callEnv: CallEnv = { provider, model, lastUser: task, secretValues };
  const messages: OAMessage[] = [{ role: "user", content: task }];
  const useTools = tools.length > 0 && !(provider.noToolModels ?? []).includes(model);
  const budget = Math.max(4000, settings.contextTokens - estimate(system) - 1500);

  for (let step = 0; ; step++) {
    if (signal.aborted) throw new DOMException("Stopped", "AbortError");
    const last = step >= settings.maxSteps;
    const record: SubagentStep = { id: uid("step"), content: "", status: "streaming" };
    run.steps.push(record);
    show();
    let streamed = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let result;
    try {
      result = await chatCompletion({
        provider,
        model,
        messages: [
          { role: "system", content: system },
          ...fitHistory(messages, budget),
          ...(last ? [{ role: "user" as const, content: "You've used all your steps. Stop here and write your final report now." }] : []),
        ],
        tools: useTools && !last ? tools.map(toOATool) : undefined,
        temperature: bot.temperature,
        signal,
        onDelta: (d) => {
          if (!d.content) return;
          streamed += d.content;
          timer ??= setTimeout(() => {
            timer = null;
            record.content = streamed;
            show();
          }, 150);
        },
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      record.status = "error";
      record.content = streamed;
      show(true);
      if (e instanceof LlmError && e.toolsUnsupported) throw new Error(`${model} can't call tools on this server, so it can't run subagents.`);
      throw e;
    }
    if (timer) clearTimeout(timer);

    const calls: ToolCall[] = result.toolCalls.map((c) => ({ id: uid("call"), name: c.function.name, arguments: c.function.arguments, status: "pending" }));
    record.content = result.content;
    record.toolCalls = calls.length ? calls : undefined;
    record.status = "done";
    messages.push({
      role: "assistant",
      content: result.content || null,
      ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments || "{}" } })) } : {}),
    });
    show(true);

    if (!calls.length || last) {
      const steps = run.steps.length;
      const where = isolated ? `\nIts folder: ${workspace}` : "";
      return `Subagent “${title}” finished after ${steps} step${steps === 1 ? "" : "s"}.${where}\n\n${result.content.trim() || "(It gave no report.)"}`;
    }

    for (const call of calls) {
      const update = (patch: Partial<ToolCall>, persist = false) => {
        if (patch.result !== undefined) patch = { ...patch, result: clip(patch.result, SHOWN_RESULT_CHARS) };
        record.toolCalls = record.toolCalls?.map((c) => (c.id === call.id ? { ...c, ...patch } : c));
        show(persist);
      };
      const output = await executeToolCall(call, tools, subCtx, callEnv, update);
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }
}
