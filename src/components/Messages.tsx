import {
  Bot as BotIcon,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  FileText,
  Globe,
  LoaderCircle,
  Pencil,
  Plug,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { editAndResend, regenerate } from "../lib/agent";
import { rulePatternForCommand } from "../lib/approval";
import { answerApproval, isAwaitingApproval, useApp } from "../lib/store";
import { DELEGATE_TOOL } from "../lib/subagents";
import { BUILTIN_TOOLS } from "../lib/tools";
import type { Bot, ChatMessage, SubagentRun, ToolCall } from "../lib/types";
import { Avatar } from "./Avatar";
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

export function describeToolCall(call: ToolCall): { title: string; icon: ReactNode } {
  const args = parseArgs(call.arguments);
  if (call.name === DELEGATE_TOOL.name) return { title: call.subagent?.title ? `Subagent: ${call.subagent.title}` : DELEGATE_TOOL.summarize(args), icon: <BotIcon size={15} /> };
  const builtin = BUILTIN_TOOLS.find((t) => t.name === call.name);
  const iconFor: Record<string, ReactNode> = {
    files: <FileText size={15} />,
    shell: <Terminal size={15} />,
    web: <Globe size={15} />,
    memory: <Brain size={15} />,
    skills: <Sparkles size={15} />,
    routines: <Clock size={15} />,
    conversationSearch: <Wrench size={15} />,
  };
  if (builtin) {
    let title = call.name.replace(/_/g, " ");
    try {
      const s = builtin.summarize(args);
      // While arguments are still streaming in, fields can be missing.
      if (s && !/undefined/.test(s)) title = s;
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

function ToolCallCard({ call, botName }: { call: ToolCall; botName: string }) {
  const awaiting = call.status === "awaiting-approval" && isAwaitingApproval(call.id);
  const [open, setOpen] = useState(false);
  const { title, icon } = describeToolCall(call);
  const args = parseArgs(call.arguments);
  const isShell = call.name === "shell";
  const pattern = isShell ? rulePatternForCommand(String(args.command ?? "")) : "";

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
            {isShell && <pre className="approval-cmd">{String(args.command ?? "")}</pre>}
            <div className="approval-actions">
              <Button variant="primary" size="sm" onClick={() => answerApproval(call.id, "allow")}>
                Allow once
              </Button>
              <Button size="sm" onClick={() => answerApproval(call.id, "always")}>
                {isShell && pattern ? `Always allow “${pattern}”` : "Always allow"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => answerApproval(call.id, "deny")}>
                Deny
              </Button>
            </div>
          </div>
        </div>
      )}

      {call.subagent && <SubagentPanel run={call.subagent} active={call.status === "running"} botName={botName} />}

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

/** A subagent's work inside its delegate_task card: live while it runs, folded away after. */
function SubagentPanel({ run, active, botName }: { run: SubagentRun; active: boolean; botName: string }) {
  const [open, setOpen] = useState(false);
  const needsYou = run.steps.some((s) => s.toolCalls?.some((c) => c.status === "awaiting-approval" && isAwaitingApproval(c.id)));
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
              {step.toolCalls?.map((c) => <ToolCallCard key={c.id} call={c} botName={`${botName}'s subagent`} />)}
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

function UserMessage({ msg }: { msg: ChatMessage }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.content);
  const running = useApp((s) => !!s.running[msg.conversationId]);
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
  const running = useApp((s) => !!s.running[msg.conversationId]);
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
        {msg.toolCalls?.map((c) => <ToolCallCard key={c.id} call={c} botName={bot.name} />)}
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
  if (msg.role === "user") return <UserMessage msg={msg} />;
  return <AssistantMessage msg={msg} bot={bot} isLast={isLast} continued={continued} />;
});
