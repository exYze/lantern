#!/usr/bin/env node
// A tiny OpenAI-compatible server for testing Lantern without a real model.
//   node scripts/mock-llm.mjs [port]        → http://localhost:11500/v1
// Models: "mock-tools" (uses tools) and "mock-chat" (rejects the tools parameter).

import http from "node:http";

const port = Number(process.argv[2] ?? 11500);

const MODELS = ["mock-tools", "mock-chat"];

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ");
  return "";
}

let callSeq = 0;

/** Decides what the "model" does next, based on the conversation so far. */
function plan(body) {
  const msgs = body.messages ?? [];
  const system = textOf(msgs[0]?.content);
  const last = msgs[msgs.length - 1];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const ask = textOf(lastUser?.content).toLowerCase();
  const hasTool = (name) => (body.tools ?? []).some((t) => t.function?.name === name);

  if (system.includes("safety reviewer")) {
    const risky = /rm -rf|del |format|shutdown/.test(textOf(last?.content));
    return { text: JSON.stringify({ verdict: risky ? "ask" : "allow", reason: risky ? "Deletes files." : "Routine, reversible action." }) };
  }

  if (last?.role === "tool") {
    const result = textOf(last.content);
    return {
      reasoning: "The tool returned a result; summarize it for the user.",
      text: `Here's what I found:\n\n\`\`\`\n${result.slice(0, 400)}\n\`\`\`\n\n| Step | Status |\n|---|---|\n| Tool call | ✅ done |\n| Summary | ✅ written |\n\nAll done.`,
    };
  }

  const tool = (name, args) => (hasTool(name) ? { toolCalls: [{ name, args }] } : null);
  if (ask.includes("list")) return tool("list_dir", {}) ?? { text: "I can't list files without tools." };
  if (ask.includes("shell") || ask.includes("command")) return tool("shell", { command: "echo hello from Lantern" }) ?? { text: "No shell here." };
  if (ask.includes("delete")) return tool("shell", { command: "rm -rf ./build" }) ?? { text: "No shell here." };
  if (ask.includes("secret")) {
    const ps = system.includes("Shell: PowerShell");
    return tool("shell", { command: ps ? 'echo "token=$env:LANTERN_TEST"' : 'echo "token=$LANTERN_TEST"' }) ?? { text: "No shell here." };
  }
  if (ask.includes("mcp")) {
    const mcp = (body.tools ?? []).find((t) => t.function?.name?.startsWith("mcp__"));
    return mcp ? { toolCalls: [{ name: mcp.function.name, args: { a: 2, b: 3 } }] } : { text: "No MCP tools are connected." };
  }
  if (ask.includes("remember")) return tool("remember", { content: "The user likes concise answers." }) ?? { text: "Noted (no memory tool)." };
  if (ask.includes("search")) return tool("web_search", { query: "open source llm" }) ?? { text: "No search." };
  if (ask.includes("routine")) return tool("create_routine", { name: "Daily check-in", prompt: "Say good morning.", schedule: { kind: "daily", time: "08:00" } }) ?? { text: "No routines." };

  return {
    reasoning: "The user greeted me. I'll show what I can render.",
    text: [
      `Hi! I'm a **mock model** answering: _${ask.slice(0, 80) || "(empty)"}_`,
      "",
      "Here's some math: $E = mc^2$ and",
      "",
      "$$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$",
      "",
      "```python",
      "def greet(name):",
      '    return f"Hello, {name}!"',
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "  User --> Lantern --> Model",
      "```",
    ].join("\n"),
    thinkInline: body.model === "mock-chat",
  };
}

function chunk(model, delta, finish = null) {
  return `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function stream(res, body, p) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const model = body.model;
  res.write(chunk(model, { role: "assistant" }));
  if (p.reasoning && !p.thinkInline) {
    for (const w of p.reasoning.split(/(?<= )/)) {
      res.write(chunk(model, { reasoning_content: w }));
      await wait(8);
    }
  }
  if (p.text) {
    const text = p.thinkInline && p.reasoning ? `<think>${p.reasoning}</think>${p.text}` : p.text;
    for (let i = 0; i < text.length; i += 6) {
      res.write(chunk(model, { content: text.slice(i, i + 6) }));
      await wait(6);
    }
  }
  if (p.toolCalls) {
    p.toolCalls.forEach((c, index) => {
      const args = JSON.stringify(c.args);
      const half = Math.ceil(args.length / 2);
      res.write(chunk(model, { tool_calls: [{ index, id: `call_${++callSeq}`, type: "function", function: { name: c.name, arguments: args.slice(0, half) } }] }));
      res.write(chunk(model, { tool_calls: [{ index, function: { arguments: args.slice(half) } }] }));
    });
  }
  res.write(chunk(model, {}, p.toolCalls ? "tool_calls" : "stop"));
  res.write(`data: ${JSON.stringify({ id: "mock", choices: [], usage: { prompt_tokens: 42, completion_tokens: 17 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");
  const path = req.url.replace(/\?.*$/, "");
  if (req.method === "GET" && path === "/v1/models") {
    return send(res, 200, { object: "list", data: MODELS.map((id) => ({ id, object: "model", owned_by: "mock" })) });
  }
  let raw = [];
  req.on("data", (c) => raw.push(c));
  req.on("end", async () => {
    if (path === "/v1/audio/transcriptions") return send(res, 200, { text: "This is a transcribed voice memo." });
    if (path !== "/v1/chat/completions") return send(res, 404, { error: { message: `No route ${path}` } });
    let body;
    try {
      body = JSON.parse(Buffer.concat(raw).toString("utf8"));
    } catch {
      return send(res, 400, { error: { message: "invalid JSON" } });
    }
    if (body.model === "mock-chat" && body.tools?.length) {
      return send(res, 400, { error: { message: `registry.example/${body.model} does not support tools` } });
    }
    const p = plan(body);
    if (body.stream === false) {
      return send(res, 200, { id: "mock", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: p.text ?? "" }, finish_reason: "stop" }] });
    }
    await stream(res, body, p);
  });
});

server.listen(port, () => console.log(`mock LLM listening on http://localhost:${port}/v1`));
