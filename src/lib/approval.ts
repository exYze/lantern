// Decides whether a tool call runs, is blocked, or needs the user's approval.
// Modes mirror the original app: Ask, Auto-review (an LLM judges each call)
// and Auto-approve, with user-defined allow/deny rules on top. Rules can be
// limited to one bot and can expire. Shell commands are parsed (quotes,
// pipes, redirects, $(…), wrappers like sudo and env) so each command in a
// line is judged on its own, and a few catastrophic ones always ask.

import type { ApprovalMode, ApprovalRule } from "./types";

export type Risk = "read" | "internal" | "write" | "exec" | "network";

export type Decision =
  | { action: "allow"; via: "rule" | "auto" | "read-only" }
  | { action: "deny"; reason: string }
  | { action: "review" }
  | { action: "ask"; warning?: string };

/** How an approval was answered. The "always…" answers and time limits also save a rule. */
export type ApprovalAnswer = "allow" | "always" | "always-bot" | "hour" | "today" | "deny";

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
const TWO_WORD_TOOLS = new Set(["git", "npm", "pnpm", "yarn", "bun", "cargo", "docker", "kubectl", "go", "pip", "uv", "dotnet", "make", "gh", "sudo", "apt", "apt-get", "brew", "systemctl"]);

// ------------------------------------------------------------------ parsing

export interface ShellSegment {
  /** The command's words, after VAR=value prefixes and wrappers like env, time and nohup. */
  argv: string[];
  /** Files it writes with > or >> (not /dev/null). */
  writes: string[];
}

export interface ShellParse {
  segments: ShellSegment[];
  /** $(…), backticks or <(…): part of the command is decided while it runs. */
  substitution: boolean;
  /** Commands joined with pipes, in order (for "download | shell"). */
  pipelines: ShellSegment[][];
  /** Quotes or parentheses that don't close: the line can't be judged. */
  failed: boolean;
}

/** Wrappers that run the command after them (their own options are skipped). */
const WRAPPERS: Record<string, Set<string>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S"]),
  time: new Set(["-f", "-o"]),
  nice: new Set(["-n", "--adjustment"]),
  nohup: new Set(),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  ionice: new Set(["-c", "-n", "-p"]),
  exec: new Set(["-a"]),
  command: new Set(),
  builtin: new Set(),
  xargs: new Set(["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs"]),
};
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const POWERSHELLS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);

function unwrap(words: string[], depth: number): { argv: string[]; inner?: string } {
  let w = [...words];
  for (let guard = 0; guard < 10 && w.length; guard++) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    const cmd = (w[0] ?? "").toLowerCase().replace(/^.*[\\/]/, "");
    const wrapper = WRAPPERS[cmd];
    if (wrapper) {
      let i = 1;
      while (i < w.length && (w[i].startsWith("-") || (cmd === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])))) {
        if (wrapper.has(w[i])) i++;
        i++;
      }
      // timeout's first plain word is the duration.
      if (cmd === "timeout" && i < w.length) i++;
      w = w.slice(i);
      continue;
    }
    if (depth < 3 && (SHELLS.has(cmd) || POWERSHELLS.has(cmd) || cmd === "cmd" || cmd === "cmd.exe")) {
      const flag = w.findIndex((x, j) => j > 0 && /^(-c|-command|\/c|\/k)$/i.test(x));
      if (flag !== -1 && w[flag + 1] !== undefined) return { argv: w, inner: w.slice(flag + 1).join(" ") };
    }
    break;
  }
  return { argv: w };
}

/** Splits a command line into simple commands without running anything. */
export function parseShell(command: string, depth = 0): ShellParse {
  const out: ShellParse = { segments: [], substitution: false, pipelines: [], failed: false };
  let words: string[] = [];
  let writes: string[] = [];
  let pipeline: ShellSegment[] = [];
  let word = "";
  let inWord = false;
  let redirect: "out" | "in" | null = null;

  const endWord = () => {
    if (!inWord) return;
    if (redirect === "out") {
      if (!/^&?\d*$/.test(word) && word !== "/dev/null" && word.toLowerCase() !== "$null" && word.toLowerCase() !== "nul") writes.push(word);
    } else if (redirect !== "in") {
      words.push(word);
    }
    redirect = null;
    word = "";
    inWord = false;
  };
  const endSegment = (pipeEnds: boolean) => {
    endWord();
    if (words.length || writes.length) {
      const { argv, inner } = unwrap(words, depth);
      if (inner !== undefined) {
        const sub = parseShell(inner, depth + 1);
        out.substitution ||= sub.substitution;
        out.failed ||= sub.failed;
        out.segments.push(...sub.segments);
        out.pipelines.push(...sub.pipelines);
        if (writes.length) out.segments.push({ argv: [], writes });
      } else {
        const seg = { argv, writes };
        out.segments.push(seg);
        pipeline.push(seg);
      }
    }
    words = [];
    writes = [];
    if (pipeEnds && pipeline.length) {
      out.pipelines.push(pipeline);
      pipeline = [];
    }
  };

  const s = command;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) return { ...out, failed: true };
      word += s.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && j + 1 < s.length) {
          word += s[j + 1];
          j++;
        } else {
          if (s[j] === "`" || (s[j] === "$" && s[j + 1] === "(")) out.substitution = true;
          word += s[j];
        }
      }
      if (j >= s.length) return { ...out, failed: true };
      inWord = true;
      i = j;
      continue;
    }
    if (c === "\\" && next !== undefined) {
      if (next === "\n") {
        i++;
        continue;
      }
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (c === "`" || (c === "$" && next === "(") || ((c === "<" || c === ">") && next === "(")) {
      // Keep the substitution in the word, but don't split inside it.
      out.substitution = true;
      if (c === "`") {
        const end = s.indexOf("`", i + 1);
        if (end === -1) return { ...out, failed: true };
        word += s.slice(i, end + 1);
        i = end;
      } else {
        let depthP = 0;
        let j = i + 1;
        for (; j < s.length; j++) {
          if (s[j] === "(") depthP++;
          else if (s[j] === ")" && --depthP === 0) break;
        }
        if (j >= s.length) return { ...out, failed: true };
        word += s.slice(i, j + 1);
        i = j;
      }
      inWord = true;
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl - 1;
      continue;
    }
    if (c === "&" && next === "&") {
      endSegment(true);
      i++;
      continue;
    }
    if (c === "|" && next === "|") {
      endSegment(true);
      i++;
      continue;
    }
    if (c === "|") {
      endSegment(false);
      if (next === "&") i++;
      continue;
    }
    if (c === ";" || c === "\n" || (c === "&" && next !== ">")) {
      endSegment(true);
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && next === ">")) {
      // A file descriptor number right before it (2>) belongs to the redirect.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      if (c === "<" && next === "<") {
        // Here-documents feed lines of input that aren't commands; the rest can't be judged reliably.
        endSegment(true);
        return { ...out, failed: true };
      }
      redirect = c === "<" ? "in" : "out";
      while (s[i + 1] === ">" || s[i + 1] === "&" || s[i + 1] === "|") i++;
      // >&2 and 2>&1 point at another descriptor, not a file.
      if (s[i] === "&" && /\d/.test(s[i + 1] ?? "")) {
        while (/\d/.test(s[i + 1] ?? "")) i++;
        redirect = null;
      }
      continue;
    }
    if ((c === "(" || c === ")") && !inWord) {
      // Subshells: ( cd x && make ).
      endSegment(true);
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  endSegment(true);
  return out;
}

const lower = (w: string) => w.toLowerCase().replace(/\.exe$/, "");

function readOnlySegment(seg: ShellSegment): boolean {
  if (seg.writes.length) return false;
  const [first, second] = seg.argv;
  const cmd = first ? lower(first).replace(/^.*[\\/]/, "") : "";
  if (!cmd) return false;
  const text = seg.argv.join(" ");
  if (cmd === "find") return !/\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/.test(` ${text}`);
  if (cmd === "sed" || cmd === "awk" || cmd === "sudo" || cmd === "doas") return false;
  if (READ_ONLY_COMMANDS.has(cmd)) return true;
  const subs = READ_ONLY_SUBCOMMANDS[cmd];
  if (!subs || !second) return false;
  if (cmd === "git" && second === "branch" && /\s-(d|D|m|M|c|C)\b|--delete|--move/.test(text)) return false;
  if (cmd === "git" && second === "remote" && !/\s-v\b/.test(text) && seg.argv.length > 2) return false;
  if (cmd === "git" && second === "tag" && seg.argv.length > 2 && !/\s-l\b|--list/.test(text)) return false;
  return subs.includes(second.toLowerCase());
}

export function isReadOnlyCommand(command: string): boolean {
  const p = parseShell(command);
  if (p.failed || p.substitution || !p.segments.length) return false;
  return p.segments.every(readOnlySegment);
}

/** The prefix stored when the user picks "Always allow" for a shell command. */
export function rulePatternForCommand(command: string): string {
  const argv = parseShell(command).segments[0]?.argv ?? [];
  const [first, second] = argv;
  if (!first) return "";
  return TWO_WORD_TOOLS.has(lower(first)) && second && !second.startsWith("-") ? `${first} ${second}` : first;
}

function prefixMatches(seg: ShellSegment, pattern: string): boolean {
  const p = pattern.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!p.length) return true;
  const w = seg.argv.map((x) => x.toLowerCase());
  return p.every((part, i) => w[i] === part || (i === 0 && w[0]?.replace(/^.*[\\/]/, "").replace(/\.exe$/, "") === part));
}

// ------------------------------------------------------------------ catastrophic commands

const SYSTEM_PATHS = /^(\/|\/\*|~|~\/|~\/\*|\$home|\$home\/|\.\.|\/(bin|boot|dev|etc|home|lib|lib64|opt|root|sbin|srv|usr|var)\/?\*?|[a-z]:\\?|[a-z]:\\\*|c:\\windows.*|\\)$/i;

/** Why a command could wreck the machine or its data (it then always asks), or null. */
export function dangerReason(command: string): string | null {
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(command)) return "This looks like a fork bomb.";
  const p = parseShell(command);
  for (const seg of p.segments) {
    const argv = seg.argv[0] && ["sudo", "doas"].includes(lower(seg.argv[0])) ? seg.argv.filter((w, i) => i > 0 && !(i === 1 && w.startsWith("-"))) : seg.argv;
    const cmd = argv[0] ? lower(argv[0]).replace(/^.*[\\/]/, "") : "";
    const args = argv.slice(1);
    const flags = args.filter((a) => a.startsWith("-")).join(" ").toLowerCase();
    const targets = args.filter((a) => !a.startsWith("-"));
    if (cmd === "rm" && /(^|\s)-\w*[rf]|--recursive|--force/i.test(flags) && targets.some((t) => SYSTEM_PATHS.test(t))) return "It deletes a system folder or your whole home folder.";
    if (["remove-item", "rm", "ri", "del", "rmdir", "rd"].includes(cmd) && /-recurse|\/s/i.test(args.join(" ")) && targets.some((t) => SYSTEM_PATHS.test(t))) return "It deletes a whole drive or system folder.";
    if (/^mkfs(\.|$)|^(wipefs|fdisk|sfdisk|parted|diskpart|format-volume|clear-disk|initialize-disk)$/.test(cmd)) return "It erases or repartitions a disk.";
    if (cmd === "dd" && args.some((a) => /^of=\/dev\//i.test(a))) return "It writes straight to a disk device.";
    if (["shutdown", "reboot", "halt", "poweroff", "stop-computer", "restart-computer"].includes(cmd)) return "It shuts down or restarts the machine.";
    if (cmd === "systemctl" && /^(poweroff|reboot|halt|kexec)$/.test(lower(args[0] ?? ""))) return "It shuts down or restarts the machine.";
    if (cmd === "init" && /^[06]$/.test(args[0] ?? "")) return "It shuts down or restarts the machine.";
    if ((cmd === "chmod" || cmd === "chown") && /-\w*r|--recursive/i.test(flags) && targets.some((t) => SYSTEM_PATHS.test(t))) return "It changes permissions on every file of the system.";
    if (seg.writes.some((w) => /^\/dev\/(sd|nvme|hd|vd|mmcblk|disk)/.test(w))) return "It writes straight to a disk device.";
  }
  for (const pipe of p.pipelines) {
    const names = pipe.map((s) => (s.argv[0] ? lower(s.argv[0]).replace(/^.*[\\/]/, "") : ""));
    const download = names.findIndex((n) => ["curl", "wget", "iwr", "invoke-webrequest", "irm", "invoke-restmethod"].includes(n));
    if (download !== -1 && names.slice(download + 1).some((n) => SHELLS.has(n) || POWERSHELLS.has(n) || ["python", "python3", "iex", "invoke-expression", "sudo"].includes(n))) {
      return "It runs a script straight from the internet.";
    }
  }
  return null;
}

// ------------------------------------------------------------------ rules

/** Rules that apply right now to this bot: not expired, and either for every bot or for this one. */
export function activeRules(rules: ApprovalRule[], botId?: string, now = Date.now()): ApprovalRule[] {
  return rules.filter((r) => (!r.expiresAt || r.expiresAt > now) && (!r.botId || r.botId === botId));
}

/** Returns the rule decision for a call, or null when no rule applies. */
export function evaluateRules(rules: ApprovalRule[], toolName: string, args: Record<string, unknown>, botId?: string, now = Date.now()): ApprovalRule | null {
  const relevant = activeRules(rules, botId, now).filter((r) => r.tool === toolName);
  if (!relevant.length) return null;
  if (toolName === "shell") {
    const parsed = parseShell(String(args.command ?? ""));
    const segments = parsed.segments.filter((s) => s.argv.length);
    const deny = relevant.find((r) => r.decision === "deny" && (!r.pattern || segments.some((s) => prefixMatches(s, r.pattern))));
    if (deny) return deny;
    // Parts decided at run time ($(…)) or a line that can't be parsed are never covered by an allow rule.
    if (parsed.failed || parsed.substitution) return null;
    const allows = relevant.filter((r) => r.decision === "allow");
    if (!segments.length || !allows.length) return null;
    // Every command in the line must be covered by an allow rule, and nothing may write files outside one.
    const covering = segments.map((s) => allows.find((r) => !r.pattern || prefixMatches(s, r.pattern)));
    return covering.every(Boolean) ? covering[0]! : null;
  }
  return relevant.find((r) => r.decision === "deny") ?? relevant.find((r) => r.decision === "allow") ?? null;
}

/** The rule an "always…" or time-limited answer saves, or null for allow-once and deny. */
export function ruleForAnswer(answer: ApprovalAnswer, tool: string, pattern: string, botId: string, now = Date.now()): Omit<ApprovalRule, "id" | "createdAt"> | null {
  const base = { tool, pattern, decision: "allow" as const };
  switch (answer) {
    case "always":
      return base;
    case "always-bot":
      return { ...base, botId };
    case "hour":
      return { ...base, botId, expiresAt: now + 3600_000 };
    case "today": {
      const d = new Date(now);
      return { ...base, botId, expiresAt: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() };
    }
    default:
      return null;
  }
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
  botId?: string;
}

export function decide({ toolName, risk, args, mode, rules, workspace, botId }: DecideInput): Decision {
  const rule = evaluateRules(rules, toolName, args, botId);
  if (rule?.decision === "deny") return { action: "deny", reason: `Blocked by your rule${rule.pattern ? ` “${rule.pattern}”` : ""}` };
  // A few commands can wreck the machine: they always ask, whatever the mode or rules say.
  const danger = toolName === "shell" ? dangerReason(String(args.command ?? "")) : null;
  if (danger) return { action: "ask", warning: danger };
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
