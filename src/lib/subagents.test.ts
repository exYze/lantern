import { describe, expect, it } from "vitest";
import { mapLimit, placeTools } from "./agent";
import type { HubToolInfo } from "./hub";
import type { OAMessage } from "./llm";
import { DELEGATE_TOOL, fitHistory, subagentTools } from "./subagents";
import { BUILTIN_TOOLS, toolEnabled } from "./tools";
import { DEFAULT_TOOLS, type Bot } from "./types";

const bot = (over: Partial<Bot> = {}): Bot => ({
  id: "bot_1",
  name: "Lumi",
  tagline: "",
  instructions: "",
  avatar: { shape: "circle", color: "#7c5cff", eyes: "dots", mouth: "smile" },
  tools: { ...DEFAULT_TOOLS },
  skillIds: [],
  mcpServerIds: [],
  secretNames: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const hub = (sandbox: boolean): HubToolInfo => ({ workspace: "/home/agent/workspace", shell: "/bin/bash", os: "Ubuntu", user: "agent", sandbox });
const mcpTool = { ...DELEGATE_TOOL, name: "mcp__git__status", group: "mcp" as const };

describe("subagents", () => {
  it("get the parent's tools minus long-term state, scheduling and more subagents", () => {
    const names = subagentTools([...BUILTIN_TOOLS, DELEGATE_TOOL, mcpTool], { isolated: false, canRunCommands: true }).map((t) => t.name);
    expect(names).toContain("shell");
    expect(names).toContain("read_file");
    expect(names).toContain("mcp__git__status");
    for (const gone of ["delegate_task", "remember", "create_routine", "create_skill", "search_conversations"]) expect(names).not.toContain(gone);
  });

  it("lose plugins when isolated, and the terminal when it can't be sandboxed", () => {
    const names = subagentTools([...BUILTIN_TOOLS, mcpTool], { isolated: true, canRunCommands: false }).map((t) => t.name);
    expect(names).not.toContain("mcp__git__status");
    expect(names).not.toContain("shell");
    expect(names).toContain("write_file");
  });

  it("is a tool for bots made before subagents existed", () => {
    const { subagents: _, ...oldTools } = DEFAULT_TOOLS;
    expect(toolEnabled(bot({ tools: oldTools }), "subagents")).toBe(true);
    expect(toolEnabled(bot({ tools: { ...DEFAULT_TOOLS, subagents: false } }), "subagents")).toBe(false);
  });

  it("trim the oldest tool output first when the history gets long", () => {
    const big = "x".repeat(20_000);
    const messages: OAMessage[] = [
      { role: "user", content: "task" },
      { role: "tool", tool_call_id: "a", content: big },
      { role: "tool", tool_call_id: "b", content: big },
    ];
    const out = fitHistory(messages, 7000);
    expect((out[1].content as string).length).toBeLessThan(1000);
    expect(out[2].content).toBe(big);
    expect(messages[1].content).toBe(big);
  });

  it("run at most `limit` at a time", async () => {
    let running = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5], 3, async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });
    expect(peak).toBe(3);
  });
});

describe("sandboxed bots", () => {
  it("work in their own folder on the hub with commands in a sandbox", () => {
    const place = placeTools(bot({ sandbox: { network: false } }), true, hub(true), "C:/Users/me/Lantern");
    expect(place.workspace).toBe("/home/agent/workspace/bots/bot_1");
    expect(place.confine).toBe(true);
    expect(place.sandbox).toEqual({ dir: "/home/agent/workspace/bots/bot_1", network: false });
    expect(place.noShell).toBe(false);
  });

  it("get no terminal when the hub can't sandbox, and no files or terminal off the hub", () => {
    const noBwrap = placeTools(bot({ sandbox: { network: true } }), true, hub(false), "C:/ws");
    expect(noBwrap.sandbox).toBeUndefined();
    expect(noBwrap.noShell).toBe(true);
    expect(noBwrap.noFiles).toBe(false);
    const offline = placeTools(bot({ sandbox: { network: true } }), false, undefined, "C:/ws");
    expect(offline.noFiles && offline.noShell).toBe(true);
  });

  it("are unaffected when the bot isn't sandboxed or runs its tools on the device", () => {
    expect(placeTools(bot(), true, hub(true), "C:/ws")).toMatchObject({ workspace: "/home/agent/workspace", confine: false, noShell: false });
    const device = placeTools(bot({ sandbox: { network: true }, computer: "device" }), false, undefined, "C:/ws");
    expect(device).toMatchObject({ workspace: "C:/ws", confine: false, noFiles: false, noShell: false });
  });
});
