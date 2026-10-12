<p align="center"><img src="src/assets/lantern.svg" width="96" alt="Lantern logo"></p>

# Lantern

**Open-source AI bots for open-source LLMs** — on Windows, macOS, Linux, Android and iOS.

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
| 🤖 **Bots** | Name, tagline, instructions, a generated character avatar (shape, color, eyes, mouth, badge), per-bot model and temperature |
| 🧩 **Templates** | 12 ready-made bots: research scout, code pilot, morning brief, writing partner, data wrangler, sysadmin sidekick, study coach, planner… |
| 💬 **Chat** | Streaming replies, reasoning ("thinking") display, Markdown, syntax-highlighted code, KaTeX math, Mermaid diagrams, image + text attachments, edit & resend, regenerate |
| 🛠️ **Tools** | Files (read / write / edit / find / grep / delete), terminal (desktop), web search & fetch, memory, skills, routines, chat-history search |
| 👥 **Subagents** | A bot hands self-contained tasks to helpers that work on their own and report back, several in parallel; isolated ones get a folder (and on the hub, a sandbox) of their own |
| 🔌 **Plugins (MCP)** | Model Context Protocol servers over stdio (desktop) or Streamable HTTP; secrets for env vars and headers |
| 🛡️ **Approvals** | *Ask first*, *Auto-review* (an LLM judges each action) or *Auto-approve*, plus allow/deny rules ("Always allow `git status`") |
| 🧠 **Memories** | Bots remember facts you tell them; view and delete them any time |
| 📚 **Skills** | Reusable instruction packs; private per bot or shared; import `SKILL.md` files |
| ⏰ **Routines** | "Every weekday at 8:00, brief me on…" — daily, weekdays, weekly, interval or one-off |
| 🔑 **Secrets** | Write-only credentials exposed to terminal commands as env vars, redacted from tool output |
| 🎙️ **Voice memos** | Transcribed by any OpenAI-compatible speech-to-text server (Speaches/faster-whisper, LocalAI…) |
| 🔒 **Private** | Local SQLite database; secrets in the OS keychain on Windows, macOS and iOS |
| 🔄 **Lantern Hub** | Optional self-hosted server: every device shares the same bots, chats, memories, settings and secrets, plus one workspace where bots' files and terminal live ([docs/HUB.md](docs/HUB.md)) |
| 📦 **Sandboxes** | On the hub, a bot can keep its files and commands in its own bubblewrap sandbox, with or without internet access |
| ⬆️ **Updates** | Desktop apps update themselves from your hub (signed installers); Android gets a download prompt |

### Platform support

| Capability | Windows | macOS | Linux | Android | iOS | Browser (dev) |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Chat, memories, skills, routines, web | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| File tools | ✅ | ✅ | ✅ | ✅ (app folder or hub) | ✅ (app folder or hub) | via hub |
| Terminal | ✅ | ✅ | ✅ | via hub | via hub | via hub |
| Local (stdio) MCP | ✅ | ✅ | ✅ | — | — | — |
| Sync through a Lantern Hub | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Auto-updates from the hub | ✅ | ✅ | ✅ | download prompt | — | — |
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
  lib/approval.ts        approval engine (modes, rules, read-only command classifier, auto-review)
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
```

## License

[MIT](LICENSE)
