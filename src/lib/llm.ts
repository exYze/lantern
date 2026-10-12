// Client for OpenAI-compatible chat servers: Ollama, llama.cpp, vLLM, LM Studio,
// LocalAI, Jan, SGLang, text-generation-webui, OpenRouter, Together, Groq, …

import { httpRequest, httpStream } from "./platform";
import { secrets } from "./platform";
import { SseParser, ThinkSplitter } from "./sse";
import type { Provider } from "./types";

export type OAContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface OAToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OAMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OAContentPart[] | null;
  tool_calls?: OAToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OATool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface StreamDelta {
  content?: string;
  reasoning?: string;
  toolCalls?: OAToolCall[];
}

export interface CompletionResult {
  content: string;
  reasoning: string;
  toolCalls: OAToolCall[];
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export class LlmError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: string,
    public toolsUnsupported = false,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export function apiKeyName(providerId: string): string {
  return `provider:${providerId}`;
}

/** Request headers for a provider; `apiKey` overrides the stored key (used to test before saving). */
export async function providerHeaders(provider: Provider, apiKey?: string | null): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Title": "Lantern", ...(provider.headers ?? {}) };
  const key = apiKey !== undefined ? apiKey : provider.hasKey ? await secrets.get(apiKeyName(provider.id)) : null;
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export function endpoint(baseUrl: string, path: string): string {
  return baseUrl.trim().replace(/\/+$/, "") + path;
}

function errorMessage(status: number, body: string): string {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail;
    if (m) return `${status}: ${typeof m === "string" ? m : JSON.stringify(m)}`;
  } catch {
    /* not JSON */
  }
  return `${status}: ${body.slice(0, 500) || "request failed"}`;
}

/** Recognizes "this model/server can't do tool calling" errors from the common servers. */
export function looksLikeToolsUnsupported(status: number, body: string): boolean {
  if (status < 400) return false;
  return /does not support tools|tool[s_ ]?(choice|call|calling|use)?[^.]{0,60}(not supported|unsupported|requires|enable)|--jinja|enable-auto-tool-choice|tools? (are|is) not (supported|enabled)/i.test(
    body,
  );
}

/** Accumulates streamed tool-call fragments (OpenAI sends them split by index). */
export class ToolCallAccumulator {
  private calls: OAToolCall[] = [];

  push(deltas: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string | object } }>) {
    for (const d of deltas) {
      let i = typeof d.index === "number" ? d.index : -1;
      if (i < 0) i = d.id ? this.calls.findIndex((c) => c.id === d.id) : -1;
      if (i < 0) i = this.calls.length;
      const call = (this.calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (d.id) call.id = d.id;
      if (d.function?.name) call.function.name += d.function.name;
      const args = d.function?.arguments;
      if (args !== undefined) call.function.arguments += typeof args === "string" ? args : JSON.stringify(args);
    }
  }

  result(): OAToolCall[] {
    return this.calls
      .filter((c) => c && c.function.name)
      .map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
  }
}

export interface ChatRequest {
  provider: Provider;
  model: string;
  messages: OAMessage[];
  tools?: OATool[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  onDelta?: (d: StreamDelta) => void;
}

export async function chatCompletion(req: ChatRequest): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools?.length) body.tools = req.tools;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.jsonMode) body.response_format = { type: "json_object" };

  const headers = await providerHeaders(req.provider);
  headers.Accept = "text/event-stream, application/json";

  const sse = new SseParser();
  const think = new ThinkSplitter();
  const tools = new ToolCallAccumulator();
  const result: CompletionResult = { content: "", reasoning: "", toolCalls: [] };
  let status = 0;
  let isEventStream = true;
  let raw = "";
  let streamError: LlmError | null = null;

  const emit = (content: string, reasoning: string) => {
    if (!content && !reasoning) return;
    result.content += content;
    result.reasoning += reasoning;
    req.onDelta?.({ content: content || undefined, reasoning: reasoning || undefined });
  };

  const handle = (payload: string) => {
    if (payload.trim() === "[DONE]") return;
    let j: any;
    try {
      j = JSON.parse(payload);
    } catch {
      return;
    }
    if (j.error) {
      const msg = errorMessage(status >= 400 ? status : 500, JSON.stringify(j));
      streamError ??= new LlmError(msg, status, payload, looksLikeToolsUnsupported(400, payload));
      return;
    }
    if (j.usage) result.usage = { promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens };
    const choice = j.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? choice.message ?? {};
    const reasoning: string = delta.reasoning_content ?? delta.reasoning ?? "";
    const split = typeof delta.content === "string" ? think.push(delta.content) : { content: "", reasoning: "" };
    emit(split.content, reasoning + split.reasoning);
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      tools.push(delta.tool_calls);
      req.onDelta?.({ toolCalls: tools.result() });
    }
    if (choice.finish_reason) result.finishReason = choice.finish_reason;
  };

  status = await httpStream(
    { method: "POST", url: endpoint(req.provider.baseUrl, "/chat/completions"), headers, body: JSON.stringify(body) },
    {
      signal: req.signal,
      onResponse: (s, h) => {
        status = s;
        isEventStream = s < 400 && !(h["content-type"] ?? "").includes("application/json");
      },
      onChunk: (text) => {
        if (!isEventStream) {
          raw += text;
          return;
        }
        for (const p of sse.feed(text)) handle(p);
      },
    },
  );

  if (status >= 400) {
    throw new LlmError(errorMessage(status, raw), status, raw, looksLikeToolsUnsupported(status, raw));
  }
  if (isEventStream) {
    for (const p of sse.end()) handle(p);
  } else if (raw) {
    // Server ignored `stream: true` and answered with a single JSON body.
    handle(raw);
  }
  if (streamError) throw streamError;
  const tail = think.flush();
  emit(tail.content, tail.reasoning);
  // Some models omit the opening <think> and only emit the closing tag.
  const close = result.content.indexOf("</think>");
  if (close !== -1 && !result.reasoning && !result.content.slice(0, close).includes("<think>")) {
    result.reasoning = result.content.slice(0, close).trim();
    result.content = result.content.slice(close + "</think>".length).trimStart();
  }
  result.toolCalls = tools.result();
  return result;
}

/** One-shot, non-streaming helper (used for auto-review and titles). */
export async function complete(
  provider: Provider,
  model: string,
  messages: OAMessage[],
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const r = await chatCompletion({ provider, model, messages, temperature: opts.temperature ?? 0, maxTokens: opts.maxTokens, signal: opts.signal });
  return r.content.trim();
}

/** Lists models from /models, falling back to Ollama's native /api/tags. */
export async function listModels(provider: Provider, apiKey?: string | null): Promise<string[]> {
  const headers = await providerHeaders(provider, apiKey);
  const res = await httpRequest({ url: endpoint(provider.baseUrl, "/models"), headers, timeoutMs: 15000 });
  if (res.status < 400) {
    try {
      const j = JSON.parse(res.body);
      const items: any[] = j.data ?? j.models ?? [];
      const ids = items.map((m) => (typeof m === "string" ? m : m.id ?? m.name)).filter(Boolean);
      if (ids.length) return [...new Set<string>(ids)].sort((a, b) => a.localeCompare(b));
    } catch {
      /* fall through */
    }
  }
  if (/\/v1\/?$/.test(provider.baseUrl)) {
    const tags = await httpRequest({ url: provider.baseUrl.replace(/\/v1\/?$/, "") + "/api/tags", headers, timeoutMs: 15000 }).catch(() => null);
    if (tags && tags.status < 400) {
      const j = JSON.parse(tags.body);
      const names: string[] = (j.models ?? []).map((m: any) => m.name ?? m.model).filter(Boolean);
      if (names.length) return names.sort((a, b) => a.localeCompare(b));
    }
  }
  throw new LlmError(errorMessage(res.status, res.body), res.status, res.body);
}
