import { create } from "zustand";
import { db, fs as pfs, secrets } from "./platform";
import type {
  ApprovalRule,
  Bot,
  ChatMessage,
  Conversation,
  McpServer,
  Memory,
  Provider,
  Routine,
  Settings,
  Skill,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import type { HubConnection } from "./hub";
import type { SyncState } from "./sync";
import { uid } from "./util";

export type View =
  | { kind: "chat" }
  | { kind: "templates" }
  | { kind: "routines" }
  | { kind: "skills" }
  | { kind: "plugins" }
  | { kind: "settings"; tab?: string };

export interface Toast {
  id: string;
  text: string;
  kind: "info" | "error" | "success";
}

export interface UpdateState {
  version: string;
  notes?: string;
  /** Android: the new APK on the hub, and its checksum. Desktop installs through the updater. */
  downloadUrl?: string;
  sha256?: string;
  /** Android: the downloaded, checked APK, ready to install. */
  apkPath?: string;
  status: "available" | "downloading" | "ready" | "installing";
  /** 0–1 while downloading, when the size is known. */
  progress?: number;
  dismissed?: boolean;
}

export interface AppState {
  ready: boolean;
  settings: Settings;
  providers: Provider[];
  bots: Bot[];
  conversations: Conversation[];
  messages: Record<string, ChatMessage[]>;
  skills: Skill[];
  memories: Memory[];
  mcpServers: McpServer[];
  routines: Routine[];
  defaultWorkspace: string;
  activeBotId: string | null;
  activeConversationId: string | null;
  view: View;
  detailsOpen: boolean;
  /** Narrow screens show either the navigation list or the main pane. */
  navOpen: boolean;
  /** Conversations with an agent run in progress. */
  running: Record<string, number>;
  toasts: Toast[];
  /** The Lantern Hub this device syncs with, if any. */
  hub: HubConnection | null;
  sync: SyncState;
  update: UpdateState | null;
}

export const useApp = create<AppState>(() => ({
  ready: false,
  settings: DEFAULT_SETTINGS,
  providers: [],
  bots: [],
  conversations: [],
  messages: {},
  skills: [],
  memories: [],
  mcpServers: [],
  routines: [],
  defaultWorkspace: "",
  activeBotId: null,
  activeConversationId: null,
  view: { kind: "chat" },
  detailsOpen: false,
  navOpen: true,
  running: {},
  toasts: [],
  hub: null,
  sync: { status: "off", pending: 0 },
  update: null,
}));

const get = () => useApp.getState();
const set = useApp.setState;

export const C = {
  meta: "meta",
  providers: "providers",
  bots: "bots",
  conversations: "conversations",
  skills: "skills",
  memories: "memories",
  mcp: "mcp",
  routines: "routines",
  messages: (conversationId: string) => `msg:${conversationId}`,
};

const byUpdated = <T extends { updatedAt: number }>(a: T, b: T) => b.updatedAt - a.updatedAt;
const sortBots = (bots: Bot[]) => bots.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);

export async function loadAll(): Promise<void> {
  const [settings, providers, bots, conversations, skills, memories, mcpServers, routines, defaultWorkspace] = await Promise.all([
    db.get<Settings>(C.meta, "settings"),
    db.list<Provider>(C.providers),
    db.list<Bot>(C.bots),
    db.list<Conversation>(C.conversations),
    db.list<Skill>(C.skills),
    db.list<Memory>(C.memories),
    db.list<McpServer>(C.mcp),
    db.list<Routine>(C.routines),
    pfs.defaultWorkspace().catch(() => ""),
  ]);
  const merged = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  const sortedBots = sortBots(bots);
  set({
    ready: true,
    settings: merged,
    providers,
    bots: sortedBots,
    conversations: conversations.sort(byUpdated),
    skills,
    memories,
    mcpServers,
    routines,
    defaultWorkspace,
    activeBotId: sortedBots[0]?.id ?? null,
  });
}

/** Reloads collections that changed underneath the app (e.g. from another device via the hub). */
export async function refreshFromDb(touched: Set<string>): Promise<void> {
  const patch: Partial<AppState> = {};
  if (touched.has(C.providers)) patch.providers = await db.list<Provider>(C.providers);
  if (touched.has(C.bots)) patch.bots = sortBots(await db.list<Bot>(C.bots));
  if (touched.has(C.conversations)) patch.conversations = (await db.list<Conversation>(C.conversations)).sort(byUpdated);
  if (touched.has(C.skills)) patch.skills = await db.list<Skill>(C.skills);
  if (touched.has(C.memories)) patch.memories = await db.list<Memory>(C.memories);
  if (touched.has(C.mcp)) patch.mcpServers = await db.list<McpServer>(C.mcp);
  if (touched.has(C.routines)) patch.routines = await db.list<Routine>(C.routines);
  if (touched.has(C.meta)) patch.settings = { ...DEFAULT_SETTINGS, ...((await db.get<Settings>(C.meta, "settings")) ?? {}) };

  const s = get();
  const messages = { ...s.messages };
  for (const c of touched) {
    if (!c.startsWith("msg:")) continue;
    const convId = c.slice(4);
    // Only chats already open here need reloading; a chat running on this device owns its messages.
    if (messages[convId] && !s.running[convId]) messages[convId] = (await db.list<ChatMessage>(c)).sort((a, b) => a.createdAt - b.createdAt);
  }
  if (patch.conversations) {
    const alive = new Set(patch.conversations.map((c) => c.id));
    for (const id of Object.keys(messages)) if (!alive.has(id) && !s.running[id]) delete messages[id];
    if (s.activeConversationId && !alive.has(s.activeConversationId) && !s.running[s.activeConversationId]) patch.activeConversationId = null;
  }
  if (patch.bots && s.activeBotId && !patch.bots.some((b) => b.id === s.activeBotId)) patch.activeBotId = patch.bots[0]?.id ?? null;
  if (!s.activeBotId && patch.bots?.length) patch.activeBotId = patch.bots[0].id;
  set({ ...patch, messages });
}

export function toast(text: string, kind: Toast["kind"] = "info") {
  const t = { id: uid("t"), text, kind };
  set({ toasts: [...get().toasts, t] });
  setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== t.id) }), kind === "error" ? 7000 : 3500);
}

export function setView(view: View) {
  set({ view, navOpen: false });
}

// ------------------------------------------------------------------ settings

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const settings = { ...get().settings, ...patch };
  set({ settings });
  await db.put(C.meta, "settings", settings);
}

export async function addApprovalRule(rule: Omit<ApprovalRule, "id" | "createdAt">): Promise<void> {
  const rules = get().settings.approvalRules.filter((r) => !(r.tool === rule.tool && r.pattern === rule.pattern));
  await updateSettings({ approvalRules: [...rules, { ...rule, id: uid("rule"), createdAt: Date.now() }] });
}

export function workspaceFor(bot: Bot | undefined): string {
  return bot?.workspace || get().settings.workspace || get().defaultWorkspace;
}

// ------------------------------------------------------------------ providers

export async function saveProvider(p: Provider, apiKey?: string | null): Promise<void> {
  if (apiKey !== undefined) {
    if (apiKey) await secrets.set(`provider:${p.id}`, apiKey);
    else await secrets.delete(`provider:${p.id}`);
    p = { ...p, hasKey: !!apiKey };
  }
  const providers = get().providers.some((x) => x.id === p.id) ? get().providers.map((x) => (x.id === p.id ? p : x)) : [...get().providers, p];
  set({ providers });
  await db.put(C.providers, p.id, p);
}

export async function deleteProvider(id: string): Promise<void> {
  set({ providers: get().providers.filter((p) => p.id !== id) });
  await db.delete(C.providers, id);
  await secrets.delete(`provider:${id}`);
  const s = get().settings;
  if (s.defaultModel?.providerId === id) await updateSettings({ defaultModel: undefined });
}

// ------------------------------------------------------------------ bots

export async function saveBot(bot: Bot): Promise<void> {
  bot = { ...bot, updatedAt: Date.now() };
  const exists = get().bots.some((b) => b.id === bot.id);
  set({ bots: exists ? get().bots.map((b) => (b.id === bot.id ? bot : b)) : [bot, ...get().bots] });
  await db.put(C.bots, bot.id, bot);
}

export async function deleteBot(id: string): Promise<void> {
  const s = get();
  const convs = s.conversations.filter((c) => c.botId === id);
  for (const c of convs) await deleteConversation(c.id);
  for (const m of s.memories.filter((m) => m.botId === id)) await db.delete(C.memories, m.id);
  for (const k of s.skills.filter((k) => k.botId === id)) await db.delete(C.skills, k.id);
  for (const r of s.routines.filter((r) => r.botId === id)) await db.delete(C.routines, r.id);
  for (const name of s.bots.find((b) => b.id === id)?.secretNames ?? []) await secrets.delete(botSecretKey(id, name));
  const bots = get().bots.filter((b) => b.id !== id);
  set({
    bots,
    memories: get().memories.filter((m) => m.botId !== id),
    skills: get().skills.filter((k) => k.botId !== id),
    routines: get().routines.filter((r) => r.botId !== id),
    activeBotId: get().activeBotId === id ? (bots[0]?.id ?? null) : get().activeBotId,
    activeConversationId: null,
  });
  await db.delete(C.bots, id);
}

export function botSecretKey(botId: string, name: string): string {
  return `bot:${botId}:${name}`;
}

export function selectBot(botId: string | null) {
  const latest = botId ? get().conversations.find((c) => c.botId === botId && !c.routineId) : undefined;
  set({ activeBotId: botId, activeConversationId: latest?.id ?? null, view: { kind: "chat" }, navOpen: false });
  if (latest) void loadMessages(latest.id);
}

// ------------------------------------------------------------------ conversations

export async function createConversation(botId: string, title = "New chat", routineId?: string): Promise<Conversation> {
  const now = Date.now();
  const conv: Conversation = { id: uid("conv"), botId, title, routineId, createdAt: now, updatedAt: now };
  set({ conversations: [conv, ...get().conversations], messages: { ...get().messages, [conv.id]: [] } });
  await db.put(C.conversations, conv.id, conv);
  return conv;
}

export async function updateConversation(id: string, patch: Partial<Conversation>): Promise<void> {
  const conv = get().conversations.find((c) => c.id === id);
  if (!conv) return;
  const next = { ...conv, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
  set({ conversations: [next, ...get().conversations.filter((c) => c.id !== id)] });
  await db.put(C.conversations, id, next);
}

export async function deleteConversation(id: string): Promise<void> {
  const { [id]: _, ...messages } = get().messages;
  set({
    conversations: get().conversations.filter((c) => c.id !== id),
    messages,
    activeConversationId: get().activeConversationId === id ? null : get().activeConversationId,
  });
  await db.clear(C.messages(id));
  await db.delete(C.conversations, id);
}

export function openConversation(id: string) {
  const conv = get().conversations.find((c) => c.id === id);
  set({ activeConversationId: id, activeBotId: conv?.botId ?? get().activeBotId, view: { kind: "chat" }, navOpen: false });
  void loadMessages(id);
}

export async function loadMessages(conversationId: string): Promise<ChatMessage[]> {
  const cached = get().messages[conversationId];
  if (cached) return cached;
  const live = !!get().running[conversationId];
  const list = (await db.list<ChatMessage>(C.messages(conversationId)))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => (live ? m : settleInterrupted(m)));
  set({ messages: { ...get().messages, [conversationId]: list } });
  return list;
}

/** A message saved mid-run (app closed or crashed) is shown as interrupted, not spinning forever. */
function settleInterrupted(m: ChatMessage): ChatMessage {
  const busy = new Set(["pending", "awaiting-approval", "reviewing", "running"]);
  const calls = m.toolCalls?.some((c) => busy.has(c.status))
    ? m.toolCalls.map((c) => (busy.has(c.status) ? { ...c, status: "error" as const, result: c.result ?? "Interrupted before it finished." } : c))
    : m.toolCalls;
  return { ...m, toolCalls: calls, status: m.status === "streaming" ? "stopped" : m.status };
}

export function messagesOf(conversationId: string): ChatMessage[] {
  return get().messages[conversationId] ?? [];
}

export async function appendMessage(msg: ChatMessage, persist = true): Promise<void> {
  const list = get().messages[msg.conversationId] ?? [];
  set({ messages: { ...get().messages, [msg.conversationId]: [...list, msg] } });
  if (persist) await db.put(C.messages(msg.conversationId), msg.id, msg);
}

/** Updates a message in memory; pass persist=true to also write it to storage. */
export function patchMessage(conversationId: string, id: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>), persist = false): ChatMessage | undefined {
  const list = get().messages[conversationId] ?? [];
  let updated: ChatMessage | undefined;
  const next = list.map((m) => {
    if (m.id !== id) return m;
    updated = { ...m, ...(typeof patch === "function" ? patch(m) : patch) };
    return updated;
  });
  set({ messages: { ...get().messages, [conversationId]: next } });
  if (persist && updated) void db.put(C.messages(conversationId), id, updated);
  return updated;
}

export async function deleteMessagesFrom(conversationId: string, messageId: string): Promise<void> {
  const list = get().messages[conversationId] ?? [];
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx < 0) return;
  const removed = list.slice(idx);
  set({ messages: { ...get().messages, [conversationId]: list.slice(0, idx) } });
  for (const m of removed) await db.delete(C.messages(conversationId), m.id);
}

export function setRunning(conversationId: string, on: boolean) {
  const { [conversationId]: _, ...rest } = get().running;
  set({ running: on ? { ...rest, [conversationId]: Date.now() } : rest });
}

// ------------------------------------------------------------------ skills, memories, MCP, routines

export async function saveSkill(skill: Skill): Promise<void> {
  skill = { ...skill, updatedAt: Date.now() };
  const exists = get().skills.some((s) => s.id === skill.id);
  set({ skills: exists ? get().skills.map((s) => (s.id === skill.id ? skill : s)) : [...get().skills, skill] });
  await db.put(C.skills, skill.id, skill);
}

export async function deleteSkill(id: string): Promise<void> {
  set({ skills: get().skills.filter((s) => s.id !== id), bots: get().bots.map((b) => ({ ...b, skillIds: b.skillIds.filter((x) => x !== id) })) });
  await db.delete(C.skills, id);
  for (const b of get().bots) await db.put(C.bots, b.id, b);
}

export async function addMemory(botId: string, content: string): Promise<Memory> {
  const m: Memory = { id: uid("mem"), botId, content: content.trim(), createdAt: Date.now() };
  set({ memories: [...get().memories, m] });
  await db.put(C.memories, m.id, m);
  return m;
}

export async function deleteMemory(id: string): Promise<void> {
  set({ memories: get().memories.filter((m) => m.id !== id) });
  await db.delete(C.memories, id);
}

export async function saveMcpServer(server: McpServer): Promise<void> {
  const exists = get().mcpServers.some((s) => s.id === server.id);
  set({ mcpServers: exists ? get().mcpServers.map((s) => (s.id === server.id ? server : s)) : [...get().mcpServers, server] });
  await db.put(C.mcp, server.id, server);
}

export async function deleteMcpServer(id: string): Promise<void> {
  const server = get().mcpServers.find((s) => s.id === id);
  set({
    mcpServers: get().mcpServers.filter((s) => s.id !== id),
    bots: get().bots.map((b) => ({ ...b, mcpServerIds: b.mcpServerIds.filter((x) => x !== id) })),
  });
  await db.delete(C.mcp, id);
  for (const k of server?.envKeys ?? []) await secrets.delete(`mcp:${id}:env:${k}`);
  for (const k of server?.headerKeys ?? []) await secrets.delete(`mcp:${id}:header:${k}`);
  for (const b of get().bots) await db.put(C.bots, b.id, b);
}

export async function saveRoutine(routine: Routine): Promise<void> {
  const exists = get().routines.some((r) => r.id === routine.id);
  set({ routines: exists ? get().routines.map((r) => (r.id === routine.id ? routine : r)) : [...get().routines, routine] });
  await db.put(C.routines, routine.id, routine);
}

export async function deleteRoutine(id: string): Promise<void> {
  set({ routines: get().routines.filter((r) => r.id !== id) });
  await db.delete(C.routines, id);
}

// ------------------------------------------------------------------ approvals

type ApprovalAnswer = "allow" | "always" | "deny";
const approvalWaiters = new Map<string, (a: ApprovalAnswer) => void>();

export function waitForApproval(toolCallId: string, signal: AbortSignal): Promise<ApprovalAnswer> {
  return new Promise((resolve) => {
    const onAbort = () => {
      approvalWaiters.delete(toolCallId);
      resolve("deny");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    approvalWaiters.set(toolCallId, (a) => {
      signal.removeEventListener("abort", onAbort);
      approvalWaiters.delete(toolCallId);
      resolve(a);
    });
  });
}

export function answerApproval(toolCallId: string, answer: ApprovalAnswer) {
  approvalWaiters.get(toolCallId)?.(answer);
}

export function isAwaitingApproval(toolCallId: string): boolean {
  return approvalWaiters.has(toolCallId);
}

// ------------------------------------------------------------------ export / import

const EXPORT_COLLECTIONS = [C.providers, C.bots, C.conversations, C.skills, C.memories, C.mcp, C.routines];

export async function exportData(): Promise<string> {
  const out: Record<string, unknown> = { format: "lantern-export", version: 1, exportedAt: new Date().toISOString() };
  for (const c of EXPORT_COLLECTIONS) out[c] = await db.list(c);
  out.settings = get().settings;
  const messages: Record<string, unknown[]> = {};
  for (const conv of get().conversations) messages[conv.id] = await db.list(C.messages(conv.id));
  out.messages = messages;
  return JSON.stringify(out, null, 2);
}

export async function importData(json: string): Promise<void> {
  const data = JSON.parse(json);
  if (data?.format !== "lantern-export") throw new Error("This file is not an Lantern export.");
  for (const c of EXPORT_COLLECTIONS) {
    for (const doc of (data[c] ?? []) as { id: string }[]) await db.put(c, doc.id, doc);
  }
  for (const [convId, msgs] of Object.entries((data.messages ?? {}) as Record<string, { id: string }[]>)) {
    for (const m of msgs) await db.put(C.messages(convId), m.id, m);
  }
  if (data.settings) await db.put(C.meta, "settings", { ...data.settings, onboarded: true });
  set({ messages: {} });
  await loadAll();
}
