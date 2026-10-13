export type ID = string;

export interface Provider {
  id: ID;
  name: string;
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  /** True when an API key is stored in the secret store under `provider:<id>`. */
  hasKey: boolean;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Models discovered from /models or typed in by the user. */
  models: string[];
  /** Models that rejected the `tools` parameter; the app falls back to plain chat for them. */
  noToolModels?: string[];
  presetId?: string;
  createdAt: number;
}

export interface ModelRef {
  providerId: ID;
  model: string;
}

export type AvatarShape = "circle" | "squircle" | "hexagon" | "flower" | "diamond" | "shield";
export type AvatarEyes = "dots" | "happy" | "wink" | "wide" | "sleepy" | "visor";
export type AvatarMouth = "smile" | "grin" | "flat" | "open" | "tongue" | "none";

export interface AvatarSpec {
  shape: AvatarShape;
  color: string;
  eyes: AvatarEyes;
  mouth: AvatarMouth;
  /** Optional emoji worn as an accessory in the top-right corner. */
  badge?: string;
}

export type ApprovalMode = "ask" | "auto-review" | "auto";

/** Where a bot's file and terminal tools run when a Lantern Hub is connected. */
export type Computer = "hub" | "device";

export interface BotToolToggles {
  files: boolean;
  shell: boolean;
  web: boolean;
  memory: boolean;
  routines: boolean;
  skills: boolean;
  conversationSearch: boolean;
  /** Hand tasks to subagents (missing on bots created before 0.3: on). */
  subagents?: boolean;
  /** Ask the user's other bots for help, or hand work to them (0.5). */
  bots?: boolean;
  /** Drive a web browser on the hub (0.5). */
  browser?: boolean;
  /** Read and send mail from the bot's own inbox, when it has one (0.5). */
  email?: boolean;
  /** Ask the user with forms in the chat (0.6). */
  forms?: boolean;
  /** Keep a plan and pursue a goal until it's done (0.6). */
  planning?: boolean;
  /** Write pages, share files, make slide decks and read documents (0.6). */
  pages?: boolean;
  /** Change its own name, tagline and avatar (0.6). */
  profile?: boolean;
}

/** A mailbox of the bot's own. The password lives in the secret store under `email:<botId>`. */
export interface BotEmail {
  address: string;
  username: string;
  imapHost: string;
  imapPort: number;
  /** IMAP is TLS unless the server is on the hub itself (a local bridge), where "none" is allowed. */
  imapSecurity?: "tls" | "none";
  smtpHost: string;
  smtpPort: number;
  /** "tls" connects with TLS; "starttls" upgrades a plain connection (SMTP on 587); "none" only on the hub itself. */
  smtpSecurity: "tls" | "starttls" | "none";
}

/** Runs a bot's files and commands in its own sandbox folder on the hub. */
export interface BotSandbox {
  /** Commands in the sandbox may use the network. */
  network: boolean;
}

export interface Bot {
  id: ID;
  name: string;
  tagline: string;
  instructions: string;
  avatar: AvatarSpec;
  /** Falls back to the default model in Settings when unset. */
  model?: ModelRef;
  temperature?: number;
  tools: BotToolToggles;
  /** Library skills this bot may use (private skills are linked by Skill.botId). */
  skillIds: ID[];
  mcpServerIds: ID[];
  /** Names of write-only secrets, exposed to shell commands as environment variables. */
  secretNames: string[];
  /** Overrides the global approval mode for this bot. */
  approvalMode?: ApprovalMode;
  /** Overrides the global workspace folder (desktop). */
  workspace?: string;
  /** Where file and terminal tools run: the shared Lantern Hub or this device. Unset follows Settings. */
  computer?: Computer;
  /** On the hub: keep this bot's files and commands in its own sandbox (bubblewrap). */
  sandbox?: BotSandbox;
  /** Its own email inbox. */
  email?: BotEmail;
  templateId?: string;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: ID;
  botId: ID;
  title: string;
  routineId?: ID;
  /** Started by another bot (ask_bot): who asked, and from which chat. */
  from?: { botId: ID; conversationId: ID };
  /** Where the chat happens besides the app (a Telegram chat id). */
  channel?: { kind: "telegram"; chatId: number };
  /** The bot's checklist for the work in this chat. */
  plan?: { items: PlanItem[]; updatedAt: number };
  /** What the bot keeps working toward until it's done. */
  goal?: { objective: string; status: "active" | "done" | "blocked" | "stopped"; note?: string; setAt: number };
  /** The older part of a long chat, summarized; `through` is the last message it covers. */
  summary?: { text: string; through: ID; at: number };
  createdAt: number;
  updatedAt: number;
}

/** A Markdown document a bot wrote; the user can edit it. */
export interface Page {
  id: ID;
  botId: ID;
  conversationId?: ID;
  title: string;
  content: string;
  /** The user changed it since the bot last wrote it. */
  editedByUser?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SlideOutline {
  title: string;
  subtitle?: string;
  slides: { title: string; bullets: string[]; notes?: string }[];
  theme: "light" | "dark";
}

/** A file a bot shared from its workspace. */
export interface SharedFile {
  id: ID;
  botId: ID;
  conversationId?: ID;
  name: string;
  /** As the bot gave it, relative to `root` (the workspace it was working in). */
  path: string;
  root: string;
  confine?: boolean;
  /** On the hub's workspace, or on one device. */
  where: "hub" | "device";
  deviceId?: string;
  deviceName?: string;
  size?: number;
  kind: "file" | "slides";
  slides?: SlideOutline;
  createdAt: number;
}

export interface PlanItem {
  text: string;
  status: "todo" | "doing" | "done" | "skipped";
}

/** A device asking the hub's runner to do something. Synced; the runner deletes it once handled. */
export interface RunnerRequest {
  id: ID;
  kind: "run" | "stop" | "approve" | "answer" | "routine";
  conversationId?: ID;
  toolCallId?: string;
  answer?: "allow" | "always" | "always-bot" | "hour" | "today" | "deny";
  /** kind "answer": what the user filled in on a form (secrets are saved separately, never here). */
  answers?: Record<string, FormValue>;
  routineId?: ID;
  deviceId?: string;
  at: number;
}

/** A bot run in progress on the hub's runner. Written only by the runner; id = conversation id. */
export interface RunDoc {
  id: ID;
  conversationId: ID;
  botId: ID;
  startedAt: number;
}

/** Something that starts a routine: a webhook call or an email. Written by the hub or the runner. */
export interface TriggerEvent {
  id: ID;
  routineId: ID;
  source: "webhook" | "email";
  receivedAt: number;
  /** Webhooks: the request's interesting headers, query string and body. */
  headers?: Record<string, string>;
  query?: string;
  body?: string;
  /** Email: who sent it, the subject and the text. */
  email?: { uid: number; from: string; subject: string; date?: string; text: string };
}

/** What the hub says about its runner, the always-on service that runs bots there. */
export interface RunnerStatus {
  online: boolean;
  version?: string;
  lastSeen?: number;
}

export interface Attachment {
  id: ID;
  name: string;
  mime: string;
  size: number;
  /** Text files: the contents. Images: a data: URL. */
  data: string;
  kind: "text" | "image";
}

export type ToolCallStatus =
  | "pending"
  | "awaiting-approval"
  | "awaiting-input"
  | "reviewing"
  | "running"
  | "done"
  | "denied"
  | "error";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as produced by the model. */
  arguments: string;
  status: ToolCallStatus;
  result?: string;
  /** How the call was approved, for the UI. */
  approval?: "rule" | "auto" | "auto-review" | "user" | "read-only";
  review?: { verdict: "allow" | "ask"; reason: string };
  startedAt?: number;
  finishedAt?: number;
  /** delegate_task: what the subagent is doing / did. */
  subagent?: SubagentRun;
  /** ask_bot: the bot that was asked and the chat it works in. */
  asked?: { botId: ID; conversationId: ID };
  /** Why this action always asks first (a command that could wreck the machine). */
  warning?: string;
  /** write_page: the page it wrote. */
  page?: { id: ID; title: string };
  /** share_file, make_slides: the file it shared. */
  file?: { id: ID; name: string };
  /** ask_user: the form the bot wants filled in, and what the user answered. */
  form?: ChatForm;
}

export interface FormQuestion {
  id: string;
  label: string;
  kind: "choice" | "multi" | "text" | "long-text" | "number" | "date" | "secret";
  options?: string[];
  placeholder?: string;
  required?: boolean;
  /** secret: the name it's saved under (as a bot secret). */
  saveAs?: string;
}

/** A form answer: text, a list of choices, or for secret questions the name of the saved secret. */
export type FormValue = string | string[] | { secret: string };

export interface ChatForm {
  title: string;
  questions: FormQuestion[];
  answers?: Record<string, FormValue>;
  answeredAt?: number;
}

export interface SubagentStep {
  id: string;
  content: string;
  toolCalls?: ToolCall[];
  status: "streaming" | "done" | "error";
}

export interface SubagentRun {
  title: string;
  model: string;
  /** Works in its own folder instead of the parent bot's workspace. */
  isolated: boolean;
  /** Its commands run in a sandbox on the hub. */
  sandboxed: boolean;
  network: boolean;
  folder: string;
  steps: SubagentStep[];
}

export interface ChatMessage {
  id: ID;
  conversationId: ID;
  role: "user" | "assistant" | "tool";
  content: string;
  /** Model "thinking" (reasoning_content or <think> blocks). */
  reasoning?: string;
  attachments?: Attachment[];
  toolCalls?: ToolCall[];
  /** For role=tool: the call this result answers. */
  toolCallId?: string;
  toolName?: string;
  /** role=user written by another bot (ask_bot) rather than the user. */
  fromBotId?: ID;
  /** role=user that arrived from outside the app. */
  via?: "telegram" | "webhook" | "email" | "goal";
  status?: "streaming" | "done" | "error" | "stopped";
  error?: string;
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  /** Marks messages produced by a routine run. */
  routineId?: ID;
  createdAt: number;
}

export interface Skill {
  id: ID;
  name: string;
  /** When the bot should use this skill. */
  description: string;
  content: string;
  /** Private to one bot when set; otherwise part of the shared library. */
  botId?: ID;
  createdAt: number;
  updatedAt: number;
}

export interface Memory {
  id: ID;
  botId: ID;
  content: string;
  createdAt: number;
}

export interface McpServer {
  id: ID;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  /** Environment variable names; values live in the secret store (write-only). */
  envKeys?: string[];
  url?: string;
  /** HTTP header names (e.g. Authorization); values live in the secret store. */
  headerKeys?: string[];
  /** Signed in with OAuth: where and as which client. Tokens live in the secret store. */
  oauth?: OAuthClient;
  enabled: boolean;
  createdAt: number;
}

export interface OAuthClient {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  clientId: string;
  /** A client secret is saved as `mcp:<id>:oauth-client`. */
  hasClientSecret?: boolean;
  scopes?: string;
  resource?: string;
}

export type Schedule =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "interval"; minutes: number }
  | { kind: "once"; at: number };

/** What starts a routine. Routines from before 0.5 have no trigger and run on their schedule. */
export type RoutineTrigger =
  | { kind: "schedule" }
  /** A POST to the hub's /hooks/<routine id>/<key>. A signing secret, if any, is the secret `routine:<id>:signing`. */
  | { kind: "webhook"; key: string }
  /** New mail in the bot's inbox; `lastUid` is the newest message already handled. */
  | { kind: "email"; lastUid?: number };

export interface Routine {
  id: ID;
  botId: ID;
  name: string;
  prompt: string;
  /** Used when the trigger is a schedule (or missing). */
  schedule: Schedule;
  trigger?: RoutineTrigger;
  /** Don't notify when the bot answers just "Nothing new" (check-ins). */
  quiet?: boolean;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus?: "ok" | "error" | "needs-approval";
  conversationId?: ID;
  createdAt: number;
}

export interface ApprovalRule {
  id: ID;
  /** Tool name, e.g. "shell", "write_file" or "mcp:github:create_issue". */
  tool: string;
  /** For shell: a command prefix like "git status". Empty means any call of the tool. */
  pattern: string;
  decision: "allow" | "deny";
  /** Only for this bot; unset means every bot. */
  botId?: ID;
  /** The rule stops applying after this time. */
  expiresAt?: number;
  createdAt: number;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  defaultModel?: ModelRef;
  /** Model used for Auto-review; falls back to the bot's model. */
  reviewModel?: ModelRef;
  approvalMode: ApprovalMode;
  approvalRules: ApprovalRule[];
  workspace?: string;
  notifications: boolean;
  sound: boolean;
  /** Approximate context budget in tokens used when trimming history. */
  contextTokens: number;
  maxSteps: number;
  search: { kind: "duckduckgo" | "searxng"; url?: string };
  stt?: { providerId?: ID; baseUrl: string; model: string };
  timezone?: string;
  /** Where bots' file and terminal tools run while a hub is connected (default: the hub). */
  computer?: Computer;
  /** This device only: install app updates automatically (default on). */
  autoUpdate?: boolean;
  /** Where bots work while the hub's runner is online: on the hub (default) or on the device you chat from. */
  runOn?: "hub" | "device";
  /** The bot that coordinates the others and checks in. */
  primaryBotId?: ID;
  /** A self-hosted Firecrawl server for search and reading pages. */
  firecrawl?: { url: string; search: boolean; read: boolean };
  /** Phone notifications through an ntfy server. An access token, if any, is the secret `push:ntfy`. */
  push?: { server: string; topic: string; hideText?: boolean };
  /** Chat with bots from Telegram. The bot token is the secret `telegram:token`. */
  telegram?: TelegramSettings;
  /** Groups of bots in the sidebar, in order. Bots in none are listed after them. */
  sidebarSections?: SidebarSection[];
  onboarded: boolean;
}

export interface SidebarSection {
  id: ID;
  name: string;
  botIds: ID[];
  collapsed?: boolean;
}

export interface TelegramSettings {
  enabled: boolean;
  /** The Telegram bot's @username, filled in by the runner. */
  username?: string;
  /** The Lantern bot that answers new Telegram chats. */
  botId?: ID;
  /** Send `/link <code>` from Telegram to connect a chat. */
  linkCode?: string;
  /** Telegram chats allowed to talk to your bots. */
  chats: { id: number; name: string; botId?: ID; conversationId?: ID }[];
}

/** Settings that belong to one device and never sync through the hub. */
export const DEVICE_SETTINGS = ["workspace", "onboarded", "autoUpdate"] as const;

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  approvalMode: "ask",
  approvalRules: [],
  notifications: true,
  sound: true,
  contextTokens: 16000,
  maxSteps: 24,
  search: { kind: "duckduckgo" },
  onboarded: false,
};

export const DEFAULT_TOOLS: BotToolToggles = {
  files: true,
  shell: true,
  web: true,
  memory: true,
  routines: true,
  skills: true,
  conversationSearch: true,
  subagents: true,
  bots: true,
  browser: true,
  email: true,
  forms: true,
  planning: true,
  pages: true,
  profile: true,
};
