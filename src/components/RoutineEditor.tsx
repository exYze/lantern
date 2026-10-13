import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { hubApi } from "../lib/hub";
import { httpRequest, secrets } from "../lib/platform";
import { describeSchedule, nextRun } from "../lib/schedule";
import { saveRoutine, toast, useApp } from "../lib/store";
import type { Routine, RoutineTrigger, Schedule } from "../lib/types";
import { uid } from "../lib/util";
import { Button, Field, IconButton, Modal, Toggle } from "./ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const newKey = () => uid("").slice(0, 16) + uid("").slice(0, 8);
export const signingKey = (routineId: string) => `routine:${routineId}:signing`;

/** Where the hub takes webhooks (its tailnet address, and any others its owner configured). */
function useHookUrls(): string[] {
  const hub = useApp((s) => s.hub);
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    if (!hub) return;
    hubApi<{ hookUrls?: string[] }>("/api/v1/info", { timeoutMs: 15000 })
      .then((i) => setUrls(i.hookUrls?.length ? i.hookUrls : [hub.url]))
      .catch(() => setUrls([hub.url]));
  }, [hub]);
  return urls;
}

export function RoutineEditor({ routine, botId, onClose }: { routine?: Routine; botId?: string; onClose: () => void }) {
  const bots = useApp((s) => s.bots);
  const hub = useApp((s) => s.hub);
  const runnerOnline = useApp((s) => !!s.runner?.online);
  const [draft, setDraft] = useState<Routine>(
    routine ?? {
      id: uid("routine"),
      botId: botId ?? bots[0]?.id ?? "",
      name: "",
      prompt: "",
      schedule: { kind: "daily", time: "09:00" },
      trigger: { kind: "schedule" },
      enabled: true,
      createdAt: Date.now(),
    },
  );
  const [signing, setSigning] = useState("");
  const [hasSigning, setHasSigning] = useState(false);
  const hookUrls = useHookUrls();
  useEffect(() => {
    void secrets.get(signingKey(draft.id)).then((v) => setHasSigning(!!v));
  }, [draft.id]);

  const s = draft.schedule;
  const trigger: RoutineTrigger = draft.trigger ?? { kind: "schedule" };
  const bot = bots.find((b) => b.id === draft.botId);
  const setSchedule = (schedule: Schedule) => setDraft({ ...draft, schedule });
  const setTrigger = (t: RoutineTrigger) => setDraft({ ...draft, trigger: t });
  const time = "time" in s ? s.time : "09:00";
  const valid = draft.botId && draft.name.trim() && draft.prompt.trim();
  const hookPath = trigger.kind === "webhook" ? `/hooks/${draft.id}/${trigger.key}` : "";

  const save = async () => {
    const scheduled = trigger.kind === "schedule";
    await saveRoutine({
      ...draft,
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      nextRunAt: scheduled && draft.enabled ? nextRun(draft.schedule, Date.now()) : undefined,
    });
    if (signing.trim()) await secrets.set(signingKey(draft.id), signing.trim());
  };

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
              await save();
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
        <Field label="Starts">
          <select
            className="select"
            value={trigger.kind}
            onChange={(e) => {
              const k = e.target.value as RoutineTrigger["kind"];
              if (k === "webhook") setTrigger({ kind: "webhook", key: trigger.kind === "webhook" ? trigger.key : newKey() });
              else if (k === "email") setTrigger({ kind: "email" });
              else setTrigger({ kind: "schedule" });
            }}
          >
            <option value="schedule">On a schedule</option>
            <option value="webhook" disabled={!hub}>
              When a webhook is called{hub ? "" : " (needs a Lantern Hub)"}
            </option>
            <option value="email" disabled={!bot?.email}>
              When an email arrives{bot?.email ? ` at ${bot.email.address}` : " (give the bot an inbox first)"}
            </option>
          </select>
        </Field>

        {trigger.kind === "schedule" && (
          <>
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
            <p className="muted small">
              {describeSchedule(s)} · {runnerOnline ? "runs on your hub, even when every app is closed." : "runs while Lantern is open on one of your devices."}
            </p>
          </>
        )}

        {trigger.kind === "webhook" && (
          <>
            <p className="muted small">
              Point a service (GitHub, GitLab, Linear, Sentry, Home Assistant, a script) at this address. Each POST starts a run, and {bot?.name ?? "the bot"} gets the request's body.
              Anyone with the address can start it, so keep it private.
            </p>
            {hookUrls.map((base) => (
              <div key={base} className="row">
                <input className="input mono" readOnly value={base + hookPath} onFocus={(e) => e.currentTarget.select()} />
                <IconButton
                  label="Copy address"
                  onClick={() => {
                    void navigator.clipboard?.writeText(base + hookPath);
                    toast("Copied.", "success");
                  }}
                >
                  <Copy size={15} />
                </IconButton>
              </div>
            ))}
            <p className="muted small">
              These work on your own networks. A service on the internet (like GitHub) needs a public address: docs/HUB.md, Webhooks, shows how to publish just the webhook path with Tailscale Funnel.
            </p>
            <Field label={hasSigning ? "Signing secret (saved; type a new one to replace it)" : "Signing secret (optional)"} hint="With one, calls must be signed with it (GitHub, Gitea, Linear and Sentry style) or carry it as GitLab's token.">
              <input className="input" type="password" autoComplete="off" value={signing} onChange={(e) => setSigning(e.target.value)} />
            </Field>
            {routine && (
              <div>
                <Button
                  size="sm"
                  onClick={async () => {
                    await save();
                    try {
                      const res = await httpRequest({ method: "POST", url: (hub?.url ?? "") + hookPath, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ test: true, sentFrom: "Lantern" }), timeoutMs: 20000 });
                      toast(res.status === 202 ? "Sent. The routine is starting." : `The hub answered ${res.status}: ${res.body.slice(0, 120)}`, res.status === 202 ? "success" : "error");
                    } catch (e) {
                      toast((e as Error).message, "error");
                    }
                  }}
                >
                  Send a test call
                </Button>
              </div>
            )}
          </>
        )}

        {trigger.kind === "email" && (
          <p className="muted small">
            Your hub checks {bot?.email?.address ?? "the inbox"} every two minutes. Each new message starts a run with the message in it. Mail that's already there doesn't count.
          </p>
        )}

        <Toggle
          label="Stay quiet when there's nothing new"
          description="No notification when the bot's whole answer is “Nothing new”. Ask for that answer in the instructions above."
          checked={!!draft.quiet}
          onChange={(quiet) => setDraft({ ...draft, quiet })}
        />
        <Toggle label="Enabled" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
      </div>
    </Modal>
  );
}
