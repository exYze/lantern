// Email tools for a bot with its own inbox: list and read its mail, and send
// mail (which asks for approval like any action that leaves your hands).
// The hub speaks IMAP and SMTP; the password stays in your secret store.

import { hubConnection, hubMail, type MailAccountRequest } from "./hub";
import { secrets } from "./platform";
import type { ToolDef } from "./tools";
import type { Bot } from "./types";

export const emailSecretKey = (botId: string) => `email:${botId}`;

export async function mailAccount(bot: Bot): Promise<MailAccountRequest> {
  const e = bot.email;
  if (!e) throw new Error(`${bot.name} doesn't have an inbox. Add one in its settings (Email tab).`);
  const password = await secrets.get(emailSecretKey(bot.id));
  if (!password) throw new Error(`The password for ${e.address} is missing. Enter it again in ${bot.name}'s Email tab.`);
  return {
    address: e.address,
    username: e.username || e.address,
    password,
    imapHost: e.imapHost,
    imapPort: e.imapPort,
    imapSecurity: e.imapSecurity ?? "tls",
    smtpHost: e.smtpHost,
    smtpPort: e.smtpPort,
    smtpSecurity: e.smtpSecurity,
  };
}

const hasInbox = (bot: Bot) => !!bot.email && !!hubConnection();

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : [])
    .map((s) => String(s).trim())
    .filter(Boolean);

export const EMAIL_TOOLS: ToolDef[] = [
  {
    name: "email_list",
    group: "email",
    risk: "network",
    available: hasInbox,
    description: "List the newest messages in your own email inbox: id, sender, subject, date, and whether you've read it.",
    parameters: {
      type: "object",
      properties: { unread_only: { type: "boolean" }, limit: { type: "integer", description: "Default 15, max 50" }, folder: { type: "string", description: "Default INBOX" } },
      additionalProperties: false,
    },
    summarize: (a) => (a.unread_only ? "Check for new email" : "List email"),
    async run(a, ctx) {
      const r = await hubMail.list(await mailAccount(ctx.bot), { folder: typeof a.folder === "string" ? a.folder : undefined, limit: Math.min(Number(a.limit) || 15, 50), unreadOnly: !!a.unread_only });
      if (!r.messages.length) return a.unread_only ? "No unread email." : "The inbox is empty.";
      return [`${r.total} messages in the folder. Newest first:`, ...r.messages.map((m) => `[${m.uid}] ${m.seen ? "" : "(unread) "}${m.date.slice(0, 16).replace("T", " ")} · ${m.from} · ${m.subject || "(no subject)"}`)].join("\n");
    },
  },
  {
    name: "email_read",
    group: "email",
    risk: "network",
    available: hasInbox,
    description: "Read one message from your inbox by its id (from email_list). Marks it as read.",
    parameters: { type: "object", properties: { id: { type: "integer" }, folder: { type: "string" } }, required: ["id"], additionalProperties: false },
    summarize: (a) => `Read email ${a.id}`,
    async run(a, ctx) {
      const m = await hubMail.read(await mailAccount(ctx.bot), Number(a.id), { folder: typeof a.folder === "string" ? a.folder : undefined, markSeen: true });
      const files = m.attachments.length ? `\nAttachments: ${m.attachments.map((f) => `${f.name} (${f.type}, ${f.size} bytes)`).join(", ")}` : "";
      return `From: ${m.from}\nTo: ${m.to}${m.cc ? `\nCc: ${m.cc}` : ""}\nDate: ${m.date}\nSubject: ${m.subject}${files}\n\n${m.text || "(no text)"}`;
    },
  },
  {
    name: "email_send",
    group: "email",
    risk: "exec",
    available: hasInbox,
    description: "Send an email from your own address. To answer a message, pass its id as reply_to so the reply stays in the same thread.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text" },
        reply_to: { type: "integer", description: "Id of the message you're answering" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
    summarize: (a) => `Email ${list(a.to).join(", ") || "someone"}: “${typeof a.subject === "string" ? a.subject : ""}”`,
    async run(a, ctx) {
      const account = await mailAccount(ctx.bot);
      const to = list(a.to);
      if (!to.length) throw new Error("Add at least one recipient in `to`.");
      let inReplyTo: string | undefined;
      if (a.reply_to !== undefined) inReplyTo = (await hubMail.read(account, Number(a.reply_to))).messageId || undefined;
      await hubMail.send(account, { to, cc: list(a.cc), subject: String(a.subject ?? ""), body: String(a.body ?? ""), inReplyTo });
      return `Sent to ${to.join(", ")}.`;
    },
  },
];
