// What bots make for you: pages (Markdown documents you can read and edit),
// files they share from their workspace, slide decks (PowerPoint), and
// documents they read (PDF, Word, Excel, PowerPoint). Pages and the list of
// shared files sync, so the Library shows them on every device.

import { capabilities } from "./platform";
import { base64ToBytes, extractText } from "./documents";
import { hubFs, usesHub } from "./hub";
import { fs } from "./platform";
import { C, useApp } from "./store";
import { db } from "./platform";
import type { ToolContext, ToolDef } from "./tools";
import type { Bot, Page, SharedFile, SlideOutline } from "./types";
import { clip, uid } from "./util";

const canUseFiles = (bot: Bot) => capabilities.files || usesHub(bot);
const files = (ctx: ToolContext) => (ctx.remote ? hubFs : fs);

export async function savePage(page: Page): Promise<void> {
  const exists = useApp.getState().pages.some((p) => p.id === page.id);
  useApp.setState((s) => ({ pages: exists ? s.pages.map((p) => (p.id === page.id ? page : p)) : [page, ...s.pages] }));
  await db.put(C.pages, page.id, page);
}

export async function deletePage(id: string): Promise<void> {
  useApp.setState((s) => ({ pages: s.pages.filter((p) => p.id !== id) }));
  await db.delete(C.pages, id);
}

export async function saveSharedFile(f: SharedFile): Promise<void> {
  useApp.setState((s) => ({ files: [f, ...s.files.filter((x) => x.id !== f.id)] }));
  await db.put(C.files, f.id, f);
}

export async function forgetSharedFile(id: string): Promise<void> {
  useApp.setState((s) => ({ files: s.files.filter((f) => f.id !== id) }));
  await db.delete(C.files, id);
}

/** Where this device is, for files that live on a device rather than the hub. */
export const thisDeviceId = () => useApp.getState().hub?.deviceId ?? "local";

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
const dirName = (p: string) => {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  return parts.join("/");
};
const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "deck";

/** Reads a shared file's bytes from wherever it lives. */
export async function readSharedFile(f: SharedFile): Promise<Uint8Array> {
  if (f.where === "hub") return base64ToBytes((await hubFs.readBytes(f.root, f.path, f.confine)).base64);
  if (f.deviceId !== thisDeviceId()) {
    const d = f.deviceId ? ` (${f.deviceName ?? "another device"})` : "";
    throw new Error(`This file is on the device that made it${d}. Open it there, or move the bot's files to the hub.`);
  }
  return base64ToBytes((await fs.readBytes(f.root, f.path, f.confine)).base64);
}

async function shareFromWorkspace(ctx: ToolContext, path: string, extra: Partial<SharedFile> = {}): Promise<SharedFile> {
  const dir = dirName(path);
  const entries = await files(ctx).list(ctx.workspace, dir || undefined, ctx.confine);
  const entry = entries.find((e) => e.name === baseName(path) && !e.isDir);
  if (!entry) throw new Error(`There's no file at ${path}.`);
  const { hub } = useApp.getState();
  const file: SharedFile = {
    id: uid("file"),
    botId: ctx.bot.id,
    conversationId: ctx.conversationId,
    name: entry.name,
    path,
    root: ctx.workspace,
    confine: ctx.confine,
    where: ctx.remote ? "hub" : "device",
    deviceId: ctx.remote ? undefined : thisDeviceId(),
    deviceName: ctx.remote ? undefined : (hub ? undefined : "this device"),
    size: entry.size,
    kind: "file",
    createdAt: Date.now(),
    ...extra,
  };
  await saveSharedFile(file);
  ctx.onProgress?.({ file: { id: file.id, name: file.name } }, true);
  return file;
}

/** Builds a .pptx from an outline, in Lantern's colors. */
export async function buildDeck(outline: SlideOutline): Promise<string> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = outline.title;
  const dark = outline.theme === "dark";
  const paper = dark ? "16291F" : "F6F6F3";
  const ink = dark ? "E6EBE7" : "191D1B";
  const muted = dark ? "A8BCAE" : "5B625E";
  const flame = dark ? "F08A3C" : "BF4512";

  const cover = pptx.addSlide();
  cover.background = { color: "1F3B2F" };
  cover.addText(outline.title, { x: 0.8, y: 2.6, w: 11.7, h: 1.4, fontFace: "Arial", fontSize: 40, bold: true, color: "EEF2EC" });
  cover.addShape("rect", { x: 0.8, y: 4.1, w: 1.6, h: 0.08, fill: { color: "F39A52" }, line: { color: "F39A52" } });
  if (outline.subtitle) cover.addText(outline.subtitle, { x: 0.8, y: 4.35, w: 11.7, h: 0.8, fontFace: "Arial", fontSize: 20, color: "A8BCAE" });

  for (const s of outline.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: paper };
    slide.addText(s.title, { x: 0.7, y: 0.45, w: 11.9, h: 0.9, fontFace: "Arial", fontSize: 30, bold: true, color: ink });
    slide.addShape("rect", { x: 0.7, y: 1.35, w: 1.1, h: 0.06, fill: { color: flame }, line: { color: flame } });
    if (s.bullets.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: { indent: 18 }, paraSpaceAfter: 10 } })),
        { x: 0.7, y: 1.7, w: 11.9, h: 5.2, fontFace: "Arial", fontSize: 20, color: ink, valign: "top" },
      );
    }
    if (s.notes) slide.addNotes(s.notes);
    slide.addText(outline.title, { x: 0.7, y: 6.95, w: 8, h: 0.35, fontFace: "Arial", fontSize: 10, color: muted });
  }
  return (await pptx.write({ outputType: "base64" })) as string;
}

export function normalizeOutline(a: Record<string, unknown>): SlideOutline {
  const slides = (Array.isArray(a.slides) ? a.slides : []).slice(0, 40).map((s: any, i: number) => ({
    title: String(s?.title ?? `Slide ${i + 1}`).slice(0, 120),
    bullets: (Array.isArray(s?.bullets) ? s.bullets : []).slice(0, 10).map((b: unknown) => String(b).slice(0, 300)),
    notes: typeof s?.notes === "string" ? s.notes.slice(0, 2000) : undefined,
  }));
  if (!slides.length) throw new Error("A deck needs at least one slide.");
  return { title: String(a.title ?? "Slides").slice(0, 120), subtitle: typeof a.subtitle === "string" ? a.subtitle.slice(0, 200) : undefined, slides, theme: a.theme === "dark" ? "dark" : "light" };
}

export const PAGE_TOOLS: ToolDef[] = [
  {
    name: "write_page",
    group: "pages",
    risk: "internal",
    description:
      "Write a page: a Markdown document the user can open, read and edit (a report, a plan, notes, a draft). Pass page_id to replace a page you wrote before; read it first, since the user may have edited it.",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, content: { type: "string", description: "Markdown" }, page_id: { type: "string" } },
      required: ["title", "content"],
      additionalProperties: false,
    },
    summarize: (a) => `Write the page “${typeof a.title === "string" ? a.title : "untitled"}”`,
    async run(a, ctx) {
      const now = Date.now();
      const existing = typeof a.page_id === "string" ? useApp.getState().pages.find((p) => p.id === a.page_id) : undefined;
      const page: Page = {
        id: existing?.id ?? uid("page"),
        botId: ctx.bot.id,
        conversationId: existing?.conversationId ?? ctx.conversationId,
        title: String(a.title ?? "Untitled").slice(0, 160),
        content: String(a.content ?? ""),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        editedByUser: false,
      };
      await savePage(page);
      ctx.onProgress?.({ page: { id: page.id, title: page.title } }, true);
      return `${existing ? "Updated" : "Saved"} the page “${page.title}” (id ${page.id}). The user can open it from the chat or the Library.`;
    },
  },
  {
    name: "read_page",
    group: "pages",
    risk: "internal",
    description: "Read one of your pages by id, including any edits the user made.",
    parameters: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"], additionalProperties: false },
    summarize: () => "Read a page",
    async run(a) {
      const page = useApp.getState().pages.find((p) => p.id === a.page_id);
      if (!page) throw new Error(`No page with id ${String(a.page_id)}.`);
      return `# ${page.title}${page.editedByUser ? "\n(The user edited this page.)" : ""}\n\n${page.content}`;
    },
  },
  {
    name: "share_file",
    group: "pages",
    risk: "internal",
    available: canUseFiles,
    description: "Share a file from your workspace with the user: it shows in the chat with a preview (PDF, Word, Excel, slides, images, HTML, text) and is kept in the Library.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    summarize: (a) => `Share ${typeof a.path === "string" ? baseName(a.path) : "a file"}`,
    async run(a, ctx) {
      const f = await shareFromWorkspace(ctx, String(a.path ?? ""));
      return `Shared ${f.name} with the user.`;
    },
  },
  {
    name: "make_slides",
    group: "pages",
    risk: "write",
    available: canUseFiles,
    description:
      "Make a slide deck (PowerPoint .pptx, which also opens in Keynote, LibreOffice and Google Slides) from an outline, save it in your workspace and share it. Keep slides short: a title and up to six bullets each, with details in notes.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        subtitle: { type: "string" },
        slides: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } }, notes: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
        theme: { type: "string", enum: ["light", "dark"] },
        path: { type: "string", description: "Where to save it (default slides/<title>.pptx)" },
      },
      required: ["title", "slides"],
      additionalProperties: false,
    },
    summarize: (a) => `Make slides: ${typeof a.title === "string" ? a.title : "a deck"}`,
    async run(a, ctx) {
      const outline = normalizeOutline(a);
      const path = typeof a.path === "string" && a.path.trim() ? a.path.trim() : `slides/${slug(outline.title)}.pptx`;
      const base64 = await buildDeck(outline);
      await files(ctx).writeBytes(ctx.workspace, path, base64, ctx.confine);
      const f = await shareFromWorkspace(ctx, path, { kind: "slides", slides: outline });
      return `Made a ${outline.slides.length + 1}-slide deck at ${path} and shared it as ${f.name}.`;
    },
  },
  {
    name: "read_document",
    group: "pages",
    risk: "read",
    available: canUseFiles,
    description: "Read a PDF, Word (.docx), Excel (.xlsx, .xls, .ods), PowerPoint (.pptx) or CSV file from your workspace as text. Use read_file for plain text files.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    summarize: (a) => `Read ${typeof a.path === "string" ? baseName(a.path) : "a document"}`,
    async run(a, ctx) {
      const path = String(a.path ?? "");
      if (!path.trim()) throw new Error("Missing required argument: path");
      const r = await files(ctx).readBytes(ctx.workspace, path, ctx.confine);
      const doc = await extractText(base64ToBytes(r.base64), r.name);
      const unit = doc.kind === "pdf" ? "pages" : doc.kind === "xlsx" ? "sheets" : doc.kind === "pptx" ? "slides" : "";
      const text = doc.text.trim() || (doc.kind === "pdf" ? "(No text found: this PDF may be scanned images.)" : "(empty)");
      return `${r.path} (${doc.kind}${doc.parts && unit ? `, ${doc.parts} ${unit}` : ""})\n\n${clip(text, 40_000)}`;
    },
  },
];
