import { Dices, FolderOpen, KeyRound, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usesHub } from "../lib/hub";
import { capabilities, pickFolder, platform, secrets } from "../lib/platform";
import { runRoutine } from "../lib/routines";
import { toolEnabled } from "../lib/tools";
import { describeSchedule } from "../lib/schedule";
import { addMemory, botSecretKey, deleteBot, deleteMemory, deleteRoutine, deleteSkill, saveBot, saveRoutine, saveSkill, setView, useApp, workspaceFor } from "../lib/store";
import type { ApprovalMode, Bot, BotToolToggles, Skill } from "../lib/types";
import { timeAgo, uid } from "../lib/util";
import { APPROVAL_MODES } from "./ChatView";
import { AVATAR_COLORS, AVATAR_EYES, AVATAR_MOUTHS, AVATAR_SHAPES, Avatar, randomAvatar } from "./Avatar";
import { ModelPicker } from "./ModelPicker";
import { RoutineEditor } from "./RoutineEditor";
import { Button, confirmDialog, Empty, Field, IconButton, Modal, Tabs, Toggle } from "./ui";

type Tab = "profile" | "model" | "tools" | "skills" | "memory" | "plugins" | "secrets" | "routines";

const TOOL_INFO: { key: keyof BotToolToggles; label: string; description: string; desktopOnly?: boolean }[] = [
  { key: "files", label: "Files", description: "Read, write, edit, search and delete files in the workspace." },
  { key: "shell", label: "Terminal", description: "Run shell commands in the workspace.", desktopOnly: true },
  { key: "web", label: "Web", description: "Search the web and read pages." },
  { key: "memory", label: "Memory", description: "Remember facts and preferences across chats." },
  { key: "skills", label: "Skills", description: "Load and create skills (reusable instructions)." },
  { key: "routines", label: "Routines", description: "Schedule recurring tasks for itself." },
  { key: "conversationSearch", label: "Chat history", description: "Search earlier chats with you." },
  { key: "subagents", label: "Subagents", description: "Hand tasks to helpers that work on their own and report back, several at once." },
];

export function BotPanel() {
  const bot = useApp((s) => s.bots.find((b) => b.id === s.activeBotId));
  const [tab, setTab] = useState<Tab>("profile");
  if (!bot) return null;
  const close = () => useApp.setState({ detailsOpen: false });
  return (
    <aside className="details">
      <div className="details-head">
        <Avatar spec={bot.avatar} size={28} />
        <h2>{bot.name}</h2>
        <IconButton label="Close" onClick={close}>
          <X size={18} />
        </IconButton>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "profile", label: "Profile" },
          { id: "model", label: "Model" },
          { id: "tools", label: "Tools" },
          { id: "skills", label: "Skills" },
          { id: "memory", label: "Memory" },
          { id: "plugins", label: "Plugins" },
          { id: "secrets", label: "Secrets" },
          { id: "routines", label: "Routines" },
        ]}
      />
      <div className="details-body">
        {tab === "profile" && <ProfileTab bot={bot} />}
        {tab === "model" && <ModelTab bot={bot} />}
        {tab === "tools" && <ToolsTab bot={bot} />}
        {tab === "skills" && <SkillsTab bot={bot} />}
        {tab === "memory" && <MemoryTab bot={bot} />}
        {tab === "plugins" && <PluginsTab bot={bot} />}
        {tab === "secrets" && <SecretsTab bot={bot} />}
        {tab === "routines" && <RoutinesTab bot={bot} />}
      </div>
    </aside>
  );
}

/** Text inputs keep a local draft and save on blur so typing stays smooth. */
function useDraft<T>(value: T, save: (v: T) => void): [T, (v: T) => void, () => void] {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return [draft, setDraft, () => draft !== value && save(draft)];
}

function ProfileTab({ bot }: { bot: Bot }) {
  const [name, setName, commitName] = useDraft(bot.name, (v) => void saveBot({ ...bot, name: v.trim() || bot.name }));
  const [tagline, setTagline, commitTagline] = useDraft(bot.tagline, (v) => void saveBot({ ...bot, tagline: v }));
  const [instructions, setInstructions, commitInstructions] = useDraft(bot.instructions, (v) => void saveBot({ ...bot, instructions: v }));
  const a = bot.avatar;
  const setAvatar = (patch: Partial<Bot["avatar"]>) => void saveBot({ ...bot, avatar: { ...a, ...patch } });

  return (
    <div className="form">
      <div className="avatar-editor">
        <Avatar spec={a} size={88} />
        <div className="avatar-options">
          <div className="option-row">
            {AVATAR_SHAPES.map((shape) => (
              <button key={shape} className={`opt${a.shape === shape ? " on" : ""}`} title={shape} onClick={() => setAvatar({ shape })}>
                <Avatar spec={{ ...a, shape, badge: undefined }} size={26} />
              </button>
            ))}
          </div>
          <div className="option-row">
            {AVATAR_COLORS.map((color) => (
              <button key={color} className={`swatch${a.color === color ? " on" : ""}`} style={{ background: color }} title={color} onClick={() => setAvatar({ color })} />
            ))}
          </div>
          <div className="option-row">
            {AVATAR_EYES.map((eyes) => (
              <button key={eyes} className={`opt${a.eyes === eyes ? " on" : ""}`} title={`Eyes: ${eyes}`} onClick={() => setAvatar({ eyes })}>
                <Avatar spec={{ ...a, eyes, badge: undefined }} size={26} />
              </button>
            ))}
          </div>
          <div className="option-row">
            {AVATAR_MOUTHS.map((mouth) => (
              <button key={mouth} className={`opt${a.mouth === mouth ? " on" : ""}`} title={`Mouth: ${mouth}`} onClick={() => setAvatar({ mouth })}>
                <Avatar spec={{ ...a, mouth, badge: undefined }} size={26} />
              </button>
            ))}
          </div>
          <div className="option-row">
            <input className="input badge-input" placeholder="Badge emoji" maxLength={4} value={a.badge ?? ""} onChange={(e) => setAvatar({ badge: e.target.value || undefined })} />
            <Button size="sm" onClick={() => void saveBot({ ...bot, avatar: { ...randomAvatar(), badge: a.badge } })}>
              <Dices size={14} /> Surprise me
            </Button>
          </div>
        </div>
      </div>
      <Field label="Name">
        <input className="input" value={name} maxLength={52} onChange={(e) => setName(e.target.value)} onBlur={commitName} />
      </Field>
      <Field label="Tagline">
        <input className="input" value={tagline} placeholder="What this bot is for" onChange={(e) => setTagline(e.target.value)} onBlur={commitTagline} />
      </Field>
      <Field label="Instructions" hint="How the bot should think, talk and work. This becomes its system prompt.">
        <textarea className="input" rows={10} value={instructions} onChange={(e) => setInstructions(e.target.value)} onBlur={commitInstructions} />
      </Field>
      <Toggle label="Pin to top" checked={!!bot.pinned} onChange={(pinned) => void saveBot({ ...bot, pinned })} />
      <div className="danger-zone">
        <Button
          variant="danger"
          onClick={async () => {
            if (await confirmDialog({ title: `Delete ${bot.name}?`, body: "This deletes the bot with its chats, memories, private skills, secrets and routines.", confirmLabel: "Delete bot", danger: true })) {
              await deleteBot(bot.id);
            }
          }}
        >
          <Trash2 size={15} /> Delete bot
        </Button>
      </div>
    </div>
  );
}

function ModelTab({ bot }: { bot: Bot }) {
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);
  const hub = useApp((s) => s.hub);
  const onHub = usesHub(bot);
  const workspace = workspaceFor(bot);
  return (
    <div className="form">
      <Field label="Model" hint={providers.length ? "Pick any model from your servers, or inherit the default from Settings." : undefined}>
        <ModelPicker value={bot.model} defaultLabel={settings.defaultModel ? `Default (${settings.defaultModel.model})` : "Default model"} onChange={(model) => void saveBot({ ...bot, model })} />
      </Field>
      {!providers.length && (
        <Button variant="primary" onClick={() => setView({ kind: "settings", tab: "models" })}>
          Add a model server
        </Button>
      )}
      <Field label={`Temperature${bot.temperature === undefined ? " (model default)" : `: ${bot.temperature.toFixed(1)}`}`} hint="Lower is more focused, higher is more creative.">
        <div className="row">
          <input type="range" min={0} max={2} step={0.1} value={bot.temperature ?? 0.7} onChange={(e) => void saveBot({ ...bot, temperature: Number(e.target.value) })} />
          {bot.temperature !== undefined && (
            <Button size="sm" variant="ghost" onClick={() => void saveBot({ ...bot, temperature: undefined })}>
              Reset
            </Button>
          )}
        </div>
      </Field>
      <Field label="Approvals">
        <select className="select" value={bot.approvalMode ?? ""} onChange={(e) => void saveBot({ ...bot, approvalMode: (e.target.value || undefined) as ApprovalMode | undefined })}>
          <option value="">Use the app setting ({APPROVAL_MODES.find((m) => m.id === settings.approvalMode)?.label})</option>
          {APPROVAL_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}: {m.description}
            </option>
          ))}
        </select>
      </Field>
      {hub && (
        <Field label="Files and terminal" hint="On the hub, this bot's files and commands are the same on every device.">
          <select className="select" value={bot.computer ?? ""} onChange={(e) => void saveBot({ ...bot, computer: (e.target.value || undefined) as Bot["computer"] })}>
            <option value="">Use the app setting ({(settings.computer ?? "hub") === "hub" ? "on the hub" : "on each device"})</option>
            <option value="hub">On the hub{hub.tools ? ` (${hub.tools.workspace})` : ""}</option>
            <option value="device">On each device</option>
          </select>
        </Field>
      )}
      {hub && (bot.computer ?? settings.computer ?? "hub") === "hub" && (
        <>
          <Toggle
            label="Sandbox"
            description={
              <>
                Keep this bot's files and commands in its own folder on the hub (<code>bots/{bot.id}</code>), walled off from your other files and the rest of the server.
                {hub.tools?.sandbox === false && " This hub can't sandbox commands yet (it needs bubblewrap), so the bot gets no terminal until it can."}
              </>
            }
            checked={!!bot.sandbox}
            onChange={(on) => void saveBot({ ...bot, sandbox: on ? { network: true } : undefined })}
          />
          {bot.sandbox && (
            <Toggle
              label="Internet access in the sandbox"
              description="Off: commands in the sandbox get no network at all."
              checked={bot.sandbox.network}
              onChange={(network) => void saveBot({ ...bot, sandbox: { network } })}
            />
          )}
        </>
      )}
      {capabilities.files && !onHub && (
        <Field label="Workspace folder" hint="Relative file paths and terminal commands start here.">
          <div className="row">
            <input className="input mono" value={bot.workspace ?? ""} placeholder={workspace} onChange={(e) => void saveBot({ ...bot, workspace: e.target.value || undefined })} />
            {capabilities.shell && (
              <IconButton
                label="Choose folder"
                onClick={async () => {
                  const dir = await pickFolder();
                  if (dir) await saveBot({ ...bot, workspace: dir });
                }}
              >
                <FolderOpen size={17} />
              </IconButton>
            )}
          </div>
        </Field>
      )}
    </div>
  );
}

function ToolsTab({ bot }: { bot: Bot }) {
  useApp((s) => s.hub);
  const onHub = usesHub(bot);
  return (
    <div className="form">
      {TOOL_INFO.map((t) => {
        const unsupported = !onHub && ((t.desktopOnly && !capabilities.shell) || (t.key === "files" && !capabilities.files));
        return (
          <Toggle
            key={t.key}
            label={t.label}
            description={unsupported ? `${t.description} (not available on this device)` : t.description}
            checked={toolEnabled(bot, t.key) && !unsupported}
            disabled={unsupported}
            onChange={(v) => void saveBot({ ...bot, tools: { ...bot.tools, [t.key]: v } })}
          />
        );
      })}
    </div>
  );
}

export function SkillEditor({ skill, botId, onClose }: { skill?: Skill; botId?: string; onClose: () => void }) {
  const [draft, setDraft] = useState<Skill>(skill ?? { id: uid("skill"), name: "", description: "", content: "", botId, createdAt: Date.now(), updatedAt: Date.now() });
  return (
    <Modal
      wide
      title={skill ? "Edit skill" : botId ? "New private skill" : "New skill"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!draft.name.trim() || !draft.description.trim() || !draft.content.trim()}
            onClick={async () => {
              await saveSkill({ ...draft, name: draft.name.trim() });
              onClose();
            }}
          >
            Save skill
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Name">
          <input className="input" value={draft.name} placeholder="weekly-report" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="When to use it" hint="Required. The bot reads this to decide when to load the skill.">
          <input className="input" value={draft.description} placeholder="Use when the user asks for a weekly status report" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </Field>
        <Field label="Instructions (Markdown)">
          <textarea className="input mono" rows={14} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function SkillsTab({ bot }: { bot: Bot }) {
  const skills = useApp((s) => s.skills);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const library = skills.filter((s) => !s.botId);
  const mine = skills.filter((s) => s.botId === bot.id);
  return (
    <div className="form">
      <h3>Private skills</h3>
      {mine.length ? (
        <ul className="list">
          {mine.map((s) => (
            <li key={s.id}>
              <div className="list-main">
                <strong>{s.name}</strong>
                <span className="muted small">{s.description}</span>
              </div>
              <IconButton label="Edit" onClick={() => setEditing(s)}>
                <Pencil size={15} />
              </IconButton>
              <IconButton label="Delete" onClick={() => void deleteSkill(s.id)}>
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No private skills yet. Write one, or ask {bot.name} to create one for you.</p>
      )}
      <Button size="sm" onClick={() => setEditing("new")}>
        <Plus size={14} /> New private skill
      </Button>
      <h3>From your library</h3>
      {library.length ? (
        library.map((s) => (
          <Toggle
            key={s.id}
            label={s.name}
            description={s.description}
            checked={bot.skillIds.includes(s.id)}
            onChange={(on) => void saveBot({ ...bot, skillIds: on ? [...bot.skillIds, s.id] : bot.skillIds.filter((x) => x !== s.id) })}
          />
        ))
      ) : (
        <p className="muted small">
          Your library is empty.{" "}
          <button className="link" onClick={() => setView({ kind: "skills" })}>
            Add skills
          </button>
        </p>
      )}
      {editing && <SkillEditor skill={editing === "new" ? undefined : editing} botId={bot.id} onClose={() => setEditing(null)} />}
    </div>
  );
}

function MemoryTab({ bot }: { bot: Bot }) {
  const memories = useApp(useShallow((s) => s.memories.filter((m) => m.botId === bot.id)));
  const [text, setText] = useState("");
  return (
    <div className="form">
      <p className="muted small">Memories between you and {bot.name}. They're included in every chat with this bot.</p>
      <div className="row">
        <input
          className="input"
          value={text}
          placeholder="Add a memory…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) {
              void addMemory(bot.id, text);
              setText("");
            }
          }}
        />
        <Button
          disabled={!text.trim()}
          onClick={() => {
            void addMemory(bot.id, text);
            setText("");
          }}
        >
          Add
        </Button>
      </div>
      {memories.length ? (
        <ul className="list">
          {memories.map((m) => (
            <li key={m.id}>
              <div className="list-main">
                <span>{m.content}</span>
                <span className="muted small">{timeAgo(m.createdAt)}</span>
              </div>
              <IconButton label="Forget" onClick={() => void deleteMemory(m.id)}>
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No memories yet" />
      )}
    </div>
  );
}

function PluginsTab({ bot }: { bot: Bot }) {
  const servers = useApp((s) => s.mcpServers);
  return (
    <div className="form">
      <p className="muted small">MCP servers give {bot.name} extra tools. Add servers on the Plugins page, then switch them on here.</p>
      {servers.map((s) => (
        <Toggle
          key={s.id}
          label={s.name}
          description={`${s.transport === "stdio" ? `Local: ${s.command} ${(s.args ?? []).join(" ")}` : s.url}${s.enabled ? "" : " (disabled)"}${s.transport === "stdio" && !capabilities.mcpStdio ? ", desktop only" : ""}`}
          checked={bot.mcpServerIds.includes(s.id)}
          onChange={(on) => void saveBot({ ...bot, mcpServerIds: on ? [...bot.mcpServerIds, s.id] : bot.mcpServerIds.filter((x) => x !== s.id) })}
        />
      ))}
      <Button size="sm" onClick={() => setView({ kind: "plugins" })}>
        <Plus size={14} /> Manage plugins
      </Button>
    </div>
  );
}

function SecretsTab({ bot }: { bot: Bot }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const valid = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) && value.length > 0;
  return (
    <div className="form">
      <p className="muted small">
        Credentials {bot.name} can use in terminal commands as environment variables. Values are write-only: they are stored in {platform.secretBackend === "keychain" ? "your system keychain" : "app-private storage"} and never shown to the model, which only sees the names.
      </p>
      {bot.secretNames.length ? (
        <ul className="list">
          {bot.secretNames.map((n) => (
            <li key={n}>
              <KeyRound size={15} className="muted" />
              <div className="list-main mono">${n}</div>
              <IconButton
                label="Remove"
                onClick={async () => {
                  await secrets.delete(botSecretKey(bot.id, n));
                  await saveBot({ ...bot, secretNames: bot.secretNames.filter((x) => x !== n) });
                }}
              >
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No secrets yet.</p>
      )}
      <div className="row wrap">
        <input className="input mono" placeholder="NAME" value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} />
        <input className="input" type="password" placeholder="Paste the secret" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
        <Button
          variant="primary"
          disabled={!valid}
          onClick={async () => {
            await secrets.set(botSecretKey(bot.id, name), value);
            await saveBot({ ...bot, secretNames: [...new Set([...bot.secretNames, name])] });
            setName("");
            setValue("");
          }}
        >
          Save secret
        </Button>
      </div>
    </div>
  );
}

function RoutinesTab({ bot }: { bot: Bot }) {
  const routines = useApp(useShallow((s) => s.routines.filter((r) => r.botId === bot.id)));
  const [editing, setEditing] = useState<string | "new" | null>(null);
  return (
    <div className="form">
      <p className="muted small">Routines are recurring tasks {bot.name} runs on a schedule. You can also ask it in chat to set one up.</p>
      {routines.map((r) => (
        <div key={r.id} className="routine-row">
          <div className="list-main">
            <strong>{r.name}</strong>
            <span className="muted small">
              {describeSchedule(r.schedule)}
              {r.enabled && r.nextRunAt ? ` · next ${new Date(r.nextRunAt).toLocaleString()}` : r.enabled ? "" : " · paused"}
            </span>
          </div>
          <input type="checkbox" className="switch" checked={r.enabled} onChange={(e) => void saveRoutine({ ...r, enabled: e.target.checked })} aria-label="Enabled" />
          <IconButton label="Run now" onClick={() => void runRoutine(r, true)}>
            <Play size={15} />
          </IconButton>
          <IconButton label="Edit" onClick={() => setEditing(r.id)}>
            <Pencil size={15} />
          </IconButton>
          <IconButton label="Delete" onClick={() => void deleteRoutine(r.id)}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      ))}
      <Button size="sm" onClick={() => setEditing("new")}>
        <Plus size={14} /> New routine
      </Button>
      {editing && <RoutineEditor routine={routines.find((r) => r.id === editing)} botId={bot.id} onClose={() => setEditing(null)} />}
    </div>
  );
}
