// The `browser` tool: a bot drives its own headless browser on the hub, for
// sites that need clicking, signing in or JavaScript. Each action returns a
// numbered list of what can be clicked or typed into, plus the page's text.
// The user can watch the same page from any device and take over.

import type { Risk } from "./approval";
import { hubBrowser, hubConnection, usesHub, type BrowserSpot } from "./hub";
import { useApp } from "./store";
import type { ToolContext, ToolDef } from "./tools";
import type { Bot } from "./types";
import { clip } from "./util";

const SNAPSHOT_TEXT = 5000;
const MAX_ELEMENTS = 120;

/** Where a bot's browser keeps its profile (sign-ins) and downloads. */
export function browserSpot(bot: Bot): BrowserSpot | null {
  const ws = hubConnection()?.tools?.workspace?.replace(/\/+$/, "");
  if (!ws) return null;
  // A sandboxed bot keeps everything in its own folder; others share the workspace's downloads.
  const home = bot.sandbox ? `${ws}/bots/${bot.id}` : ws;
  return { key: bot.id, profile: bot.sandbox ? `${home}/.browser` : `${ws}/.lantern/browser/${bot.id}`, downloads: `${home}/downloads` };
}

export function browserAvailable(bot: Bot): boolean {
  return usesHub(bot) && !!hubConnection()?.tools?.browser;
}

// Runs in the page: numbers everything you can click or type into, and reads the visible text.
const SNAPSHOT_JS = `(() => {
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [role=textbox], [contenteditable=""], [contenteditable=true], [onclick]';
  document.querySelectorAll('[data-lantern-ref]').forEach((e) => e.removeAttribute('data-lantern-ref'));
  const vw = innerWidth, vh = innerHeight;
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none' || el.closest('[aria-hidden=true]')) continue;
    if (++n > ${MAX_ELEMENTS}) break;
    el.setAttribute('data-lantern-ref', String(n));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'select' ? 'select' : tag === 'textarea' ? 'textbox' : tag === 'input' ? (['checkbox','radio','submit','button','file'].includes(type) ? type : 'textbox') : tag);
    const label = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    let name = el.getAttribute('aria-label') || (label && label.innerText) || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || (type === 'submit' ? el.value : '') || '';
    name = name.replace(/\\s+/g, ' ').trim().slice(0, 80);
    const item = { ref: n, role, name };
    if (tag === 'a') item.href = el.getAttribute('href');
    if ('value' in el && role !== 'link' && !['submit','button','checkbox','radio'].includes(role)) item.value = type === 'password' ? (el.value ? '(filled)' : '') : String(el.value).slice(0, 80);
    if (type === 'password') item.password = true;
    if (el.checked) item.checked = true;
    if (el.disabled) item.disabled = true;
    if (tag === 'select') item.options = Array.from(el.options).slice(0, 15).map((o) => o.text.trim());
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) item.offscreen = true;
    out.push(item);
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { url: location.href, title: document.title, elements: out, text, scrollY: Math.round(scrollY), height: document.documentElement.scrollHeight, vh };
})()`;

interface Snapshot {
  url: string;
  title: string;
  elements: { ref: number; role: string; name: string; href?: string; value?: string; password?: boolean; checked?: boolean; disabled?: boolean; options?: string[]; offscreen?: boolean }[];
  text: string;
  scrollY: number;
  height: number;
  vh: number;
}

async function evaluate<T>(spot: BrowserSpot, expression: string): Promise<T> {
  const r = await hubBrowser.call<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(spot, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "script error");
  return r.result?.value as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for the page to finish loading (up to ~15 seconds), then a moment for scripts. */
async function settle(spot: BrowserSpot, signal?: AbortSignal) {
  const until = Date.now() + 15_000;
  await sleep(300);
  while (Date.now() < until && !signal?.aborted) {
    const state = await evaluate<string>(spot, "document.readyState").catch(() => "loading");
    if (state === "complete") break;
    await sleep(300);
  }
  await sleep(500);
}

export function formatSnapshot(s: Snapshot, dialogs: string[] = []): string {
  const lines = [`Page: ${s.title || "(untitled)"}`, `URL: ${s.url}`];
  if (dialogs.length) lines.push(`Dialogs the page showed (answered OK): ${dialogs.join(" | ")}`);
  const below = s.height - (s.scrollY + s.vh);
  lines.push(`Scrolled ${s.scrollY}px of ${s.height}px${below > 50 ? `, more below` : ""}.`, "", "Things you can use (pass the number as ref):");
  for (const e of s.elements) {
    let line = `[${e.ref}] ${e.role}${e.name ? ` "${e.name}"` : ""}`;
    if (e.href && !e.href.startsWith("javascript:")) line += ` → ${e.href.slice(0, 120)}`;
    if (e.value !== undefined) line += ` (value: "${e.value}")`;
    if (e.options) line += ` options: ${e.options.join(" / ")}`;
    if (e.checked) line += " (checked)";
    if (e.disabled) line += " (disabled)";
    if (e.offscreen) line += " (off screen)";
    lines.push(line);
  }
  if (!s.elements.length) lines.push("(nothing clickable found)");
  lines.push("", "Text on the page:", clip(s.text, SNAPSHOT_TEXT) || "(empty)");
  return lines.join("\n");
}

async function snapshot(spot: BrowserSpot): Promise<string> {
  const [s, status] = await Promise.all([evaluate<Snapshot>(spot, SNAPSHOT_JS), hubBrowser.status(spot.key).catch(() => ({ open: true, dialogs: [] as string[] }))]);
  return formatSnapshot(s, status.dialogs ?? []);
}

async function pointOf(spot: BrowserSpot, ref: number): Promise<{ x: number; y: number }> {
  const p = await evaluate<{ x: number; y: number } | null>(
    spot,
    `(() => { const el = document.querySelector('[data-lantern-ref="${ref}"]'); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  if (!p) throw new Error(`There's no element ${ref} on the page any more (it changed). Use look to see the page again.`);
  return p;
}

export async function clickAt(spot: BrowserSpot, x: number, y: number) {
  const base = { x, y, button: "left", clickCount: 1 };
  await hubBrowser.call(spot, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await hubBrowser.call(spot, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await hubBrowser.call(spot, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageDown: { code: "PageDown", keyCode: 34 },
  PageUp: { code: "PageUp", keyCode: 33 },
  Space: { code: "Space", keyCode: 32, text: " " },
};

export async function pressKey(spot: BrowserSpot, key: string) {
  const k = KEYS[key];
  if (!k) throw new Error(`Unknown key "${key}". Use one of: ${Object.keys(KEYS).join(", ")}.`);
  const common = { key: key === "Space" ? " " : key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await hubBrowser.call(spot, "Input.dispatchKeyEvent", { type: "keyDown", ...common, ...(k.text ? { text: k.text } : {}) });
  await hubBrowser.call(spot, "Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

export async function typeText(spot: BrowserSpot, text: string) {
  await hubBrowser.call(spot, "Input.insertText", { text });
}

/** Replaces {{NAME}} with the bot's secret NAME, so passwords never pass through the model. */
export function fillSecrets(text: string, env: Record<string, string>): { text: string; used: string[] } {
  const used: string[] = [];
  const out = text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, name: string) => {
    if (!(name in env)) return m;
    used.push(name);
    return env[name];
  });
  return { text: out, used };
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && !isNaN(+v) ? +v : undefined);

function riskOf(a: Record<string, unknown>): Risk {
  switch (a.action) {
    case "click":
    case "type":
    case "select":
      return "write";
    case "press":
      return a.key === "Enter" ? "write" : "network";
    default:
      return "network";
  }
}

function summary(a: Record<string, unknown>): string {
  const what = typeof a.description === "string" && a.description.trim() ? a.description.trim() : a.ref !== undefined ? `element ${a.ref}` : "";
  switch (a.action) {
    case "open":
      return `Browse to ${a.url}`;
    case "click":
      return `Click ${what || "on the page"}`;
    case "type":
      return `Type into ${what || "the page"}${a.submit ? " and submit" : ""}`;
    case "select":
      return `Choose “${a.option}” in ${what || "a list"}`;
    case "press":
      return `Press ${a.key}`;
    case "scroll":
      return `Scroll ${a.direction ?? "down"}`;
    case "back":
      return "Go back";
    case "close":
      return "Close the browser";
    case "wait":
      return "Wait for the page";
    default:
      return "Look at the page";
  }
}

export const BROWSER_TOOL: ToolDef = {
  name: "browser",
  group: "browser",
  risk: riskOf,
  available: browserAvailable,
  description:
    "Use your own web browser on the hub, for sites that need clicking, typing, signing in or JavaScript. Every action returns the page: its title, URL, a numbered list of things you can click or type into, and its text. " +
    "Actions: open (url), look, click (ref), type (ref, text; submit=true presses Enter), select (ref, option), press (key: Enter, Tab, Escape, ArrowDown, PageDown…), scroll (direction up/down), back, wait (seconds), close. " +
    "Numbers change when the page changes, so use the ones from the latest result. Give a short description of what you click or type into (e.g. 'the Sign in button'): the user sees it. " +
    "To type a secret you have (like a password), write {{SECRET_NAME}}: it's filled in without you seeing it. Your sign-ins are kept between chats. If a site needs a code or a captcha, ask the user to take over from the Browser tab.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["open", "look", "click", "type", "select", "press", "scroll", "back", "wait", "close"] },
      url: { type: "string" },
      ref: { type: "integer", description: "Element number from the latest result" },
      description: { type: "string", description: "What you're clicking or typing into, for the user" },
      text: { type: "string" },
      submit: { type: "boolean" },
      option: { type: "string" },
      key: { type: "string" },
      direction: { type: "string", enum: ["down", "up"] },
      seconds: { type: "number" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  summarize: summary,
  run: (a, ctx) => runBrowser(a, ctx),
};

async function runBrowser(a: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const spot = browserSpot(ctx.bot);
  if (!spot) throw new Error("The browser needs a connected Lantern Hub.");
  const ref = num(a.ref);
  const needRef = () => {
    if (ref === undefined) throw new Error("This action needs `ref`, the element's number from the latest result.");
    return ref;
  };
  switch (a.action) {
    case "open": {
      let url = typeof a.url === "string" ? a.url.trim() : "";
      if (!url) throw new Error("open needs a url.");
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
      if (!/^https?:/i.test(url)) throw new Error("Only http(s) pages can be opened.");
      const r = await hubBrowser.call<{ errorText?: string }>(spot, "Page.navigate", { url }, { timeoutMs: 45_000 });
      if (r.errorText) throw new Error(`Couldn't open ${url}: ${r.errorText}`);
      await settle(spot, ctx.signal);
      break;
    }
    case "click": {
      const p = await pointOf(spot, needRef());
      await clickAt(spot, p.x, p.y);
      await settle(spot, ctx.signal);
      // A link that opens a new tab: follow it.
      if ((await hubBrowser.followPopup(spot.key)).switched) await settle(spot, ctx.signal);
      break;
    }
    case "type": {
      const raw = typeof a.text === "string" ? a.text : "";
      const p = await pointOf(spot, needRef());
      await clickAt(spot, p.x, p.y);
      // Replace what's there rather than adding to it.
      await evaluate(spot, `(() => { const el = document.activeElement; if (el && 'value' in el) { el.select?.(); } else { document.execCommand('selectAll'); } })()`);
      await typeText(spot, fillSecrets(raw, ctx.env).text);
      if (a.submit) {
        await pressKey(spot, "Enter");
        await settle(spot, ctx.signal);
      } else {
        await sleep(300);
      }
      break;
    }
    case "select": {
      const option = typeof a.option === "string" ? a.option : "";
      const ok = await evaluate<boolean>(
        spot,
        `(() => { const el = document.querySelector('[data-lantern-ref="${needRef()}"]'); if (!el || el.tagName !== 'SELECT') return false; const want = ${JSON.stringify(option.toLowerCase())}; const opt = Array.from(el.options).find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) || Array.from(el.options).find((o) => o.text.toLowerCase().includes(want)); if (!opt) return false; el.value = opt.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
      );
      if (!ok) throw new Error(`Couldn't choose “${option}” there: it isn't a list with that option.`);
      await settle(spot, ctx.signal);
      break;
    }
    case "press":
      await pressKey(spot, typeof a.key === "string" ? a.key : "Enter");
      await settle(spot, ctx.signal);
      break;
    case "scroll":
      await evaluate(spot, `window.scrollBy(0, ${a.direction === "up" ? "-" : ""}Math.round(innerHeight * 0.8))`);
      await sleep(400);
      break;
    case "back":
      await evaluate(spot, "history.back()");
      await settle(spot, ctx.signal);
      break;
    case "wait":
      await sleep(Math.min(30, Math.max(1, num(a.seconds) ?? 3)) * 1000);
      break;
    case "close":
      await hubBrowser.close(spot.key);
      return "Closed the browser. Your sign-ins are kept for next time.";
    case "look":
      break;
    default:
      throw new Error(`Unknown action "${String(a.action)}".`);
  }
  return snapshot(spot);
}

/** Bots whose browser the user can watch: those with the tool on, on a hub that has one. */
export function watchableBot(bot: Bot): boolean {
  return browserAvailable(bot) && (bot.tools.browser ?? true) && !!useApp.getState().hub;
}
