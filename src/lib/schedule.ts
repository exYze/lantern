import type { Schedule } from "./types";

/** Runs missed by more than this while the app was closed are skipped, not replayed. */
export const CATCH_UP_WINDOW_MS = 60 * 60 * 1000;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseTime(time: string): [number, number] {
  const [h, m] = time.split(":").map((n) => parseInt(n, 10));
  return [Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 9, Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 0];
}

/** Next run strictly after `from` (local time), or undefined if the schedule is finished. */
export function nextRun(schedule: Schedule, from: number): number | undefined {
  switch (schedule.kind) {
    case "interval":
      return from + Math.max(1, schedule.minutes) * 60_000;
    case "once":
      return schedule.at > from ? schedule.at : undefined;
    case "daily":
    case "weekdays":
    case "weekly": {
      const [h, m] = parseTime(schedule.time);
      const allowed =
        schedule.kind === "daily"
          ? [0, 1, 2, 3, 4, 5, 6]
          : schedule.kind === "weekdays"
            ? [1, 2, 3, 4, 5]
            : schedule.days.length
              ? schedule.days
              : [1];
      const d = new Date(from);
      for (let i = 0; i < 8; i++) {
        const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m, 0, 0);
        if (c.getTime() > from && allowed.includes(c.getDay())) return c.getTime();
      }
      return undefined;
    }
  }
}

export function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case "daily":
      return `Every day at ${s.time}`;
    case "weekdays":
      return `Every weekday at ${s.time}`;
    case "weekly":
      return `Every week on ${(s.days.length ? s.days : [1]).map((d) => DAY_NAMES[d]).join(", ")} at ${s.time}`;
    case "interval":
      return s.minutes % 60 === 0 ? `Every ${s.minutes / 60 === 1 ? "hour" : `${s.minutes / 60} hours`}` : `Every ${s.minutes} minutes`;
    case "once":
      return `Once on ${new Date(s.at).toLocaleString()}`;
  }
}

/** Accepts loosely-typed schedules from the model's create_routine call. */
export function parseSchedule(input: unknown): Schedule {
  const o = (input ?? {}) as Record<string, unknown>;
  const time = typeof o.time === "string" && /^\d{1,2}:\d{2}$/.test(o.time) ? o.time.padStart(5, "0") : "09:00";
  switch (o.kind) {
    case "daily":
      return { kind: "daily", time };
    case "weekdays":
      return { kind: "weekdays", time };
    case "weekly": {
      const days = Array.isArray(o.days)
        ? o.days
            .map((d) => (typeof d === "number" ? d : DAY_NAMES.findIndex((n) => String(d).toLowerCase().startsWith(n.toLowerCase()))))
            .filter((d) => d >= 0 && d <= 6)
        : [];
      return { kind: "weekly", days: days.length ? days : [1], time };
    }
    case "interval": {
      const minutes = Number(o.minutes ?? (Number(o.hours) || 0) * 60);
      return { kind: "interval", minutes: Number.isFinite(minutes) && minutes >= 5 ? Math.round(minutes) : 60 };
    }
    case "once": {
      const at = typeof o.at === "number" ? o.at : Date.parse(String(o.at ?? ""));
      if (Number.isFinite(at)) return { kind: "once", at };
      throw new Error("A one-time schedule needs `at` as an ISO date-time.");
    }
    default:
      throw new Error('Unknown schedule kind. Use "daily", "weekdays", "weekly", "interval" or "once".');
  }
}
