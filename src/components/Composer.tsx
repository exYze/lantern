import { ArrowUp, FileText, Image as ImageIcon, LoaderCircle, Mic, Paperclip, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { platform } from "../lib/platform";
import { toast, useApp } from "../lib/store";
import type { Attachment } from "../lib/types";
import { formatBytes, uid } from "../lib/util";
import { transcribe, VoiceRecorder } from "../lib/voice";
import { IconButton } from "./ui";

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|toml|ini|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|ps1|bat|sql|r|lua|log|env|cfg|conf|tex|svg)$/i;
const MAX_TEXT = 300 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;

function readFile(file: File, as: "text" | "dataUrl"): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    if (as === "text") r.readAsText(file);
    else r.readAsDataURL(file);
  });
}

export async function fileToAttachment(file: File): Promise<Attachment> {
  if (file.type.startsWith("image/") && !file.type.includes("svg")) {
    if (file.size > MAX_IMAGE) throw new Error(`${file.name} is larger than ${formatBytes(MAX_IMAGE)}`);
    return { id: uid("att"), name: file.name, mime: file.type, size: file.size, kind: "image", data: await readFile(file, "dataUrl") };
  }
  if (file.type.startsWith("text/") || file.type.includes("json") || TEXT_EXT.test(file.name)) {
    if (file.size > MAX_TEXT) throw new Error(`${file.name} is larger than ${formatBytes(MAX_TEXT)}; ask the bot to read it from the workspace instead`);
    return { id: uid("att"), name: file.name, mime: file.type || "text/plain", size: file.size, kind: "text", data: await readFile(file, "text") };
  }
  throw new Error(`${file.name}: only text and image files can be attached`);
}

export function Composer({ placeholder, running, onSend, onStop, seed }: { placeholder: string; running: boolean; onSend: (text: string, attachments: Attachment[]) => void; onStop: () => void; seed?: { text: string; n: number } }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [recording, setRecording] = useState<null | { started: number }>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [, tick] = useState(0);
  const recorder = useRef<VoiceRecorder | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);

  useEffect(() => {
    if (seed) {
      setText(seed.text);
      area.current?.focus();
    }
  }, [seed]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const max = Math.round(window.innerHeight * 0.4);
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, max) + "px";
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [recording]);

  const send = () => {
    const t = text.trim();
    if ((!t && !attachments.length) || running) return;
    onSend(t, attachments);
    setText("");
    setAttachments([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !platform.mobile) {
      e.preventDefault();
      send();
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      try {
        const a = await fileToAttachment(f);
        setAttachments((prev) => [...prev, a]);
      } catch (e) {
        toast((e as Error).message, "error");
      }
    }
  };

  const startVoice = async () => {
    if (!settings.stt?.baseUrl) {
      toast("Add a speech-to-text server in Settings → Voice to use voice memos.", "info");
      return;
    }
    try {
      recorder.current = new VoiceRecorder();
      await recorder.current.start();
      setRecording({ started: Date.now() });
    } catch (e) {
      toast(`Microphone unavailable: ${(e as Error).message}`, "error");
    }
  };

  const stopVoice = async (keep: boolean) => {
    const rec = recorder.current;
    recorder.current = null;
    setRecording(null);
    if (!rec) return;
    if (!keep) return rec.cancel();
    setTranscribing(true);
    try {
      const blob = await rec.stop();
      const said = await transcribe(blob, settings, providers);
      if (said) setText((t) => (t ? `${t} ${said}` : said));
      area.current?.focus();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setTranscribing(false);
    }
  };

  const seconds = recording ? Math.floor((Date.now() - recording.started) / 1000) : 0;

  return (
    <div
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <span key={a.id} className="attach-chip">
              {a.kind === "image" ? <ImageIcon size={14} /> : <FileText size={14} />}
              {a.name}
              <button aria-label={`Remove ${a.name}`} onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {recording ? (
        <div className="composer-recording">
          <span className="rec-dot" />
          Recording voice memo · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={() => void stopVoice(false)}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => void stopVoice(true)}>
            Done
          </button>
        </div>
      ) : (
        <div className="composer-row">
          <IconButton label="Attach files" onClick={() => fileInput.current?.click()}>
            <Paperclip size={18} />
          </IconButton>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder={transcribing ? "Transcribing…" : placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
          />
          {VoiceRecorder.supported() && !text && !running && (
            <IconButton label="Record a voice memo" onClick={() => void startVoice()} disabled={transcribing}>
              {transcribing ? <LoaderCircle size={18} className="spin" /> : <Mic size={18} />}
            </IconButton>
          )}
          {running ? (
            <button className="send-btn stop" onClick={onStop} aria-label="Stop" title="Stop">
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button className="send-btn" onClick={send} disabled={!text.trim() && !attachments.length} aria-label="Send" title="Send">
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
