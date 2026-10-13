import { Dices, FolderOpen, KeyRound, Pencil, Play, Plus, Share2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { designAvatar } from "../lib/avatar";
import { shareLink, templateFromBot } from "../lib/share";
import { browserAvailable } from "../lib/browser";
import { hubConnection, hubMail, usesHub } from "../lib/hub";
import { emailSecretKey, mailAccount } from "../lib/mail";
import { capabilities, pickFolder, platform, secrets } from "../lib/platform";
import { describeRoutineTrigger, runRoutine } from "../lib/routines";
import { teamFor } from "../lib/team";
import { toolEnabled } from "../lib/tools";
import { nextRun } from "../lib/schedule";
import { db } from "../lib/platform";
import { forgetSharedFile } from "../lib/pages";
import { addMemory, botSecretKey, deleteBot, deleteMemory, deleteRoutine, deleteSkill, saveBot, saveRoutine, saveSkill, setView, toast, updateSettings, useApp, workspaceFor } from "../lib/store";
import type { ApprovalMode, Bot, BotEmail, BotToolToggles, ChatMessage, Routine, Skill } from "../lib/types";
import { formatBytes, timeAgo, uid } from "../lib/util";
import { BrowserView } from "./BrowserView";
import { openFile, openPage } from "./Viewers";
import { APPROVAL_MODES } from "./ChatView";
import { AVATAR_COLORS, AVATAR_EYES, AVATAR_MOUTHS, AVATAR_SHAPES, Avatar, randomAvatar } from "./Avatar";
import { ModelPicker } from "./ModelPicker";
import { RoutineEditor } from "./RoutineEditor";
import { Button, confirmDialog, Empty, Field, IconButton, Modal, Tabs, Toggle } from "./ui";

type Tab = "profile" | "library" | "model" | "tools" | "skills" | "memory" | "plugins" | "secrets" | "routines" | "browser" | "email";

/** The primary bot's daily check-in: it looks over recent work and offers to take things off your plate. */
export const CHECK_IN_PROMPT =
  "Check in with the user. Use recent_chats (all bots) and your routines to see what has happened since your last check-in, and follow up on anything you were asked to keep an eye on. If you spot work you or another bot could take off the user's plate, offer it as a short list (at most three items), each with what you'd do. If there's nothing worth raising, reply with exactly: Nothing new.";
const checkInId = (botId: string) => `checkin_${botId}`;

const TOOL_INFO: { key: keyof BotToolToggles; label: string; description: string; desktopOnly?: boolean }[] = [
  { key: "files", label: "Files", description: "Read, write, edit, search and delete files in the workspace." },
  { key: "shell", label: "Terminal", description: "Run shell commands in the workspace.", desktopOnly: true },
  { key: "web", label: "Web", description: "Search the web and read pages." },
  { key: "memory", label: "Memory", description: "Remember facts and preferences across chats." },
  { key: "skills", label: "Skills", description: "Load and create skills (reusable instructions)." },
  { key: "routines", label: "Routines", description: "Schedule recurring tasks for itself." },
  { key: "conversationSearch", label: "Chat history", description: "Search earlier chats with you." },
  { key: "subagents", label: "Subagents", description: "Hand tasks to helpers that work on their own and report back, several at once." },
  { key: "bots", label: "Other bots", description: "Ask your other bots for help, or hand them a whole task." },
  { key: "browser", label: "Browser", description: "Use a web browser on your hub for sites that need clicking or signing in. You can watch and take over." },
  { key: "email", label: "Email", description: "Read and send mail from this bot's own inbox (set it up in the Email tab)." },
  { key: "forms", label: "Forms", description: "Ask you with a form in the chat: choices, dates, and secret fields it never sees." },
  { key: "planning", label: "Plans and goals", description: "Keep a checklist above the chat, and keep going until a goal is done." },
  { key: "pages", label: "Pages and files", description: "Write pages you can read and edit, share files, make slide decks, and read PDFs, Word and Excel files." },
  { key: "profile", label: "Its own look", description: "Change its name, tagline and avatar when you ask." },
];

export function BotPanel() {
  const bot = useApp((s) => s.bots.find((b) => b.id === s.activeBotId));
  const wanted = useApp((s) => s.detailsTab);
  const [tab, setTab] = useState<Tab>((wanted as Tab) ?? "profile");
  useApp((s) => s.hub?.tools);
  useEffect(() => {
    if (!wanted) return;
    setTab(wanted as Tab);
    useApp.setState({ detailsTab: null });
  }, [wanted]);
  if (!bot) return null;
  const hasBrowser = browserAvailable(bot);
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
          { id: "library", label: "Library" },
          { id: "model", label: "Model" },
          { id: "tools", label: "Tools" },
          { id: "skills", label: "Skills" },
          { id: "memory", label: "Memory" },
          { id: "plugins", label: "Plugins" },
          { id: "secrets", label: "Secrets" },
          { id: "routines", label: "Routines" },
          ...(hubConnection() ? [{ id: "email" as const, label: "Email" }] : []),
          ...(hasBrowser ? [{ id: "browser" as const, label: "Browser" }] : []),
        ]}
      />
      <div className="details-body">
        {tab === "profile" && <ProfileTab bot={bot} />}
        {tab === "library" && <LibraryTab bot={bot} />}
        {tab === "model" && <ModelTab bot={bot} />}
        {tab === "tools" && <ToolsTab bot={bot} />}
        {tab === "skills" && <SkillsTab bot={bot} />}
        {tab === "memory" && <MemoryTab bot={bot} />}
        {tab === "plugins" && <PluginsTab bot={bot} />}
        {tab === "secrets" && <SecretsTab bot={bot} />}
        {tab === "routines" && <RoutinesTab bot={bot} />}
        {tab === "email" && <EmailTab bot={bot} />}
        {tab === "browser" && <BrowserView bot={bot} />}
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
          <DescribeLook bot={bot} />
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
      <PrimaryToggle bot={bot} />
      <SectionPicker bot={bot} />
      <ShareTemplate bot={bot} />
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

/** Shares the bot as a template link anyone can add to their own Lantern. */
function ShareTemplate({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const [withSkills, setWithSkills] = useState(true);
  const [withRoutines, setWithRoutines] = useState(true);
  const [link, setLink] = useState("");
  useEffect(() => {
    if (open) void shareLink(templateFromBot(bot, { skills: withSkills, routines: withRoutines })).then(setLink);
  }, [open, bot, withSkills, withRoutines]);
  return (
    <>
      <div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Share2 size={14} /> Share as a template
        </Button>
      </div>
      {open && (
        <Modal title={`Share ${bot.name} as a template`} onClose={() => setOpen(false)}>
          <div className="form">
            <p className="muted small">
              Anyone with this link can add their own copy of {bot.name} to Lantern: its name, look, instructions and tools. The template is inside the link itself, so nothing is uploaded
              anywhere. Secrets, memories, chats, inboxes and your model choice are never included.
            </p>
            <Toggle label="Include its private skills" checked={withSkills} onChange={setWithSkills} />
            <Toggle label="Include its scheduled routines" description="They arrive paused." checked={withRoutines} onChange={setWithRoutines} />
            <div className="row">
              <input className="input mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
              <Button
                variant="primary"
                disabled={!link}
                onClick={() => {
                  void navigator.clipboard?.writeText(link);
                  toast("Link copied.", "success");
                }}
              >
                Copy
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Which sidebar section the bot is listed in. */
function SectionPicker({ bot }: { bot: Bot }) {
  const sections = useApp((s) => s.settings.sidebarSections ?? []);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const current = sections.find((s) => s.botIds.includes(bot.id));
  const move = (to: string | null, extra: typeof sections = []) => {
    const next = [...sections, ...extra].map((s) => ({ ...s, botIds: s.id === to ? [...s.botIds.filter((id) => id !== bot.id), bot.id] : s.botIds.filter((id) => id !== bot.id) }));
    void updateSettings({ sidebarSections: next });
  };
  return (
    <Field label="Sidebar section" hint="Group bots in the sidebar, like Work and Home. Double-click a section's name there to rename it.">
      {naming ? (
        <div className="row">
          <input className="input" autoFocus placeholder="Section name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            size="sm"
            variant="primary"
            disabled={!name.trim()}
            onClick={() => {
              const id = uid("section");
              move(id, [{ id, name: name.trim(), botIds: [] }]);
              setNaming(false);
              setName("");
            }}
          >
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <select
          className="select"
          value={current?.id ?? ""}
          onChange={(e) => (e.target.value === "__new" ? setNaming(true) : move(e.target.value || null))}
        >
          <option value="">None</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          <option value="__new">New section…</option>
        </select>
      )}
    </Field>
  );
}

/** Turns a few words ("a calm owl who likes maps") into an avatar, using the bot's model. */
function DescribeLook({ bot }: { bot: Bot }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const avatar = await designAvatar(bot, text.trim());
      await saveBot({ ...bot, avatar });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="option-row">
      <input
        className="input"
        placeholder="Or describe its look: a calm owl who likes maps"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && text.trim() && !busy && void make()}
      />
      <Button size="sm" disabled={!text.trim() || busy} onClick={() => void make()}>
        {busy ? "Drawing…" : "Make it"}
      </Button>
    </div>
  );
}

function PrimaryToggle({ bot }: { bot: Bot }) {
  const primaryId = useApp((s) => s.settings.primaryBotId);
  const checkIn = useApp((s) => s.routines.find((r) => r.id === checkInId(bot.id)));
  const team = teamFor(bot);
  const isPrimary = primaryId === bot.id;
  return (
    <>
      <Toggle
        label="Primary bot"
        description={`Your main point of contact: it coordinates your other bots${team.length ? ` (${team.map((b) => b.name).join(", ")})` : ""} and can check in with you.`}
        checked={isPrimary}
        onChange={(on) => void updateSettings({ primaryBotId: on ? bot.id : undefined })}
      />
      {isPrimary && (
        <Toggle
          label="Daily check-in"
          description="Every morning it looks over recent work and offers to take things off your plate. When there's nothing worth raising, it stays quiet."
          checked={!!checkIn?.enabled}
          onChange={async (on) => {
            if (on) {
              const routine: Routine = {
                id: checkInId(bot.id),
                botId: bot.id,
                name: "Check-in",
                prompt: CHECK_IN_PROMPT,
                schedule: { kind: "daily", time: "08:30" },
                trigger: { kind: "schedule" },
                quiet: true,
                enabled: true,
                createdAt: Date.now(),
              };
              await saveRoutine({ ...routine, ...(checkIn ?? {}), enabled: true, nextRunAt: nextRun(routine.schedule, Date.now()) });
            } else if (checkIn) {
              await saveRoutine({ ...checkIn, enabled: false });
            }
          }}
        />
      )}
    </>
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
  const why: Partial<Record<keyof BotToolToggles, string | null>> = {
    browser: browserAvailable(bot) ? null : "needs a Lantern Hub with the browser installed",
    email: bot.email && hubConnection() ? null : "set up an inbox in the Email tab first",
  };
  return (
    <div className="form">
      {TOOL_INFO.map((t) => {
        const missing = why[t.key];
        if (missing) {
          return <Toggle key={t.key} label={t.label} description={`${t.description} (${missing})`} checked={false} disabled onChange={() => {}} />;
        }
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
      <p className="muted small">Routines are tasks {bot.name} runs on a schedule, when a webhook is called, or when mail arrives. You can also ask it in chat to set one up.</p>
      {routines.map((r) => (
        <div key={r.id} className="routine-row">
          <div className="list-main">
            <strong>{r.name}</strong>
            <span className="muted small">
              {describeRoutineTrigger(r)}
              {r.enabled && r.nextRunAt && (r.trigger?.kind ?? "schedule") === "schedule" ? ` · next ${new Date(r.nextRunAt).toLocaleString()}` : r.enabled ? "" : " · paused"}
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

const EMAIL_PRESETS: { label: string; imapHost: string; smtpHost: string; smtpPort: number; smtpSecurity: BotEmail["smtpSecurity"]; note?: string }[] = [
  { label: "Gmail", imapHost: "imap.gmail.com", smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecurity: "tls", note: "Use an app password (Google Account → Security → App passwords)." },
  { label: "Fastmail", imapHost: "imap.fastmail.com", smtpHost: "smtp.fastmail.com", smtpPort: 465, smtpSecurity: "tls", note: "Use an app password." },
  { label: "Outlook.com", imapHost: "outlook.office365.com", smtpHost: "smtp-mail.outlook.com", smtpPort: 587, smtpSecurity: "starttls" },
  { label: "iCloud", imapHost: "imap.mail.me.com", smtpHost: "smtp.mail.me.com", smtpPort: 587, smtpSecurity: "starttls", note: "Use an app-specific password." },
];

function EmailTab({ bot }: { bot: Bot }) {
  const blank: BotEmail = { address: "", username: "", imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 465, smtpSecurity: "tls" };
  const [draft, setDraft] = useState<BotEmail>(bot.email ?? blank);
  const [password, setPassword] = useState("");
  const [testing, setTesting] = useState(false);
  const set = (patch: Partial<BotEmail>) => setDraft({ ...draft, ...patch });
  const valid = /.+@.+/.test(draft.address) && draft.imapHost && draft.smtpHost && (password || bot.email);
  const preset = EMAIL_PRESETS.find((p) => p.imapHost === draft.imapHost);

  return (
    <div className="form">
      <p className="muted small">
        Give {bot.name} an inbox of its own (a separate address is best). It can read and answer mail, and a routine can start whenever mail arrives. Sending always goes through your
        approval settings. The password is stored like your other secrets, and only your hub uses it.
      </p>
      <Field label="Provider">
        <select
          className="select"
          value={preset?.label ?? ""}
          onChange={(e) => {
            const p = EMAIL_PRESETS.find((x) => x.label === e.target.value);
            if (p) set({ imapHost: p.imapHost, imapPort: 993, smtpHost: p.smtpHost, smtpPort: p.smtpPort, smtpSecurity: p.smtpSecurity });
          }}
        >
          <option value="">Other (enter the servers)</option>
          {EMAIL_PRESETS.map((p) => (
            <option key={p.label} value={p.label}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      {preset?.note && <p className="small">{preset.note}</p>}
      <Field label="Email address">
        <input className="input" value={draft.address} placeholder="lumi@example.com" onChange={(e) => set({ address: e.target.value.trim() })} />
      </Field>
      <Field label="Username" hint="Usually the address itself.">
        <input className="input" value={draft.username} placeholder={draft.address || "same as the address"} onChange={(e) => set({ username: e.target.value.trim() })} />
      </Field>
      <Field label={bot.email ? "Password (leave empty to keep the saved one)" : "Password"}>
        <input className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <div className="field-pair">
        <Field label="IMAP server (TLS)">
          <input className="input mono" value={draft.imapHost} placeholder="imap.example.com" onChange={(e) => set({ imapHost: e.target.value.trim() })} />
        </Field>
        <Field label="Port">
          <input className="input" type="number" value={draft.imapPort} onChange={(e) => set({ imapPort: Number(e.target.value) || 993 })} />
        </Field>
      </div>
      <div className="field-pair">
        <Field label="SMTP server">
          <input className="input mono" value={draft.smtpHost} placeholder="smtp.example.com" onChange={(e) => set({ smtpHost: e.target.value.trim() })} />
        </Field>
        <Field label="Port">
          <input className="input" type="number" value={draft.smtpPort} onChange={(e) => set({ smtpPort: Number(e.target.value) || 465 })} />
        </Field>
      </div>
      <div>
        <Field label="Security">
          <select className="select" value={draft.smtpSecurity} onChange={(e) => set({ smtpSecurity: e.target.value as BotEmail["smtpSecurity"] })}>
            <option value="tls">TLS (465)</option>
            <option value="starttls">STARTTLS (587)</option>
          </select>
        </Field>
      </div>
      <div className="row wrap">
        <Button
          variant="primary"
          disabled={!valid}
          onClick={async () => {
            if (password) await secrets.set(emailSecretKey(bot.id), password);
            await saveBot({ ...bot, email: { ...draft, username: draft.username || draft.address } });
            setPassword("");
            toast(`${bot.name}'s inbox is saved.`, "success");
          }}
        >
          Save inbox
        </Button>
        <Button
          disabled={!bot.email || testing}
          onClick={async () => {
            setTesting(true);
            try {
              const r = await hubMail.list(await mailAccount(bot), { limit: 1 });
              toast(`Connected: ${r.total} messages in the inbox.`, "success");
            } catch (e) {
              toast((e as Error).message, "error");
            } finally {
              setTesting(false);
            }
          }}
        >
          {testing ? "Checking…" : "Test the inbox"}
        </Button>
        {bot.email && (
          <Button
            variant="ghost"
            onClick={async () => {
              await secrets.delete(emailSecretKey(bot.id));
              await saveBot({ ...bot, email: undefined });
              setDraft(blank);
            }}
          >
            Remove inbox
          </Button>
        )}
      </div>
    </div>
  );
}

/** Links in recent replies, newest first, with the words they were linked from. */
async function recentLinks(botId: string): Promise<{ url: string; text: string; at: number }[]> {
  const convs = useApp
    .getState()
    .conversations.filter((c) => c.botId === botId)
    .slice(0, 15);
  const seen = new Map<string, { url: string; text: string; at: number }>();
  for (const c of convs) {
    for (const m of await db.list<ChatMessage>(`msg:${c.id}`)) {
      if (m.role !== "assistant") continue;
      for (const hit of m.content.matchAll(/\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])/g)) {
        const url = hit[2] ?? hit[3];
        if (!url || seen.has(url)) continue;
        seen.set(url, { url, text: hit[1] ?? new URL(url).hostname, at: m.createdAt });
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.at - a.at).slice(0, 40);
}

/** Everything the bot made or pointed you to: pages, shared files, links. */
function LibraryTab({ bot }: { bot: Bot }) {
  const pages = useApp(useShallow((s) => s.pages.filter((p) => p.botId === bot.id)));
  const files = useApp(useShallow((s) => s.files.filter((f) => f.botId === bot.id)));
  const [links, setLinks] = useState<{ url: string; text: string; at: number }[] | null>(null);
  useEffect(() => {
    void recentLinks(bot.id).then(setLinks);
  }, [bot.id]);
  return (
    <div className="form">
      <h3>Pages</h3>
      {pages.length ? (
        <ul className="list">
          {pages.map((p) => (
            <li key={p.id}>
              <button className="list-main list-button" onClick={() => openPage(p.id)}>
                <strong>{p.title}</strong>
                <span className="muted small">
                  {p.editedByUser ? "Edited by you" : "Written"} {timeAgo(p.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No pages yet. Ask {bot.name} to write one, like a report or a plan you can edit.</p>
      )}
      <h3>Files</h3>
      {files.length ? (
        <ul className="list">
          {files.map((f) => (
            <li key={f.id}>
              <button className="list-main list-button" onClick={() => openFile(f.id)}>
                <strong>{f.name}</strong>
                <span className="muted small">
                  {f.kind === "slides" ? "Slide deck · " : ""}
                  {f.size !== undefined ? `${formatBytes(f.size)} · ` : ""}
                  {timeAgo(f.createdAt)}
                </span>
              </button>
              <IconButton label="Remove from the Library" onClick={() => void forgetSharedFile(f.id)}>
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Files {bot.name} shares with you show up here.</p>
      )}
      <h3>Links</h3>
      {links === null ? (
        <p className="muted small">Looking through recent chats…</p>
      ) : links.length ? (
        <ul className="list">
          {links.map((l) => (
            <li key={l.url}>
              <a className="list-main" href={l.url} target="_blank" rel="noreferrer noopener">
                <span>{l.text}</span>
                <span className="muted small mono">{l.url.length > 70 ? `${l.url.slice(0, 70)}…` : l.url}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No links in recent chats.</p>
      )}
    </div>
  );
}
