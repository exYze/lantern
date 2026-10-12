// App updates from the Lantern Hub. Desktop apps download and install signed
// updates in-app (the signature is checked against the key built into the app);
// Android is offered the new APK to download and install.

import { Channel, invoke } from "@tauri-apps/api/core";
import { DEFAULT_HUB_URL, hubConnection } from "./hub";
import { httpRequest, isTauri, openExternal, platform } from "./platform";
import { toast, useApp } from "./store";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;

/** Compares dotted versions numerically: >0 when a is newer. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function startUpdateChecks() {
  if (!isTauri || timer) return;
  setTimeout(() => void checkForUpdates({ startup: true }), 15_000);
  timer = setInterval(() => void checkForUpdates(), CHECK_EVERY_MS);
}

type Outcome = "none" | "available" | "unavailable" | "error";

export async function checkForUpdates(opts: { startup?: boolean; manual?: boolean } = {}): Promise<Outcome> {
  // The manifest is public, so an app built with a hub address gets updates even before it pairs.
  const base = hubConnection()?.url ?? DEFAULT_HUB_URL;
  if (!isTauri || !base) {
    if (opts.manual) toast("Updates come from your Lantern Hub. Connect one in Settings → Hub.");
    return "unavailable";
  }
  if (checking) return "none";
  checking = true;
  const endpoint = `${base}/updates/latest.json`;
  try {
    if (platform.mobile) {
      if (platform.os !== "android") return "unavailable";
      const res = await httpRequest({ url: endpoint, timeoutMs: 20000 });
      if (res.status === 404) return report("none", opts);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const manifest = JSON.parse(res.body) as { version: string; notes?: string; platforms?: Record<string, { url: string }> };
      const apk = manifest.platforms?.["android-universal"];
      if (!apk || compareVersions(manifest.version, platform.version) <= 0) return report("none", opts);
      useApp.setState({ update: { version: manifest.version, notes: manifest.notes, downloadUrl: apk.url, status: "available" } });
      return "available";
    }

    const info = await invoke<{ version: string; notes?: string } | null>("update_check", { endpoint });
    if (!info) return report("none", opts);
    const current = useApp.getState().update;
    if (current?.status !== "available" || current.version !== info.version) {
      useApp.setState({ update: { version: info.version, notes: info.notes ?? undefined, status: "available" } });
    }
    // Automatic installs happen when they won't interrupt: at startup or while the window is hidden, with no bot running.
    const { settings, running } = useApp.getState();
    if (settings.autoUpdate !== false && !Object.keys(running).length && (opts.startup || document.hidden)) await installUpdate();
    return "available";
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    // "No releases published yet" and similar are not worth a toast during background checks.
    if (/404|not found|no releases/i.test(message)) return report("none", opts);
    if (opts.manual) toast(`Couldn't check for updates: ${message}`, "error");
    return "error";
  } finally {
    checking = false;
  }
}

function report(outcome: Outcome, opts: { manual?: boolean }): Outcome {
  if (outcome === "none") {
    useApp.setState({ update: null });
    if (opts.manual) toast(`Lantern ${platform.version} is up to date.`, "success");
  }
  return outcome;
}

type InstallEvent = { event: "progress"; data: { downloaded: number; total?: number | null } } | { event: "installing" };

export async function installUpdate(): Promise<void> {
  const update = useApp.getState().update;
  if (!update || update.status !== "available") return;
  if (update.downloadUrl) {
    await openExternal(update.downloadUrl);
    return;
  }
  useApp.setState({ update: { ...update, status: "downloading", progress: undefined } });
  const channel = new Channel<InstallEvent>();
  channel.onmessage = (e) => {
    const u = useApp.getState().update;
    if (!u) return;
    if (e.event === "progress") useApp.setState({ update: { ...u, progress: e.data.total ? e.data.downloaded / e.data.total : undefined } });
    else useApp.setState({ update: { ...u, status: "installing" } });
  };
  try {
    // On success the app restarts into the new version (Windows installers close it themselves).
    await invoke("update_install", { onEvent: channel });
  } catch (e) {
    toast(`Update failed: ${(e as Error)?.message ?? e}`, "error");
    useApp.setState({ update: { ...update, status: "available" } });
  }
}
