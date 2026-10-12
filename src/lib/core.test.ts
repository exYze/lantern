import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../views/SkillsView";
import { toOpenAIHistory } from "./agent";
import { decide, evaluateRules, isInside, isReadOnlyCommand, parseReview, rulePatternForCommand } from "./approval";
import { looksLikeToolsUnsupported, ToolCallAccumulator } from "./llm";
import { nextRun, parseSchedule } from "./schedule";
import { parseDuckDuckGo } from "./search";
import { SseParser, ThinkSplitter } from "./sse";
import type { ApprovalRule, ChatMessage } from "./types";

describe("SseParser", () => {
  it("joins events split across chunks and handles CRLF", () => {
    const p = new SseParser();
    expect(p.feed('data: {"a":')).toEqual([]);
    expect(p.feed('1}\r\n\r\ndata: [DONE]\n\n')).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("ignores comments and joins multi-line data", () => {
    const p = new SseParser();
    expect(p.feed(": ping\n\ndata: a\ndata: b\n\n")).toEqual(["a\nb"]);
  });

  it("flushes an unterminated final event", () => {
    const p = new SseParser();
    p.feed("data: tail");
    expect(p.end()).toEqual(["tail"]);
  });
});

describe("ThinkSplitter", () => {
  const run = (chunks: string[]) => {
    const s = new ThinkSplitter();
    let content = "";
    let reasoning = "";
    for (const c of chunks) {
      const r = s.push(c);
      content += r.content;
      reasoning += r.reasoning;
    }
    const f = s.flush();
    return { content: content + f.content, reasoning: reasoning + f.reasoning };
  };

  it("separates leading think blocks, even when tags are split", () => {
    expect(run(["<thi", "nk>pondering</th", "ink>Answer"])).toEqual({ content: "Answer", reasoning: "pondering" });
  });

  it("keeps a literal <think> that appears mid-answer", () => {
    expect(run(["Use the <think> tag like this"]).content).toBe("Use the <think> tag like this");
  });

  it("passes plain text through untouched", () => {
    expect(run(["Hello ", "world"])).toEqual({ content: "Hello world", reasoning: "" });
  });
});

describe("ToolCallAccumulator", () => {
  it("assembles fragments by index", () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, id: "call_1", function: { name: "read_", arguments: '{"pa' } }]);
    acc.push([{ index: 0, function: { name: "file", arguments: 'th":"a.txt"}' } }]);
    acc.push([{ index: 1, id: "call_2", function: { name: "shell", arguments: { command: "ls" } } }]);
    const calls = acc.result();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: "call_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } });
    expect(JSON.parse(calls[1].function.arguments)).toEqual({ command: "ls" });
  });

  it("invents ids when the server omits them", () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ function: { name: "web_search", arguments: "{}" } }]);
    expect(acc.result()[0].id).toMatch(/^call_/);
  });
});

describe("tool support detection", () => {
  it("recognizes common server errors", () => {
    expect(looksLikeToolsUnsupported(400, '{"error":{"message":"registry.ollama.ai/library/gemma:2b does not support tools"}}')).toBe(true);
    expect(looksLikeToolsUnsupported(400, '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set')).toBe(true);
    expect(looksLikeToolsUnsupported(500, "tools param requires --jinja flag")).toBe(true);
    expect(looksLikeToolsUnsupported(400, "context length exceeded")).toBe(false);
    expect(looksLikeToolsUnsupported(200, "does not support tools")).toBe(false);
  });
});

describe("approval engine", () => {
  const rule = (tool: string, pattern: string, decision: "allow" | "deny"): ApprovalRule => ({ id: pattern, tool, pattern, decision, createdAt: 0 });

  it("classifies read-only shell commands", () => {
    expect(isReadOnlyCommand("ls -la && git status")).toBe(true);
    expect(isReadOnlyCommand("cat a.txt | grep foo | wc -l")).toBe(true);
    expect(isReadOnlyCommand("Get-ChildItem -Recurse")).toBe(true);
    expect(isReadOnlyCommand("rm -rf build")).toBe(false);
    expect(isReadOnlyCommand("echo hi > file.txt")).toBe(false);
    expect(isReadOnlyCommand("find . -name '*.tmp' -delete")).toBe(false);
    expect(isReadOnlyCommand("git push origin main")).toBe(false);
    expect(isReadOnlyCommand("ls $(rm x)")).toBe(false);
    expect(isReadOnlyCommand("git branch -D old")).toBe(false);
  });

  it("derives rule patterns", () => {
    expect(rulePatternForCommand("git status --short")).toBe("git status");
    expect(rulePatternForCommand("npm run test")).toBe("npm run");
    expect(rulePatternForCommand("python script.py")).toBe("python");
  });

  it("requires every segment of a compound command to be allowed", () => {
    const rules = [rule("shell", "git status", "allow")];
    expect(evaluateRules(rules, "shell", { command: "git status" })?.decision).toBe("allow");
    expect(evaluateRules(rules, "shell", { command: "git status && rm -rf /" })).toBeNull();
    expect(evaluateRules(rules, "shell", { command: "git statusx" })).toBeNull();
  });

  it("lets deny rules win", () => {
    const rules = [rule("shell", "", "allow"), rule("shell", "rm", "deny")];
    expect(evaluateRules(rules, "shell", { command: "ls; rm a" })?.decision).toBe("deny");
  });

  it("decides by mode and risk", () => {
    const base = { rules: [], workspace: "/home/u/ws" };
    expect(decide({ ...base, toolName: "read_file", risk: "read", args: { path: "notes.md" }, mode: "ask" })).toEqual({ action: "allow", via: "read-only" });
    expect(decide({ ...base, toolName: "read_file", risk: "read", args: { path: "/etc/passwd" }, mode: "ask" })).toEqual({ action: "ask" });
    expect(decide({ ...base, toolName: "write_file", risk: "write", args: { path: "a" }, mode: "auto" })).toEqual({ action: "allow", via: "auto" });
    expect(decide({ ...base, toolName: "shell", risk: "exec", args: { command: "ls" }, mode: "auto-review" })).toEqual({ action: "allow", via: "read-only" });
    expect(decide({ ...base, toolName: "shell", risk: "exec", args: { command: "npm install" }, mode: "auto-review" })).toEqual({ action: "review" });
    expect(decide({ ...base, toolName: "shell", risk: "exec", args: { command: "ls" }, mode: "ask" })).toEqual({ action: "ask" });
    expect(decide({ ...base, toolName: "remember", risk: "internal", args: {}, mode: "ask" })).toEqual({ action: "allow", via: "read-only" });
    expect(decide({ ...base, rules: [rule("shell", "rm", "deny")], toolName: "shell", risk: "exec", args: { command: "rm x" }, mode: "auto" }).action).toBe("deny");
  });

  it("checks workspace containment", () => {
    expect(isInside("C:\\Users\\me\\Lantern", "C:/Users/me/Lantern/a.txt")).toBe(true);
    expect(isInside("/ws", "/ws2/a")).toBe(false);
    expect(isInside("/ws", "../secret")).toBe(false);
    expect(isInside("/ws", "sub/file")).toBe(true);
  });

  it("parses reviewer output defensively", () => {
    expect(parseReview('Sure! {"verdict":"allow","reason":"reads a file"}')).toEqual({ verdict: "allow", reason: "reads a file" });
    expect(parseReview("I think it's fine").verdict).toBe("ask");
  });
});

describe("schedules", () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

  it("computes daily, weekday and weekly runs", () => {
    // 2026-10-09 is a Friday.
    expect(nextRun({ kind: "daily", time: "09:00" }, at(2026, 10, 9, 8, 0))).toBe(at(2026, 10, 9, 9, 0));
    expect(nextRun({ kind: "daily", time: "09:00" }, at(2026, 10, 9, 9, 0))).toBe(at(2026, 10, 10, 9, 0));
    expect(nextRun({ kind: "weekdays", time: "09:00" }, at(2026, 10, 9, 10, 0))).toBe(at(2026, 10, 12, 9, 0));
    expect(nextRun({ kind: "weekly", days: [3], time: "17:30" }, at(2026, 10, 9, 10, 0))).toBe(at(2026, 10, 14, 17, 30));
    expect(nextRun({ kind: "interval", minutes: 30 }, 1000)).toBe(1000 + 30 * 60_000);
    expect(nextRun({ kind: "once", at: 500 }, 1000)).toBeUndefined();
  });

  it("parses schedules from model output", () => {
    expect(parseSchedule({ kind: "weekly", days: ["Mon", "thursday"], time: "8:15" })).toEqual({ kind: "weekly", days: [1, 4], time: "08:15" });
    expect(parseSchedule({ kind: "interval", hours: 2 })).toEqual({ kind: "interval", minutes: 120 });
    expect(() => parseSchedule({ kind: "sometimes" })).toThrow();
  });
});

describe("history", () => {
  const msg = (m: Partial<ChatMessage>): ChatMessage => ({ id: Math.random().toString(36), conversationId: "c", role: "user", content: "", createdAt: 0, ...m });

  it("pairs every tool call with a result", () => {
    const h = toOpenAIHistory(
      [
        msg({ role: "user", content: "list files" }),
        msg({ role: "assistant", content: "", toolCalls: [{ id: "t1", name: "list_dir", arguments: "{}", status: "done", result: "a.txt" }] }),
        msg({ role: "tool", toolCallId: "t1", content: "a.txt" }),
        msg({ role: "assistant", content: "", toolCalls: [{ id: "t2", name: "shell", arguments: '{"command":"ls"}', status: "running" }] }),
      ],
      100000,
      true,
    );
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(h[4]).toMatchObject({ tool_call_id: "t2" });
  });

  it("flattens tool calls when the model can't use tools", () => {
    const h = toOpenAIHistory(
      [
        msg({ role: "user", content: "hi" }),
        msg({ role: "assistant", content: "Let me check.", toolCalls: [{ id: "t1", name: "web_search", arguments: '{"query":"x"}', status: "done" }] }),
        msg({ role: "tool", toolCallId: "t1", content: "results" }),
        msg({ role: "user", content: "and?" }),
      ],
      100000,
      false,
    );
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(String(h[1].content)).toContain("results");
  });

  it("trims old turns to the budget and starts on a user message", () => {
    const long = "x".repeat(4000);
    const h = toOpenAIHistory(
      [
        msg({ role: "user", content: long }),
        msg({ role: "assistant", content: long }),
        msg({ role: "user", content: "latest question" }),
      ],
      300,
      true,
    );
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ role: "user", content: "latest question" });
  });

  it("sends images as content parts", () => {
    const h = toOpenAIHistory([msg({ role: "user", content: "what's this?", attachments: [{ id: "a", name: "p.png", mime: "image/png", size: 1, kind: "image", data: "data:image/png;base64,AA" }] })], 100000, true);
    expect(Array.isArray(h[0].content)).toBe(true);
  });
});

describe("parsers", () => {
  it("parses DuckDuckGo results and unwraps redirect links", () => {
    const html = `
      <div class="result results_links web-result"><div class="links_main">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example <b>Page</b></a>
        <a class="result__snippet" href="#">An &amp; example snippet</a>
      </div></div>`;
    expect(parseDuckDuckGo(html, 5)).toEqual([{ title: "Example Page", url: "https://example.com/page", snippet: "An & example snippet" }]);
  });

  it("parses SKILL.md front-matter", () => {
    const s = parseSkillMarkdown("---\nname: pdf-tools\ndescription: Use when working with PDFs\n---\n# Steps\n1. Do it", "file");
    expect(s).toEqual({ name: "pdf-tools", description: "Use when working with PDFs", content: "# Steps\n1. Do it" });
    expect(parseSkillMarkdown("just text", "notes").name).toBe("notes");
  });
});
