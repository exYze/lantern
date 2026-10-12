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

export interface BotToolToggles {
  files: boolean;
  shell: boolean;
  web: boolean;
  memory: boolean;
  routines: boolean;
  skills: boolean;
  conversationSearch: boolean;
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
  createdAt: number;
  updatedAt: number;
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
  enabled: boolean;
  createdAt: number;
}

export type Schedule =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "interval"; minutes: number }
  | { kind: "once"; at: number };

export interface Routine {
  id: ID;
  botId: ID;
  name: string;
  prompt: string;
  schedule: Schedule;
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
  onboarded: boolean;
}

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
};
