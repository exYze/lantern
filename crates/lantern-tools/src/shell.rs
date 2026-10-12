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
    /// Run the command walled off in `sandbox.dir` (Linux with bubblewrap).
    #[serde(default)]
    pub sandbox: Option<Sandbox>,
}

/// A bubblewrap sandbox: the system is read-only, other users' and bots' files
/// are hidden, and only `dir` (plus a private /tmp) can be written.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Sandbox {
    pub dir: String,
    /// Commands may use the network (otherwise they get none at all).
    #[serde(default)]
    pub network: bool,
}

/// bubblewrap arguments for running `command` inside `sb`.
pub fn sandbox_args(command: &str, sb: &Sandbox) -> Vec<String> {
    let dir = sb.dir.as_str();
    let mut args: Vec<&str> = vec!["--die-with-parent", "--new-session", "--unshare-all"];
    if sb.network {
        args.push("--share-net");
    }
    args.extend([
        "--ro-bind", "/", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/tmp",
        "--tmpfs", "/var/tmp",
        // Hides every home folder (other bots, the admin), the hub's and the
        // tool runner's sockets, and the Tailscale socket.
        "--tmpfs", "/home",
        "--tmpfs", "/root",
        "--tmpfs", "/run",
        // DNS: /etc/resolv.conf points into /run on systemd-resolved systems.
        "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve",
        "--tmpfs", "/srv",
        "--tmpfs", "/mnt",
        "--tmpfs", "/media",
        "--bind", dir, dir,
        "--chdir", dir,
        "--setenv", "HOME", dir,
        "--setenv", "TMPDIR", "/tmp",
        "--", "/bin/bash", "-l", "-c", command,
    ]);
    args.into_iter().map(str::to_string).collect()
}

/// True when bubblewrap is installed and can create a sandbox here.
pub async fn sandbox_available() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    let probe = Command::new("bwrap")
        .args(["--die-with-parent", "--unshare-all", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    matches!(tokio::time::timeout(Duration::from_secs(10), probe).await, Ok(Ok(s)) if s.success())
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

fn sandboxed_command(command: &str, sb: &Sandbox) -> Result<Command, String> {
    if !cfg!(target_os = "linux") {
        return Err("sandboxes need a Linux machine with bubblewrap".into());
    }
    if !std::path::Path::new(&sb.dir).is_absolute() {
        return Err(format!("sandbox folder must be an absolute path: {}", sb.dir));
    }
    std::fs::create_dir_all(&sb.dir).map_err(|e| format!("{}: {e}", sb.dir))?;
    let mut cmd = Command::new("bwrap");
    cmd.args(sandbox_args(command, sb));
    #[cfg(unix)]
    cmd.process_group(0);
    Ok(cmd)
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
        let mut cmd = match &req.sandbox {
            Some(sb) => sandboxed_command(&req.command, sb)?,
            None => shell_command(&req.command),
        };
        if let Some(cwd) = req.cwd.as_deref().filter(|c| !c.is_empty() && req.sandbox.is_none()) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_shares_the_network_only_when_asked() {
        let sb = |network| Sandbox { dir: "/w/bots/b1".into(), network };
        let closed = sandbox_args("ls", &sb(false));
        assert!(!closed.contains(&"--share-net".to_string()));
        assert!(closed.contains(&"--unshare-all".to_string()));
        assert!(sandbox_args("ls", &sb(true)).contains(&"--share-net".to_string()));
    }

    #[test]
    fn sandbox_hides_homes_before_binding_its_folder() {
        let args = sandbox_args("echo hi", &Sandbox { dir: "/home/agent/ws/b1".into(), network: false });
        let pos = |flag: &str, value: &str| args.windows(2).position(|w| w[0] == flag && w[1] == value).unwrap();
        assert!(pos("--tmpfs", "/home") < pos("--bind", "/home/agent/ws/b1"));
        assert!(pos("--tmpfs", "/run") < pos("--bind", "/home/agent/ws/b1"));
        assert_eq!(args.last().unwrap(), "echo hi");
    }

    #[cfg(not(target_os = "linux"))]
    #[tokio::test]
    async fn sandboxes_are_refused_off_linux() {
        let req = ShellRequest {
            id: "s1".into(),
            command: "echo hi".into(),
            cwd: None,
            timeout_ms: None,
            env: HashMap::new(),
            sandbox: Some(Sandbox { dir: "/tmp/x".into(), network: false }),
        };
        assert!(ShellRunner::default().run(req).await.is_err());
    }
}
