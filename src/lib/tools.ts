// Built-in tools a bot can call. Each tool declares a JSON schema for the model,
// a risk class for the approval engine, and a short human summary for the UI.

import type { Risk } from "./approval";
import { hubFs, hubShellRun, usesHub, type HubSandbox } from "./hub";
import { capabilities, db, fs, platform, shellRun, webFetch } from "./platform";
import { describeSchedule, nextRun, parseSchedule } from "./schedule";
import { webSearch } from "./search";
import {
  addMemory,
  deleteMemory,
  deleteRoutine,
  saveRoutine,
  saveSkill,
  useApp,
} from "./store";
import { DEFAULT_TOOLS, type Bot, type BotToolToggles, type Routine, type ToolCall } from "./types";
import { uid } from "./util";

export interface ToolContext {
  bot: Bot;
  conversationId: string;
  workspace: string;
  env: Record<string, string>;
  signal: AbortSignal;
  /** File and terminal tools run on the Lantern Hub instead of this device. */
  remote: boolean;
  /** File tools must stay inside `workspace` (a sandboxed bot's or an isolated subagent's folder). */
  confine?: boolean;
  /** Terminal commands run in this sandbox on the hub. */
  sandbox?: HubSandbox;
  /** Every tool this run offers the model (subagents pick theirs from it). */
  tools?: ToolDef[];
  /** Reports progress of a long-running call (subagents) to its card in the chat. */
  onProgress?: (patch: Partial<ToolCall>, persist?: boolean) => void;
}

/** The file system the bot's tools use: the hub's shared workspace or this device. */
const files = (ctx: ToolContext) => (ctx.remote ? hubFs : fs);
const canUseFiles = (bot: Bot) => capabilities.files || usesHub(bot);
const canUseShell = (bot: Bot) => capabilities.shell || usesHub(bot);

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: Risk | ((args: Record<string, unknown>) => Risk);
  group: keyof BotToolToggles | "mcp";
  /** Platform support (e.g. the terminal needs a desktop or the hub). */
  available?: (bot: Bot) => boolean;
  summarize: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing required argument: ${name}`);
  return v;
};
const opt = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && !isNaN(+v) ? +v : undefined);

function obj(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

export const BUILTIN_TOOLS: ToolDef[] = [
  {
    name: "read_file",
    group: "files",
    risk: "read",
    available: canUseFiles,
    description:
      "Read a text file. Relative paths are inside the workspace. Returns numbered lines; use offset/limit to page through large files.",
    parameters: obj(
      {
        path: { type: "string", description: "File path (relative to the workspace or absolute)" },
        offset: { type: "integer", description: "1-based line to start from" },
        limit: { type: "integer", description: "Maximum number of lines (default 2000)" },
      },
      ["path"],
    ),
    summarize: (a) => `Read ${a.path}`,
    async run(a, ctx) {
      const r = await files(ctx).read(ctx.workspace, str(a.path, "path"), num(a.offset), num(a.limit), ctx.confine);
      const width = String(r.startLine + r.content.split("\n").length).length;
      const body = r.content
        ? r.content
            .split("\n")
            .map((l, i) => `${String(r.startLine + i).padStart(width)}\t${l}`)
            .join("\n")
        : "(empty file)";
      return `${r.path} (${r.totalLines} lines)\n${body}${r.truncated ? `\n[more lines available; continue with offset=${r.startLine + r.content.split("\n").length}]` : ""}`;
    },
  },
  {
    name: "write_file",
    group: "files",
    risk: "write",
    available: canUseFiles,
    description: "Create or overwrite a file with the given content. Parent folders are created as needed.",
    parameters: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    summarize: (a) => `Write ${a.path}`,
    run: (a, ctx) => files(ctx).write(ctx.workspace, str(a.path, "path"), typeof a.content === "string" ? a.content : "", ctx.confine),
  },
  {
    name: "edit_file",
    group: "files",
    risk: "write",
    available: canUseFiles,
    description:
      "Edit a file with exact search-and-replace. Each old_text must appear exactly once (include enough surrounding lines) unless replace_all is true. Read the file first.",
    parameters: obj(
      {
        path: { type: "string" },
        edits: {
          type: "array",
          items: obj(
            {
              old_text: { type: "string", description: "Exact text to find" },
              new_text: { type: "string", description: "Replacement text" },
              replace_all: { type: "boolean" },
            },
            ["old_text", "new_text"],
          ),
        },
      },
      ["path", "edits"],
    ),
    summarize: (a) => `Edit ${a.path}`,
    async run(a, ctx) {
      const edits = Array.isArray(a.edits) ? a.edits : [];
      if (!edits.length) throw new Error("edits must be a non-empty array");
      return files(ctx).edit(
        ctx.workspace,
        str(a.path, "path"),
        edits.map((e: any) => ({ oldText: String(e.old_text ?? e.oldText ?? ""), newText: String(e.new_text ?? e.newText ?? ""), replaceAll: !!(e.replace_all ?? e.replaceAll) })),
        ctx.confine,
      );
    },
  },
  {
    name: "list_dir",
    group: "files",
    risk: "read",
    available: canUseFiles,
    description: "List the entries of a folder (defaults to the workspace).",
    parameters: obj({ path: { type: "string" } }),
    summarize: (a) => `List ${a.path && a.path !== "." ? a.path : "workspace"}`,
    async run(a, ctx) {
      const entries = await files(ctx).list(ctx.workspace, opt(a.path), ctx.confine);
      if (!entries.length) return "(empty folder)";
      return entries.map((e) => (e.isDir ? `${e.name}/` : `${e.name}  (${e.size} bytes)`)).join("\n");
    },
  },
  {
    name: "find_files",
    group: "files",
    risk: "read",
    available: canUseFiles,
    description: 'Find files by glob pattern, e.g. "*.md" or "src/**/*.ts". Respects .gitignore.',
    parameters: obj({ pattern: { type: "string" }, path: { type: "string", description: "Folder to search (default workspace)" } }, ["pattern"]),
    summarize: (a) => `Find ${a.pattern}`,
    async run(a, ctx) {
      const found = await files(ctx).find(ctx.workspace, str(a.pattern, "pattern"), opt(a.path), 200, ctx.confine);
      return found.length ? found.join("\n") : "No files found.";
    },
  },
  {
    name: "grep",
    group: "files",
    risk: "read",
    available: canUseFiles,
    description: "Search file contents with a regular expression. Returns path:line: text for each match.",
    parameters: obj(
      {
        pattern: { type: "string" },
        path: { type: "string", description: "File or folder (default workspace)" },
        glob: { type: "string", description: 'Only files matching this glob, e.g. "*.py"' },
        ignore_case: { type: "boolean" },
        literal: { type: "boolean", description: "Treat the pattern as plain text" },
        context: { type: "integer", description: "Lines of context around each match" },
      },
      ["pattern"],
    ),
    summarize: (a) => `Search for “${a.pattern}”`,
    run: (a, ctx) =>
      files(ctx).grep({
        root: ctx.workspace,
        pattern: str(a.pattern, "pattern"),
        path: opt(a.path),
        glob: opt(a.glob),
        ignoreCase: !!a.ignore_case,
        literal: !!a.literal,
        context: num(a.context),
        limit: 100,
      }, ctx.confine),
  },
  {
    name: "delete_file",
    group: "files",
    risk: "write",
    available: canUseFiles,
    description: "Delete a file or folder (folders are deleted recursively).",
    parameters: obj({ path: { type: "string" } }, ["path"]),
    summarize: (a) => `Delete ${a.path}`,
    run: (a, ctx) => files(ctx).delete(ctx.workspace, str(a.path, "path"), ctx.confine),
  },
  {
    name: "shell",
    group: "shell",
    risk: "exec",
    available: canUseShell,
    description:
      "Run a shell command in the workspace folder and return its output. Use non-interactive commands. Secrets the bot has are available as environment variables.",
    parameters: obj(
      {
        command: { type: "string" },
        timeout_seconds: { type: "integer", description: "Default 120, max 3600" },
      },
      ["command"],
    ),
    summarize: (a) => String(a.command ?? ""),
    async run(a, ctx) {
      // Sandboxes exist only on the hub; never fall back to running unsandboxed here.
      if (ctx.sandbox && !ctx.remote) throw new Error("This bot's commands must run in its sandbox on the hub.");
      const r = await (ctx.remote ? hubShellRun : shellRun)(str(a.command, "command"), {
        cwd: ctx.workspace,
        timeoutMs: (num(a.timeout_seconds) ?? 120) * 1000,
        env: ctx.env,
        signal: ctx.signal,
        sandbox: ctx.sandbox,
      });
      const parts = [];
      const norm = (t: string) => t.replace(/\r\n?/g, "\n").trimEnd();
      if (r.stdout.trim()) parts.push(norm(r.stdout));
      if (r.stderr.trim()) parts.push(`[stderr]\n${norm(r.stderr)}`);
      const status = r.timedOut ? "timed out" : r.cancelled ? "cancelled" : `exit code ${r.exitCode ?? "?"}`;
      parts.push(`[${status}, ${(r.durationMs / 1000).toFixed(1)}s]`);
      return parts.join("\n");
    },
  },
  {
    name: "web_search",
    group: "web",
    risk: "network",
    description: "Search the web. Returns titles, URLs and snippets. Follow up with web_fetch to read a page.",
    parameters: obj({ query: { type: "string" }, max_results: { type: "integer" } }, ["query"]),
    summarize: (a) => `Search the web for “${a.query}”`,
    async run(a) {
      const results = await webSearch(str(a.query, "query"), useApp.getState().settings, Math.min(num(a.max_results) ?? 8, 15));
      if (!results.length) return "No results.";
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
    },
  },
  {
    name: "web_fetch",
    group: "web",
    risk: "network",
    description: "Fetch a web page or file over HTTP(S) and return it as readable text.",
    parameters: obj({ url: { type: "string" } }, ["url"]),
    summarize: (a) => `Open ${a.url}`,
    async run(a) {
      const url = str(a.url, "url");
      if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs can be fetched.");
      const p = await webFetch(url, 30000);
      return `${p.title ? `# ${p.title}\n` : ""}URL: ${p.url} (status ${p.status})\n\n${p.text}${p.truncated ? "\n[truncated]" : ""}`;
    },
  },
  {
    name: "remember",
    group: "memory",
    risk: "internal",
    description:
      "Save a long-term memory about the user or their preferences so you can use it in future conversations. Keep each memory short and factual.",
    parameters: obj({ content: { type: "string" } }, ["content"]),
    summarize: (a) => `Remember: ${a.content}`,
    async run(a, ctx) {
      const m = await addMemory(ctx.bot.id, str(a.content, "content"));
      return `Saved memory ${m.id}.`;
    },
  },
  {
    name: "forget",
    group: "memory",
    risk: "internal",
    description: "Delete a saved memory by its id (shown in brackets in your memories list).",
    parameters: obj({ memory_id: { type: "string" } }, ["memory_id"]),
    summarize: (a) => `Forget memory ${a.memory_id}`,
    async run(a, ctx) {
      const id = str(a.memory_id, "memory_id");
      const m = useApp.getState().memories.find((x) => x.id === id && x.botId === ctx.bot.id);
      if (!m) throw new Error(`No memory with id ${id}`);
      await deleteMemory(id);
      return `Deleted memory ${id}.`;
    },
  },
  {
    name: "load_skill",
    group: "skills",
    risk: "internal",
    description: "Load the full instructions of one of your skills by name before doing a task that matches its description.",
    parameters: obj({ name: { type: "string" } }, ["name"]),
    summarize: (a) => `Load skill “${a.name}”`,
    async run(a, ctx) {
      const name = str(a.name, "name").toLowerCase();
      const skill = skillsForBot(ctx.bot).find((s) => s.name.toLowerCase() === name);
      if (!skill) throw new Error(`No skill named "${a.name}". Available: ${skillsForBot(ctx.bot).map((s) => s.name).join(", ") || "none"}`);
      return `# Skill: ${skill.name}\n${skill.content}`;
    },
  },
  {
    name: "create_skill",
    group: "skills",
    risk: "internal",
    description:
      "Create (or update) a private skill for yourself: reusable step-by-step instructions for a recurring task. The description says when to use it.",
    parameters: obj({ name: { type: "string" }, description: { type: "string" }, content: { type: "string" } }, ["name", "description", "content"]),
    summarize: (a) => `Save skill “${a.name}”`,
    async run(a, ctx) {
      const name = str(a.name, "name").trim();
      const existing = useApp.getState().skills.find((s) => s.botId === ctx.bot.id && s.name.toLowerCase() === name.toLowerCase());
      const now = Date.now();
      await saveSkill({
        id: existing?.id ?? uid("skill"),
        name,
        description: str(a.description, "description"),
        content: str(a.content, "content"),
        botId: ctx.bot.id,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      return existing ? `Updated skill "${name}".` : `Created skill "${name}".`;
    },
  },
  {
    name: "create_routine",
    group: "routines",
    risk: "internal",
    description:
      'Schedule a recurring task that you will run automatically. schedule examples: {"kind":"daily","time":"08:30"}, {"kind":"weekdays","time":"09:00"}, {"kind":"weekly","days":["Mon","Thu"],"time":"17:00"}, {"kind":"interval","minutes":120}, {"kind":"once","at":"2026-12-24T09:00:00"}. Times are local.',
    parameters: obj(
      {
        name: { type: "string" },
        prompt: { type: "string", description: "What you should do on each run, written as an instruction to yourself" },
        schedule: { type: "object", description: "When to run (see examples)" },
      },
      ["name", "prompt", "schedule"],
    ),
    summarize: (a) => `Create routine “${a.name}”`,
    async run(a, ctx) {
      const schedule = parseSchedule(a.schedule);
      const now = Date.now();
      const routine: Routine = {
        id: uid("routine"),
        botId: ctx.bot.id,
        name: str(a.name, "name"),
        prompt: str(a.prompt, "prompt"),
        schedule,
        enabled: true,
        nextRunAt: nextRun(schedule, now),
        createdAt: now,
      };
      await saveRoutine(routine);
      return `Created routine ${routine.id}: ${describeSchedule(schedule)}. Next run: ${routine.nextRunAt ? new Date(routine.nextRunAt).toLocaleString() : "none"}.`;
    },
  },
  {
    name: "list_routines",
    group: "routines",
    risk: "internal",
    description: "List your scheduled routines.",
    parameters: obj({}),
    summarize: () => "List routines",
    async run(_a, ctx) {
      const rs = useApp.getState().routines.filter((r) => r.botId === ctx.bot.id);
      if (!rs.length) return "No routines.";
      return rs
        .map((r) => `[${r.id}] ${r.name}: ${describeSchedule(r.schedule)}${r.enabled ? "" : " (paused)"}; next: ${r.nextRunAt ? new Date(r.nextRunAt).toLocaleString() : "none"}\n  ${r.prompt}`)
        .join("\n");
    },
  },
  {
    name: "delete_routine",
    group: "routines",
    risk: "internal",
    description: "Delete one of your routines by id.",
    parameters: obj({ routine_id: { type: "string" } }, ["routine_id"]),
    summarize: (a) => `Delete routine ${a.routine_id}`,
    async run(a, ctx) {
      const id = str(a.routine_id, "routine_id");
      if (!useApp.getState().routines.some((r) => r.id === id && r.botId === ctx.bot.id)) throw new Error(`No routine with id ${id}`);
      await deleteRoutine(id);
      return `Deleted routine ${id}.`;
    },
  },
  {
    name: "search_conversations",
    group: "conversationSearch",
    risk: "internal",
    description: "Search your earlier conversations with the user for a word or phrase.",
    parameters: obj({ query: { type: "string" }, limit: { type: "integer" } }, ["query"]),
    summarize: (a) => `Search past chats for “${a.query}”`,
    async run(a, ctx) {
      const q = str(a.query, "query");
      const hits = await db.search<{ role: string; content: string; createdAt: number; conversationId: string }>("msg:", q, Math.min(num(a.limit) ?? 20, 50));
      const convs = useApp.getState().conversations;
      const mine = hits.filter((h) => convs.find((c) => c.id === h.data.conversationId)?.botId === ctx.bot.id && h.data.conversationId !== ctx.conversationId);
      if (!mine.length) return "No matches in earlier conversations.";
      return mine
        .map((h) => {
          const conv = convs.find((c) => c.id === h.data.conversationId);
          const text = h.data.content ?? "";
          const i = text.toLowerCase().indexOf(q.toLowerCase());
          const snippet = text.slice(Math.max(0, i - 160), i + 240).replace(/\s+/g, " ");
          return `• "${conv?.title}" (${new Date(h.data.createdAt).toLocaleDateString()}, ${h.data.role}): …${snippet}…`;
        })
        .join("\n");
    },
  },
];

export function skillsForBot(bot: Bot) {
  const all = useApp.getState().skills;
  return all.filter((s) => s.botId === bot.id || (!s.botId && bot.skillIds.includes(s.id)));
}

/** Whether a bot has a tool group turned on; groups added after the bot was made use their default. */
export function toolEnabled(bot: Bot, group: keyof BotToolToggles): boolean {
  return bot.tools[group] ?? DEFAULT_TOOLS[group] ?? false;
}

export function builtinToolsFor(bot: Bot): ToolDef[] {
  return BUILTIN_TOOLS.filter((t) => (t.available ? t.available(bot) : true) && t.group !== "mcp" && toolEnabled(bot, t.group as keyof BotToolToggles));
}

export function riskOf(tool: ToolDef, args: Record<string, unknown>): Risk {
  return typeof tool.risk === "function" ? tool.risk(args) : tool.risk;
}

export function platformLabel(): string {
  const names: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux", android: "Android", ios: "iOS", web: "a web browser" };
  return names[platform.os] ?? platform.os;
}
