//! Launches local MCP servers over stdio (desktop only). The JSON-RPC protocol
//! itself lives in the frontend; Rust just moves newline-delimited messages.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, State};
use tokio::sync::oneshot;

#[derive(Serialize, Clone)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum McpEvent {
    Message(String),
    Stderr(String),
    Exit(Option<i32>),
}

#[allow(dead_code)]
struct Proc {
    stdin: Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>,
    kill: oneshot::Sender<()>,
}

#[derive(Default)]
pub struct McpState {
    procs: Mutex<HashMap<String, Proc>>,
}

#[tauri::command]
pub fn mcp_kill(state: State<'_, McpState>, id: String) {
    if let Some(p) = state.procs.lock().ok().and_then(|mut m| m.remove(&id)) {
        let _ = p.kill.send(());
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn mcp_spawn(
    _state: State<'_, McpState>,
    _id: String,
    _command: String,
    _args: Vec<String>,
    _env: HashMap<String, String>,
    _cwd: Option<String>,
    _on_event: Channel<McpEvent>,
) -> Result<(), String> {
    Err("Local (stdio) MCP servers are not available on mobile. Use an HTTP MCP server.".into())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn mcp_send(_state: State<'_, McpState>, _id: String, _message: String) -> Result<(), String> {
    Err("not available on mobile".into())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn mcp_spawn(
    state: State<'_, McpState>,
    id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: Option<String>,
    on_event: Channel<McpEvent>,
) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    mcp_kill(state.clone(), id.clone());

    #[cfg(windows)]
    let mut cmd = {
        // `cmd /C` resolves npx.cmd, uvx.exe, etc. the same way a terminal would.
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&command).args(&args);
        c.creation_flags(lantern_tools::shell::CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        // Run through a login shell so PATH includes npx/uvx/docker on macOS GUI launches.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut c = Command::new(shell);
        c.args(["-l", "-c", "exec \"$0\" \"$@\"", &command]).args(&args);
        c.process_group(0);
        c
    };
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("failed to start {command}: {e}"))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let ev = on_event.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() && ev.send(McpEvent::Message(line)).is_err() {
                break;
            }
        }
    });
    let ev = on_event.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = ev.send(McpEvent::Stderr(line));
        }
    });

    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let code = tokio::select! {
            status = child.wait() => status.ok().and_then(|s| s.code()),
            _ = kill_rx => {
                lantern_tools::shell::kill_tree(&mut child).await;
                None
            }
        };
        let _ = on_event.send(McpEvent::Exit(code));
    });

    state
        .procs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, Proc { stdin: Arc::new(tokio::sync::Mutex::new(stdin)), kill: kill_tx });
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn mcp_send(state: State<'_, McpState>, id: String, message: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let stdin = state
        .procs
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .map(|p| p.stdin.clone())
        .ok_or_else(|| format!("MCP server {id} is not running"))?;
    let mut w = stdin.lock().await;
    w.write_all(message.as_bytes()).await.map_err(|e| e.to_string())?;
    w.write_all(b"\n").await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())
}
