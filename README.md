<p align="center"><img src="src/assets/lantern.svg" width="96" alt="Lantern logo"></p>

# Lantern

**Open-source AI bots for open-source LLMs**, on Windows, macOS, Linux, Android and iOS.

**Website:** [exyze.github.io/lantern](https://exyze.github.io/lantern/) · [Download](https://github.com/exYze/lantern/releases/latest)

Lantern lets you create bots with their own personality, instructions, memories, skills, tools and
scheduled routines, and run them on models **you** choose: Ollama, llama.cpp, vLLM, LM Studio,
SGLang, LocalAI, Jan, KoboldCpp, text-generation-webui, or hosted open models (OpenRouter, Together,
Groq, Hugging Face). Everything stays on your devices: no account, no telemetry. Run a
[Lantern Hub](docs/HUB.md) on your own server to share one environment across all of them.

Lantern is a clean-room, open-source take on the "desktop agent bot" idea popularized by Grok Bot.
The proprietary app was studied with [REA](https://github.com/morluto/rea) to learn *what* it does
(see [`docs/REA-ANALYSIS.md`](docs/REA-ANALYSIS.md));
none of its code, assets or branding are used. Lantern is not affiliated with xAI, SpaceX or Anysphere.

## Features

| | |
|---|---|
| 🤖 **Bots** | Name, tagline, instructions, a drawn character avatar (shape, color, eyes, mouth, badge) that a bot can change itself or draw from a description, per-bot model and temperature, sidebar sections like Work and Home |
| 🧩 **Templates** | 53 ready-made bots in 16 categories, from research and code to sales, support, finance and home. Share any bot as a link: the template travels inside the link, so nothing is uploaded, and it never carries secrets, memories or chats |
| 💬 **Chat** | Streaming replies, reasoning ("thinking") display, Markdown, syntax-highlighted code, KaTeX math, Mermaid diagrams, attachments (images, text, PDF, Word, Excel, PowerPoint, iPhone HEIC photos), edit & resend, regenerate, quote a selection (Ctrl+L), `:emoji:` shortcodes, Ctrl+K search over bots, chats, pages and settings. Long chats get a running summary instead of losing their start |
| 📝 **Forms** | A bot asks several questions at once (choices, checkboxes, text, numbers, dates, secrets). Secret answers are saved as the bot's secrets and the model only ever sees their names. One-question forms work in Telegram too |
| ✅ **Plans & goals** | Bots keep a checklist above the chat for work with several steps. Give one a goal and it keeps going until it's done or it needs you |
| 📄 **Pages & files** | Bots write pages you can read, edit and save, make slide decks (.pptx), and share files to the bot's Library. Previews for PDF, Word, Excel, CSV, PowerPoint, HTML, images and HEIC; bots read documents in their workspace |
| 🛠️ **Tools** | Files (read / write / edit / find / grep / delete), terminal (desktop), web search & fetch (optionally through your own Firecrawl, with site maps and crawls), memory, skills, routines, chat-history search |
| 👥 **Subagents** | A bot hands self-contained tasks to helpers that work on their own and report back, several in parallel; isolated ones get a folder (and on the hub, a sandbox) of their own |
| 🤝 **Bots working together** | A bot asks another for help or hands it a whole task; a primary bot coordinates the rest and checks in each morning with work it could take off your plate |
| 🌐 **Browser** | On the hub, each bot has its own headless browser for sites that need clicking or signing in; watch it live and take over from any device |
| ✉️ **Email** | Give a bot its own inbox (IMAP/SMTP): it reads and answers mail, and new mail can start a routine |
| 📲 **Telegram & push** | Talk to your bots from Telegram (text, photos, voice notes, approval buttons); phone notifications through ntfy |
| 🔌 **Plugins (MCP)** | Model Context Protocol servers over stdio (desktop) or Streamable HTTP; secrets for env vars and headers. Sign in to apps like Notion, Linear, Atlassian, Sentry and Zapier with one click (OAuth, through your hub) |
| 🛡️ **Approvals** | *Ask first*, *Auto-review* (an LLM judges each action) or *Auto-approve*, plus allow/deny rules ("Always allow `git status`") for every bot or one, for good, for an hour or until tomorrow. Commands that could wreck the machine (wiping a disk, deleting system folders, piping a download into a shell) always ask |
| 🧠 **Memories** | Bots remember facts you tell them; view and delete them any time |
| 📚 **Skills** | Reusable instruction packs; private per bot or shared; import `SKILL.md` files |
| ⏰ **Routines** | "Every weekday at 8:00, brief me on…": on a schedule, when a webhook is called (GitHub, Home Assistant, a script), or when mail arrives |
| 🔑 **Secrets** | Write-only credentials exposed to terminal commands as env vars, redacted from tool output |
| 🎙️ **Voice memos** | Transcribed by any OpenAI-compatible speech-to-text server (Speaches/faster-whisper, LocalAI…) |
| 🔒 **Private** | Local SQLite database; secrets in the OS keychain on Windows, macOS and iOS |
| 🔄 **Lantern Hub** | Optional self-hosted server: every device shares the same bots, chats, memories, settings and secrets, plus one workspace where bots' files and terminal live. Its runner does the bots' work, so a task keeps going after you close the app and routines run with every app closed ([docs/HUB.md](docs/HUB.md)) |
| 📦 **Sandboxes** | On the hub, a bot can keep its files and commands in its own bubblewrap sandbox, with or without internet access |
| ⬆️ **Updates** | Desktop apps update themselves from your hub (signed installers). Android installs updates in-app, and without a prompt once Lantern has updated itself once |

### Platform support

| Capability | Windows | macOS | Linux | Android | iOS | Browser (dev) |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Chat, memories, skills, routines, web | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| File tools | ✅ | ✅ | ✅ | ✅ (app folder or hub) | ✅ (app folder or hub) | via hub |
| Terminal | ✅ | ✅ | ✅ | via hub | via hub | via hub |
| Local (stdio) MCP | ✅ | ✅ | ✅ | no | no | no |
| Sync through a Lantern Hub | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Auto-updates from the hub | ✅ | ✅ | ✅ | ✅ (Android 12+, after the first) | no | no |
| HTTP MCP servers | ✅ | ✅ | ✅ | ✅ | ✅ | CORS-limited |
| Secrets storage | Credential Manager | Keychain | app DB | app DB | Keychain | localStorage |

## Quick start

1. **Run a model server.** The easiest: install [Ollama](https://ollama.com), then
   `ollama pull qwen3` (or `llama3.2`, `gemma3`, `mistral`…).
2. **Install Lantern** from the [latest release](https://github.com/exYze/lantern/releases/latest)
   (Windows, macOS, Linux and Android; or build it yourself, below) and open it.
3. In onboarding, pick **Ollama**, press **Connect & list models**, then create your first bot.

On a phone, `localhost` is the phone itself. Point Lantern at your computer's LAN address
(e.g. `http://192.168.1.20:11434/v1`) and make the server listen on the network
(`OLLAMA_HOST=0.0.0.0`).

### Tool calling

Bots use tools through the OpenAI `tools` API. Most servers support it; some need a flag:

| Server | Flag |
|---|---|
| llama.cpp | `llama-server --jinja` |
| vLLM | `--enable-auto-tool-choice --tool-call-parser <parser>` |
| SGLang | `--tool-call-parser <parser>` |

If a model rejects tools, Lantern notices and keeps chatting without them (Settings → Models →
*Retry tools* re-enables them).

## Building

Prerequisites: [Node.js 22+](https://nodejs.org), [Rust](https://rustup.rs) and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run tauri dev          # desktop app with hot reload
npm run tauri build        # installers in src-tauri/target/release/bundle/
npm run dev                # UI only, in a browser (no file/terminal tools)
npm test                   # unit tests
```

### Linux packages from any OS (Docker)

```bash
docker build -t lantern-linux -f scripts/linux.Dockerfile scripts
docker run --rm -v "$PWD:/src:ro" -v "$PWD/dist-linux:/out" lantern-linux   # → deb, rpm, AppImage
```

### Android

Needs the Android SDK, NDK (r27+) and JDK 17+, with `ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME` set.

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm run tauri android build -- --apk      # or: npm run tauri android dev
```

### macOS and iOS (on a Mac)

One command builds the universal macOS app (`.app` + `.dmg`) and an iOS Simulator build:

```bash
./scripts/build-mac.sh            # add --skip-ios for macOS only
```

Or step by step:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

### iOS details

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
npm run tauri ios init
npm run tauri ios dev                     # simulator
npm run tauri ios build                   # needs an Apple development team for signing
```

### CI

`.github/workflows/build.yml` tests the code and builds Windows (MSI + NSIS), macOS (universal DMG),
Linux (deb, rpm, AppImage), Android (APK + AAB) and iOS (simulator build; signed IPA when an
`APPLE_DEVELOPMENT_TEAM` secret is set) on every push.

### Lantern Hub

`hub/` is the self-hosted sync and workspace server (Rust, single binary). See [docs/HUB.md](docs/HUB.md)
for setup (the [releases](https://github.com/exYze/lantern/releases) include the hub for x86_64 and ARM)
and `scripts/release.mjs` for building, signing and publishing app releases to it and to GitHub.

### Testing without a model

`npm run mock-llm` starts a tiny OpenAI-compatible server on `http://localhost:11500/v1` with two
models: `mock-tools` (streams reasoning, Markdown and tool calls) and `mock-chat` (rejects tools, to
exercise the fallback).

## Architecture

```
src/                     React + TypeScript UI (shared by all platforms)
  lib/agent.ts           agent loop: stream → tool calls → approvals → results → repeat
  lib/llm.ts             OpenAI-compatible client (SSE, tool-call assembly, <think> splitting)
  lib/approval.ts        approval engine (modes, rules, shell parser, read-only and catastrophic
                         command checks, auto-review)
  lib/forms.ts           forms in the chat (ask_user)
  lib/planning.ts        plans, goals and long-chat summaries
  lib/pages.ts           pages, shared files, slide decks, reading documents
  lib/documents.ts       PDF, Word, Excel, PowerPoint, CSV and HEIC readers
  lib/oauth.ts           sign-in to MCP apps (discovery, dynamic registration, PKCE, refresh)
  lib/share.ts           bot templates as links
  lib/mcp.ts             MCP client (stdio + Streamable HTTP)
  lib/tools.ts           built-in tools
  lib/routines.ts        scheduler
  lib/platform.ts        native bridge with a browser fallback
src-tauri/               Rust backend (Tauri 2)
  src/http.rs            streaming HTTP from Rust (no CORS / mobile cleartext limits)
  src/db.rs              SQLite document store
  src/secrets.rs         OS keychain with app-DB fallback
  src/fs_tools.rs        file tools (sandboxed to the workspace on mobile)
  src/shell.rs           terminal commands with timeout and process-tree kill (desktop)
  src/mcp_stdio.rs       launches local MCP servers (desktop)
  src/updates.rs         signed auto-updates from the hub (desktop)
crates/lantern-tools/    file and shell tools shared by the app and the hub
hub/                     Lantern Hub: sync API, shared workspace, downloads and update manifest
src/lib/sync.ts          local-first sync with the hub (outbox, live events, merge)
src/lib/hub.ts           hub pairing, API and remote tools
src/lib/subagents.ts     subagents (delegate_task): parallel helpers, isolated folders and sandboxes
src/lib/team.ts          bots asking bots (ask_bot), hand-offs
src/lib/remote.ts        handing chats to the hub's runner; live replies
src/lib/browser.ts       the browser tool (DevTools commands to the hub's headless Chrome)
src/runner/              the runner: the same bot code, headless on the hub (Node), plus Telegram,
                         ntfy pushes and email triggers
hub/src/browser.rs       one headless Chrome per bot, over a private DevTools pipe
hub/src/mail.rs          bots' inboxes (IMAP/SMTP over verified TLS)
hub/src/hooks.rs         webhooks that start routines (key + optional signatures)
```

## Design

The look and the rules behind it are in [docs/DESIGN.md](docs/DESIGN.md). The website lives in `site/` and deploys to GitHub Pages from `main`.

## License

[MIT](LICENSE)
