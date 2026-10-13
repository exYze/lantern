// Chat with your bots from Telegram. The runner long-polls the Telegram Bot API
// (no public address needed), so it works from anywhere your phone has Telegram.
// Only chats you link with a one-time code from the app can talk to your bots.
// Approvals arrive as buttons; voice notes are transcribed with your speech server.

import { agentListeners } from "../lib/events";
import { httpRequest, secrets } from "../lib/platform";
import { appendMessage, createConversation, messagesOf, toast, updateSettings, useApp } from "../lib/store";
import { stopRun } from "../lib/agent";
import { answerApproval } from "../lib/store";
import { answerForm } from "../lib/forms";
import type { FormQuestion } from "../lib/types";
import type { Attachment, Bot, ChatMessage, TelegramSettings } from "../lib/types";
import { uid } from "../lib/util";
import { transcribe } from "../lib/voice";
import { runChat } from "./requests";

const API = (process.env.LANTERN_TELEGRAM_API || "https://api.telegram.org").replace(/\/+$/, "");
const MAX_TEXT = 4000;

let token: string | null = null;
let offset = 0;
let polling = false;
let generation = 0;
/** Approval buttons carry a short number instead of the tool call id (Telegram caps button data at 64 bytes). */
const approvalIds = new Map<number, { callId: string; conversationId: string }>();
let nextApproval = 1;
const typing = new Map<string, ReturnType<typeof setInterval>>();
/** One-question forms answered from Telegram: by button (choices) or by the next message (text). */
const pendingForms = new Map<number, { callId: string; question: FormQuestion; n: number }>();
const formIds = new Map<number, { callId: string; question: FormQuestion; chatId: number }>();
let nextForm = 1;
const warned = new Set<number>();

async function tg<T = any>(method: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  if (!token) throw new Error("no Telegram token");
  const res = await httpRequest({ method: "POST", url: `${API}/bot${token}/${method}`, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), timeoutMs });
  let j: any = null;
  try {
    j = JSON.parse(res.body);
  } catch {
    /* not JSON */
  }
  if (!j?.ok) {
    const err = new Error(`Telegram ${method}: ${j?.description ?? `HTTP ${res.status}`}`) as Error & { status?: number };
    err.status = j?.error_code ?? res.status;
    throw err;
  }
  return j.result as T;
}

function settingsOf(): TelegramSettings | undefined {
  return useApp.getState().settings.telegram;
}

async function saveTelegram(patch: Partial<TelegramSettings>) {
  const current = settingsOf() ?? { enabled: false, chats: [] };
  await updateSettings({ telegram: { ...current, ...patch } });
}

// ------------------------------------------------------------------ formatting

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Markdown to the small HTML subset Telegram understands. */
export function toTelegramHtml(md: string): string {
  const blocks: string[] = [];
  let s = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(`<pre>${esc(code.replace(/\n$/, ""))}</pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, "$1<i>$2</i>")
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]);
}

/** Splits long text at paragraph or line breaks so each piece fits in one message. */
export function splitForTelegram(text: string, max = MAX_TEXT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function say(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  for (const part of splitForTelegram(text || "(no text)")) {
    try {
      await tg("sendMessage", { chat_id: chatId, text: toTelegramHtml(part), parse_mode: "HTML", disable_web_page_preview: true, ...extra });
    } catch {
      // Telegram rejects HTML it can't parse; plain text always works.
      await tg("sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true, ...extra });
    }
  }
}

// ------------------------------------------------------------------ chats

function botFor(chat: TelegramSettings["chats"][number]): Bot | undefined {
  const s = useApp.getState();
  const tgs = settingsOf();
  const id = chat.botId ?? tgs?.botId ?? s.settings.primaryBotId;
  return s.bots.find((b) => b.id === id) ?? s.bots[0];
}

async function conversationFor(chatId: number): Promise<{ bot: Bot; conversationId: string } | null> {
  const tgs = settingsOf();
  const chat = tgs?.chats.find((c) => c.id === chatId);
  if (!chat) return null;
  const bot = botFor(chat);
  if (!bot) return null;
  const s = useApp.getState();
  const existing = chat.conversationId ? s.conversations.find((c) => c.id === chat.conversationId && c.botId === bot.id) : undefined;
  if (existing) return { bot, conversationId: existing.id };
  const conv = await createConversation(bot.id, `Telegram · ${chat.name}`, undefined, { channel: { kind: "telegram", chatId } });
  await saveTelegram({ chats: (settingsOf()?.chats ?? []).map((c) => (c.id === chatId ? { ...c, conversationId: conv.id } : c)) });
  return { bot, conversationId: conv.id };
}

async function download(fileId: string): Promise<{ data: Uint8Array<ArrayBuffer>; path: string }> {
  const file = await tg<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(`${API}/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
  return { data: new Uint8Array(await res.arrayBuffer()), path: file.file_path };
}

async function handleCommand(chatId: number, text: string): Promise<boolean> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ");
  const s = useApp.getState();
  switch (cmd.split("@")[0].toLowerCase()) {
    case "/help":
    case "/start":
      await say(chatId, "Talk to your Lantern bots here.\n\n/bots lists them\n/use <name> switches bot\n/new starts a fresh chat\n/stop stops the bot");
      return true;
    case "/bots":
      await say(chatId, s.bots.map((b) => `**${b.name}**${b.tagline ? `: ${b.tagline}` : ""}`).join("\n") || "No bots yet.");
      return true;
    case "/use": {
      const want = arg.toLowerCase();
      const bot = s.bots.find((b) => b.name.toLowerCase() === want) ?? s.bots.find((b) => b.name.toLowerCase().startsWith(want));
      if (!want || !bot) {
        await say(chatId, `Which bot? ${s.bots.map((b) => b.name).join(", ")}`);
        return true;
      }
      await saveTelegram({ chats: (settingsOf()?.chats ?? []).map((c) => (c.id === chatId ? { ...c, botId: bot.id, conversationId: undefined } : c)) });
      await say(chatId, `You're now talking to **${bot.name}**.`);
      return true;
    }
    case "/new":
      await saveTelegram({ chats: (settingsOf()?.chats ?? []).map((c) => (c.id === chatId ? { ...c, conversationId: undefined } : c)) });
      await say(chatId, "New chat started.");
      return true;
    case "/stop": {
      const id = settingsOf()?.chats.find((c) => c.id === chatId)?.conversationId;
      if (id) stopRun(id);
      await say(chatId, "Stopped.");
      return true;
    }
  }
  return false;
}

async function handleMessage(msg: any) {
  const chatId: number = msg.chat.id;
  const text: string = msg.text ?? msg.caption ?? "";
  const tgs = settingsOf();
  const allowed = tgs?.chats.some((c) => c.id === chatId);

  if (!allowed) {
    const code = text.match(/^\/(?:link|start)\s+([A-Za-z0-9-]+)/)?.[1];
    const norm = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code && tgs?.linkCode && norm(code) === norm(tgs.linkCode)) {
      const name = msg.chat.title ?? [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") ?? msg.chat.username ?? String(chatId);
      // Each code links one chat.
      await saveTelegram({ chats: [...(tgs.chats ?? []), { id: chatId, name }], linkCode: undefined });
      const bot = botFor({ id: chatId, name });
      await say(chatId, `Linked. You're talking to **${bot?.name ?? "your bots"}**. Send /help for commands.`);
      toast(`Telegram chat “${name}” linked.`, "success");
      return;
    }
    if (!warned.has(chatId)) {
      warned.add(chatId);
      await say(chatId, "This bot is private. To use it, open Lantern, go to Settings → Telegram, and send the link command shown there.");
    }
    return;
  }

  if (text.startsWith("/") && (await handleCommand(chatId, text))) return;

  // The answer to a question the bot asked here.
  const pending = pendingForms.get(chatId);
  if (pending && text && !msg.photo && !msg.voice) {
    pendingForms.delete(chatId);
    formIds.delete(pending.n);
    answerForm(pending.callId, { [pending.question.id]: text });
    return;
  }

  const target = await conversationFor(chatId);
  if (!target) return;
  const attachments: Attachment[] = [];
  let content = text;
  try {
    if (msg.photo?.length) {
      const best = msg.photo[msg.photo.length - 1];
      const { data } = await download(best.file_id);
      attachments.push({ id: uid("att"), name: "photo.jpg", mime: "image/jpeg", size: data.length, kind: "image", data: `data:image/jpeg;base64,${Buffer.from(data).toString("base64")}` });
    }
    if (msg.voice || msg.audio) {
      const media = msg.voice ?? msg.audio;
      const { data } = await download(media.file_id);
      const s = useApp.getState();
      const words = await transcribe(new Blob([data], { type: media.mime_type ?? "audio/ogg" }), s.settings, s.providers);
      content = [content, words].filter(Boolean).join("\n\n");
    }
  } catch (e) {
    await say(chatId, `I couldn't read that attachment: ${(e as Error).message}`);
    if (!content) return;
  }
  if (!content && !attachments.length) return;

  const message: ChatMessage = {
    id: uid("msg"),
    conversationId: target.conversationId,
    role: "user",
    content,
    attachments: attachments.length ? attachments : undefined,
    via: "telegram",
    createdAt: Date.now(),
  };
  await appendMessage(message);
  startTyping(chatId, target.conversationId);
  await runChat(target.conversationId);
}

async function handleCallback(q: any) {
  const chatId: number | undefined = q.message?.chat?.id;
  const [kind, n, answer] = String(q.data ?? "").split(":");
  if (kind === "fm") {
    const f = formIds.get(Number(n));
    const option = f?.question.options?.[Number(answer)];
    if (!f || !chatId || f.chatId !== chatId || option === undefined) {
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: "This question has expired." }).catch(() => {});
      return;
    }
    formIds.delete(Number(n));
    pendingForms.delete(chatId);
    answerForm(f.callId, { [f.question.id]: option });
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: option }).catch(() => {});
    await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return;
  }
  const pending = approvalIds.get(Number(n));
  if (kind !== "ap" || !chatId || !settingsOf()?.chats.some((c) => c.id === chatId) || !pending) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "This request has expired." }).catch(() => {});
    return;
  }
  const map: Record<string, "allow" | "always-bot" | "deny"> = { a: "allow", A: "always-bot", d: "deny" };
  answerApproval(pending.callId, map[answer] ?? "deny");
  approvalIds.delete(Number(n));
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: answer === "d" ? "Denied" : "Allowed" }).catch(() => {});
  await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  await say(chatId, answer === "d" ? "Denied." : answer === "A" ? "Allowed, and I'll stop asking about this." : "Allowed.").catch(() => {});
}

function startTyping(chatId: number, conversationId: string) {
  if (typing.has(conversationId)) return;
  const ping = () => void tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  ping();
  typing.set(conversationId, setInterval(ping, 4500));
}

function stopTyping(conversationId: string) {
  const t = typing.get(conversationId);
  if (t) clearInterval(t);
  typing.delete(conversationId);
}

function chatOf(conversationId: string): number | undefined {
  const conv = useApp.getState().conversations.find((c) => c.id === conversationId);
  return conv?.channel?.kind === "telegram" ? conv.channel.chatId : undefined;
}

/** Replies that came after the last message from the user. */
export function replyAfterLastUser(list: ChatMessage[]): { text: string; error?: string } {
  const lastUser = list.map((m) => m.role).lastIndexOf("user");
  const after = list.slice(lastUser + 1).filter((m) => m.role === "assistant");
  const error = [...after].reverse().find((m) => m.error)?.error;
  const text = [...after].reverse().find((m) => m.content.trim())?.content.trim() ?? "";
  return { text, error };
}

// ------------------------------------------------------------------ loop

async function poll(gen: number) {
  polling = true;
  let failures = 0;
  while (gen === generation && token) {
    try {
      const updates = await tg<any[]>("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, 65_000);
      failures = 0;
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          if (u.message) await handleMessage(u.message);
          else if (u.callback_query) await handleCallback(u.callback_query);
        } catch (e) {
          console.warn("telegram: update failed:", (e as Error).message);
        }
      }
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 404) {
        console.warn("telegram: the bot token was refused; stopping until it changes");
        await saveTelegram({ username: undefined });
        break;
      }
      failures++;
      await new Promise((r) => setTimeout(r, Math.min(60_000, 2000 * failures)));
    }
  }
  polling = false;
}

async function restart() {
  const tgs = settingsOf();
  const next = tgs?.enabled ? await secrets.get("telegram:token") : null;
  if (next === token && (polling || !next)) return;
  generation++;
  token = next;
  if (!token) return;
  try {
    const me = await tg<{ username: string }>("getMe", {});
    if (settingsOf()?.username !== me.username) await saveTelegram({ username: me.username });
    console.log(`telegram: connected as @${me.username}`);
    void poll(generation);
  } catch (e) {
    console.warn("telegram:", (e as Error).message);
    token = null;
  }
}

export function startTelegram() {
  void restart();
  // Pick up a new token or the switch being turned on or off.
  useApp.subscribe((s, prev) => s.settings.telegram !== prev.settings.telegram && void restart());
  setInterval(() => void restart(), 60_000);

  agentListeners.add((e) => {
    const chatId = chatOf(e.conversationId);
    if (chatId === undefined || !token) return;
    if (e.type === "approval") {
      const n = nextApproval++;
      approvalIds.set(n, { callId: e.callId, conversationId: e.conversationId });
      const bot = useApp.getState().bots.find((b) => b.id === e.botId);
      void say(chatId, `**${bot?.name ?? "Your bot"}** wants to: ${e.summary}`, {
        reply_markup: { inline_keyboard: [[{ text: "Allow once", callback_data: `ap:${n}:a` }, { text: "Always allow", callback_data: `ap:${n}:A` }, { text: "Deny", callback_data: `ap:${n}:d` }]] },
      }).catch((err) => console.warn("telegram: approval message failed:", err));
    } else if (e.type === "input") {
      const bot = useApp.getState().bots.find((b) => b.id === e.botId);
      const [only] = e.form.questions;
      const simple = e.form.questions.length === 1 && only.kind !== "secret" && only.kind !== "multi";
      if (!simple) {
        void say(chatId, `**${bot?.name ?? "Your bot"}** needs a few answers (“${e.form.title}”). Open Lantern to fill in the form.`).catch(() => {});
        return;
      }
      const n = nextForm++;
      formIds.set(n, { callId: e.callId, question: only, chatId });
      pendingForms.set(chatId, { callId: e.callId, question: only, n });
      const buttons = only.kind === "choice" ? only.options!.map((o, i) => [{ text: o.slice(0, 60), callback_data: `fm:${n}:${i}` }]) : null;
      void say(chatId, `**${bot?.name ?? "Your bot"}** asks: ${only.label}${buttons ? "" : "\n\nReply with your answer."}`, buttons ? { reply_markup: { inline_keyboard: buttons } } : {}).catch(() => {});
    } else if (e.type === "run-end") {
      stopTyping(e.conversationId);
      if (e.outcome === "stopped") return;
      const reply = replyAfterLastUser(messagesOf(e.conversationId));
      void say(chatId, reply.error && !reply.text ? `Something went wrong: ${reply.error}` : reply.text || "Done.").catch((err) => console.warn("telegram: reply failed:", err));
    }
  });
}
