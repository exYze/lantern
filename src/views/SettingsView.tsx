import { Download, ExternalLink, FolderOpen, KeyRound, Pencil, Plus, RefreshCw, Smartphone, Trash2, Unplug, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { APPROVAL_MODES } from "../components/ChatView";
import { HubConnectForm } from "../components/HubConnect";
import { ModelPicker } from "../components/ModelPicker";
import { ProviderForm } from "../components/ProviderForm";
import { Button, confirmDialog, Field, IconButton, Modal, Pill, Toggle } from "../components/ui";
import { listModels } from "../lib/llm";
import { hubDevices, type HubDevice } from "../lib/hub";
import { capabilities, fs, isTauri, openExternal, pickFolder, platform } from "../lib/platform";
import { addApprovalRule, deleteProvider, exportData, importData, saveProvider, toast, updateSettings, useApp, type View } from "../lib/store";
import { disconnectHub, syncNow, type SyncState } from "../lib/sync";
import { BUILTIN_TOOLS } from "../lib/tools";
import { checkForUpdates } from "../lib/updates";
import { timeAgo } from "../lib/util";
import type { Provider } from "../lib/types";
import { PageHead } from "./PageHead";
import logo from "../assets/lantern.svg";

type Section = "models" | "hub" | "approvals" | "general" | "voice" | "data" | "about";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "models", label: "Models" },
  { id: "hub", label: "Hub" },
  { id: "approvals", label: "Approvals" },
  { id: "general", label: "General" },
  { id: "voice", label: "Voice" },
  { id: "data", label: "Data" },
  { id: "about", label: "About" },
];

export function SettingsView() {
  const view = useApp((s) => s.view) as Extract<View, { kind: "settings" }>;
  const [section, setSection] = useState<Section>((view.tab as Section) ?? "models");
  return (
    <div className="main-pane page">
      <PageHead title="Settings" />
      <div className="settings">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button key={s.id} className={`settings-nav-item${section === s.id ? " active" : ""}`} onClick={() => setSection(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {section === "models" && <ModelsSection />}
          {section === "hub" && <HubSection />}
          {section === "approvals" && <ApprovalsSection />}
          {section === "general" && <GeneralSection />}
          {section === "voice" && <VoiceSection />}
          {section === "data" && <DataSection />}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}

function ModelsSection() {
  const providers = useApp((s) => s.providers);
  const settings = useApp((s) => s.settings);
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  return (
    <div className="form">
      <h2>Model servers</h2>
      <p className="muted small">Lantern talks to any OpenAI-compatible server. Run open-weight models locally with Ollama, llama.cpp, vLLM or LM Studio, or use a hosted provider for open models.</p>
      <div className="stack">
        {providers.map((p) => (
          <div key={p.id} className="card skill-card">
            <div className="list-main">
              <div className="row">
                <strong>{p.name}</strong>
                <Pill>{p.models.length} models</Pill>
                {p.hasKey && (
                  <Pill tone="accent">
                    <KeyRound size={11} /> key
                  </Pill>
                )}
              </div>
              <span className="muted small mono">{p.baseUrl}</span>
              {!!p.noToolModels?.length && (
                <span className="small">
                  Chatting without tools for: {p.noToolModels.join(", ")}{" "}
                  <button className="link" onClick={() => void saveProvider({ ...p, noToolModels: [] })}>
                    Retry tools
                  </button>
                </span>
              )}
            </div>
            <IconButton
              label="Refresh models"
              disabled={refreshing === p.id}
              onClick={async () => {
                setRefreshing(p.id);
                try {
                  const models = await listModels(p);
                  await saveProvider({ ...p, models });
                  toast(`${p.name}: ${models.length} models`, "success");
                } catch (e) {
                  toast(`${p.name}: ${(e as Error).message}`, "error");
                } finally {
                  setRefreshing(null);
                }
              }}
            >
              <RefreshCw size={16} className={refreshing === p.id ? "spin" : ""} />
            </IconButton>
            <IconButton label="Edit" onClick={() => setEditing(p)}>
              <Pencil size={16} />
            </IconButton>
            <IconButton
              label="Remove"
              onClick={async () => {
                if (await confirmDialog({ title: `Remove ${p.name}?`, body: "Bots using its models will fall back to the default model.", confirmLabel: "Remove", danger: true })) await deleteProvider(p.id);
              }}
            >
              <Trash2 size={16} />
            </IconButton>
          </div>
        ))}
      </div>
      <div>
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus size={16} /> Add server
        </Button>
      </div>

      <Field label="Default model" hint="Used by every bot that doesn't pick its own.">
        <ModelPicker value={settings.defaultModel} onChange={(defaultModel) => void updateSettings({ defaultModel })} />
      </Field>
      <Field label="Auto-review model" hint="Judges tool calls in Auto-review mode. A small, fast model works well.">
        <ModelPicker value={settings.reviewModel} defaultLabel="Same model as the bot" onChange={(reviewModel) => void updateSettings({ reviewModel })} />
      </Field>
      {editing && (
        <Modal wide title={editing === "new" ? "Add a model server" : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <ProviderForm
            provider={editing === "new" ? undefined : editing}
            onCancel={() => setEditing(null)}
            onSaved={(p) => {
              setEditing(null);
              if (!useApp.getState().settings.defaultModel && p.models[0]) void updateSettings({ defaultModel: { providerId: p.id, model: p.models[0] } });
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function HubSection() {
  const hub = useApp((s) => s.hub);
  const sync = useApp((s) => s.sync);
  if (!hub) {
    return (
      <div className="form">
        <h2>Lantern Hub</h2>
        <p className="muted small">
          A Lantern Hub is a small server you run (for example a VM on your home network, reachable over Tailscale). Every device connected to it shares one environment: bots, chats,
          memories, skills, routines, plugins, model servers, settings and secrets, plus a shared workspace where bots' files and terminal commands live. It also serves app
          installers and updates.
        </p>
        <HubConnectForm onConnected={() => toast("Connected to your hub.", "success")} />
        <p className="muted small">
          Set one up with <code>hub/deploy/install.sh</code> from the Lantern source (see docs/HUB.md).
        </p>
      </div>
    );
  }
  return <HubConnected key={hub.deviceId} sync={sync} />;
}

function syncLabel(sync: SyncState): string {
  const waiting = `${sync.pending} change${sync.pending === 1 ? "" : "s"}`;
  switch (sync.status) {
    case "online":
      return sync.pending ? `Syncing ${waiting}…` : `Synced${sync.lastSyncAt ? ` · ${timeAgo(sync.lastSyncAt)}` : ""}`;
    case "connecting":
      return "Connecting…";
    case "offline":
      return `Offline${sync.pending ? ` · ${waiting} waiting` : ""}. Changes sync when the hub is reachable again.`;
    case "error":
      return sync.error ?? "Not syncing.";
    default:
      return "Not syncing.";
  }
}

function HubConnected({ sync }: { sync: SyncState }) {
  const hub = useApp((s) => s.hub)!;
  const settings = useApp((s) => s.settings);
  const [devices, setDevices] = useState<HubDevice[] | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [syncing, setSyncing] = useState(false);

  const loadDevices = () =>
    hubDevices
      .list()
      .then(setDevices)
      .catch(() => setDevices(null));
  useEffect(() => {
    void loadDevices();
  }, []);

  return (
    <div className="form">
      <h2>Lantern Hub</h2>
      <div className="card">
        <div className="list-main">
          <strong>{hub.name}</strong>
          <span className="muted small mono">{hub.url}</span>
          <span className="hub-status small">
            <span className={`sync-dot ${sync.status}`} />
            {syncLabel(sync)}
          </span>
          {sync.status === "offline" && sync.error && <span className="muted small">{sync.error}</span>}
        </div>
      </div>
      <div className="row wrap">
        <Button
          disabled={syncing || sync.status === "error"}
          onClick={async () => {
            setSyncing(true);
            await syncNow();
            setSyncing(false);
          }}
        >
          <RefreshCw size={16} className={syncing ? "spin" : ""} /> Sync now
        </Button>
        <Button
          onClick={async () => {
            try {
              setCode(await hubDevices.pairCode());
            } catch (e) {
              toast((e as Error).message, "error");
            }
          }}
        >
          <Smartphone size={16} /> Add a device
        </Button>
        <Button variant="ghost" onClick={() => void openExternal(hub.url)}>
          <ExternalLink size={16} /> Downloads page
        </Button>
      </div>

      <Field label="Bots' files and terminal" hint="On the hub, every device sees the same workspace, and phones get a terminal too. A bot can override this in its settings.">
        <select className="select" value={settings.computer ?? "hub"} onChange={(e) => void updateSettings({ computer: e.target.value as "hub" | "device" })}>
          <option value="hub">On the hub, shared by all devices{hub.tools ? ` (${hub.tools.workspace})` : ""}</option>
          <option value="device">On each device</option>
        </select>
      </Field>

      <h3>Devices</h3>
      {devices ? (
        <ul className="list">
          {devices.map((d) => (
            <li key={d.id}>
              <div className="list-main">
                <span>
                  <strong>{d.name}</strong> {d.id === hub.deviceId && <Pill tone="accent">This device</Pill>}
                </span>
                <span className="muted small">
                  {d.platform} · paired {new Date(d.createdAt).toLocaleDateString()} via {d.pairedVia === "tailscale" ? "Tailscale" : "code"} · seen {timeAgo(d.lastSeen)}
                </span>
              </div>
              {d.id !== hub.deviceId && (
                <IconButton
                  label="Remove device"
                  onClick={async () => {
                    if (await confirmDialog({ title: `Remove ${d.name}?`, body: "It stops syncing right away. Its local data stays on it.", confirmLabel: "Remove", danger: true })) {
                      await hubDevices.remove(d.id).catch((e) => toast((e as Error).message, "error"));
                      await loadDevices();
                    }
                  }}
                >
                  <Trash2 size={15} />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">The device list loads when the hub is reachable.</p>
      )}

      <div>
        <Button
          variant="danger"
          onClick={async () => {
            if (await confirmDialog({ title: "Disconnect from the hub?", body: "This device stops syncing. Everything already on it stays here.", confirmLabel: "Disconnect", danger: true })) {
              await disconnectHub();
            }
          }}
        >
          <Unplug size={16} /> Disconnect this device
        </Button>
      </div>

      {code && (
        <Modal title="Add a device" onClose={() => setCode(null)}>
          <div className="form">
            <p>
              On the new device, install Lantern from the downloads page and choose <strong>Connect to a Lantern Hub</strong>. Enter <code>{hub.url}</code> and this one-time code:
            </p>
            <div className="pair-code">{code.code}</div>
            <p className="muted small">Valid until {new Date(code.expiresAt).toLocaleTimeString()}. Devices signed in to your Tailscale account connect without a code.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ApprovalsSection() {
  const settings = useApp((s) => s.settings);
  const [tool, setTool] = useState("shell");
  const [pattern, setPattern] = useState("");
  const [decision, setDecision] = useState<"allow" | "deny">("deny");
  return (
    <div className="form">
      <h2>Approvals</h2>
      <p className="muted small">Choose how much bots can do without asking. Reading files in the workspace, web search and the bot's own memories, skills and routines never need approval.</p>
      <div className="radio-cards">
        {APPROVAL_MODES.map((m) => (
          <label key={m.id} className={`radio-card${settings.approvalMode === m.id ? " on" : ""}`}>
            <input type="radio" name="mode" checked={settings.approvalMode === m.id} onChange={() => void updateSettings({ approvalMode: m.id })} />
            <span className="radio-title">{m.label}</span>
            <span className="radio-desc">{m.description}</span>
          </label>
        ))}
      </div>
      <h3>Rules</h3>
      <p className="muted small">Rules apply in every mode. Deny rules win. A shell rule matches commands that start with its pattern.</p>
      {settings.approvalRules.length ? (
        <ul className="list">
          {settings.approvalRules.map((r) => (
            <li key={r.id}>
              <Pill tone={r.decision === "allow" ? "success" : "danger"}>{r.decision === "allow" ? "Allow" : "Deny"}</Pill>
              <div className="list-main mono">
                {r.tool}
                {r.pattern ? `: ${r.pattern}` : ""}
              </div>
              <IconButton label="Delete rule" onClick={() => void updateSettings({ approvalRules: settings.approvalRules.filter((x) => x.id !== r.id) })}>
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No rules yet. Choosing “Always allow” on an approval card adds one.</p>
      )}
      <div className="row wrap">
        <select className="select" value={decision} onChange={(e) => setDecision(e.target.value as "allow" | "deny")}>
          <option value="deny">Deny</option>
          <option value="allow">Allow</option>
        </select>
        <select className="select" value={tool} onChange={(e) => setTool(e.target.value)}>
          {BUILTIN_TOOLS.filter((t) => ["write", "exec"].includes(String(t.risk))).map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        {tool === "shell" && <input className="input mono" placeholder="e.g. rm, git push" value={pattern} onChange={(e) => setPattern(e.target.value)} />}
        <Button
          onClick={async () => {
            await addApprovalRule({ tool, pattern: tool === "shell" ? pattern.trim() : "", decision });
            setPattern("");
          }}
        >
          Add rule
        </Button>
      </div>
    </div>
  );
}

function GeneralSection() {
  const settings = useApp((s) => s.settings);
  const defaultWorkspace = useApp((s) => s.defaultWorkspace);
  return (
    <div className="form">
      <h2>General</h2>
      <Field label="Theme">
        <select className="select" value={settings.theme} onChange={(e) => void updateSettings({ theme: e.target.value as typeof settings.theme })}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Field>
      {capabilities.files && (
        <Field label="Workspace folder" hint={platform.mobile ? "On mobile, bots work inside the app's private folder." : "Where bots read and write files and run commands, unless a bot sets its own."}>
          <div className="row">
            <input className="input mono" value={settings.workspace ?? ""} placeholder={defaultWorkspace} disabled={platform.mobile} onChange={(e) => void updateSettings({ workspace: e.target.value || undefined })} />
            {capabilities.shell && (
              <IconButton
                label="Choose folder"
                onClick={async () => {
                  const dir = await pickFolder();
                  if (dir) await updateSettings({ workspace: dir });
                }}
              >
                <FolderOpen size={17} />
              </IconButton>
            )}
          </div>
        </Field>
      )}
      <Toggle label="Notifications" description="Notify when a bot finishes in the background or needs approval." checked={settings.notifications} onChange={(notifications) => void updateSettings({ notifications })} />
      <Toggle label="Play a sound" description="Chime when a background reply finishes." checked={settings.sound} onChange={(sound) => void updateSettings({ sound })} />
      <Field label="Web search">
        <select className="select" value={settings.search.kind} onChange={(e) => void updateSettings({ search: { ...settings.search, kind: e.target.value as "duckduckgo" | "searxng" } })}>
          <option value="duckduckgo">DuckDuckGo (no setup)</option>
          <option value="searxng">SearXNG (self-hosted)</option>
        </select>
      </Field>
      {settings.search.kind === "searxng" && (
        <Field label="SearXNG URL" hint="Enable the JSON output format in your instance's settings.yml.">
          <input className="input mono" value={settings.search.url ?? ""} placeholder="http://localhost:8888" onChange={(e) => void updateSettings({ search: { ...settings.search, url: e.target.value } })} />
        </Field>
      )}
      <Field label="Time zone" hint="Used for dates in prompts and routine times.">
        <input className="input" value={settings.timezone ?? ""} placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone} onChange={(e) => void updateSettings({ timezone: e.target.value || undefined })} />
      </Field>
      <Field label="Context budget (tokens)" hint="Older messages are left out once a chat grows past this. Match your model's context window.">
        <input className="input" type="number" min={2048} step={1024} value={settings.contextTokens} onChange={(e) => void updateSettings({ contextTokens: Math.max(2048, Number(e.target.value) || 16000) })} />
      </Field>
      <Field label="Max tool steps per reply">
        <input className="input" type="number" min={1} max={200} value={settings.maxSteps} onChange={(e) => void updateSettings({ maxSteps: Math.min(200, Math.max(1, Number(e.target.value) || 24)) })} />
      </Field>
    </div>
  );
}

function VoiceSection() {
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);
  const stt = settings.stt ?? { baseUrl: "", model: "whisper-1" };
  return (
    <div className="form">
      <h2>Voice memos</h2>
      <p className="muted small">
        Voice memos are transcribed by a speech-to-text server you choose, using the OpenAI-compatible <code>/audio/transcriptions</code> API. Open-source options: Speaches (faster-whisper), LocalAI, or
        whisper.cpp behind a compatible proxy.
      </p>
      <Field label="Server URL">
        <input className="input mono" value={stt.baseUrl} placeholder="http://localhost:8000/v1" onChange={(e) => void updateSettings({ stt: { ...stt, baseUrl: e.target.value } })} />
      </Field>
      <Field label="Model">
        <input className="input mono" value={stt.model} placeholder="Systran/faster-whisper-small" onChange={(e) => void updateSettings({ stt: { ...stt, model: e.target.value } })} />
      </Field>
      <Field label="Use the API key of">
        <select className="select" value={stt.providerId ?? ""} onChange={(e) => void updateSettings({ stt: { ...stt, providerId: e.target.value || undefined } })}>
          <option value="">No key</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function DataSection() {
  const file = useRef<HTMLInputElement>(null);
  const hub = useApp((s) => s.hub);
  return (
    <div className="form">
      <h2>Your data</h2>
      <p className="muted small">
        Bots, chats, memories and settings live in a local database on this device, secrets in {platform.secretBackend === "keychain" ? "your system keychain" : "app-private storage"}.{" "}
        {hub ? `They also sync with your Lantern Hub (${hub.name}), which only your paired devices can reach.` : "Nothing leaves this device unless you connect a Lantern Hub."} Exports never
        include secrets or API keys.
      </p>
      <div className="row wrap">
        <Button
          onClick={async () => {
            const json = await exportData();
            const name = `lantern-export-${new Date().toISOString().slice(0, 10)}.json`;
            if (isTauri && !platform.mobile) {
              const { save } = await import("@tauri-apps/plugin-dialog");
              const path = await save({ defaultPath: name, filters: [{ name: "JSON", extensions: ["json"] }] });
              if (path) {
                await fs.write("", path, json);
                toast(`Exported to ${path}`, "success");
              }
            } else if (isTauri) {
              const ws = useApp.getState().defaultWorkspace;
              await fs.write(ws, name, json);
              toast(`Exported to the app workspace as ${name}`, "success");
            } else {
              const a = document.createElement("a");
              a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
              a.download = name;
              a.click();
            }
          }}
        >
          <Download size={16} /> Export
        </Button>
        <Button onClick={() => file.current?.click()}>
          <Upload size={16} /> Import
        </Button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            if (!(await confirmDialog({ title: "Import data?", body: "Bots, chats and settings from the file are merged into this device.", confirmLabel: "Import" }))) return;
            try {
              await importData(await f.text());
              toast("Import complete", "success");
            } catch (err) {
              toast((err as Error).message, "error");
            }
          }}
        />
      </div>
    </div>
  );
}

function AboutSection() {
  return (
    <div className="form">
      <h2>About Lantern</h2>
      <div className="about">
        <img src={logo} alt="" width={56} height={56} />
        <div>
          <strong>Lantern {platform.version}</strong>
          <div className="muted small">
            {platform.os} {platform.arch} · secrets: {platform.secretBackend}
          </div>
        </div>
      </div>
      <p className="small">
        Lantern is free, open-source software under the MIT license. It is an independent project that works with open-source language models you run or choose yourself, and it is not affiliated with any AI
        vendor.
      </p>
      <p className="muted small">No telemetry. Network requests go only to your Lantern Hub, the model servers, MCP servers, search provider and websites you or your bots use.</p>
      {isTauri && (
        <>
          <h3>Updates</h3>
          <p className="muted small">New versions come from your Lantern Hub{platform.mobile ? "" : " and are checked against Lantern's signing key before they install"}.</p>
          <div>
            <Button onClick={() => void checkForUpdates({ manual: true })}>
              <RefreshCw size={16} /> Check for updates
            </Button>
          </div>
          {!platform.mobile && <UpdateToggle />}
        </>
      )}
    </div>
  );
}

function UpdateToggle() {
  const autoUpdate = useApp((s) => s.settings.autoUpdate !== false);
  return (
    <Toggle
      label="Install updates automatically"
      description="Updates install when Lantern starts or while it's in the background, never in the middle of a bot's work."
      checked={autoUpdate}
      onChange={(v) => void updateSettings({ autoUpdate: v })}
    />
  );
}
