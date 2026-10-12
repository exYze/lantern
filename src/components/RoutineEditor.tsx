import { useState } from "react";
import { describeSchedule, nextRun } from "../lib/schedule";
import { saveRoutine, useApp } from "../lib/store";
import type { Routine, Schedule } from "../lib/types";
import { uid } from "../lib/util";
import { Button, Field, Modal, Toggle } from "./ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function RoutineEditor({ routine, botId, onClose }: { routine?: Routine; botId?: string; onClose: () => void }) {
  const bots = useApp((s) => s.bots);
  const [draft, setDraft] = useState<Routine>(
    routine ?? {
      id: uid("routine"),
      botId: botId ?? bots[0]?.id ?? "",
      name: "",
      prompt: "",
      schedule: { kind: "daily", time: "09:00" },
      enabled: true,
      createdAt: Date.now(),
    },
  );
  const s = draft.schedule;
  const setSchedule = (schedule: Schedule) => setDraft({ ...draft, schedule });
  const time = "time" in s ? s.time : "09:00";
  const valid = draft.botId && draft.name.trim() && draft.prompt.trim();

  return (
    <Modal
      title={routine ? "Edit routine" : "New routine"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={async () => {
              await saveRoutine({ ...draft, name: draft.name.trim(), prompt: draft.prompt.trim(), nextRunAt: draft.enabled ? nextRun(draft.schedule, Date.now()) : draft.nextRunAt });
              onClose();
            }}
          >
            Save routine
          </Button>
        </>
      }
    >
      <div className="form">
        {!botId && (
          <Field label="Bot">
            <select className="select" value={draft.botId} onChange={(e) => setDraft({ ...draft, botId: e.target.value })}>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Name">
          <input className="input" value={draft.name} placeholder="Weekly report" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="What should the bot do each time?">
          <textarea className="input" rows={4} value={draft.prompt} placeholder="Summarize what changed in my project folder this week…" onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
        </Field>
        <Field label="Repeat">
          <select
            className="select"
            value={s.kind}
            onChange={(e) => {
              const k = e.target.value as Schedule["kind"];
              if (k === "interval") setSchedule({ kind: "interval", minutes: 60 });
              else if (k === "weekly") setSchedule({ kind: "weekly", days: [1], time });
              else if (k === "once") setSchedule({ kind: "once", at: Date.now() + 3600_000 });
              else setSchedule({ kind: k, time });
            }}
          >
            <option value="daily">Every day</option>
            <option value="weekdays">Every weekday</option>
            <option value="weekly">On specific days</option>
            <option value="interval">Every few hours or minutes</option>
            <option value="once">Once</option>
          </select>
        </Field>
        {s.kind === "weekly" && (
          <div className="day-picker">
            {DAYS.map((d, i) => (
              <button
                key={d}
                className={`day${s.days.includes(i) ? " on" : ""}`}
                onClick={() => setSchedule({ ...s, days: s.days.includes(i) ? s.days.filter((x) => x !== i) : [...s.days, i].sort() })}
              >
                {d}
              </button>
            ))}
          </div>
        )}
        {"time" in s && (
          <Field label="At">
            <input className="input" type="time" value={s.time} onChange={(e) => setSchedule({ ...s, time: e.target.value || "09:00" })} />
          </Field>
        )}
        {s.kind === "interval" && (
          <Field label="Every (minutes)">
            <input className="input" type="number" min={5} step={5} value={s.minutes} onChange={(e) => setSchedule({ kind: "interval", minutes: Math.max(5, Number(e.target.value) || 60) })} />
          </Field>
        )}
        {s.kind === "once" && (
          <Field label="When">
            <input className="input" type="datetime-local" value={toLocalInput(s.at)} onChange={(e) => setSchedule({ kind: "once", at: new Date(e.target.value).getTime() || Date.now() })} />
          </Field>
        )}
        <p className="muted small">{describeSchedule(s)} · routines run while Lantern is open.</p>
        <Toggle label="Enabled" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
      </div>
    </Modal>
  );
}
