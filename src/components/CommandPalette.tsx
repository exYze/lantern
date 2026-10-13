import { BookOpen, Bot as BotIcon, Clock, FileText, LayoutGrid, MessageSquare, MessageSquarePlus, Plug, Plus, Search, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { createBlankBot } from "../lib/bots";
import { db } from "../lib/platform";
import { openConversation, selectBot, setView, useApp } from "../lib/store";
import { openPage } from "./Viewers";

interface Item {
  id: string;
  group: string;
  label: string;
  detail?: string;
  icon: ReactNode;
  run: () => void;
}

const SETTINGS = [
  ["models", "Models"],
  ["hub", "Hub"],
  ["connections", "Phone & Telegram"],
  ["approvals", "Approvals"],
  ["general", "General"],
  ["voice", "Voice"],
  ["data", "Data"],
  ["about", "About"],
] as const;

const matches = (text: string, q: string) => text.toLowerCase().includes(q);

/** Ctrl/Cmd+K: jump to any bot, chat, page, setting or action, or search what was said. */
export function CommandPalette() {
  const open = useApp((s) => s.palette);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<Item[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const { bots, conversations, routines, pages, activeBotId } = useApp(
    useShallow((s) => ({ bots: s.bots, conversations: s.conversations, routines: s.routines, pages: s.pages, activeBotId: s.activeBotId })),
  );
  const close = () => {
    useApp.setState({ palette: false });
    setQuery("");
    setActive(0);
  };

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  // What was said in chats: searched once the query is long enough.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setHits([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const found = await db.search<{ id: string; role: string; content: string; conversationId: string; via?: string }>("msg:", q, 40);
      if (!alive) return;
      const lower = q.toLowerCase();
      setHits(
        found
          // Only what was written: the stored message also holds tool calls and their output.
          .filter((h) => h.data.role !== "tool" && h.data.via !== "goal" && typeof h.data.content === "string" && h.data.content.toLowerCase().includes(lower))
          .slice(0, 20)
          .map((h) => {
            const conv = useApp.getState().conversations.find((c) => c.id === h.data.conversationId);
            const text = h.data.content;
            const i = text.toLowerCase().indexOf(lower);
            const from = Math.max(0, i - 40);
            const to = i + 80;
            const snippet = text.slice(from, to).replace(/[`*#>|]+/g, "").replace(/\s+/g, " ").trim();
            return {
              id: `msg:${h.id}`,
              group: "In chats",
              label: `${from > 0 ? "…" : ""}${snippet}${to < text.length ? "…" : ""}`,
              detail: conv?.title,
              icon: <MessageSquare size={15} />,
              run: () => conv && openConversation(conv.id),
            };
          })
          .filter((h) => h.detail !== undefined),
      );
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const bot = bots.find((b) => b.id === activeBotId);
    const actions: Item[] = [
      ...(bot ? [{ id: "new-chat", group: "Actions", label: `New chat with ${bot.name}`, icon: <MessageSquarePlus size={15} />, run: () => useApp.setState({ activeConversationId: null, view: { kind: "chat" } }) }] : []),
      { id: "new-bot", group: "Actions", label: "New bot", icon: <Plus size={15} />, run: () => void createBlankBot() },
      { id: "templates", group: "Actions", label: "Templates", icon: <LayoutGrid size={15} />, run: () => setView({ kind: "templates" }) },
      { id: "routines", group: "Actions", label: "Routines", icon: <Clock size={15} />, run: () => setView({ kind: "routines" }) },
      { id: "skills", group: "Actions", label: "Skills", icon: <BookOpen size={15} />, run: () => setView({ kind: "skills" }) },
      { id: "plugins", group: "Actions", label: "Plugins and apps", icon: <Plug size={15} />, run: () => setView({ kind: "plugins" }) },
      ...SETTINGS.map(([tab, label]) => ({ id: `settings-${tab}`, group: "Settings", label: `Settings: ${label}`, icon: <Settings size={15} />, run: () => setView({ kind: "settings", tab }) })),
    ];
    const botItems: Item[] = bots.map((b) => ({ id: b.id, group: "Bots", label: b.name, detail: b.tagline, icon: <BotIcon size={15} />, run: () => selectBot(b.id) }));
    const chatItems: Item[] = conversations.slice(0, 300).map((c) => ({
      id: c.id,
      group: "Chats",
      label: c.title,
      detail: bots.find((b) => b.id === c.botId)?.name,
      icon: <MessageSquare size={15} />,
      run: () => openConversation(c.id),
    }));
    const routineItems: Item[] = routines.map((r) => ({ id: r.id, group: "Routines", label: r.name, detail: bots.find((b) => b.id === r.botId)?.name, icon: <Clock size={15} />, run: () => setView({ kind: "routines" }) }));
    const pageItems: Item[] = pages.map((p) => ({ id: p.id, group: "Pages", label: p.title, detail: bots.find((b) => b.id === p.botId)?.name, icon: <FileText size={15} />, run: () => openPage(p.id) }));
    if (!q) return [...actions.slice(0, 3), ...botItems.slice(0, 6), ...chatItems.slice(0, 6)];
    const pick = (list: Item[], n: number) => list.filter((i) => matches(i.label, q) || (i.detail && matches(i.detail, q))).slice(0, n);
    return [...pick(botItems, 6), ...pick(chatItems, 8), ...pick(pageItems, 5), ...pick(routineItems, 4), ...pick(actions, 6), ...hits];
  }, [query, bots, conversations, routines, pages, activeBotId, hits]);

  if (!open) return null;
  const run = (i: Item | undefined) => {
    if (!i) return;
    close();
    i.run();
  };
  let lastGroup = "";
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Search">
        <div className="palette-input">
          <Search size={17} className="muted" />
          <input
            ref={input}
            value={query}
            placeholder="Search bots, chats, pages, settings…"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") run(items[active]);
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" role="listbox">
          {items.length === 0 && <div className="palette-empty muted small">Nothing matches “{query}”.</div>}
          {items.map((i, n) => {
            const head = i.group !== lastGroup ? i.group : null;
            lastGroup = i.group;
            return (
              <div key={`${i.group}-${i.id}`}>
                {head && <div className="palette-group stamp">{head}</div>}
                <button role="option" aria-selected={n === active} className={`palette-item${n === active ? " active" : ""}`} onMouseEnter={() => setActive(n)} onClick={() => run(i)}>
                  {i.icon}
                  <span className="palette-label">{i.label}</span>
                  {i.detail && <span className="palette-detail muted">{i.detail}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
