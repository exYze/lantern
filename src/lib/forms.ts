// Forms in the chat: a bot asks for several answers at once (choices,
// checkboxes, text, dates) instead of a wall of questions in prose. Secret
// fields (passwords, codes) are saved as the bot's secrets on your device and
// never reach the model: it gets the secret's name, which it can use as
// {{NAME}} in the browser or $NAME in commands.

import { emitAgentEvent } from "./events";
import { appVisible, notify, secrets } from "./platform";
import { botSecretKey, remoteForm, useApp } from "./store";
import type { ToolContext, ToolDef } from "./tools";
import type { ChatForm, FormQuestion, FormValue } from "./types";

const KINDS = new Set<FormQuestion["kind"]>(["choice", "multi", "text", "long-text", "number", "date", "secret"]);
const MAX_QUESTIONS = 12;

/** A name a secret can be saved under: letters, digits and underscores. */
export function secretNameFor(q: FormQuestion): string {
  const base = (q.saveAs || q.label || q.id).toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const name = /^[A-Z_]/.test(base) ? base : `S_${base}`;
  return name.slice(0, 64) || "FORM_SECRET";
}

/** Cleans up what the model sent: known kinds, unique ids, options where they're needed. */
export function normalizeForm(a: Record<string, unknown>): ChatForm {
  const raw = Array.isArray(a.questions) ? a.questions : [];
  const seen = new Set<string>();
  const questions: FormQuestion[] = [];
  for (const [i, q] of raw.slice(0, MAX_QUESTIONS).entries()) {
    if (!q || typeof q !== "object") continue;
    const r = q as Record<string, unknown>;
    let kind = (typeof r.kind === "string" ? r.kind : "text") as FormQuestion["kind"];
    if (!KINDS.has(kind)) kind = "text";
    const options = Array.isArray(r.options) ? r.options.map(String).filter(Boolean).slice(0, 20) : undefined;
    if ((kind === "choice" || kind === "multi") && !options?.length) kind = "text";
    let id = (typeof r.id === "string" && r.id.trim() ? r.id.trim() : `q${i + 1}`).slice(0, 40);
    while (seen.has(id)) id += "_";
    seen.add(id);
    questions.push({
      id,
      label: String(r.label ?? r.question ?? `Question ${i + 1}`).slice(0, 300),
      kind,
      options: kind === "choice" || kind === "multi" ? options : undefined,
      placeholder: typeof r.placeholder === "string" ? r.placeholder.slice(0, 120) : undefined,
      required: r.required === true,
      saveAs: kind === "secret" && typeof r.save_as === "string" ? r.save_as : undefined,
    });
  }
  if (!questions.length) throw new Error("A form needs at least one question.");
  return { title: String(a.title ?? "A few questions").slice(0, 120), questions };
}

/** What the model reads back: each answer, with secrets only by name. */
export function describeAnswers(form: ChatForm, answers: Record<string, FormValue> | null): string {
  if (!answers) return "The user closed the form without answering. Don't ask again right away; continue with what you have or ask in plain words.";
  const lines = [`The user answered "${form.title}":`];
  for (const q of form.questions) {
    const v = answers[q.id];
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) lines.push(`- ${q.label}: (no answer)`);
    else if (typeof v === "object" && !Array.isArray(v)) lines.push(`- ${q.label}: saved as the secret ${v.secret}. Type it with {{${v.secret}}} in the browser, or use $${v.secret} in commands; never ask for its value.`);
    else lines.push(`- ${q.label}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------ waiting for answers

const waiters = new Map<string, (answers: Record<string, FormValue> | null) => void>();

function waitForAnswers(callId: string, signal: AbortSignal): Promise<Record<string, FormValue> | null> {
  return new Promise((resolve) => {
    const onAbort = () => {
      waiters.delete(callId);
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    waiters.set(callId, (answers) => {
      signal.removeEventListener("abort", onAbort);
      waiters.delete(callId);
      resolve(answers);
    });
  });
}

/** Delivers answers to a form, here or (through the hub) to the runner. Secrets must already be saved. */
export function answerForm(callId: string, answers: Record<string, FormValue> | null, conversationId?: string) {
  const local = waiters.get(callId);
  if (local) {
    local(answers);
    return;
  }
  if (conversationId && remoteForm.send) void remoteForm.send(conversationId, callId, answers);
}

export function isWaitingForAnswers(callId: string): boolean {
  return waiters.has(callId);
}

/** Saves the secret fields as the bot's secrets and returns the answers with only their names. */
export async function storeSecretAnswers(botId: string, form: ChatForm, values: Record<string, string | string[]>): Promise<Record<string, FormValue>> {
  const answers: Record<string, FormValue> = {};
  const { bots } = useApp.getState();
  const bot = bots.find((b) => b.id === botId);
  const added: string[] = [];
  for (const q of form.questions) {
    const v = values[q.id];
    if (q.kind === "secret") {
      if (typeof v !== "string" || !v) continue;
      const name = secretNameFor(q);
      await secrets.set(botSecretKey(botId, name), v);
      added.push(name);
      answers[q.id] = { secret: name };
    } else if (v !== undefined) {
      answers[q.id] = v;
    }
  }
  if (bot && added.some((n) => !bot.secretNames.includes(n))) {
    const { saveBot } = await import("./store");
    await saveBot({ ...bot, secretNames: [...new Set([...bot.secretNames, ...added])] });
  }
  return answers;
}

export const ASK_USER_TOOL: ToolDef = {
  name: "ask_user",
  group: "forms",
  risk: "internal",
  description:
    "Ask the user something with a form in the chat, when you need answers to go on: choices, checkboxes, short text, a number or a date. Use kind 'secret' for passwords, codes and keys: it's saved as one of your secrets and you get its name, never its value. Ask everything you need at once; keep it short. Wait for the answers before going on.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "What the form is for, a few words" },
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string", description: "The question" },
            kind: { type: "string", enum: ["choice", "multi", "text", "long-text", "number", "date", "secret"] },
            options: { type: "array", items: { type: "string" }, description: "For choice (pick one) and multi (pick any)" },
            placeholder: { type: "string" },
            required: { type: "boolean" },
            save_as: { type: "string", description: "secret: the name to save it under, like SITE_PASSWORD" },
          },
          required: ["label", "kind"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "questions"],
    additionalProperties: false,
  },
  summarize: (a) => `Ask: ${typeof a.title === "string" ? a.title : "a few questions"}`,
  async run(a, ctx: ToolContext) {
    const form = normalizeForm(a);
    const callId = ctx.callId ?? "";
    ctx.onProgress?.({ status: "awaiting-input", form }, true);
    if (!appVisible()) void notify(`${ctx.bot.name} has a question for you`, form.title);
    emitAgentEvent({ type: "input", conversationId: ctx.conversationId, botId: ctx.bot.id, callId, form });
    const answers = await waitForAnswers(callId, ctx.signal);
    if (ctx.signal.aborted) throw new DOMException("Stopped", "AbortError");
    // Secrets the user just saved: available to this run's commands and browser right away.
    for (const v of Object.values(answers ?? {})) {
      if (typeof v === "object" && !Array.isArray(v)) {
        let value: string | null = null;
        // On the hub, the secret arrives through sync alongside the answer; give it a moment.
        for (let i = 0; i < 20 && value === null; i++) {
          value = await secrets.get(botSecretKey(ctx.bot.id, v.secret));
          if (value === null) await new Promise((r) => setTimeout(r, 250));
        }
        if (value !== null) {
          ctx.env[v.secret] = value;
          if (value.length >= 4) ctx.secretValues?.push(value);
        }
      }
    }
    ctx.onProgress?.({ status: "running", form: { ...form, answers: answers ?? undefined, answeredAt: Date.now() } }, true);
    return describeAnswers(form, answers);
  },
};
