//! Runs shell commands for bots. Output is captured with a size cap, and a
//! timeout or cancel kills the whole process tree.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::oneshot;

const MAX_CAPTURE: usize = 512 * 1024;

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShellRequest {
    pub id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
}

/// The shell bots get on this machine, shown to the model in its system prompt.
pub fn shell_name() -> String {
    if cfg!(windows) {
        "PowerShell".into()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

pub fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
        // Make PowerShell emit UTF-8 so non-ASCII output survives.
        cmd.arg(format!(
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; {command}"
        ));
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        // A login shell picks up the user's PATH (GUI apps on macOS start with a minimal one).
        let mut cmd = Command::new(shell_name());
        cmd.args(["-l", "-c", command]);
        cmd.process_group(0);
        cmd
    }
}

pub async fn kill_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
        #[cfg(not(windows))]
        {
            let _ = Command::new("kill")
                .args(["-9", &format!("-{pid}")])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
    }
    let _ = child.kill().await;
}

async fn read_capped<R: AsyncRead + Unpin>(mut r: R) -> String {
    let mut kept = Vec::new();
    let mut buf = [0u8; 8192];
    let mut dropped = 0usize;
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = MAX_CAPTURE.saturating_sub(kept.len());
                kept.extend_from_slice(&buf[..n.min(room)]);
                dropped += n.saturating_sub(room);
            }
        }
    }
    let mut s = String::from_utf8_lossy(&kept).into_owned();
    if dropped > 0 {
        s.push_str(&format!("\n[output truncated: {dropped} more bytes]"));
    }
    s
}

/// Tracks running commands so they can be cancelled by id.
#[derive(Default)]
pub struct ShellRunner {
    cancels: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl ShellRunner {
    pub fn cancel(&self, id: &str) {
        if let Some(tx) = self.cancels.lock().ok().and_then(|mut m| m.remove(id)) {
            let _ = tx.send(());
        }
    }

    pub async fn run(&self, req: ShellRequest) -> Result<ShellResult, String> {
        let started = Instant::now();
        let mut cmd = shell_command(&req.command);
        if let Some(cwd) = req.cwd.as_deref().filter(|c| !c.is_empty()) {
            std::fs::create_dir_all(cwd).map_err(|e| format!("{cwd}: {e}"))?;
            cmd.current_dir(cwd);
        }
        cmd.envs(&req.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("failed to start shell: {e}"))?;
        let out = tokio::spawn(read_capped(child.stdout.take().expect("piped stdout")));
        let err = tokio::spawn(read_capped(child.stderr.take().expect("piped stderr")));

        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.cancels.lock().map_err(|e| e.to_string())?.insert(req.id.clone(), cancel_tx);
        let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(120_000).clamp(1_000, 3_600_000));

        let mut result = ShellResult::default();
        tokio::select! {
            status = child.wait() => {
                result.exit_code = status.ok().and_then(|s| s.code());
            }
            _ = tokio::time::sleep(timeout) => {
                kill_tree(&mut child).await;
                result.timed_out = true;
            }
            _ = cancel_rx => {
                kill_tree(&mut child).await;
                result.cancelled = true;
            }
        }
        if let Ok(mut m) = self.cancels.lock() {
            m.remove(&req.id);
        }
        // Grandchildren can hold the pipes open; don't wait on them forever.
        let grace = Duration::from_secs(3);
        result.stdout = tokio::time::timeout(grace, out).await.ok().and_then(|r| r.ok()).unwrap_or_default();
        result.stderr = tokio::time::timeout(grace, err).await.ok().and_then(|r| r.ok()).unwrap_or_default();
        result.duration_ms = started.elapsed().as_millis() as u64;
        Ok(result)
    }
}
