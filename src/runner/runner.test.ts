import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../lib/types";
import { FileDb } from "./backend";
import { slimMessage } from "./live";
import { replyAfterLastUser, splitForTelegram, toTelegramHtml } from "./telegram";

describe("FileDb", () => {
  it("keeps documents across restarts, in insertion order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-runner-"));
    try {
      const a = new FileDb(dir);
      await a.put("bots", "b2", { id: "b2" });
      await a.put("bots", "b1", { id: "b1" });
      await a.put("msg:c1", "m1", { id: "m1", content: "hello world" });
      await a.delete("bots", "b2");
      a.flush();
      const b = new FileDb(dir);
      expect(await b.list("bots")).toEqual([{ id: "b1" }]);
      expect((await b.search("msg:", "WORLD", 10))[0].id).toBe("m1");
      expect(await b.get("msg:c1", "missing")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("telegram", () => {
  it("turns Markdown into Telegram's HTML", () => {
    expect(toTelegramHtml("**Done** with `x<y`\n```\na < b\n```")).toBe("<b>Done</b> with <code>x&lt;y</code>\n<pre>a &lt; b</pre>");
    expect(toTelegramHtml("# Plan\nSee [docs](https://a.com)")).toBe('<b>Plan</b>\nSee <a href="https://a.com">docs</a>');
  });

  it("splits long replies at paragraph breaks", () => {
    const parts = splitForTelegram(`${"a".repeat(3000)}\n\n${"b".repeat(3000)}`, 4000);
    expect(parts).toEqual(["a".repeat(3000), "b".repeat(3000)]);
  });

  it("answers with the reply after your last message", () => {
    const m = (role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: content, conversationId: "c", role, content, createdAt: 0, ...extra });
    expect(replyAfterLastUser([m("user", "q1"), m("assistant", "old"), m("user", "q2"), m("assistant", "step"), m("assistant", "final")]).text).toBe("final");
    expect(replyAfterLastUser([m("user", "q"), m("assistant", "", { error: "boom" })])).toEqual({ text: "", error: "boom" });
  });
});

describe("live relay", () => {
  it("trims tool output in live updates", () => {
    const msg: ChatMessage = { id: "a", conversationId: "c", role: "assistant", content: "", createdAt: 0, toolCalls: [{ id: "t", name: "shell", arguments: "{}", status: "done", result: "x".repeat(10_000) }] };
    expect(slimMessage(msg).toolCalls![0].result!.length).toBeLessThan(2500);
  });
});
