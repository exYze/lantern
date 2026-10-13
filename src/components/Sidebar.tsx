import { BookOpen, Clock, Flame, LayoutGrid, MessageSquare, Pin, Plug, Plus, Send, Settings, Star, Trash2, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { createBlankBot } from "../lib/bots";
import { deleteConversation, isBusy, openConversation, selectBot, setView, useApp, type View } from "../lib/store";
import type { Conversation } from "../lib/types";
import { timeAgo } from "../lib/util";
import { Avatar } from "./Avatar";
import { confirmDialog, IconButton } from "./ui";
import logo from "../assets/lantern.svg";

export function Sidebar() {
  const bots = useApp((s) => s.bots);
  const activeBotId = useApp((s) => s.activeBotId);
  const activeConvId = useApp((s) => s.activeConversationId);
  const view = useApp((s) => s.view);
  const busy = useApp(useShallow((s) => ({ running: s.running, remoteRuns: s.remoteRuns, runner: s.runner })));
  const conversations = useApp((s) => s.conversations);
  const routinesNeedingCount = useApp((s) => s.routines.filter((r) => r.enabled).length);
  const primaryBotId = useApp((s) => s.settings.primaryBotId);

  const busyBots = new Set(conversations.filter((c) => isBusy(busy, c.id)).map((c) => c.botId));
  const chatIcon = (c: Conversation) => (c.routineId ? <Clock size={14} /> : c.from ? <Users size={14} /> : c.channel ? <Send size={14} /> : <MessageSquare size={14} />);
  const chats = conversations.filter((c) => c.botId === activeBotId);
  const navItem = (v: View, label: string, icon: ReactNode, badge?: number) => (
    <button key={label} className={`nav-item${view.kind === v.kind ? " active" : ""}`} onClick={() => setView(v)}>
      {icon}
      <span>{label}</span>
      {badge ? <span className="nav-badge">{badge}</span> : null}
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src={logo} alt="" width={28} height={28} />
        <span>Lantern</span>
      </div>

      <div className="sidebar-section-head">
        <span>Bots</span>
        <IconButton label="New bot" onClick={() => void createBlankBot()}>
          <Plus size={16} />
        </IconButton>
      </div>
      <div className="bot-list">
        {bots.map((b) => (
          <button key={b.id} className={`bot-item${b.id === activeBotId && view.kind === "chat" ? " active" : ""}`} onClick={() => selectBot(b.id)}>
            <Avatar spec={b.avatar} size={32} busy={busyBots.has(b.id)} />
            <span className="bot-item-text">
              <span className="bot-item-name">
                {b.name}
                {b.id === primaryBotId && <Star size={11} className="muted" aria-label="Primary bot" />}
                {b.pinned && <Pin size={11} className="muted" />}
              </span>
              <span className="bot-item-tagline">{b.tagline}</span>
            </span>
          </button>
        ))}
        {!bots.length && (
          <button className="bot-item ghost" onClick={() => setView({ kind: "templates" })}>
            <LayoutGrid size={18} /> Pick a template to create your first bot
          </button>
        )}
      </div>

      {activeBotId && chats.length > 0 && (
        <>
          <div className="sidebar-section-head">
            <span>Chats</span>
          </div>
          <div className="chat-list">
            {chats.map((c) => (
              <div key={c.id} className={`chat-item${c.id === activeConvId && view.kind === "chat" ? " active" : ""}`}>
                <button className="chat-item-main" onClick={() => openConversation(c.id)}>
                  {chatIcon(c)}
                  <span className="chat-item-title">{c.title}</span>
                  {isBusy(busy, c.id) ? <Flame size={13} className="live-flame" aria-label="Working" /> : <span className="chat-item-time">{timeAgo(c.updatedAt)}</span>}
                </button>
                <IconButton
                  label="Delete chat"
                  className="chat-item-del"
                  onClick={async () => {
                    if (await confirmDialog({ title: "Delete this chat?", body: `“${c.title}” and its messages will be deleted.`, confirmLabel: "Delete", danger: true })) {
                      await deleteConversation(c.id);
                    }
                  }}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            ))}
          </div>
        </>
      )}

      <nav className="sidebar-nav">
        {navItem({ kind: "templates" }, "Templates", <LayoutGrid size={17} />)}
        {navItem({ kind: "routines" }, "Routines", <Clock size={17} />, routinesNeedingCount)}
        {navItem({ kind: "skills" }, "Skills", <BookOpen size={17} />)}
        {navItem({ kind: "plugins" }, "Plugins", <Plug size={17} />)}
        {navItem({ kind: "settings" }, "Settings", <Settings size={17} />)}
      </nav>
    </aside>
  );
}
