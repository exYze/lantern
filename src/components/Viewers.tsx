import { Download, LoaderCircle, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bytesToBase64, docKind, docxToHtml, heicToJpeg, MIME, openPdf, parseCsv, pptxSlides, readSheets, type Sheet } from "../lib/documents";
import { deletePage, readSharedFile, savePage } from "../lib/pages";
import { fs, isTauri, platform } from "../lib/platform";
import { toast, useApp } from "../lib/store";
import type { Page, SharedFile, SlideOutline } from "../lib/types";
import { formatBytes, timeAgo } from "../lib/util";
import { CopyButton, Markdown } from "./Markdown";
import { Button, confirmDialog, Modal } from "./ui";

/** Saves bytes where the user can find them: a save dialog on desktop, the app's folder on phones, a download in a browser. */
export async function saveBytes(name: string, bytes: Uint8Array, mime = "application/octet-stream") {
  if (isTauri && !platform.mobile) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: name });
    if (!path) return;
    await fs.writeBytes("", path, bytesToBase64(bytes));
    toast(`Saved to ${path}`, "success");
  } else if (isTauri) {
    const ws = useApp.getState().defaultWorkspace;
    await fs.writeBytes(ws, `Downloads/${name}`, bytesToBase64(bytes));
    toast(`Saved to the app's Downloads folder as ${name}`, "success");
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
    a.download = name;
    a.click();
  }
}

/** The page or file someone opened, shown over the app. */
export function ViewerHost() {
  const viewer = useApp((s) => s.viewer);
  const page = useApp((s) => (viewer?.kind === "page" ? s.pages.find((p) => p.id === viewer.id) : undefined));
  const file = useApp((s) => (viewer?.kind === "file" ? s.files.find((f) => f.id === viewer.id) : undefined));
  const close = () => useApp.setState({ viewer: null });
  if (page) return <PageViewer page={page} onClose={close} />;
  if (file) return <FileViewer file={file} onClose={close} />;
  if (viewer) return <Modal title="Not found" onClose={close}>This was deleted, or hasn't reached this device yet.</Modal>;
  return null;
}

export const openPage = (id: string) => useApp.setState({ viewer: { kind: "page", id } });
export const openFile = (id: string) => useApp.setState({ viewer: { kind: "file", id } });

function PageViewer({ page, onClose }: { page: Page; onClose: () => void }) {
  const bot = useApp((s) => s.bots.find((b) => b.id === page.botId));
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(page.title);
  const [content, setContent] = useState(page.content);
  useEffect(() => {
    if (!editing) {
      setTitle(page.title);
      setContent(page.content);
    }
  }, [page, editing]);

  return (
    <Modal
      wide
      title={editing ? <input className="input title-input" value={title} onChange={(e) => setTitle(e.target.value)} /> : page.title}
      onClose={onClose}
      footer={
        editing ? (
          <>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                await savePage({ ...page, title: title.trim() || page.title, content, updatedAt: Date.now(), editedByUser: true });
                setEditing(false);
              }}
            >
              Save page
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={async () => {
                if (await confirmDialog({ title: `Delete “${page.title}”?`, confirmLabel: "Delete", danger: true })) {
                  await deletePage(page.id);
                  onClose();
                }
              }}
            >
              <Trash2 size={15} /> Delete
            </Button>
            <Button onClick={() => void saveBytes(`${page.title.replace(/[\\/:*?"<>|]+/g, "-")}.md`, new TextEncoder().encode(`# ${page.title}\n\n${page.content}`), "text/markdown")}>
              <Download size={15} /> Save as Markdown
            </Button>
            <Button variant="primary" onClick={() => setEditing(true)}>
              <Pencil size={15} /> Edit
            </Button>
          </>
        )
      }
    >
      <div className="muted small viewer-meta">
        By {bot?.name ?? "a bot"} · {page.editedByUser ? "edited by you" : "written"} {timeAgo(page.updatedAt)} <CopyButton text={page.content} />
      </div>
      {editing ? <textarea className="input mono page-editor" value={content} onChange={(e) => setContent(e.target.value)} /> : <Markdown text={page.content} />}
    </Modal>
  );
}

function FileViewer({ file, onClose }: { file: SharedFile; onClose: () => void }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    readSharedFile(file)
      .then((b) => alive && setBytes(b))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [file]);
  const kind = docKind(file.name);
  return (
    <Modal
      wide
      title={file.name}
      onClose={onClose}
      footer={
        <Button variant="primary" disabled={!bytes} onClick={() => bytes && void saveBytes(file.name, bytes, MIME[kind] ?? "application/octet-stream")}>
          <Download size={15} /> Save
        </Button>
      }
    >
      <div className="muted small viewer-meta">
        {file.size !== undefined ? `${formatBytes(file.size)} · ` : ""}
        {file.where === "hub" ? "on your hub" : "on the device that made it"} · {file.path}
      </div>
      {error ? (
        <p className="notice notice-error">{error}</p>
      ) : file.kind === "slides" && file.slides ? (
        <SlidesPreview outline={file.slides} />
      ) : !bytes ? (
        <div className="viewer-loading">
          <LoaderCircle size={18} className="spin" /> Opening…
        </div>
      ) : (
        <FilePreview name={file.name} bytes={bytes} />
      )}
    </Modal>
  );
}

/** A preview of any file a bot shared or you attached. */
export function FilePreview({ name, bytes }: { name: string; bytes: Uint8Array }) {
  const kind = docKind(name);
  switch (kind) {
    case "pdf":
      return <PdfPreview bytes={bytes} />;
    case "docx":
      return <AsyncHtml load={() => docxToHtml(bytes)} />;
    case "xlsx":
      return <SheetPreview load={() => readSheets(bytes, 500)} />;
    case "csv":
      return <SheetPreview load={async () => [{ name, rows: parseCsv(new TextDecoder().decode(bytes), 500) }]} />;
    case "pptx":
      return <AsyncText load={async () => (await pptxSlides(bytes)).map((t, i) => `Slide ${i + 1}\n${t}`).join("\n\n")} />;
    case "html":
      return <HtmlPreview html={new TextDecoder().decode(bytes)} />;
    case "image":
      return <ImagePreview blob={new Blob([bytes.slice()])} />;
    case "heic":
      return <ImagePreview blob={new Blob([bytes.slice()])} heic />;
    case "text":
      return name.toLowerCase().endsWith(".md") ? <Markdown text={new TextDecoder().decode(bytes)} /> : <pre className="viewer-text">{new TextDecoder().decode(bytes).slice(0, 200_000)}</pre>;
    default:
      return <p className="muted">There's no preview for this kind of file. Save it to open it in another app.</p>;
  }
}

function useAsync<T>(load: () => Promise<T>): { value?: T; error?: string } {
  const [state, setState] = useState<{ value?: T; error?: string }>({});
  useEffect(() => {
    let alive = true;
    load().then(
      (value) => alive && setState({ value }),
      (e) => alive && setState({ error: (e as Error).message }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

function Waiting({ error }: { error?: string }) {
  return error ? <p className="notice notice-error">{error}</p> : <div className="viewer-loading"><LoaderCircle size={18} className="spin" /> Reading…</div>;
}

function PdfPreview({ bytes }: { bytes: Uint8Array }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ pages?: number; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    let close: (() => Promise<void>) | undefined;
    (async () => {
      try {
        const pdf = await openPdf(bytes);
        close = pdf.close;
        if (cancelled) return;
        setState({ pages: pdf.doc.numPages });
        const width = Math.min(900, box.current?.clientWidth ?? 800);
        for (let n = 1; n <= Math.min(pdf.doc.numPages, 50) && !cancelled; n++) {
          const page = await pdf.doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * (window.devicePixelRatio || 1) });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = "100%";
          box.current?.appendChild(canvas);
          await page.render({ canvas, viewport }).promise;
        }
      } catch (e) {
        if (!cancelled) setState({ error: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
      void close?.();
    };
  }, [bytes]);
  return (
    <>
      {state.error && <p className="notice notice-error">{state.error}</p>}
      {state.pages && state.pages > 50 && <p className="muted small">Showing the first 50 of {state.pages} pages.</p>}
      <div className="pdf-pages" ref={box} />
    </>
  );
}

/** Documents converted to HTML show in a frame where nothing can run. */
function AsyncHtml({ load }: { load: () => Promise<string> }) {
  const { value, error } = useAsync(load);
  return value === undefined ? <Waiting error={error} /> : <HtmlFrame html={`<style>body{font:15px/1.55 system-ui,sans-serif;max-width:46em;margin:16px auto;padding:0 12px;color:#191d1b}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 6px}img{max-width:100%}</style>${value}`} />;
}

function HtmlFrame({ html }: { html: string }) {
  return <iframe className="html-frame" sandbox="" srcDoc={html} title="Preview" />;
}

function HtmlPreview({ html }: { html: string }) {
  const [source, setSource] = useState(false);
  return (
    <>
      <div className="row">
        <Button size="sm" variant="ghost" onClick={() => setSource(!source)}>
          {source ? "Show the page" : "Show the source"}
        </Button>
        <span className="muted small">Scripts don't run in previews.</span>
      </div>
      {source ? <pre className="viewer-text">{html}</pre> : <HtmlFrame html={html} />}
    </>
  );
}

function AsyncText({ load }: { load: () => Promise<string> }) {
  const { value, error } = useAsync(load);
  return value === undefined ? <Waiting error={error} /> : <pre className="viewer-text">{value}</pre>;
}

function SheetPreview({ load }: { load: () => Promise<Sheet[]> }) {
  const { value, error } = useAsync(load);
  const [tab, setTab] = useState(0);
  if (value === undefined) return <Waiting error={error} />;
  const sheet = value[tab];
  return (
    <>
      {value.length > 1 && (
        <div className="tabs">
          {value.map((s, i) => (
            <button key={s.name} className={`tab${i === tab ? " active" : ""}`} onClick={() => setTab(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="sheet-wrap">
        <table className="sheet">
          <tbody>
            {sheet?.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet && sheet.rows.length >= 500 && <p className="muted small">Showing the first 500 rows.</p>}
    </>
  );
}

function ImagePreview({ blob, heic }: { blob: Blob; heic?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    (heic ? heicToJpeg(blob) : Promise.resolve(blob)).then(
      (b) => setUrl((made = URL.createObjectURL(b))),
      (e) => setError((e as Error).message),
    );
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [blob, heic]);
  if (error) return <p className="notice notice-error">{error}</p>;
  return url ? <img className="viewer-image" src={url} alt="" /> : <Waiting />;
}

/** A deck a bot made, shown from its outline. */
function SlidesPreview({ outline }: { outline: SlideOutline }) {
  return (
    <div className="slides">
      <div className="slide slide-cover">
        <div className="slide-title">{outline.title}</div>
        {outline.subtitle && <div className="slide-sub">{outline.subtitle}</div>}
      </div>
      {outline.slides.map((s, i) => (
        <div key={i} className="slide">
          <div className="slide-title">{s.title}</div>
          <ul>
            {s.bullets.map((b, j) => (
              <li key={j}>{b}</li>
            ))}
          </ul>
          {s.notes && <div className="slide-notes muted small">Notes: {s.notes}</div>}
        </div>
      ))}
    </div>
  );
}
