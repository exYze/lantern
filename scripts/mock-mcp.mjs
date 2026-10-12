#!/usr/bin/env node
// A minimal stdio MCP server for testing Lantern's plugin support.
// Add it in Plugins → Custom server with command `node` and argument `scripts/mock-mcp.mjs` (absolute path).

import readline from "node:readline";

const tools = [
  {
    name: "add",
    description: "Add two numbers",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    annotations: { title: "Add numbers", readOnlyHint: true },
  },
  {
    name: "shout",
    description: "Return the text in upper case",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return; // notification
  switch (req.method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-mcp", version: "1.0.0" } } });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: req.id, result: { tools } });
    case "tools/call": {
      const { name, arguments: args = {} } = req.params ?? {};
      if (name === "add") return send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] } });
      if (name === "shout") return send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: String(args.text ?? "").toUpperCase() }] } });
      return send({ jsonrpc: "2.0", id: req.id, result: { isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] } });
    }
    case "ping":
      return send({ jsonrpc: "2.0", id: req.id, result: {} });
    default:
      return send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  }
});
