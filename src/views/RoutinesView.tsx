import { CircleAlert, MessageSquare, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Avatar } from "../components/Avatar";
import { RoutineEditor } from "../components/RoutineEditor";
import { Button, confirmDialog, Empty, IconButton, Pill } from "../components/ui";
import { isRoutineActive, runRoutine } from "../lib/routines";
import { describeSchedule, nextRun } from "../lib/schedule";
import { deleteRoutine, openConversation, saveRoutine, useApp } from "../lib/store";
import { timeAgo } from "../lib/util";
import { PageHead } from "./PageHead";

export function RoutinesView() {
  const routines = useApp((s) => s.routines);
  const bots = useApp((s) => s.bots);
  useApp((s) => s.running); // re-render as runs start and stop
  const [editing, setEditing] = useState<string | "new" | null>(null);

  return (
    <div className="main-pane page">
      <PageHead
        title="Routines"
        subtitle="Recurring tasks your bots run on a schedule while Lantern is open."
        actions={
          <Button variant="primary" disabled={!bots.length} onClick={() => setEditing("new")}>
            <Plus size={16} /> New routine
          </Button>
        }
      />
      <div className="page-body">
        {!routines.length ? (
          <Empty title="No routines yet">
            Ask a bot “every weekday at 8:00, brief me on…” or create one here.
          </Empty>
        ) : (
          <div className="stack">
            {routines.map((r) => {
              const bot = bots.find((b) => b.id === r.botId);
              const active = isRoutineActive(r.id);
              return (
                <div key={r.id} className="card routine-card">
                  {bot && <Avatar spec={bot.avatar} size={36} busy={active} />}
                  <div className="list-main">
                    <div className="row">
                      <strong>{r.name}</strong>
                      {active ? <Pill tone="accent">Running</Pill> : !r.enabled ? <Pill>Paused</Pill> : null}
                      {r.lastStatus === "error" && (
                        <Pill tone="danger">
                          <CircleAlert size={12} /> Last run failed
                        </Pill>
                      )}
                    </div>
                    <span className="muted small">
                      {bot?.name} · {describeSchedule(r.schedule)}
                      {r.enabled && r.nextRunAt ? ` · next ${new Date(r.nextRunAt).toLocaleString()}` : ""}
                      {r.lastRunAt ? ` · last ran ${timeAgo(r.lastRunAt)}` : ""}
                    </span>
                    <span className="small clamp-2">{r.prompt}</span>
                  </div>
                  <div className="row">
                    <input
                      type="checkbox"
                      className="switch"
                      aria-label="Enabled"
                      checked={r.enabled}
                      onChange={(e) => void saveRoutine({ ...r, enabled: e.target.checked, nextRunAt: e.target.checked ? nextRun(r.schedule, Date.now()) : r.nextRunAt })}
                    />
                    <IconButton label="Run now" disabled={active} onClick={() => void runRoutine(r, true)}>
                      <Play size={16} />
                    </IconButton>
                    {r.conversationId && (
                      <IconButton label="Open chat" onClick={() => openConversation(r.conversationId!)}>
                        <MessageSquare size={16} />
                      </IconButton>
                    )}
                    <IconButton label="Edit" onClick={() => setEditing(r.id)}>
                      <Pencil size={16} />
                    </IconButton>
                    <IconButton
                      label="Delete"
                      onClick={async () => {
                        if (await confirmDialog({ title: "Delete this routine?", body: "This deletes the routine and stops its future runs. This can't be undone.", confirmLabel: "Delete", danger: true })) {
                          await deleteRoutine(r.id);
                        }
                      }}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editing && <RoutineEditor routine={routines.find((r) => r.id === editing)} onClose={() => setEditing(null)} />}
    </div>
  );
}
