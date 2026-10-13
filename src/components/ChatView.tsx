import { ArrowRight, ChevronLeft, MessageSquarePlus, PanelRightOpen, Server, ShieldCheck, Users } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { sendUserMessage, stopRun } from "../lib/agent";
import { capabilities } from "../lib/platform";
import { createConversation, isBusy, loadMessages, openConversation, saveBot, setView, updateConversation, useApp } from "../lib/store";
import { TEMPLATES } from "../lib/templates";
import type { ApprovalMode, Attachment, Bot } from "../lib/types";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { MessageItem } from "./Messages";
import { ModelPicker } from "./ModelPicker";
import { Button, Empty, IconButton } from "./ui";

export const APPROVAL_MODES: { id: ApprovalMode; label: string; description: string }[] = [
  { id: "ask", label: "Ask first", description: "Ask before any action that changes something or runs a command." },
  { id: "auto-review", label: "Auto-review", description: "An AI reviewer approves routine actions and asks you about risky ones." },
  { id: "auto", label: "Auto-approve", description: "Run every action without asking. Your deny rules still apply." },
];

const GENERIC_STARTERS = ["What can you do?", "Help me plan my week", "Explain something I've always wondered about"];

function startersFor(bot: Bot): string[] {
  const t = TEMPLATES.find((x) => x.id === bot.templateId);
  return t && (!t.desktopOnly || capabilities.shell || !!useApp.getState().hub) ? t.starters : GENERIC_STARTERS;
}

export function ChatView() {
  const bot = useApp((s) => s.bots.find((b) => b.id === s.activeBotId));
  const convId = useApp((s) => s.activeConversationId);
  const conv = useApp((s) => s.conversations.find((c) => c.id === s.activeConversationId));
  const messages = useApp((s) => (convId ? s.messages[convId] : undefined));
  const running = useApp((s) => (convId ? isBusy(s, convId) : false));
  const onHub = useApp((s) => !!convId && !s.running[convId] && isBusy(s, convId));
  const asker = useApp((s) => (conv?.from ? s.bots.find((b) => b.id === conv.from!.botId) : undefined));
  const globalMode = useApp((s) => s.settings.approvalMode);
  const defaultModel = useApp((s) => s.settings.defaultModel);
  const [seed, setSeed] = useState<{ text: string; n: number }>();
  const [editingTitle, setEditingTitle] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (convId) void loadMessages(convId);
  }, [convId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    stick.current = true;
  }, [convId]);

  if (!bot) {
    return (
      <div className="main-pane">
        <Empty title="No bot selected">
          <p>Pick a template and you'll have a bot to talk to.</p>
          <Button variant="primary" onClick={() => setView({ kind: "templates" })}>
            Browse templates
          </Button>
        </Empty>
      </div>
    );
  }

  const send = async (text: string, attachments: Attachment[]) => {
    stick.current = true;
    let id = convId;
    if (!id || conv?.botId !== bot.id) {
      const c = await createConversation(bot.id);
      useApp.setState({ activeConversationId: c.id });
      id = c.id;
    }
    void sendUserMessage(id, text, attachments);
  };

  const mode = bot.approvalMode ?? globalMode;
  const visible = (messages ?? []).filter((m) => m.role !== "tool");
  const lastAssistant = [...visible].reverse().find((m) => m.role === "assistant");

  return (
    <div className="main-pane chat">
      <header className="chat-head">
        <IconButton label="Back" className="only-narrow" onClick={() => useApp.setState({ navOpen: true })}>
          <ChevronLeft size={20} />
        </IconButton>
        <Avatar spec={bot.avatar} size={34} busy={running} />
        <div className="chat-title">
          <div className="chat-bot-name">{bot.name}</div>
          {conv && editingTitle ? (
            <input
              className="title-input"
              defaultValue={conv.title}
              autoFocus
              onBlur={(e) => {
                setEditingTitle(false);
                const v = e.target.value.trim();
                if (v && v !== conv.title) void updateConversation(conv.id, { title: v, updatedAt: conv.updatedAt });
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <button className="chat-conv-title" onClick={() => conv && setEditingTitle(true)} title="Rename chat">
              {conv?.title ?? bot.tagline ?? "New chat"}
            </button>
          )}
        </div>
        <div className="chat-head-tools">
          <ModelPicker
            className="compact hide-narrow"
            value={bot.model}
            defaultLabel={defaultModel ? `Default (${defaultModel.model})` : "Default model"}
            onChange={(model) => void saveBot({ ...bot, model })}
          />
          <label className="mode-chip hide-narrow" title={APPROVAL_MODES.find((m) => m.id === mode)?.description}>
            <ShieldCheck size={15} />
            <select value={mode} onChange={(e) => void saveBot({ ...bot, approvalMode: e.target.value as ApprovalMode })}>
              {APPROVAL_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <IconButton
            label="New chat"
            onClick={() => {
              useApp.setState({ activeConversationId: null });
              stick.current = true;
            }}
          >
            <MessageSquarePlus size={19} />
          </IconButton>
          <IconButton label="Bot settings" onClick={() => useApp.setState((s) => ({ detailsOpen: !s.detailsOpen }))}>
            <PanelRightOpen size={19} />
          </IconButton>
        </div>
      </header>

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="messages-inner">
          {visible.length === 0 ? (
            <div className="chat-intro">
              <div className="chat-intro-head">
                <Avatar spec={bot.avatar} size={56} />
                <div>
                  <h1>{bot.name}</h1>
                  {bot.tagline && <p className="muted">{bot.tagline}</p>}
                </div>
              </div>
              <div className="starters">
                <span className="stamp muted">Try asking</span>
                {startersFor(bot).map((s) => (
                  <button key={s} className="starter" onClick={() => setSeed({ text: s, n: Date.now() })}>
                    <span>{s}</span>
                    <ArrowRight size={15} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            visible.map((m, i) => <MessageItem key={m.id} msg={m} bot={bot} isLast={m.id === lastAssistant?.id} continued={m.role === "assistant" && visible[i - 1]?.role === "assistant"} />)
          )}
        </div>
      </div>

      <div className="composer-wrap">
        {conv?.from && (
          <div className="chat-origin small">
            <Users size={14} /> {asker?.name ?? "Another bot"} started this chat to ask {bot.name} for help.{" "}
            <button className="link" onClick={() => openConversation(conv.from!.conversationId)}>
              Open {asker?.name ?? "its"} chat
            </button>
          </div>
        )}
        {onHub && (
          <div className="chat-origin small">
            <Server size={14} /> {bot.name} is working on your hub. You can close Lantern; the reply will be here when you're back.
          </div>
        )}
        <Composer
          placeholder={`Message ${bot.name}…`}
          running={running}
          seed={seed}
          onSend={(t, a) => void send(t, a)}
          onStop={() => convId && stopRun(convId)}
        />
      </div>
    </div>
  );
}
