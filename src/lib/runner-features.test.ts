import { describe, expect, it } from "vitest";
import { fillSecrets, formatSnapshot } from "./browser";
import { htmlToText } from "./html";
import { checkChain } from "./team";
import type { Bot, Routine, TriggerEvent } from "./types";
import { routinePrompt, summarizeWebhook } from "./webhook";
import { isNothingNew } from "./agent";

const routine: Routine = { id: "r1", botId: "b1", name: "Triage", prompt: "Sort it out.", schedule: { kind: "daily", time: "09:00" }, trigger: { kind: "webhook", key: "k" }, enabled: true, createdAt: 0 };
const event = (headers: Record<string, string>, body: unknown): TriggerEvent => ({ id: "e1", routineId: "r1", source: "webhook", receivedAt: 0, headers, body: JSON.stringify(body) });

describe("webhooks", () => {
  it("summarizes GitHub events", () => {
    const e = event({ "x-github-event": "pull_request" }, { action: "opened", repository: { full_name: "me/app" }, sender: { login: "pat" }, pull_request: { title: "Fix login", html_url: "https://github.com/me/app/pull/7" } });
    expect(summarizeWebhook(e)).toBe("GitHub pull_request (opened) in me/app by pat: “Fix login” https://github.com/me/app/pull/7");
  });

  it("summarizes Sentry and leaves unknown senders alone", () => {
    expect(summarizeWebhook(event({ "sentry-hook-resource": "issue" }, { action: "created", data: { issue: { title: "TypeError", web_url: "https://sentry.io/i/1" } } }))).toBe("Sentry issue created: “TypeError” https://sentry.io/i/1");
    expect(summarizeWebhook(event({}, { hello: "world" }))).toBeNull();
  });

  it("puts the payload in the run's first message", () => {
    const text = routinePrompt(routine, event({ "x-github-event": "push" }, { ref: "refs/heads/main" }));
    expect(text).toContain("**Routine “Triage”:** Sort it out.");
    expect(text).toContain("A webhook call started this run.");
    expect(text).toContain('"ref": "refs/heads/main"');
  });

  it("shows plain-text bodies and emails", () => {
    expect(routinePrompt(routine, { ...event({}, null), body: "door opened" })).toContain("(not JSON)");
    const mail = routinePrompt(routine, { id: "e2", routineId: "r1", source: "email", receivedAt: 0, email: { uid: 42, from: "Sam <sam@x.com>", subject: "Invoice", text: "Please pay." } });
    expect(mail).toContain("From: Sam <sam@x.com>");
    expect(mail).toContain("Message id (for email_read): 42");
  });
});

describe("bots asking bots", () => {
  const bot = (id: string) => ({ id, name: id.toUpperCase() }) as Bot;
  it("refuses circles and long chains", () => {
    expect(() => checkChain(["a"], bot("b"))).not.toThrow();
    expect(() => checkChain(["a", "b"], bot("a"))).toThrow(/circles/);
    expect(() => checkChain(["a", "b", "c"], bot("d"))).toThrow(/several bots/);
  });
});

describe("browser", () => {
  it("fills secrets without showing them", () => {
    expect(fillSecrets("{{PASSWORD}}", { PASSWORD: "hunter2" })).toEqual({ text: "hunter2", used: ["PASSWORD"] });
    expect(fillSecrets("hi {{ MISSING }}", {}).text).toBe("hi {{ MISSING }}");
  });

  it("lists what the bot can use", () => {
    const text = formatSnapshot(
      {
        url: "https://example.com/login",
        title: "Sign in",
        elements: [
          { ref: 1, role: "textbox", name: "Email", value: "" },
          { ref: 2, role: "textbox", name: "Password", value: "(filled)", password: true },
          { ref: 3, role: "button", name: "Sign in" },
          { ref: 4, role: "link", name: "Help", href: "/help", offscreen: true },
        ],
        text: "Welcome back",
        scrollY: 0,
        height: 2000,
        vh: 900,
      },
      ["alert dialog: Saved"],
    );
    expect(text).toContain('[3] button "Sign in"');
    expect(text).toContain('[2] textbox "Password" (value: "(filled)")');
    expect(text).toContain('[4] link "Help" → /help (off screen)');
    expect(text).toContain("more below");
    expect(text).toContain("alert dialog: Saved");
  });
});

describe("htmlToText", () => {
  it("keeps the words and links, drops scripts", () => {
    const r = htmlToText('<html><head><title>Hi &amp; bye</title><script>x()</script></head><body><h1>Title</h1><p>One<br>two</p><a href="https://a.com">A</a><ul><li>x</li></ul></body></html>');
    expect(r.title).toBe("Hi & bye");
    expect(r.text).toContain("# Title");
    expect(r.text).toContain("One\ntwo");
    expect(r.text).toContain("A (https://a.com)");
    expect(r.text).toContain("- x");
    expect(r.text).not.toContain("x()");
  });
});

describe("check-ins", () => {
  it("recognizes a quiet answer", () => {
    expect(isNothingNew("Nothing new.")).toBe(true);
    expect(isNothingNew("  nothing new ")).toBe(true);
    expect(isNothingNew("Nothing new, but the build failed")).toBe(false);
  });
});
