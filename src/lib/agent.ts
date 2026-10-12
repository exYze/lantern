// The agent loop: stream a reply, run the tool calls it asks for (subject to the
// approval engine), feed results back, repeat until the model answers in text.

import { decide, parseReview, REVIEW_SYSTEM_PROMPT, rulePatternForCommand } from "./approval";
import { hubConnection, hubToolInfo, usesHub, type HubToolInfo } from "./hub";
import { chatCompletion, complete, LlmError, type OAContentPart, type OAMessage, type OATool } from "./llm";
import { getMcpClient, mcpToolName } from "./mcp";
import { capabilities, notify, platform, secrets } from "./platform";
import { chime } from "./sound";
import {
  addApprovalRule,
  appendMessage,
  botSecretKey,
  deleteMessagesFrom,
  loadMessages,
  messagesOf,
  patchMessage,
  saveProvider,
  setRunning,
  toast,
  updateConversation,
  useApp,
  waitForApproval,
  workspaceFor,
} from "./store";
import { builtinToolsFor, platformLabel, riskOf, skillsForBot, type ToolContext, type ToolDef } from "./tools";
import type { Attachment, Bot, ChatMessage, Provider, ToolCall } from "./types";
import { clip, safeJson, uid } from "./util";

const controllers = new Map<string, AbortController>();
const MAX_TOOL_RESULT_CHARS = 30_000;

export function stopRun(conversationId: string) {
  controllers.get(conversationId)?.abort();
}

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return (e as Error)?.name === "AbortError" || !!signal?.aborted;
}

export function makeTitle(text: string): string {
  const line = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>[\]]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "New chat";
  return line.length > 60 ? line.slice(0, 57).trimEnd() + "…" : line;
}

// ------------------------------------------------------------------ model & tools

export function resolveModel(bot: Bot): { provider: Provider; model: string } {
  const { providers, settings } = useApp.getState();
  const ref = bot.model ?? settings.defaultModel;
  const provider = ref ? providers.find((p) => p.id === ref.providerId) : undefined;
  if (provider && ref?.model) return { provider, model: ref.model };
  const fallback = providers.find((p) => p.models.length);
  if (fallback) return { provider: fallback, model: fallback.models[0] };
  throw new Error("No model is set up yet. Open Settings → Models and add your LLM server.");
}

async function botEnv(bot: Bot): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const name of bot.secretNames) {
    const v = await secrets.get(botSecretKey(bot.id, name));
    if (v) env[name] = v;
  }
  return env;
}

async function toolsFor(bot: Bot, workspace: string): Promise<{ tools: ToolDef[]; mcpErrors: string[] }> {
  const tools = builtinToolsFor(bot);
  const mcpErrors: string[] = [];
  const servers = useApp.getState().mcpServers.filter((s) => s.enabled && bot.mcpServerIds.includes(s.id));
  await Promise.all(
    servers.map(async (server) => {
      if (server.transport === "stdio" && !capabilities.mcpStdio) {
        mcpErrors.push(`${server.name}: local (stdio) servers only run on desktop`);
        return;
      }
      try {
        const client = await getMcpClient(server, workspace);
        for (const t of client.tools) {
          tools.push({
            name: mcpToolName(server.name, t.name),
            group: "mcp",
            risk: t.annotations?.readOnlyHint ? "read" : "exec",
            description: `${t.description ?? t.name} (MCP server: ${server.name})`.slice(0, 1024),
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
            summarize: () => `${server.name} · ${t.annotations?.title ?? t.name}`,
            run: (args, ctx) => client.callTool(t.name, args, ctx.signal),
          });
        }
      } catch (e) {
        mcpErrors.push(`${server.name}: ${(e as Error).message}`);
      }
    }),
  );
  const seen = new Set<string>();
  return { tools: tools.filter((t) => !seen.has(t.name) && seen.add(t.name)), mcpErrors };
}

const toOATool = (t: ToolDef): OATool => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } });

// ------------------------------------------------------------------ prompt

export function buildSystemPrompt(bot: Bot, tools: ToolDef[], useTools: boolean, workspace: string, mcpErrors: string[], hub?: HubToolInfo): string {
  const { memories, settings } = useApp.getState();
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date().toLocaleString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz });
  const lines: string[] = [];
  lines.push(`You are ${bot.name}${bot.tagline ? ` — ${bot.tagline}` : ""}.`);
  if (bot.instructions.trim()) lines.push("", bot.instructions.trim());

  lines.push("", "# Environment", `- Current date and time: ${now} (${tz})`, `- You are running in the Lantern app on ${platformLabel()}${platform.mobile ? " (mobile)" : ""}.`);
  const names = new Set(tools.map((t) => t.name));
  const usesFiles = useTools && (names.has("read_file") || names.has("shell"));
  if (usesFiles && hub) {
    lines.push(`- Your files and terminal are on the user's Lantern Hub server (${hub.os}), shared by all of their devices — not on this ${platformLabel()} device.`);
  }
  if (usesFiles) lines.push(`- Workspace folder: ${workspace} — relative paths resolve here.`);
  if (useTools && names.has("shell")) {
    lines.push(`- Shell: ${hub ? hub.shell : (platform.shell ?? "system shell")}. Commands run non-interactively in the workspace.`);
  }
  if (useTools && bot.secretNames.length) {
    lines.push(`- Secrets available to shell commands as environment variables: ${bot.secretNames.map((n) => "$" + n).join(", ")}. Never print their values.`);
  }
  if (mcpErrors.length) lines.push(`- Some plugins failed to start: ${mcpErrors.join("; ")}`);

  const mine = memories.filter((m) => m.botId === bot.id);
  if (bot.tools.memory) {
    lines.push("", "# Memories");
    if (mine.length) {
      lines.push("Things you remember from earlier conversations:");
      for (const m of mine) lines.push(`- [${m.id}] ${m.content}`);
    } else {
      lines.push("(none yet)");
    }
    if (useTools) lines.push("Use `remember` to save durable facts or preferences the user shares, and `forget` to remove outdated ones.");
  }

  const skills = skillsForBot(bot);
  if (bot.tools.skills && skills.length && useTools) {
    lines.push("", "# Skills", "Before a task that matches one of these, call `load_skill` with its name and follow it:");
    for (const s of skills) lines.push(`- ${s.name}: ${s.description}`);
  }

  lines.push("", "# How to work");
  if (useTools) {
    lines.push(
      "- Use your tools whenever they help; don't ask for permission in text. The app asks the user to approve risky actions.",
      "- If a tool call is declined, don't retry it. Explain or choose a different approach.",
      "- Read files before editing them, and verify your work (for example by running tests) when you can.",
    );
  } else {
    lines.push("- Tools are unavailable with the current model, so answer from your own knowledge and say when you'd need to look something up.");
  }
  lines.push("- Reply in Markdown. Use fenced code blocks with a language. ```mermaid blocks render as diagrams and $…$ / $$…$$ render as math.");
  return lines.join("\n");
}

// ------------------------------------------------------------------ history

const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

function userContent(m: ChatMessage): string | OAContentPart[] {
  const texts = (m.attachments ?? []).filter((a) => a.kind === "text");
  const images = (m.attachments ?? []).filter((a) => a.kind === "image");
  let text = m.content;
  for (const a of texts) text += `\n\nAttached file \`${a.name}\`:\n\`\`\`\n${a.data}\n\`\`\``;
  if (!images.length) return text;
  return [{ type: "text", text: text || "(image)" }, ...images.map((a): OAContentPart => ({ type: "image_url", image_url: { url: a.data } }))];
}

function messageTokens(m: OAMessage): number {
  const c = m.content;
  let n = 4;
  if (typeof c === "string") n += estimateTokens(c);
  else if (Array.isArray(c)) n += c.reduce((s, p) => s + (p.type === "text" ? estimateTokens(p.text) : 800), 0);
  for (const t of m.tool_calls ?? []) n += estimateTokens(t.function.arguments) + 10;
  return n;
}

/** Converts stored messages to OpenAI format, repairs tool-call pairing and trims to the budget. */
export function toOpenAIHistory(messages: ChatMessage[], budgetTokens: number, useTools: boolean): OAMessage[] {
  const results = new Map(messages.filter((m) => m.role === "tool" && m.toolCallId).map((m) => [m.toolCallId!, m]));
  const out: OAMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: userContent(m) });
    } else if (m.role === "assistant") {
      const calls = (m.toolCalls ?? []).filter((c) => c.status !== "pending" || results.has(c.id));
      if (!m.content.trim() && !calls.length) continue;
      if (useTools) {
        out.push({
          role: "assistant",
          content: m.content || null,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments || "{}" } })) } : {}),
        });
        for (const c of calls) {
          out.push({ role: "tool", tool_call_id: c.id, content: results.get(c.id)?.content ?? c.result ?? "(no result: the run was interrupted)" });
        }
      } else {
        const notes = calls.map((c) => `\n\n[Used tool ${c.name}(${c.arguments})]\n[Result]: ${clip(results.get(c.id)?.content ?? c.result ?? "", 4000)}`);
        out.push({ role: "assistant", content: m.content + notes.join("") });
      }
    }
  }

  // Many chat templates require user/assistant alternation; merge same-role neighbours.
  const merged: OAMessage[] = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && m.role !== "tool" && !prev.tool_calls && !m.tool_calls && typeof prev.content === "string" && typeof m.content === "string") {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      merged.push({ ...m });
    }
  }

  // Keep the most recent messages that fit, always including the last user turn.
  let total = 0;
  let start = merged.length;
  for (let i = merged.length - 1; i >= 0; i--) {
    total += messageTokens(merged[i]);
    if (total > budgetTokens && start < merged.length && merged.slice(start).some((x) => x.role === "user")) break;
    start = i;
  }
  let kept = merged.slice(start);
  // Start on a user message so no tool result is orphaned from its call.
  const firstUser = kept.findIndex((m) => m.role === "user");
  if (firstUser > 0) kept = kept.slice(firstUser);
  return kept;
}

// ------------------------------------------------------------------ running

export async function sendUserMessage(conversationId: string, text: string, attachments: Attachment[] = [], opts: { routineId?: string } = {}) {
  const msg: ChatMessage = { id: uid("msg"), conversationId, role: "user", content: text, attachments: attachments.length ? attachments : undefined, createdAt: Date.now(), routineId: opts.routineId };
  await loadMessages(conversationId);
  await appendMessage(msg);
  const conv = useApp.getState().conversations.find((c) => c.id === conversationId);
  await updateConversation(conversationId, conv?.title === "New chat" ? { title: makeTitle(text) } : {});
  return runAgent(conversationId, opts);
}

/** Drops an assistant reply (and everything after it) and asks again. */
export async function regenerate(conversationId: string, assistantMessageId: string) {
  const list = messagesOf(conversationId);
  const idx = list.findIndex((m) => m.id === assistantMessageId);
  const userIdx = list.slice(0, idx).map((m) => m.role).lastIndexOf("user");
  if (userIdx < 0 || idx < 0) return;
  const next = list[userIdx + 1];
  if (next) await deleteMessagesFrom(conversationId, next.id);
  return runAgent(conversationId);
}

export async function editAndResend(conversationId: string, userMessageId: string, text: string) {
  const original = messagesOf(conversationId).find((m) => m.id === userMessageId);
  await deleteMessagesFrom(conversationId, userMessageId);
  return sendUserMessage(conversationId, text, original?.attachments ?? []);
}

export type RunOutcome = "ok" | "error" | "stopped";

export async function runAgent(conversationId: string, opts: { routineId?: string } = {}): Promise<RunOutcome> {
  if (controllers.has(conversationId)) return "error";
  const abort = new AbortController();
  controllers.set(conversationId, abort);
  setRunning(conversationId, true);
  let current: string | null = null;
  let outcome: RunOutcome = "ok";
  let bot: Bot | undefined;

  try {
    await loadMessages(conversationId);
    const state = useApp.getState();
    const conv = state.conversations.find((c) => c.id === conversationId);
    bot = state.bots.find((b) => b.id === conv?.botId);
    if (!bot) throw new Error("This conversation's bot no longer exists.");
    const remote = usesHub(bot);
    let hubInfo: HubToolInfo | undefined;
    if (remote) {
      // Cached after the first call, so a short hub outage doesn't block chatting; tool calls then report the error.
      hubInfo = await hubToolInfo().catch(() => hubConnection()?.tools ?? { workspace: "~/workspace", shell: "bash", os: "Linux", user: "" });
    }
    const workspace = hubInfo?.workspace ?? workspaceFor(bot);
    const env = await botEnv(bot);
    const secretValues = Object.values(env).filter((v) => v.length >= 4);
    const { provider: initialProvider, model } = resolveModel(bot);
    const { tools, mcpErrors } = await toolsFor(bot, workspace);
    const ctx: ToolContext = { bot, conversationId, workspace, env, signal: abort.signal, remote };
    const settings = useApp.getState().settings;

    for (let step = 0; step < settings.maxSteps; step++) {
      if (abort.signal.aborted) break;
      const provider = useApp.getState().providers.find((p) => p.id === initialProvider.id) ?? initialProvider;
      const useTools = tools.length > 0 && !(provider.noToolModels ?? []).includes(model);
      const system = buildSystemPrompt(bot, tools, useTools, workspace, mcpErrors, hubInfo);
      const history = toOpenAIHistory(messagesOf(conversationId), Math.max(2000, settings.contextTokens - estimateTokens(system) - 1500), useTools);

      const assistant: ChatMessage = { id: uid("msg"), conversationId, role: "assistant", content: "", status: "streaming", model, createdAt: Date.now(), routineId: opts.routineId };
      await appendMessage(assistant, false);
      current = assistant.id;

      // Batch streamed deltas so the UI re-renders at most ~20 times per second.
      let pendingContent = "";
      let pendingReasoning = "";
      let pendingCalls: ToolCall[] | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        timer = null;
        const c = pendingContent;
        const r = pendingReasoning;
        const calls = pendingCalls;
        pendingContent = pendingReasoning = "";
        pendingCalls = null;
        patchMessage(conversationId, assistant.id, (m) => ({
          content: m.content + c,
          reasoning: r ? (m.reasoning ?? "") + r : m.reasoning,
          ...(calls ? { toolCalls: calls } : {}),
        }));
      };

      let result;
      try {
        result = await chatCompletion({
          provider,
          model,
          messages: [{ role: "system", content: system }, ...history],
          tools: useTools ? tools.map(toOATool) : undefined,
          temperature: bot.temperature,
          signal: abort.signal,
          onDelta: (d) => {
            if (d.content) pendingContent += d.content;
            if (d.reasoning) pendingReasoning += d.reasoning;
            if (d.toolCalls) pendingCalls = d.toolCalls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments, status: "pending" }));
            timer ??= setTimeout(flush, 50);
          },
        });
      } catch (e) {
        if (timer) clearTimeout(timer);
        if (e instanceof LlmError && e.toolsUnsupported && useTools) {
          await saveProvider({ ...provider, noToolModels: [...(provider.noToolModels ?? []), model] });
          useApp.setState((s) => ({ messages: { ...s.messages, [conversationId]: (s.messages[conversationId] ?? []).filter((m) => m.id !== assistant.id) } }));
          current = null;
          toast(`${model} can't call tools on this server, so ${bot.name} will chat without them.`, "info");
          step--;
          continue;
        }
        throw e;
      }
      if (timer) clearTimeout(timer);

      const toolCalls: ToolCall[] = result.toolCalls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments, status: "pending" }));
      patchMessage(
        conversationId,
        assistant.id,
        { content: result.content, reasoning: result.reasoning || undefined, toolCalls: toolCalls.length ? toolCalls : undefined, status: "done", usage: result.usage },
        true,
      );
      current = null;
      if (!toolCalls.length) break;

      const lastUser = [...messagesOf(conversationId)].reverse().find((m) => m.role === "user")?.content ?? "";
      for (const call of toolCalls) {
        await runToolCall(call, assistant.id, tools, ctx, { provider, model, lastUser, secretValues, routineId: opts.routineId });
      }
      if (step === settings.maxSteps - 1) {
        toast(`${bot.name} reached the limit of ${settings.maxSteps} steps. Say “continue” to keep going.`, "info");
      }
    }
  } catch (e) {
    if (isAbort(e, abort.signal)) {
      outcome = "stopped";
      if (current) patchMessage(conversationId, current, { status: "stopped" }, true);
    } else {
      outcome = "error";
      const message = (e as Error)?.message ?? String(e);
      if (current) {
        patchMessage(conversationId, current, { status: "error", error: message }, true);
      } else {
        await appendMessage({ id: uid("msg"), conversationId, role: "assistant", content: "", status: "error", error: message, createdAt: Date.now(), routineId: opts.routineId });
      }
    }
  } finally {
    controllers.delete(conversationId);
    setRunning(conversationId, false);
    await updateConversation(conversationId, {});
  }

  const s = useApp.getState().settings;
  if (bot && (document.hidden || opts.routineId) && outcome !== "stopped") {
    const last = [...messagesOf(conversationId)].reverse().find((m) => m.role === "assistant");
    if (s.notifications) void notify(bot.name, (last?.error ? `Error: ${last.error}` : last?.content || "Finished").slice(0, 160));
    if (s.sound) chime();
  }
  return outcome;
}

interface CallEnv {
  provider: Provider;
  model: string;
  lastUser: string;
  secretValues: string[];
  routineId?: string;
}

function redact(text: string, values: string[]): string {
  let out = text;
  for (const v of values) out = out.split(v).join("[secret]");
  return out;
}

async function autoReview(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext, env: CallEnv): Promise<{ verdict: "allow" | "ask"; reason: string }> {
  const { providers, settings } = useApp.getState();
  const ref = settings.reviewModel;
  const provider = (ref && providers.find((p) => p.id === ref.providerId)) || env.provider;
  const model = ref && provider.id === ref.providerId ? ref.model : env.model;
  try {
    const text = await complete(
      provider,
      model,
      [
        { role: "system", content: REVIEW_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Latest user request:\n${env.lastUser.slice(0, 2000)}\n\nWorkspace: ${ctx.workspace}\nPlatform: ${ctx.remote ? "Lantern Hub server (Linux, shared workspace)" : platformLabel()}\nTool: ${tool.name} — ${tool.description.slice(0, 300)}\nArguments:\n${JSON.stringify(args, null, 2).slice(0, 4000)}`,
        },
      ],
      { maxTokens: 1024, signal: ctx.signal },
    );
    return parseReview(text);
  } catch (e) {
    if (isAbort(e, ctx.signal)) throw e;
    return { verdict: "ask", reason: `Auto-review failed: ${(e as Error).message}` };
  }
}

async function runToolCall(call: ToolCall, assistantId: string, tools: ToolDef[], ctx: ToolContext, env: CallEnv) {
  const { conversationId, bot, signal } = ctx;
  const update = (patch: Partial<ToolCall>, persist = false) =>
    patchMessage(conversationId, assistantId, (m) => ({ toolCalls: m.toolCalls?.map((c) => (c.id === call.id ? { ...c, ...patch } : c)) }), persist);

  let result: string;
  let status: ToolCall["status"] = "done";
  const tool = tools.find((t) => t.name === call.name);
  let args: Record<string, unknown> = {};

  try {
    if (!tool) throw new Error(`Unknown tool "${call.name}". Available tools: ${tools.map((t) => t.name).join(", ")}`);
    args = safeJson(call.arguments);
  } catch (e) {
    result = `Error: ${(e as Error).message}`;
    update({ status: "error", result }, true);
    await appendMessage({ id: uid("msg"), conversationId, role: "tool", toolCallId: call.id, toolName: call.name, content: result, createdAt: Date.now() });
    return;
  }

  const settings = useApp.getState().settings;
  const mode = bot.approvalMode ?? settings.approvalMode;
  let decision = decide({ toolName: tool!.name, risk: riskOf(tool!, args), args, mode, rules: settings.approvalRules, workspace: ctx.workspace });
  let via: ToolCall["approval"];

  if (decision.action === "review") {
    update({ status: "reviewing" });
    const review = await autoReview(tool!, args, ctx, env);
    update({ review });
    via = "auto-review";
    decision = review.verdict === "allow" ? { action: "allow", via: "auto" } : { action: "ask" };
  }

  if (decision.action === "deny") {
    result = `Not run: ${decision.reason}.`;
    status = "denied";
  } else {
    if (decision.action === "ask") {
      update({ status: "awaiting-approval" });
      if (env.routineId || document.hidden) void notify(`${bot.name} needs your approval`, tool!.summarize(args).slice(0, 160));
      const answer = await waitForApproval(call.id, signal);
      if (answer === "deny") {
        result = signal.aborted ? "Cancelled." : "The user declined this action. Don't retry it; ask them or choose another approach.";
        update({ status: "denied", result }, true);
        await appendMessage({ id: uid("msg"), conversationId, role: "tool", toolCallId: call.id, toolName: call.name, content: result, createdAt: Date.now() });
        return;
      }
      if (answer === "always") {
        await addApprovalRule({ tool: tool!.name, pattern: tool!.name === "shell" ? rulePatternForCommand(String(args.command ?? "")) : "", decision: "allow" });
      }
      via = "user";
    } else {
      via ??= decision.via;
    }

    update({ status: "running", approval: via, startedAt: Date.now() });
    try {
      result = await tool!.run(args, ctx);
    } catch (e) {
      status = "error";
      result = signal.aborted ? "Cancelled by the user." : `Error: ${(e as Error)?.message ?? String(e)}`;
    }
  }

  result = redact(clip(result, MAX_TOOL_RESULT_CHARS), env.secretValues);
  update({ status, result, finishedAt: Date.now() }, true);
  await appendMessage({ id: uid("msg"), conversationId, role: "tool", toolCallId: call.id, toolName: call.name, content: result, createdAt: Date.now() });
}
