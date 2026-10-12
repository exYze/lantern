import { CircleAlert, CircleCheck, LoaderCircle, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, confirmDialog, Empty, Field, IconButton, Modal, Pill, Toggle } from "../components/ui";
import { disconnectMcp, getMcpClient, mcpStatus, secretKey, type McpTool } from "../lib/mcp";
import { capabilities, secrets } from "../lib/platform";
import { deleteMcpServer, saveMcpServer, useApp } from "../lib/store";
import type { McpServer } from "../lib/types";
import { uid } from "../lib/util";
import { PageHead } from "./PageHead";

interface Preset {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  headerKeys?: string[];
  note: string;
}

const PRESETS: Preset[] = [
  { name: "Filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "{workspace}"], note: "Read and write files in the folders you list, one per line (needs Node.js)." },
  { name: "Fetch", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"], note: "Fetch web pages as Markdown (needs uv)." },
  { name: "Git", transport: "stdio", command: "uvx", args: ["mcp-server-git"], note: "Inspect and work with git repositories (needs uv)." },
  { name: "Memory graph", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], note: "A knowledge-graph memory (needs Node.js)." },
  { name: "GitHub", transport: "http", url: "https://api.githubcopilot.com/mcp/", headerKeys: ["Authorization"], note: "GitHub's hosted MCP server. Set Authorization to “Bearer <token>”." },
  { name: "Custom server", transport: "stdio", command: "", args: [], note: "Any MCP server: a local command, or a Streamable HTTP URL." },
];

/** Presets can say {workspace}; no shell expands "~" for us. */
function withWorkspace(args: string[] = []): string[] {
  const { settings, defaultWorkspace } = useApp.getState();
  return args.map((a) => a.replace("{workspace}", settings.workspace || defaultWorkspace || "."));
}

function KeyValues({ label, keys, values, onChange }: { label: string; keys: string[]; values: Record<string, string>; onChange: (keys: string[], values: Record<string, string>) => void }) {
  const [k, setK] = useState("");
  return (
    <Field label={label} hint="Values are write-only and kept in secure storage. Leave a value empty to keep the saved one.">
      <div className="stack-sm">
        {keys.map((key) => (
          <div key={key} className="row">
            <span className="mono kv-key">{key}</span>
            <input className="input" type="password" placeholder="(unchanged)" value={values[key] ?? ""} onChange={(e) => onChange(keys, { ...values, [key]: e.target.value })} autoComplete="off" />
            <IconButton label="Remove" onClick={() => onChange(keys.filter((x) => x !== key), values)}>
              <Trash2 size={15} />
            </IconButton>
          </div>
        ))}
        <div className="row">
          <input className="input mono" placeholder="NAME" value={k} onChange={(e) => setK(e.target.value)} />
          <Button
            size="sm"
            disabled={!k.trim() || keys.includes(k.trim())}
            onClick={() => {
              onChange([...keys, k.trim()], values);
              setK("");
            }}
          >
            Add
          </Button>
        </div>
      </div>
    </Field>
  );
}

function ServerEditor({ server, onClose }: { server?: McpServer; onClose: () => void }) {
  const [preset, setPreset] = useState<Preset | null>(server ? null : PRESETS[0]);
  const base: McpServer = server ?? {
    id: uid("mcp"),
    name: PRESETS[0].name,
    transport: PRESETS[0].transport,
    command: PRESETS[0].command,
    args: PRESETS[0].args,
    enabled: true,
    createdAt: Date.now(),
  };
  const [draft, setDraft] = useState<McpServer>(base);
  const [argsText, setArgsText] = useState((server ? (base.args ?? []) : withWorkspace(base.args)).join("\n"));
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [headerValues, setHeaderValues] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<null | "running" | { tools: McpTool[] } | { error: string }>(null);

  const applyPreset = (p: Preset) => {
    const args = withWorkspace(p.args);
    setPreset(p);
    setDraft({ ...draft, name: p.name === "Custom server" ? "" : p.name, transport: p.transport, command: p.command, args, url: p.url, envKeys: p.envKeys, headerKeys: p.headerKeys });
    setArgsText(args.join("\n"));
  };

  const build = (): McpServer => ({
    ...draft,
    name: draft.name.trim() || "MCP server",
    args: argsText
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean),
  });

  const persist = async (s: McpServer) => {
    for (const [k, v] of Object.entries(envValues)) if (v) await secrets.set(secretKey(s.id, "env", k), v);
    for (const [k, v] of Object.entries(headerValues)) if (v) await secrets.set(secretKey(s.id, "header", k), v);
    await saveMcpServer(s);
    await disconnectMcp(s.id);
  };

  const valid = draft.transport === "stdio" ? !!draft.command?.trim() : /^https?:\/\//.test(draft.url ?? "");

  return (
    <Modal
      wide
      title={server ? `Edit ${server.name}` : "Add an MCP server"}
      onClose={onClose}
      footer={
        <>
          <Button
            disabled={!valid || testing === "running"}
            onClick={async () => {
              const s = build();
              await persist(s);
              setTesting("running");
              try {
                const c = await getMcpClient(s, useApp.getState().settings.workspace || useApp.getState().defaultWorkspace);
                setTesting({ tools: c.tools });
              } catch (e) {
                setTesting({ error: (e as Error).message });
              }
            }}
          >
            {testing === "running" ? <LoaderCircle size={15} className="spin" /> : null} Test connection
          </Button>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={async () => {
              await persist(build());
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        {!server && (
          <div className="chips">
            {PRESETS.map((p) => (
              <button key={p.name} className={`chip${preset?.name === p.name ? " on" : ""}`} onClick={() => applyPreset(p)}>
                {p.name}
              </button>
            ))}
          </div>
        )}
        {preset && <p className="muted small">{preset.note}</p>}
        <Field label="Name">
          <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="Type">
          <select className="select" value={draft.transport} onChange={(e) => setDraft({ ...draft, transport: e.target.value as McpServer["transport"] })}>
            <option value="stdio" disabled={!capabilities.mcpStdio}>
              Local command (stdio){capabilities.mcpStdio ? "" : ", desktop only"}
            </option>
            <option value="http">Remote URL (Streamable HTTP)</option>
          </select>
        </Field>
        {draft.transport === "stdio" ? (
          <>
            <Field label="Command">
              <input className="input mono" value={draft.command ?? ""} placeholder="npx, uvx, docker, /path/to/server" onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
            </Field>
            <Field label="Arguments (one per line)">
              <textarea className="input mono" rows={4} value={argsText} onChange={(e) => setArgsText(e.target.value)} />
            </Field>
            <KeyValues label="Environment variables" keys={draft.envKeys ?? []} values={envValues} onChange={(envKeys, v) => (setDraft({ ...draft, envKeys }), setEnvValues(v))} />
          </>
        ) : (
          <>
            <Field label="URL">
              <input className="input mono" value={draft.url ?? ""} placeholder="https://example.com/mcp" onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
            </Field>
            <KeyValues label="Headers" keys={draft.headerKeys ?? []} values={headerValues} onChange={(headerKeys, v) => (setDraft({ ...draft, headerKeys }), setHeaderValues(v))} />
          </>
        )}
        <Toggle label="Enabled" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
        {testing && testing !== "running" && (
          <div className={`notice ${"error" in testing ? "notice-error" : "notice-ok"}`}>
            {"error" in testing ? (
              <>
                <CircleAlert size={15} /> {testing.error}
              </>
            ) : (
              <>
                <CircleCheck size={15} /> Connected. {testing.tools.length} tools: {testing.tools.map((t) => t.name).join(", ") || "none"}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function PluginsView() {
  const servers = useApp((s) => s.mcpServers);
  const bots = useApp((s) => s.bots);
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  return (
    <div className="main-pane page">
      <PageHead
        title="Plugins"
        subtitle="Model Context Protocol (MCP) servers add tools to your bots."
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus size={16} /> Add server
          </Button>
        }
      />
      <div className="page-body">
        {!servers.length ? (
          <Empty title="No plugins yet">
            Add an MCP server, then switch it on for a bot in the bot's Plugins tab.
          </Empty>
        ) : (
          <div className="stack">
            {servers.map((s) => {
              const st = mcpStatus.get(s.id);
              const users = bots.filter((b) => b.mcpServerIds.includes(s.id));
              return (
                <div key={s.id} className="card skill-card">
                  <Plug size={20} className="muted" />
                  <div className="list-main">
                    <div className="row">
                      <strong>{s.name}</strong>
                      {!s.enabled && <Pill>Disabled</Pill>}
                      {st?.ok && <Pill tone="success">{st.toolCount} tools</Pill>}
                      {st && !st.ok && <Pill tone="danger">Error</Pill>}
                    </div>
                    <span className="muted small mono">{s.transport === "stdio" ? `${s.command} ${(s.args ?? []).join(" ")}` : s.url}</span>
                    {st?.error && <span className="small bad">{st.error}</span>}
                    <span className="small">{users.length ? `Used by ${users.map((b) => b.name).join(", ")}` : "Not used by any bot yet"}</span>
                  </div>
                  <IconButton label="Edit" onClick={() => setEditing(s)}>
                    <Pencil size={16} />
                  </IconButton>
                  <IconButton
                    label="Delete"
                    onClick={async () => {
                      if (await confirmDialog({ title: `Remove ${s.name}?`, confirmLabel: "Remove", danger: true })) {
                        await disconnectMcp(s.id);
                        await deleteMcpServer(s.id);
                      }
                    }}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editing && <ServerEditor server={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
