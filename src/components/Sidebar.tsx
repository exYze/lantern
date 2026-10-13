import { BookOpen, ChevronDown, ChevronRight, Clock, Flame, LayoutGrid, MessageSquare, Pin, Plug, Plus, Search, Send, Settings, Star, Trash2, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { createBlankBot } from "../lib/bots";
import { deleteConversation, isBusy, openConversation, selectBot, setView, updateSettings, useApp, type View } from "../lib/store";
import type { Bot, Conversation, SidebarSection } from "../lib/types";
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
  const sections = useApp((s) => s.settings.sidebarSections ?? []);
  const [renaming, setRenaming] = useState<string | null>(null);
  const saveSections = (next: SidebarSection[]) => void updateSettings({ sidebarSections: next });
  const placed = new Set(sections.flatMap((s) => s.botIds));
  const loose = bots.filter((b) => !placed.has(b.id));
  const botRow = (b: Bot) => (
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
  );
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

      <button className="sidebar-search" onClick={() => useApp.setState({ palette: true })}>
        <Search size={15} /> <span>Search</span> <kbd>{/Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl+K"}</kbd>
      </button>
      <div className="sidebar-section-head">
        <span>Bots</span>
        <IconButton label="New bot" onClick={() => void createBlankBot()}>
          <Plus size={16} />
        </IconButton>
      </div>
      <div className="bot-list">
        {sections.map((sec) => {
          const members = sec.botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
          return (
            <div key={sec.id} className="bot-section">
              <div className="bot-section-head">
                {renaming === sec.id ? (
                  <input
                    className="bot-section-rename"
                    defaultValue={sec.name}
                    autoFocus
                    onBlur={(e) => {
                      setRenaming(null);
                      const name = e.target.value.trim();
                      if (name && name !== sec.name) saveSections(sections.map((s) => (s.id === sec.id ? { ...s, name } : s)));
                    }}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                ) : (
                  <button
                    className="bot-section-toggle"
                    aria-expanded={!sec.collapsed}
                    title="Double-click to rename"
                    onClick={() => saveSections(sections.map((s) => (s.id === sec.id ? { ...s, collapsed: !s.collapsed } : s)))}
                    onDoubleClick={() => setRenaming(sec.id)}
                  >
                    {sec.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <span>{sec.name}</span>
                    <span className="muted">{members.length}</span>
                  </button>
                )}
                <IconButton label={`Remove the section ${sec.name}`} className="bot-section-del" onClick={() => saveSections(sections.filter((s) => s.id !== sec.id))}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
              {!sec.collapsed && members.map(botRow)}
            </div>
          );
        })}
        {sections.length > 0 && loose.length > 0 && <div className="bot-section-head bot-section-loose muted">Other bots</div>}
        {loose.map(botRow)}
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
