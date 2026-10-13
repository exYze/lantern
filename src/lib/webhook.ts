// Turns a webhook call or an email into the message that starts a routine run.
// Well-known senders (GitHub, GitLab, Linear, Sentry, PagerDuty) get a one-line
// summary so the bot knows what happened before reading the raw payload.

import type { Routine, TriggerEvent } from "./types";
import { clip } from "./util";

const MAX_BODY = 12_000;

function parse(body?: string): any {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const h = (e: TriggerEvent, name: string) => e.headers?.[name.toLowerCase()];

/** One line saying what a known service is reporting, or null for anything else. */
export function summarizeWebhook(e: TriggerEvent): string | null {
  const j = parse(e.body);
  const gh = h(e, "x-github-event");
  if (gh) {
    const repo = j?.repository?.full_name;
    const who = j?.sender?.login;
    const item = j?.pull_request ?? j?.issue ?? j?.release ?? j?.workflow_run ?? j?.check_run ?? null;
    const title = item?.title ?? item?.name ?? j?.head_commit?.message?.split("\n")[0];
    const url = item?.html_url ?? j?.compare;
    const head = [`GitHub ${gh}${j?.action ? ` (${j.action})` : ""}`, repo && `in ${repo}`, who && `by ${who}`].filter(Boolean).join(" ");
    return `${head}${title ? `: “${title}”` : ""}${url ? ` ${url}` : ""}`;
  }
  const gl = h(e, "x-gitlab-event");
  if (gl) {
    const attrs = j?.object_attributes;
    const head = [`GitLab ${gl}`, j?.project?.path_with_namespace && `in ${j.project.path_with_namespace}`].filter(Boolean).join(" ");
    return `${head}${attrs?.title ? `: “${attrs.title}”` : ""}${attrs?.url ? ` ${attrs.url}` : ""}`;
  }
  if (h(e, "linear-event") || (j?.type && j?.action && j?.organizationId)) {
    return `Linear ${j?.type ?? h(e, "linear-event")} ${j?.action ?? ""}${j?.data?.title ? `: “${j.data.title}”` : ""}${j?.url ? ` ${j.url}` : ""}`.trim();
  }
  const sentry = h(e, "sentry-hook-resource");
  if (sentry) {
    const issue = j?.data?.issue ?? j?.data?.error ?? j?.data?.event;
    return `Sentry ${sentry} ${j?.action ?? ""}${issue?.title ? `: “${issue.title}”` : ""}${issue?.web_url ? ` ${issue.web_url}` : ""}`.trim();
  }
  if (j?.event?.event_type?.startsWith?.("incident.") || j?.messages?.[0]?.event?.startsWith?.("incident.")) {
    const ev = j.event ?? j.messages[0];
    const incident = ev.data ?? ev.incident;
    return `PagerDuty ${ev.event_type ?? ev.event}${incident?.title ? `: “${incident.title}”` : ""}${incident?.html_url ? ` ${incident.html_url}` : ""}`;
  }
  return null;
}

/** The message a routine run starts with. */
export function routinePrompt(routine: Routine, event?: TriggerEvent): string {
  const head = `**Routine “${routine.name}”:** ${routine.prompt}`;
  if (!event) return head;
  if (event.source === "email" && event.email) {
    const m = event.email;
    return `${head}\n\nA new email arrived in your inbox and started this run.\n\nFrom: ${m.from}\nSubject: ${m.subject}${m.date ? `\nDate: ${m.date}` : ""}\nMessage id (for email_read): ${m.uid}\n\n${clip(m.text, MAX_BODY)}`;
  }
  const lines = [head, "", "A webhook call started this run."];
  const summary = summarizeWebhook(event);
  if (summary) lines.push(summary);
  if (event.query) lines.push(`Query string: ${event.query}`);
  const json = parse(event.body);
  if (event.body?.trim()) {
    lines.push("", json ? "The request body:" : "The request body (not JSON):", "```" + (json ? "json" : ""), clip(json ? JSON.stringify(json, null, 2) : event.body, MAX_BODY), "```");
  } else {
    lines.push("It had no body.");
  }
  return lines.join("\n");
}
