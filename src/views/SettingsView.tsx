import { Check, CircleAlert, CloudOff, Download, ExternalLink, FolderOpen, KeyRound, Pencil, Plus, RefreshCw, Smartphone, Trash2, Unplug, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { APPROVAL_MODES } from "../components/ChatView";
import { HubConnectForm } from "../components/HubConnect";
import { ModelPicker } from "../components/ModelPicker";
import { ProviderForm } from "../components/ProviderForm";
import { Button, confirmDialog, Field, IconButton, Modal, Pill, Toggle } from "../components/ui";
import { firecrawlSearch } from "../lib/firecrawl";
import { listModels } from "../lib/llm";
import { hubDevices, hubToolInfo, type HubDevice } from "../lib/hub";
import { capabilities, fs, httpRequest, isTauri, openExternal, pickFolder, platform, secrets } from "../lib/platform";
import { addApprovalRule, deleteProvider, exportData, importData, saveProvider, toast, updateSettings, useApp, type View } from "../lib/store";
import { disconnectHub, syncNow, type SyncState } from "../lib/sync";
import { PAGE_TOOLS } from "../lib/pages";
import { BUILTIN_TOOLS } from "../lib/tools";
import { checkForUpdates } from "../lib/updates";
import { timeAgo, uid } from "../lib/util";
import type { Provider, TelegramSettings } from "../lib/types";
import { PageHead } from "./PageHead";
import logo from "../assets/lantern.svg";

type Section = "models" | "hub" | "connections" | "approvals" | "general" | "voice" | "data" | "about";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "models", label: "Models" },
  { id: "hub", label: "Hub" },
  { id: "connections", label: "Phone & Telegram" },
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
          {section === "connections" && <ConnectionsSection />}
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

function RunnerCard() {
  const runner = useApp((s) => s.runner);
  const runOn = useApp((s) => s.settings.runOn ?? "hub");
  return (
    <>
      <div className="card">
        <div className="list-main">
          <span className={`hub-status ${runner?.online ? "online" : "offline"}`}>
            {runner?.online ? <Check size={14} /> : <CloudOff size={14} />}
            <strong>Runner {runner?.online ? "online" : "offline"}</strong>
          </span>
          <span className="muted small">
            {runner?.online
              ? `Your hub runs your bots${runner.version ? ` (runner ${runner.version})` : ""}: chats, routines, webhooks and Telegram keep going when every app is closed.`
              : "Without the runner, bots work in the app you chat from, and routines run only while Lantern is open. Install it on the hub with install.sh (docs/HUB.md, Runner)."}
          </span>
        </div>
      </div>
      <Field label="Where bots work" hint="On the hub, a chat you start on your phone keeps going after you lock it. Bots with files on this device, or local plugins, always work here.">
        <select className="select" value={runOn} onChange={(e) => void updateSettings({ runOn: e.target.value as "hub" | "device" })}>
          <option value="hub">On your hub, when its runner is online</option>
          <option value="device">On the device you chat from</option>
        </select>
      </Field>
    </>
  );
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
    // Also refreshes what the hub can do (e.g. sandboxes after a hub upgrade).
    void hubToolInfo().catch(() => {});
  }, []);

  return (
    <div className="form">
      <h2>Lantern Hub</h2>
      <div className="card">
        <div className="list-main">
          <strong>{hub.name}</strong>
          <span className="muted small mono">{hub.url}</span>
          <span className={`hub-status small ${sync.status}`}>
            {sync.status === "online" ? <Check size={14} /> : sync.status === "connecting" ? <RefreshCw size={14} /> : sync.status === "error" ? <CircleAlert size={14} /> : <CloudOff size={14} />}
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

      <RunnerCard />

      <Field label="Bots' files and terminal" hint="On the hub, every device sees the same workspace, and phones get a terminal too. A bot can override this in its settings.">
        <select className="select" value={settings.computer ?? "hub"} onChange={(e) => void updateSettings({ computer: e.target.value as "hub" | "device" })}>
          <option value="hub">On the hub, shared by all devices{hub.tools ? ` (${hub.tools.workspace})` : ""}</option>
          <option value="device">On each device</option>
        </select>
      </Field>
      {hub.tools?.sandbox !== undefined && (
        <p className="muted small">
          {hub.tools.sandbox
            ? "Sandboxes: available. A bot can keep its files and commands in a sandbox (its Model tab), and isolated subagents run in one."
            : "Sandboxes: not set up on this hub. Install bubblewrap there to sandbox bots and subagents (docs/HUB.md, Sandboxes)."}
        </p>
      )}

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
                  {d.platform === "runner"
                    ? `Runs your bots on the hub · seen ${timeAgo(d.lastSeen)}`
                    : `${d.platform} · paired ${new Date(d.createdAt).toLocaleDateString()} via ${d.pairedVia === "tailscale" ? "Tailscale" : "code"} · seen ${timeAgo(d.lastSeen)}`}
                </span>
              </div>
              {d.id !== hub.deviceId && d.platform !== "runner" && (
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
  const bots = useApp((s) => s.bots);
  const now = Date.now();
  // Rules that ran out stay stored until the next one is added; they aren't shown.
  const rules = settings.approvalRules.filter((r) => !r.expiresAt || r.expiresAt > now);
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
      {rules.length ? (
        <ul className="list">
          {rules.map((r) => (
            <li key={r.id}>
              <Pill tone={r.decision === "allow" ? "success" : "danger"}>{r.decision === "allow" ? "Allow" : "Deny"}</Pill>
              <div className="list-main">
                <span className="mono">
                  {r.tool}
                  {r.pattern ? `: ${r.pattern}` : ""}
                </span>
                <span className="muted small">
                  {r.botId ? `Only ${bots.find((b) => b.id === r.botId)?.name ?? "a deleted bot"}` : "Every bot"}
                  {r.expiresAt ? `, until ${new Date(r.expiresAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}
                </span>
              </div>
              <IconButton label="Delete rule" onClick={() => void updateSettings({ approvalRules: settings.approvalRules.filter((x) => x.id !== r.id) })}>
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No rules yet. Choosing “Always allow” when a bot asks adds one.</p>
      )}
      <div className="row wrap">
        <select className="select" value={decision} onChange={(e) => setDecision(e.target.value as "allow" | "deny")}>
          <option value="deny">Deny</option>
          <option value="allow">Allow</option>
        </select>
        <select className="select" value={tool} onChange={(e) => setTool(e.target.value)}>
          {[...BUILTIN_TOOLS, ...PAGE_TOOLS].filter((t) => ["write", "exec"].includes(String(t.risk))).map((t) => (
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
      <FirecrawlSettings />
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

function FirecrawlSettings() {
  const fc = useApp((s) => s.settings.firecrawl);
  const [testing, setTesting] = useState(false);
  const value = fc ?? { url: "", search: true, read: true };
  const save = (patch: Partial<typeof value>) => void updateSettings({ firecrawl: { ...value, ...patch } });
  return (
    <>
      <Field label="Firecrawl server (optional)" hint="A self-hosted Firecrawl reads pages in a real browser and searches with its own engine, so bots get cleaner text from JavaScript-heavy sites, plus site maps and crawls.">
        <div className="row">
          <input className="input mono" value={value.url} placeholder="http://firecrawl.local:3002" onChange={(e) => save({ url: e.target.value.trim() })} />
          <Button
            size="sm"
            disabled={!value.url || testing}
            onClick={async () => {
              setTesting(true);
              try {
                const r = await firecrawlSearch(value.url, "Lantern open source", 2);
                toast(`Firecrawl answered with ${r.length} results.`, "success");
              } catch (e) {
                toast((e as Error).message, "error");
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? "Testing…" : "Test"}
          </Button>
        </div>
      </Field>
      {!!value.url && (
        <>
          <Toggle label="Search with Firecrawl" description="Your web search setting below stays as the fallback if Firecrawl is down." checked={value.search} onChange={(search) => save({ search })} />
          <Toggle label="Read pages with Firecrawl" description="web_fetch asks Firecrawl first, then fetches the page directly if that fails." checked={value.read} onChange={(read) => save({ read })} />
        </>
      )}
    </>
  );
}

function newLinkCode(): string {
  const raw = uid("").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/[01OIL]/g, "7");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function ConnectionsSection() {
  const settings = useApp((s) => s.settings);
  const bots = useApp((s) => s.bots);
  const runnerOnline = useApp((s) => !!s.runner?.online);
  const hub = useApp((s) => s.hub);
  const push = settings.push ?? { server: "https://ntfy.sh", topic: "" };
  const tg: TelegramSettings = settings.telegram ?? { enabled: false, chats: [] };
  const [token, setToken] = useState("");
  const [ntfyToken, setNtfyToken] = useState("");
  const savePush = (patch: Partial<typeof push>) => void updateSettings({ push: { ...push, ...patch } });
  const saveTg = (patch: Partial<TelegramSettings>) => void updateSettings({ telegram: { ...tg, ...patch } });

  return (
    <div className="form">
      <h2>Phone & Telegram</h2>
      {!hub || !runnerOnline ? (
        <p className="small">
          These work through your hub's runner, which {hub ? "isn't online right now" : "needs a Lantern Hub"}. You can set them up now; they start when the runner is online.
        </p>
      ) : null}

      <h3>Phone notifications (ntfy)</h3>
      <p className="muted small">
        Lantern can't reach a closed app on your phone, so the hub sends notifications through ntfy, a small open-source push service. Install the ntfy app, subscribe to the topic below,
        and you'll hear when a bot needs approval, a routine finishes, or a long task is done. Use your own ntfy server, or ntfy.sh with a topic nobody can guess.
      </p>
      <Field label="ntfy server">
        <input className="input mono" value={push.server} placeholder="https://ntfy.sh" onChange={(e) => savePush({ server: e.target.value.trim() })} />
      </Field>
      <Field label="Topic" hint="Like a password: anyone who knows it can read your notifications.">
        <div className="row">
          <input className="input mono" value={push.topic} placeholder="lantern-…" onChange={(e) => savePush({ topic: e.target.value.trim() })} />
          <Button size="sm" onClick={() => savePush({ topic: `lantern-${uid("").slice(0, 12)}` })}>
            New topic
          </Button>
        </div>
      </Field>
      <Field label="Access token (only if your ntfy server needs one)">
        <div className="row">
          <input className="input" type="password" autoComplete="off" value={ntfyToken} placeholder="tk_…" onChange={(e) => setNtfyToken(e.target.value)} />
          <Button
            size="sm"
            disabled={!ntfyToken}
            onClick={async () => {
              await secrets.set("push:ntfy", ntfyToken);
              setNtfyToken("");
              toast("Saved.", "success");
            }}
          >
            Save
          </Button>
        </div>
      </Field>
      <Toggle label="Hide what bots say" description="Notifications only say which bot wants you, not what it wrote." checked={!!push.hideText} onChange={(hideText) => savePush({ hideText })} />
      <div className="row wrap">
        <Button
          disabled={!push.server || !push.topic}
          onClick={async () => {
            try {
              const t = await secrets.get("push:ntfy");
              const res = await httpRequest({
                method: "POST",
                url: push.server.replace(/\/+$/, ""),
                headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) },
                body: JSON.stringify({ topic: push.topic, title: "Lantern", message: "Notifications from your bots will look like this." }),
                timeoutMs: 15000,
              });
              toast(res.status < 400 ? "Sent. Check your phone." : `ntfy answered ${res.status}.`, res.status < 400 ? "success" : "error");
            } catch (e) {
              toast((e as Error).message, "error");
            }
          }}
        >
          Send a test
        </Button>
        {push.topic && (
          <Button variant="ghost" onClick={() => void openExternal(`${push.server.replace(/\/+$/, "")}/${push.topic}`)}>
            <ExternalLink size={16} /> Open the topic
          </Button>
        )}
      </div>

      <h3>Telegram</h3>
      <p className="muted small">
        Talk to your bots from Telegram, including voice notes and photos, and answer approvals with a tap. Only chats you link below can use it.
      </p>
      <ol className="steps small">
        <li>
          In Telegram, message <strong>@BotFather</strong>, send <code>/newbot</code>, and copy the token it gives you.
        </li>
        <li>Paste the token here and switch Telegram on.</li>
        <li>Send the link command below to your new bot.</li>
      </ol>
      <Field label={tg.username ? `Bot token (connected as @${tg.username}; paste a new one to replace it)` : "Bot token"}>
        <div className="row">
          <input className="input mono" type="password" autoComplete="off" value={token} placeholder="123456:ABC…" onChange={(e) => setToken(e.target.value.trim())} />
          <Button
            size="sm"
            disabled={!/^\d+:[\w-]{20,}$/.test(token)}
            onClick={async () => {
              await secrets.set("telegram:token", token);
              setToken("");
              saveTg({ enabled: true, username: undefined });
              toast("Saved. Your hub connects to Telegram in a moment.", "success");
            }}
          >
            Save
          </Button>
        </div>
      </Field>
      <Toggle label="Telegram on" checked={tg.enabled} onChange={(enabled) => saveTg({ enabled })} />
      <Field label="Answers new chats">
        <select className="select" value={tg.botId ?? ""} onChange={(e) => saveTg({ botId: e.target.value || undefined })}>
          <option value="">Your primary bot (or the first one)</option>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="row wrap">
        <Button onClick={() => saveTg({ linkCode: newLinkCode() })}>Link a chat</Button>
        {tg.linkCode && (
          <span className="small">
            Send <code>/link {tg.linkCode}</code> to {tg.username ? <strong>@{tg.username}</strong> : "your bot"}
            {tg.username && (
              <>
                {" "}
                or{" "}
                <button className="link" onClick={() => void openExternal(`https://t.me/${tg.username}?start=${tg.linkCode!.replace("-", "")}`)}>
                  open it in Telegram
                </button>
              </>
            )}
            . The code works once.
          </span>
        )}
      </div>
      {tg.chats.length > 0 && (
        <ul className="list">
          {tg.chats.map((c) => (
            <li key={c.id}>
              <div className="list-main">
                <strong>{c.name}</strong>
                <span className="muted small">Talks to {bots.find((b) => b.id === (c.botId ?? tg.botId ?? settings.primaryBotId))?.name ?? bots[0]?.name ?? "your bots"} · send /use to switch</span>
              </div>
              <IconButton label="Unlink" onClick={() => saveTg({ chats: tg.chats.filter((x) => x.id !== c.id) })}>
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
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
          <p className="muted small">
            New versions come from your Lantern Hub
            {platform.os === "android" ? " and are checked against the checksum it publishes" : platform.mobile ? "" : " and are checked against Lantern's signing key before they install"}.
          </p>
          <div>
            <Button onClick={() => void checkForUpdates({ manual: true })}>
              <RefreshCw size={16} /> Check for updates
            </Button>
          </div>
          {(!platform.mobile || platform.os === "android") && <UpdateToggle />}
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
      description={
        platform.os === "android"
          ? "After the first update, new versions download in the background and install when you switch away from Lantern (Android 12 and later)."
          : "Updates install when Lantern starts or while it's in the background, never in the middle of a bot's work."
      }
      checked={autoUpdate}
      onChange={(v) => void updateSettings({ autoUpdate: v })}
    />
  );
}
