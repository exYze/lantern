// Reading documents: PDF (pdf.js), Word (mammoth), Excel and CSV (SheetJS),
// PowerPoint (the slides' XML) and iPhone photos (HEIC, converted to JPEG).
// The libraries are large, so each loads only when a document of its kind
// turns up. The same code runs in the apps and in the hub's runner.

export type DocKind = "pdf" | "docx" | "xlsx" | "pptx" | "csv" | "html" | "text" | "image" | "heic" | "other";

const TEXT_EXT = /\.(txt|md|markdown|tsv|json|jsonl|yaml|yml|toml|ini|xml|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|ps1|bat|sql|r|lua|log|env|cfg|conf|tex|svg)$/i;

export function docKind(name: string, mime = ""): DocKind {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (n.endsWith(".docx")) return "docx";
  if (/\.(xlsx|xlsm|xls|ods)$/.test(n)) return "xlsx";
  if (n.endsWith(".pptx")) return "pptx";
  if (n.endsWith(".csv") || mime === "text/csv") return "csv";
  if (/\.(html?|xhtml)$/.test(n)) return "html";
  if (/\.(heic|heif)$/.test(n) || /image\/hei[cf]/.test(mime)) return "heic";
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/.test(n) || mime.startsWith("image/")) return "image";
  if (TEXT_EXT.test(n) || mime.startsWith("text/") || mime.includes("json")) return "text";
  return "other";
}

export const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  html: "text/html",
};

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ------------------------------------------------------------------ PDF

type PdfModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<PdfModule> | null = null;

/** pdf.js, with its worker code run on this thread (no worker file to serve, and it works in Node). */
export function loadPdf(): Promise<PdfModule> {
  pdfjs ??= (async () => {
    // @ts-expect-error: the worker module ships without type declarations.
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })();
  return pdfjs;
}

/** Opens a PDF; call `close()` when done with it. */
export async function openPdf(bytes: Uint8Array) {
  const lib = await loadPdf();
  const task = lib.getDocument({ data: bytes.slice(), useSystemFonts: true });
  const doc = await task.promise;
  return { doc, close: () => task.destroy() };
}

async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const { doc, close } = await openPdf(bytes);
  const parts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let line = "";
    const lines: string[] = [];
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
      line += item.str ?? "";
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    parts.push(`[page ${p}]\n${lines.join("\n").trim()}`);
  }
  const pages = doc.numPages;
  await close();
  return { text: parts.join("\n\n"), pages };
}

// ------------------------------------------------------------------ Word, Excel, PowerPoint

async function mammothLib() {
  const m = await import("mammoth");
  return ((m as unknown as { default?: typeof m }).default ?? m) as typeof m;
}

function mammothInput(bytes: Uint8Array) {
  const arrayBuffer = bytes.slice().buffer;
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): unknown } }).Buffer;
  return B ? { arrayBuffer, buffer: B.from(bytes) } : { arrayBuffer };
}

export async function docxToHtml(bytes: Uint8Array): Promise<string> {
  const mammoth = await mammothLib();
  return (await mammoth.convertToHtml(mammothInput(bytes) as Parameters<typeof mammoth.convertToHtml>[0])).value;
}

async function docxText(bytes: Uint8Array): Promise<string> {
  const mammoth = await mammothLib();
  return (await mammoth.extractRawText(mammothInput(bytes) as Parameters<typeof mammoth.extractRawText>[0])).value;
}

export interface Sheet {
  name: string;
  rows: string[][];
}

export async function readSheets(bytes: Uint8Array, maxRows = 2000): Promise<Sheet[]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, { type: "array", cellDates: true, dense: true });
  return wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: "", blankrows: false }).slice(0, maxRows);
    return { name, rows: rows.map((r) => r.map((c) => String(c ?? ""))) };
  });
}

export function parseCsv(text: string, maxRows = 2000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const sep = (text.split("\n")[0].match(/\t/g)?.length ?? 0) > (text.split("\n")[0].match(/,/g)?.length ?? 0) ? "\t" : ",";
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

export async function pptxSlides(bytes: Uint8Array): Promise<string[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()));
  const slides: string[] = [];
  for (const n of names) {
    const xml = await zip.files[n].async("string");
    const paragraphs = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("")).filter((t) => t.trim());
    slides.push(paragraphs.join("\n").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  }
  return slides;
}

// ------------------------------------------------------------------ text for the model

export interface Extracted {
  kind: DocKind;
  text: string;
  /** Pages, sheets or slides, when the document has them. */
  parts?: number;
}

/** Turns a document into plain text a model can read. */
export async function extractText(bytes: Uint8Array, name: string, mime = ""): Promise<Extracted> {
  const kind = docKind(name, mime);
  switch (kind) {
    case "pdf": {
      const r = await pdfText(bytes);
      return { kind, text: r.text, parts: r.pages };
    }
    case "docx":
      return { kind, text: await docxText(bytes) };
    case "xlsx": {
      const sheets = await readSheets(bytes);
      return { kind, text: sheets.map((s) => `[sheet ${s.name}]\n${s.rows.map((r) => r.join("\t")).join("\n")}`).join("\n\n"), parts: sheets.length };
    }
    case "pptx": {
      const slides = await pptxSlides(bytes);
      return { kind, text: slides.map((t, i) => `[slide ${i + 1}]\n${t}`).join("\n\n"), parts: slides.length };
    }
    case "html": {
      const { htmlToText } = await import("./html");
      return { kind, text: htmlToText(new TextDecoder().decode(bytes)).text };
    }
    case "csv":
    case "text":
      return { kind, text: new TextDecoder().decode(bytes) };
    default:
      throw new Error(`${name} isn't a document I can read (PDF, Word, Excel, PowerPoint, CSV or text).`);
  }
}

/** iPhone photos (HEIC) as JPEG, so models and every screen can show them. Browser only. */
export async function heicToJpeg(blob: Blob): Promise<Blob> {
  const heic2any = (await import("heic2any")).default;
  const out = await heic2any({ blob, toType: "image/jpeg", quality: 0.85 });
  return Array.isArray(out) ? out[0] : out;
}
