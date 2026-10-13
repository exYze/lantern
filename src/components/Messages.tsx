import {
  AppWindow,
  ArrowUpRight,
  Bot as BotIcon,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock,
  ListChecks,
  Presentation,
  UserRound,
  FileText,
  Globe,
  LoaderCircle,
  Mail,
  Pencil,
  Plug,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
  Webhook,
  Wrench,
  X,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { editAndResend, regenerate } from "../lib/agent";
import { rulePatternForCommand } from "../lib/approval";
import type { ApprovalAnswer } from "../lib/approval";
import { UPDATE_PROFILE_TOOL } from "../lib/avatar";
import { answerForm, ASK_USER_TOOL, isWaitingForAnswers, storeSecretAnswers } from "../lib/forms";
import { PAGE_TOOLS } from "../lib/pages";
import { PLANNING_TOOLS } from "../lib/planning";
import { answerApproval, canAnswerApproval, isBusy, openConversation, toast, useApp } from "../lib/store";
import { DELEGATE_TOOL } from "../lib/subagents";
import { ASK_BOT_TOOL } from "../lib/team";
import { BUILTIN_TOOLS } from "../lib/tools";
import type { Bot, ChatForm, ChatMessage, FormValue, SubagentRun, ToolCall } from "../lib/types";
import { Avatar } from "./Avatar";
import { openFile, openPage } from "./Viewers";
import { CopyButton, Markdown } from "./Markdown";
import { Button, IconButton } from "./ui";

function parseArgs(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Built-in tools plus the ones added per bot (forms, plans, pages, profile).
const TITLED_TOOLS = [...BUILTIN_TOOLS, ASK_USER_TOOL, ...PLANNING_TOOLS, ...PAGE_TOOLS, UPDATE_PROFILE_TOOL];

export function describeToolCall(call: ToolCall): { title: string; icon: ReactNode } {
  const args = parseArgs(call.arguments);
  if (call.name === DELEGATE_TOOL.name) return { title: call.subagent?.title ? `Subagent: ${call.subagent.title}` : DELEGATE_TOOL.summarize(args), icon: <BotIcon size={15} /> };
  if (call.name === ASK_BOT_TOOL.name) return { title: ASK_BOT_TOOL.summarize(args), icon: <Users size={15} /> };
  const builtin = TITLED_TOOLS.find((t) => t.name === call.name);
  const iconFor: Record<string, ReactNode> = {
    files: <FileText size={15} />,
    shell: <Terminal size={15} />,
    web: <Globe size={15} />,
    memory: <Brain size={15} />,
    skills: <Sparkles size={15} />,
    routines: <Clock size={15} />,
    conversationSearch: <Wrench size={15} />,
    browser: <AppWindow size={15} />,
    email: <Mail size={15} />,
    forms: <CircleHelp size={15} />,
    planning: <ListChecks size={15} />,
    pages: <Presentation size={15} />,
    profile: <UserRound size={15} />,
  };
  if (builtin) {
    let title = call.name.replace(/_/g, " ");
    try {
      const s = builtin.summarize(args);
      // While arguments are still streaming in, fields can be missing.
      if (s && !/\bundefined\b/.test(s)) title = s;
    } catch {
      /* partial args while streaming */
    }
    return { title, icon: iconFor[builtin.group] ?? <Wrench size={15} /> };
  }
  const m = call.name.match(/^mcp__(.+?)__(.+)$/);
  if (m) return { title: `${m[1]} · ${m[2].replace(/_/g, " ")}`, icon: <Plug size={15} /> };
  return { title: call.name, icon: <Wrench size={15} /> };
}

const STATUS_LABEL: Record<ToolCall["status"], string> = {
  pending: "Preparing",
  "awaiting-approval": "Needs your approval",
  "awaiting-input": "Waiting for your answers",
  reviewing: "Auto-reviewing",
  running: "Running",
  done: "Done",
  denied: "Not run",
  error: "Failed",
};

function StatusIcon({ status }: { status: ToolCall["status"] }) {
  switch (status) {
    case "done":
      return <Check size={14} className="ok" />;
    case "error":
      return <CircleAlert size={14} className="bad" />;
    case "denied":
      return <X size={14} className="muted" />;
    case "awaiting-approval":
      return <ShieldAlert size={14} className="warn" />;
    case "awaiting-input":
      return <CircleHelp size={14} className="warn" />;
    case "reviewing":
      return <ShieldCheck size={14} />;
    default:
      return <LoaderCircle size={14} className="spin" />;
  }
}

const APPROVAL_NOTE: Record<NonNullable<ToolCall["approval"]>, string> = {
  rule: "Auto-approved by your rule",
  auto: "Auto-approve is on",
  "auto-review": "Approved by Auto-review",
  user: "Approved by you",
  "read-only": "Read-only",
};

function EmailDraft({ args }: { args: Record<string, unknown> }) {
  const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));
  return (
    <div className="approval-draft">
      <div>
        <span className="muted">To</span> {list(args.to)}
      </div>
      {!!list(args.cc) && (
        <div>
          <span className="muted">Cc</span> {list(args.cc)}
        </div>
      )}
      <div>
        <span className="muted">Subject</span> {String(args.subject ?? "")}
      </div>
      <pre>{String(args.body ?? "")}</pre>
    </div>
  );
}

function ToolCallCard({ call, botName, conversationId }: { call: ToolCall; botName: string; conversationId: string }) {
  useApp((s) => s.remoteRuns[conversationId]);
  const awaiting = call.status === "awaiting-approval" && canAnswerApproval(conversationId, call.id);
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const { title, icon } = describeToolCall(call);
  const args = parseArgs(call.arguments);
  const isShell = call.name === "shell";
  const pattern = isShell ? rulePatternForCommand(String(args.command ?? "")) : "";
  const [menu, setMenu] = useState(false);
  const answer = (a: ApprovalAnswer) => {
    setSent(a);
    setMenu(false);
    answerApproval(call.id, a, conversationId);
  };
  const what = isShell && pattern ? `“${pattern}”` : "this";
  const asked = useApp((s) => (call.asked ? s.bots.find((b) => b.id === call.asked!.botId) : undefined));

  return (
    <div className={`toolcard status-${call.status}${awaiting ? " awaiting" : ""}`}>
      <button className="toolcard-head" onClick={() => setOpen(!open)}>
        <span className="toolcard-icon">{icon}</span>
        <span className={`toolcard-title${isShell ? " mono" : ""}`}>{title}</span>
        <span className="toolcard-status">
          <StatusIcon status={call.status} />
          <span>{STATUS_LABEL[call.status]}</span>
        </span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>

      {awaiting && (
        <div className="approval-tag">
          <span className="approval-string" aria-hidden="true" />
          <div className="approval">
            <div className="approval-text">
              <strong>{botName}</strong> asks to {isShell ? "run this command" : call.name.startsWith("mcp__") ? `use ${title}` : title.charAt(0).toLowerCase() + title.slice(1)}.
              {call.review && <div className="approval-review">Auto-review: {call.review.reason}</div>}
            </div>
            {call.warning && (
              <div className="approval-warning">
                <CircleAlert size={14} /> {call.warning} It always asks, whatever your approval settings.
              </div>
            )}
            {isShell && <pre className="approval-cmd">{String(args.command ?? "")}</pre>}
            {call.name === "email_send" && <EmailDraft args={args} />}
            {sent ? (
              <div className="approval-sent muted small">{sent === "deny" ? "Denied." : "Allowed."} Waiting for the hub…</div>
            ) : (
              <div className="approval-actions">
                <Button variant="primary" size="sm" onClick={() => answer("allow")}>
                  Allow once
                </Button>
                {!call.warning && (
                  <span className="approval-menu-wrap">
                    <Button size="sm" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                      Keep allowing <ChevronDown size={13} />
                    </Button>
                    {menu && (
                      <span className="approval-menu" role="menu">
                        <button role="menuitem" onClick={() => answer("hour")}>
                          Allow {what} for an hour
                        </button>
                        <button role="menuitem" onClick={() => answer("today")}>
                          Allow {what} until tomorrow
                        </button>
                        <button role="menuitem" onClick={() => answer("always-bot")}>
                          Always allow {what} for {botName.replace(/'s subagent$/, "")}
                        </button>
                        <button role="menuitem" onClick={() => answer("always")}>
                          Always allow {what} for every bot
                        </button>
                      </span>
                    )}
                  </span>
                )}
                <Button variant="ghost" size="sm" onClick={() => answer("deny")}>
                  Deny
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {call.form && <FormCard call={call} form={call.form} conversationId={conversationId} botName={botName} />}

      {call.asked && (
        <button className="toolcard-link" onClick={() => openConversation(call.asked!.conversationId)}>
          Open {asked?.name ?? "the other bot"}'s chat <ArrowUpRight size={13} />
        </button>
      )}
      {call.page && (
        <button className="toolcard-link" onClick={() => openPage(call.page!.id)}>
          Open the page “{call.page.title}” <ArrowUpRight size={13} />
        </button>
      )}
      {call.file && (
        <button className="toolcard-link" onClick={() => openFile(call.file!.id)}>
          Open {call.file.name} <ArrowUpRight size={13} />
        </button>
      )}
      {call.name === "browser" && call.status !== "awaiting-approval" && (
        <button className="toolcard-link" onClick={() => useApp.setState({ detailsOpen: true, detailsTab: "browser" })}>
          Watch the browser <ArrowUpRight size={13} />
        </button>
      )}

      {call.subagent && <SubagentPanel run={call.subagent} active={call.status === "running"} botName={botName} conversationId={conversationId} />}

      {open && (
        <div className="toolcard-body">
          <div className="toolcard-label">{call.subagent ? "Task" : "Arguments"}</div>
          <pre>{isShell ? String(args.command ?? "") : call.subagent ? String(args.task ?? "") : JSON.stringify(args, null, 2)}</pre>
          {call.result !== undefined && (
            <>
              <div className="toolcard-label">
                Result <CopyButton text={call.result} />
              </div>
              <pre className="toolcard-result">{call.result}</pre>
            </>
          )}
          {call.review && <div className="toolcard-note">Auto-review said {call.review.verdict === "allow" ? "allow" : "ask you"}: {call.review.reason}</div>}
        </div>
      )}
      {call.approval && call.status !== "awaiting-approval" && call.approval !== "read-only" && <div className="toolcard-note">{APPROVAL_NOTE[call.approval]}</div>}
    </div>
  );
}

/** A form the bot sent: filled in here while it waits, then shown as the answers you gave. */
function FormCard({ call, form, conversationId, botName }: { call: ToolCall; form: ChatForm; conversationId: string; botName: string }) {
  useApp((s) => s.remoteRuns[conversationId]);
  const botId = useApp((s) => s.conversations.find((c) => c.id === conversationId)?.botId);
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [sending, setSending] = useState(false);
  const open = call.status === "awaiting-input" && !form.answers && (isWaitingForAnswers(call.id) || canAnswerApproval(conversationId, call.id));
  const set = (id: string, v: string | string[]) => setValues({ ...values, [id]: v });
  const missing = form.questions.filter((q) => q.required && !(Array.isArray(values[q.id]) ? (values[q.id] as string[]).length : values[q.id]));

  if (!open) {
    if (!form.answers) return call.status === "awaiting-input" ? <div className="toolcard-note">Waiting for an answer on another device.</div> : null;
    return (
      <div className="form-answers">
        {form.questions.map((q) => {
          const v: FormValue | undefined = form.answers![q.id];
          const shown = v === undefined || v === "" ? "(no answer)" : typeof v === "object" && !Array.isArray(v) ? `saved as the secret ${v.secret}` : Array.isArray(v) ? v.join(", ") : v;
          return (
            <div key={q.id}>
              <span className="muted">{q.label}</span> {shown}
            </div>
          );
        })}
      </div>
    );
  }

  const submit = async (skip = false) => {
    if (!botId) return;
    setSending(true);
    try {
      const answers = skip ? null : await storeSecretAnswers(botId, form, values);
      answerForm(call.id, answers, conversationId);
    } catch (e) {
      toast((e as Error).message, "error");
      setSending(false);
    }
  };

  return (
    <div className="approval-tag">
      <span className="approval-string" aria-hidden="true" />
      <form
        className="approval chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="approval-text">
          <strong>{botName}</strong> asks: {form.title}
        </div>
        {form.questions.map((q) => (
          <div key={q.id} className="chat-form-q">
            <div className="chat-form-label">
              {q.label}
              {q.required && <span className="muted"> (needed)</span>}
            </div>
            {q.kind === "choice" &&
              q.options!.map((o) => (
                <label key={o} className="chat-form-option">
                  <input type="radio" name={`${call.id}-${q.id}`} checked={values[q.id] === o} onChange={() => set(q.id, o)} /> {o}
                </label>
              ))}
            {q.kind === "multi" &&
              q.options!.map((o) => {
                const list = (values[q.id] as string[] | undefined) ?? [];
                return (
                  <label key={o} className="chat-form-option">
                    <input type="checkbox" checked={list.includes(o)} onChange={(e) => set(q.id, e.target.checked ? [...list, o] : list.filter((x) => x !== o))} /> {o}
                  </label>
                );
              })}
            {(q.kind === "text" || q.kind === "number" || q.kind === "date") && (
              <input className="input" type={q.kind === "text" ? "text" : q.kind} placeholder={q.placeholder} value={(values[q.id] as string) ?? ""} onChange={(e) => set(q.id, e.target.value)} />
            )}
            {q.kind === "long-text" && <textarea className="input" rows={3} placeholder={q.placeholder} value={(values[q.id] as string) ?? ""} onChange={(e) => set(q.id, e.target.value)} />}
            {q.kind === "secret" && (
              <>
                <input className="input" type="password" autoComplete="off" placeholder={q.placeholder} value={(values[q.id] as string) ?? ""} onChange={(e) => set(q.id, e.target.value)} />
                <div className="muted small">Saved as one of {botName}'s secrets. The bot never sees it.</div>
              </>
            )}
          </div>
        ))}
        <div className="approval-actions">
          <Button variant="primary" size="sm" type="submit" disabled={sending || missing.length > 0}>
            {sending ? "Sending…" : "Send answers"}
          </Button>
          <Button variant="ghost" size="sm" type="button" disabled={sending} onClick={() => void submit(true)}>
            Don't answer
          </Button>
        </div>
      </form>
    </div>
  );
}

/** A subagent's work inside its delegate_task card: live while it runs, folded away after. */
function SubagentPanel({ run, active, botName, conversationId }: { run: SubagentRun; active: boolean; botName: string; conversationId: string }) {
  const [open, setOpen] = useState(false);
  const needsYou = run.steps.some((s) => s.toolCalls?.some((c) => c.status === "awaiting-approval" && canAnswerApproval(conversationId, c.id)));
  const actions = run.steps.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0);
  const expanded = active || needsYou || open;
  return (
    <div className="subagent">
      <div className="subagent-meta">
        <span className="pill">{run.isolated ? "Own folder" : "Shared workspace"}</span>
        {run.sandboxed && <span className="pill pill-accent">{run.network ? "Sandboxed" : "Sandboxed · no internet"}</span>}
        <span className="subagent-model">{run.model}</span>
        {!active && !needsYou && (
          <button className="subagent-toggle" onClick={() => setOpen(!open)}>
            {open ? "Hide steps" : `${run.steps.length} step${run.steps.length === 1 ? "" : "s"} · ${actions} action${actions === 1 ? "" : "s"}`}
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
      </div>
      {expanded && (
        <div className="subagent-steps">
          {run.steps.map((step) => (
            <div key={step.id} className="subagent-step">
              {step.content.trim() && <div className="subagent-text">{step.content.length > 1200 ? `${step.content.slice(0, 1200)}…` : step.content}</div>}
              {step.status === "streaming" && !step.content && <div className="subagent-text muted">Thinking…</div>}
              {step.status === "error" && <div className="subagent-text bad">This step failed.</div>}
              {step.toolCalls?.map((c) => <ToolCallCard key={c.id} call={c} botName={`${botName}'s subagent`} conversationId={conversationId} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning">
      <button className="reasoning-head" onClick={() => setOpen(!open)}>
        <Brain size={14} />
        <span>{streaming ? "Thinking…" : "Thoughts"}</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  );
}

/** A message another bot wrote into this chat (a question for this bot, or a handed-off result). */
function BotNote({ msg }: { msg: ChatMessage }) {
  const from = useApp((s) => s.bots.find((b) => b.id === msg.fromBotId));
  return (
    <div className="msg msg-note-bot">
      {from ? <Avatar spec={from.avatar} size={26} /> : <BotIcon size={18} />}
      <div className="msg-main">
        <div className="stamp muted">{from?.name ?? "Another bot"}</div>
        <Markdown text={msg.content} />
      </div>
    </div>
  );
}

/** When a message was sent: the time today, otherwise the date too. */
function MsgTime({ at }: { at: number }) {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  const short = today ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <time className="msg-time" dateTime={d.toISOString()} title={d.toLocaleString()}>
      {short}
    </time>
  );
}

const VIA_LABEL: Partial<Record<NonNullable<ChatMessage["via"]>, { label: string; icon: ReactNode }>> = {
  telegram: { label: "From Telegram", icon: <Send size={12} /> },
  webhook: { label: "From a webhook", icon: <Webhook size={12} /> },
  email: { label: "From an email", icon: <Mail size={12} /> },
};

function UserMessage({ msg }: { msg: ChatMessage }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.content);
  const running = useApp((s) => isBusy(s, msg.conversationId));
  if (editing) {
    return (
      <div className="msg msg-user">
        <div className="bubble bubble-edit">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(10, draft.split("\n").length + 1)} autoFocus />
          <div className="row-end">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!draft.trim()}
              onClick={() => {
                setEditing(false);
                void editAndResend(msg.conversationId, msg.id, draft.trim());
              }}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg msg-user">
      <div className="bubble">
        {msg.attachments?.map((a) =>
          a.kind === "image" ? (
            <img key={a.id} className="attach-img" src={a.data} alt={a.name} />
          ) : (
            <div key={a.id} className="attach-chip">
              <FileText size={14} /> {a.name}
            </div>
          ),
        )}
        {msg.routineId ? <Markdown text={msg.content} /> : <div className="user-text">{msg.content}</div>}
      </div>
      <div className="msg-actions">
        <MsgTime at={msg.createdAt} />
        {msg.via && VIA_LABEL[msg.via] && (
          <span className="msg-via">
            {VIA_LABEL[msg.via]!.icon} {VIA_LABEL[msg.via]!.label}
          </span>
        )}
        <CopyButton text={msg.content} />
        {!running && (
          <IconButton label="Edit and resend" onClick={() => setEditing(true)}>
            <Pencil size={14} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

function AssistantMessage({ msg, bot, isLast, continued }: { msg: ChatMessage; bot: Bot; isLast: boolean; continued: boolean }) {
  const running = useApp((s) => isBusy(s, msg.conversationId));
  const streaming = msg.status === "streaming";
  const empty = !msg.content && !msg.toolCalls?.length && !msg.error;
  return (
    <div className={`msg msg-bot${continued ? " continued" : ""}`}>
      {continued ? <span className="msg-avatar-spacer" /> : <Avatar spec={bot.avatar} size={30} busy={streaming} className="msg-avatar" />}
      <div className="msg-main">
        {msg.reasoning?.trim() && <Reasoning text={msg.reasoning} streaming={streaming && !msg.content} />}
        {streaming && empty && !msg.reasoning && (
          <div className="typing">
            <LoaderCircle size={14} className="spin" /> Thinking
          </div>
        )}
        {msg.content && <Markdown text={msg.content} />}
        {msg.toolCalls?.map((c) => <ToolCallCard key={c.id} call={c} botName={bot.name} conversationId={msg.conversationId} />)}
        {msg.status === "error" && (
          <div className="msg-error">
            <CircleAlert size={16} />
            <div>
              <div>{msg.error}</div>
              {isLast && !running && (
                <Button size="sm" onClick={() => void regenerate(msg.conversationId, msg.id)}>
                  <RotateCcw size={14} /> Try again
                </Button>
              )}
            </div>
          </div>
        )}
        {msg.status === "stopped" && <div className="msg-note">Stopped</div>}
        {!streaming && (msg.content || (isLast && msg.status === "done")) && (
          <div className="msg-actions">
            <MsgTime at={msg.createdAt} />
            {msg.content && <CopyButton text={msg.content} />}
            {isLast && !running && (
              <IconButton label="Regenerate" onClick={() => void regenerate(msg.conversationId, msg.id)}>
                <RotateCcw size={14} />
              </IconButton>
            )}
            {msg.model && <span className="msg-model">{msg.model}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export const MessageItem = memo(function MessageItem({ msg, bot, isLast, continued = false }: { msg: ChatMessage; bot: Bot; isLast: boolean; continued?: boolean }) {
  if (msg.role === "tool") return null;
  if (msg.role === "user" && msg.fromBotId) return <BotNote msg={msg} />;
  if (msg.role === "user" && msg.via === "goal") {
    return (
      <div className="msg-note-goal small muted">
        <ListChecks size={13} /> Kept going toward the goal
      </div>
    );
  }
  if (msg.role === "user") return <UserMessage msg={msg} />;
  return <AssistantMessage msg={msg} bot={bot} isLast={isLast} continued={continued} />;
});
