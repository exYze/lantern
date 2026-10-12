// Decides whether a tool call runs, is blocked, or needs the user's approval.
// Modes mirror the original app: Ask, Auto-review (an LLM judges each call)
// and Auto-approve, with user-defined allow/deny rules on top.

import type { ApprovalMode, ApprovalRule } from "./types";

export type Risk = "read" | "internal" | "write" | "exec" | "network";

export type Decision =
  | { action: "allow"; via: "rule" | "auto" | "read-only" }
  | { action: "deny"; reason: string }
  | { action: "review" }
  | { action: "ask" };

const READ_ONLY_COMMANDS = new Set([
  "ls", "dir", "pwd", "cat", "type", "head", "tail", "wc", "echo", "which", "where", "whoami", "date",
  "uname", "hostname", "grep", "rg", "egrep", "fgrep", "file", "stat", "du", "df", "tree", "sort", "uniq",
  "cut", "less", "more", "basename", "dirname", "realpath", "readlink", "uptime", "id", "nproc", "free",
  "get-childitem", "gci", "get-content", "gc", "get-location", "gl", "select-string", "sls", "get-process",
  "gps", "get-date", "test-path", "get-item", "gi", "measure-object", "get-command", "gcm", "resolve-path",
  "get-itemproperty", "format-table", "format-list", "select-object", "where-object", "sort-object",
]);

const READ_ONLY_SUBCOMMANDS: Record<string, string[]> = {
  git: ["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "remote", "describe", "shortlog", "tag"],
  npm: ["ls", "list", "view", "outdated", "--version", "-v"],
  pnpm: ["ls", "list", "outdated", "--version"],
  cargo: ["--version", "tree", "metadata"],
  docker: ["ps", "images", "version", "info"],
  kubectl: ["get", "describe", "version"],
  node: ["--version", "-v"],
  python: ["--version", "-V"],
  python3: ["--version", "-V"],
  go: ["version", "env"],
  find: [],
};

/** Commands where the first two words identify the action (used for "Always allow"). */
const TWO_WORD_TOOLS = new Set(["git", "npm", "pnpm", "yarn", "bun", "cargo", "docker", "kubectl", "go", "pip", "uv", "dotnet", "make", "gh"]);

/** Splits a command line on && || ; | so each piece can be checked on its own. */
export function splitCommand(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function words(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

export function isReadOnlyCommand(command: string): boolean {
  if (/[`]|\$\(|>|<\(|\btee\b/.test(command)) return false;
  const segments = splitCommand(command);
  if (!segments.length) return false;
  return segments.every((seg) => {
    const [first, second] = words(seg);
    const cmd = first?.toLowerCase().replace(/\.exe$/, "");
    if (!cmd) return false;
    if (cmd === "find") return !/\s-(delete|exec|execdir|ok|okdir|fprint)\b/.test(seg);
    if (cmd === "sed" || cmd === "awk") return false;
    if (READ_ONLY_COMMANDS.has(cmd)) return true;
    const subs = READ_ONLY_SUBCOMMANDS[cmd];
    if (!subs || !second) return false;
    if (cmd === "git" && second === "branch" && /\s-(d|D|m|M)\b/.test(seg)) return false;
    if (cmd === "git" && second === "remote" && !/\s-v\b/.test(seg) && words(seg).length > 2) return false;
    return subs.includes(second.toLowerCase());
  });
}

/** The prefix stored when the user picks "Always allow" for a shell command. */
export function rulePatternForCommand(command: string): string {
  const [first, second] = words(splitCommand(command)[0] ?? "");
  if (!first) return "";
  return TWO_WORD_TOOLS.has(first.toLowerCase()) && second && !second.startsWith("-") ? `${first} ${second}` : first;
}

function prefixMatches(segment: string, pattern: string): boolean {
  const s = segment.trim().toLowerCase();
  const p = pattern.trim().toLowerCase();
  return s === p || s.startsWith(p + " ");
}

/** Returns the rule decision for a call, or null when no rule applies. */
export function evaluateRules(rules: ApprovalRule[], toolName: string, args: Record<string, unknown>): ApprovalRule | null {
  const relevant = rules.filter((r) => r.tool === toolName);
  if (!relevant.length) return null;
  if (toolName === "shell") {
    const segments = splitCommand(String(args.command ?? ""));
    const deny = relevant.find((r) => r.decision === "deny" && (!r.pattern || segments.some((s) => prefixMatches(s, r.pattern))));
    if (deny) return deny;
    const allows = relevant.filter((r) => r.decision === "allow");
    if (!segments.length || !allows.length) return null;
    // Every piece of a compound command must be covered by an allow rule.
    const covering = segments.map((s) => allows.find((r) => !r.pattern || prefixMatches(s, r.pattern)));
    return covering.every(Boolean) ? covering[0]! : null;
  }
  return relevant.find((r) => r.decision === "deny") ?? relevant.find((r) => r.decision === "allow") ?? null;
}

export function isInside(root: string, path: string): boolean {
  if (!root) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const isAbs = /^([a-zA-Z]:)?[\\/]/.test(path) || path.startsWith("~");
  if (!isAbs) return !path.replace(/\\/g, "/").split("/").includes("..");
  const r = norm(root);
  const p = norm(path);
  return p === r || p.startsWith(r + "/");
}

export interface DecideInput {
  toolName: string;
  risk: Risk;
  args: Record<string, unknown>;
  mode: ApprovalMode;
  rules: ApprovalRule[];
  workspace: string;
}

export function decide({ toolName, risk, args, mode, rules, workspace }: DecideInput): Decision {
  const rule = evaluateRules(rules, toolName, args);
  if (rule?.decision === "deny") return { action: "deny", reason: `Blocked by your rule${rule.pattern ? ` “${rule.pattern}”` : ""}` };
  if (rule?.decision === "allow") return { action: "allow", via: "rule" };

  if (risk === "internal" || risk === "network") return { action: "allow", via: "read-only" };
  if (risk === "read") {
    const path = typeof args.path === "string" ? args.path : "";
    if (!path || isInside(workspace, path)) return { action: "allow", via: "read-only" };
  }
  if (mode === "auto") return { action: "allow", via: "auto" };
  if (toolName === "shell" && mode === "auto-review" && isReadOnlyCommand(String(args.command ?? ""))) {
    return { action: "allow", via: "read-only" };
  }
  return mode === "auto-review" ? { action: "review" } : { action: "ask" };
}

export const REVIEW_SYSTEM_PROMPT = `You are a safety reviewer for an AI assistant that can act on the user's computer.
Decide whether the tool call below can run WITHOUT asking the user first.

Allow routine, reversible actions that clearly serve the user's latest request: reading files, creating or editing files inside the workspace, running builds, tests, linters or package installs for the project, harmless queries.

Ask the user for anything that: deletes or overwrites data outside the workspace or that looks important; touches credentials, keys, browser data or system settings; sends private data to external services; spends money; is hard to undo; or does not clearly follow from the request.

Reply with JSON only: {"verdict": "allow" | "ask", "reason": "<one short sentence>"}`;

export function parseReview(text: string): { verdict: "allow" | "ask"; reason: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j.verdict === "allow" || j.verdict === "ask") return { verdict: j.verdict, reason: String(j.reason ?? "").slice(0, 300) };
    } catch {
      /* fall through */
    }
  }
  return { verdict: "ask", reason: "The reviewer's answer could not be understood." };
}
