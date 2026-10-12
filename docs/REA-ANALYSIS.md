# Grok Bot 0.70.2 — REA analysis and clean-room spec

This document records what was learned about `Grok_Bot_0.70.2_Setup.exe` with
[REA](https://github.com/morluto/rea) and turns it into a **feature spec** for
Lantern. Lantern is an independent, clean-room implementation: no code, fonts,
sounds, icons, templates or other assets from Grok Bot are copied, and the
"Grok" name is not used. Only observed *behavior and structure* informed the design.

## How the binary was analyzed

| Step | Tool | Result |
|---|---|---|
| 1 | `rea inspect-artifact Grok_Bot_0.70.2_Setup.exe` | PE, sha256 `0194521743ff…10ced8`, no container entries visible to REA; next probes: managed/native inspection |
| 2 | manifest strings | Nullsoft Install System v3.04 (electron-builder NSIS stub) |
| 3 | 7z signature scan | one embedded `app-64.7z` at offset 507719 (117 MB, stored) |
| 4 | carve + `7za x` | Electron app: `Grok Bot.exe`, `resources/app.asar` (42 MB), `app.asar.unpacked` (native addons) |
| 5 | `rea analyze-javascript-application app.asar` | 616 files, 600 JS sources parsed, 7.07 M AST nodes, 0 parse failures; 2 837 graph nodes, 25 379 semantic nodes |
| 6 | `rea trace-application-feature` (seed `channel:sand:coordinator-port`) | renderer ↔ agent-coordinator MessagePort boundary |
| 7 | Lingui catalog dump | 3 471 English UI strings used to inventory features |

## Architecture (as shipped)

```
Grok Bot.exe (Electron; REA found 4 BrowserWindow definitions)
├── electron-main/main.cjs → main-core.cjs, main-app.cjs, proto.cjs
│     window mgmt, deep links, boot snapshot, notifications, 1Password bridge
├── electron-preload/preload.cjs
│     contextBridge APIs: desktop, desktopMount, coordinatorPort, sandRenderTrace
├── node-agent-coordinator/main.cjs   ← agent loop runs here (separate Node process)
│     renderer talks to it over a MessagePort ("sand:coordinator-port")
├── local-exec-daemon/main.cjs        ← tool execution on the user's machine
├── renderer/ (React, Vite chunks: chat, agents, settings, plugins, routines…)
└── native addons: tree-sitter + tree-sitter-bash (shell command parsing for
    approval rules), cursor-proclist (process list), sand-notification-settings
```

* Package name `sand`, author "SpaceXAI", built on Anysphere's agent stack
  (`@anysphere/agent`, `agent-exec`, `local-exec`, `shell-exec`, `mcp-core`,
  `model-selection`, `chat-inference`, `voice-call-harness`, …).
* Model access is **proprietary**: Connect-RPC/protobuf to the vendor backend.
  Lantern replaces this with user-configured, OpenAI-compatible endpoints.

### Agent tool surface (from local-exec protobuf descriptors)

| Tool | Arguments (observed) |
|---|---|
| Shell | `command, working_directory, timeout`, background shells, write stdin, force-background |
| Read | `path, offset, limit, encoding_hint` |
| Write | `path, file_text` |
| Edit | `path, edits[]` (search/replace) |
| Ls | `path, ignore[]` |
| Find | `pattern, path, limit` (glob) |
| Grep | `pattern, path, glob, ignore_case, literal, context, limit` |
| Delete | `path` |
| Fetch | `url` |
| ComputerUse | `actions[]`, screenshots |
| RecordScreen | `mode` |
| MCP | list/read resources, call tools, allowlist precheck |
| ConversationSearch | `query, limit` |
| Subagents | spawn / await |

Approval pipeline: `ShellAllowlistPrecheck` (tree-sitter-bash parse +
classifier), `WebFetchAllowlistPrecheck`, `McpAllowlistPrecheck`, and a
`SmartModeClassifier` ("Auto-review": an LLM judges whether a tool call is safe).

## Feature inventory (from UI strings)

| Area | What the original does | Lantern |
|---|---|---|
| **Bots** | Named agents with profile, character avatar (shape + color), instructions | ✅ |
| **Bot templates** | Gallery of ready-made job bots with one-line descriptions | ✅ (original templates) |
| **Chat** | Streaming replies, markdown, code, KaTeX math, Mermaid diagrams, file viewer, drafts | ✅ |
| **Model choice** | "Choose which AI model Grok Bot thinks with" (vendor models only) | ✅ any OpenAI-compatible open model |
| **Approval modes** | Approve tool call / terminal command / computer action; Auto-review; per-rule auto-approve | ✅ Ask / Auto-review / Auto-approve + rules |
| **Local tools** | Shell, files, fetch on the user's computer | ✅ desktop (sandboxed workspace on mobile) |
| **Skills** | Named instruction packs with "when to use" description, private per bot or library | ✅ |
| **Memories** | Per-bot memories, add / delete | ✅ |
| **Secrets** | Write-only secrets exposed to shell as env vars | ✅ OS keychain where available |
| **Plugins / MCP** | Custom MCP servers, connectors with OAuth | ✅ MCP stdio (desktop) + HTTP |
| **Routines** | Recurring tasks: every day at, weekdays, weekly on, time zone | ✅ |
| **Voice** | Voice memos, voice chat | ✅ voice memo → user-specified Whisper endpoint |
| **Attachments** | Attach files, images | ✅ text + images (vision models) |
| **Settings** | Theme (system/light/dark), language, notifications + sound | ✅ |
| Team bots, service accounts, Slack/Teams/iMessage channels | vendor cloud | ✗ out of scope |
| Cloud "computer" VM, Chrome-cookie import, VNC | vendor cloud | ✗ out of scope |
| Purchases, virtual cards, passkeys, 1Password | vendor commerce | ✗ out of scope |
| Telemetry (Sentry, analytics) | vendor | ✗ intentionally omitted |
