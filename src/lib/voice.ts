// Voice memos: record in the webview, transcribe with any OpenAI-compatible
// speech-to-text server (faster-whisper/Speaches, LocalAI, whisper.cpp proxies…).

import { endpoint, providerHeaders } from "./llm";
import { httpRequest } from "./platform";
import type { Provider, Settings } from "./types";

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  static supported(): boolean {
    return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported?.(t));
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(250);
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec) return resolve(new Blob());
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || "audio/webm" });
        this.release();
        resolve(blob);
      };
      rec.stop();
    });
  }

  cancel() {
    try {
      this.recorder?.stop();
    } catch {
      /* already stopped */
    }
    this.release();
  }

  private release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function transcribe(blob: Blob, settings: Settings, providers: Provider[]): Promise<string> {
  const stt = settings.stt;
  if (!stt?.baseUrl) throw new Error("Set up speech-to-text in Settings → Voice first.");
  const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
  const boundary = "----lantern" + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${stt.model || "whisper-1"}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="memo.${ext}"\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`,
  );
  const audio = new Uint8Array(await blob.arrayBuffer());
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + audio.length + tail.length);
  body.set(head, 0);
  body.set(audio, head.length);
  body.set(tail, head.length + audio.length);

  const provider = stt.providerId ? providers.find((p) => p.id === stt.providerId) : undefined;
  const headers = provider ? await providerHeaders(provider) : {};
  headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
  const res = await httpRequest({ method: "POST", url: endpoint(stt.baseUrl, "/audio/transcriptions"), headers, bodyBase64: bytesToBase64(body), timeoutMs: 120000 });
  if (res.status >= 400) throw new Error(`Transcription failed (${res.status}): ${res.body.slice(0, 200)}`);
  try {
    return String(JSON.parse(res.body).text ?? "").trim();
  } catch {
    return res.body.trim();
  }
}
