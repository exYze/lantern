import { CircleAlert, CircleCheck, KeyRound, LoaderCircle, LogIn, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, confirmDialog, Field, IconButton, Modal, Pill, Toggle } from "../components/ui";
import { disconnectMcp, getMcpClient, mcpStatus, secretKey, type McpTool } from "../lib/mcp";
import { isSignedIn, redirectUri, signIn, signOut } from "../lib/oauth";
import { capabilities, secrets } from "../lib/platform";
import { deleteMcpServer, saveMcpServer, toast, useApp } from "../lib/store";
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

/** Hosted MCP servers you sign in to with one click (they register Lantern themselves). */
export const APPS: { name: string; url: string; what: string; needsClient?: boolean }[] = [
  { name: "Notion", url: "https://mcp.notion.com/mcp", what: "Search, read and write pages and databases" },
  { name: "Linear", url: "https://mcp.linear.app/mcp", what: "Issues, projects and comments" },
  { name: "Atlassian", url: "https://mcp.atlassian.com/v1/mcp", what: "Jira issues and Confluence pages" },
  { name: "Zapier", url: "https://mcp.zapier.com/api/mcp/mcp", what: "Gmail, Google Calendar, Sheets and thousands more, through the actions you pick in Zapier" },
  { name: "Sentry", url: "https://mcp.sentry.dev/mcp", what: "Errors, issues and releases" },
  { name: "Figma", url: "https://mcp.figma.com/mcp", what: "Designs, components and comments" },
  { name: "Canva", url: "https://mcp.canva.com/mcp", what: "Find and make designs" },
  { name: "Airtable", url: "https://mcp.airtable.com/mcp", what: "Bases, tables and records" },
  { name: "Todoist", url: "https://ai.todoist.net/mcp", what: "Tasks and projects" },
  { name: "monday.com", url: "https://mcp.monday.com/mcp", what: "Boards, items and updates" },
  { name: "Intercom", url: "https://mcp.intercom.com/mcp", what: "Conversations and contacts" },
  { name: "Webflow", url: "https://mcp.webflow.com/mcp", what: "Sites, pages and CMS items" },
  { name: "Vercel", url: "https://mcp.vercel.com", what: "Projects, deployments and logs" },
  { name: "Supabase", url: "https://mcp.supabase.com/mcp", what: "Projects, databases and functions" },
  { name: "Neon", url: "https://mcp.neon.tech/mcp", what: "Postgres projects and queries" },
  { name: "Cloudflare", url: "https://observability.mcp.cloudflare.com/mcp", what: "Workers logs and analytics" },
  { name: "Hugging Face", url: "https://huggingface.co/mcp", what: "Models, datasets and Spaces" },
  { name: "Stripe", url: "https://mcp.stripe.com", what: "Customers, payments and invoices" },
  { name: "PayPal", url: "https://mcp.paypal.com/mcp", what: "Invoices, orders and transactions" },
  { name: "Square", url: "https://mcp.squareup.com/mcp", what: "Payments, orders and items" },
  { name: "GitHub", url: "https://api.githubcopilot.com/mcp/", what: "Repositories, issues and pull requests (needs a GitHub OAuth app of your own)", needsClient: true },
];

/** Signs in to a server, with a Cancel for when you change your mind in the browser. */
function useSignIn() {
  const [busy, setBusy] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const run = async (server: McpServer, client?: { clientId?: string; clientSecret?: string }): Promise<McpServer | null> => {
    abort.current = new AbortController();
    setBusy(server.id);
    try {
      const signed = await signIn(server, { ...client, signal: abort.current.signal });
      await saveMcpServer(signed);
      await disconnectMcp(signed.id);
      const c = await getMcpClient(signed, useApp.getState().settings.workspace || useApp.getState().defaultWorkspace);
      toast(`Signed in to ${signed.name}: ${c.tools.length} tools. Switch it on for a bot in the bot's Plugins tab.`, "success");
      return signed;
    } catch (e) {
      if (!abort.current?.signal.aborted) toast((e as Error).message, "error");
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run, cancel: () => abort.current?.abort() };
}

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
  const [clientId, setClientId] = useState(server?.oauth?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const signing = useSignIn();
  useEffect(() => {
    void isSignedIn(draft).then(setSignedIn);
  }, [draft]);

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
            <Field
              label="Sign in"
              hint={
                <>
                  For servers that use OAuth sign-in. Most register Lantern by themselves; for one that doesn't (like GitHub), create an OAuth app there with the redirect URL{" "}
                  <code>{(() => {
                    try {
                      return redirectUri();
                    } catch {
                      return "<your hub>/oauth/callback";
                    }
                  })()}</code>{" "}
                  and enter its client ID.
                </>
              }
            >
              <div className="stack-sm">
                <div className="row wrap">
                  <input className="input mono" placeholder="Client ID (only if needed)" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                  <input className="input" type="password" autoComplete="off" placeholder="Client secret (if it has one)" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
                </div>
                <div className="row wrap">
                  <Button
                    disabled={!valid || !!signing.busy}
                    onClick={async () => {
                      const s = build();
                      await persist(s);
                      const signed = await signing.run(s, { clientId: clientId.trim() || undefined, clientSecret: clientSecret || undefined });
                      if (signed) {
                        setDraft(signed);
                        setSignedIn(true);
                      }
                    }}
                  >
                    {signing.busy ? <LoaderCircle size={15} className="spin" /> : <LogIn size={15} />} {signing.busy ? "Finish signing in in your browser…" : signedIn ? "Sign in again" : "Sign in"}
                  </Button>
                  {signing.busy && (
                    <Button variant="ghost" onClick={signing.cancel}>
                      Cancel
                    </Button>
                  )}
                  {signedIn && !signing.busy && (
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        await signOut(draft);
                        await disconnectMcp(draft.id);
                        setSignedIn(false);
                      }}
                    >
                      Sign out
                    </Button>
                  )}
                  {signedIn && <Pill tone="success">Signed in</Pill>}
                </div>
              </div>
            </Field>
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

/** The one-click catalog: hosted apps you sign in to. */
function ConnectApps({ onCustom }: { onCustom: (s: McpServer) => void }) {
  const servers = useApp((s) => s.mcpServers);
  const hub = useApp((s) => s.hub);
  const signing = useSignIn();
  return (
    <section className="connect-apps">
      <h2>Connect an app</h2>
      <p className="muted small">
        Sign in once and your bots can use the app's tools{hub ? ", on every device and on your hub" : ""}. You sign in on the app's own page; Lantern never sees your password.
        {!hub && " Signing in needs a Lantern Hub (Settings → Hub), because the app sends you back to it."}
      </p>
      <ul className="list">
        {APPS.map((app) => {
          const existing = servers.find((s) => s.url === app.url);
          return (
            <li key={app.url}>
              <div className="list-main">
                <strong>{app.name}</strong>
                <span className="muted small">{app.what}</span>
              </div>
              {existing?.oauth ? (
                <Pill tone="success">Connected</Pill>
              ) : signing.busy === existing?.id || (signing.busy && !existing && signing.busy === `app:${app.url}`) ? (
                <Button size="sm" variant="ghost" onClick={signing.cancel}>
                  <LoaderCircle size={14} className="spin" /> Cancel
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={!hub || !!signing.busy}
                  onClick={async () => {
                    const server: McpServer = existing ?? { id: uid("mcp"), name: app.name, transport: "http", url: app.url, enabled: true, createdAt: Date.now() };
                    if (!existing) await saveMcpServer(server);
                    if (app.needsClient) return onCustom(server);
                    await signing.run(server);
                  }}
                >
                  <LogIn size={14} /> Connect
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
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
          <p className="muted">No servers yet. Connect an app below, or add any MCP server with Add server. Then switch it on for a bot in the bot's Plugins tab.</p>
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
                      {s.oauth && (
                        <Pill>
                          <KeyRound size={11} /> Signed in
                        </Pill>
                      )}
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
        <ConnectApps onCustom={(s) => setEditing(s)} />
      </div>
      {editing && <ServerEditor server={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
