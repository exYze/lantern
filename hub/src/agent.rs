//! Bot tools on the hub: files and shell commands in a shared workspace.
//!
//! In production the tools run in a separate `lantern-hub agent` process under
//! its own Unix user, so a bot's commands can't read the hub database (which
//! holds device tokens and synced secrets). The hub talks to it over a local
//! socket: one JSON request line in, one JSON response line out.

use lantern_tools::fs::{self, Edit, GrepRequest};
use lantern_tools::shell::{Sandbox, ShellRequest, ShellRunner};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ToolRequest {
    Info,
    // `confine`: every path must stay inside `root` (a sandboxed bot's or subagent's folder).
    FsRead { root: String, path: String, offset: Option<usize>, limit: Option<usize>, #[serde(default)] confine: bool },
    FsWrite { root: String, path: String, content: String, #[serde(default)] confine: bool },
    FsEdit { root: String, path: String, edits: Vec<Edit>, #[serde(default)] confine: bool },
    FsList { root: String, path: Option<String>, #[serde(default)] confine: bool },
    FsFind { root: String, pattern: String, path: Option<String>, limit: Option<usize>, #[serde(default)] confine: bool },
    FsGrep { request: GrepRequest, #[serde(default)] confine: bool },
    FsDelete { root: String, path: String, #[serde(default)] confine: bool },
    ShellRun { request: ShellRequest },
    ShellCancel { id: String },
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(unix), allow(dead_code))]
enum Reply {
    Ok(Value),
    Err(String),
}

fn os_name() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|s| s.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=").map(|v| v.trim_matches('"').to_string())))
        .unwrap_or_else(|| std::env::consts::OS.to_string())
}

/// Runs tool requests directly in this process.
pub struct LocalTools {
    workspace: PathBuf,
    shell: ShellRunner,
    sandbox: tokio::sync::OnceCell<bool>,
}

impl LocalTools {
    pub fn new(workspace: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&workspace);
        LocalTools { workspace, shell: ShellRunner::default(), sandbox: tokio::sync::OnceCell::new() }
    }

    /// Whether bubblewrap sandboxes work on this machine (checked once).
    async fn can_sandbox(&self) -> bool {
        *self.sandbox.get_or_init(lantern_tools::shell::sandbox_available).await
    }

    /// Sandboxes live inside the shared workspace, so the user's other bots can look into them.
    fn check_sandbox(&self, sb: &Sandbox) -> Result<(), String> {
        let dir = fs::normalize(Path::new(&sb.dir));
        if dir == fs::normalize(&self.workspace) || !dir.starts_with(fs::normalize(&self.workspace)) {
            return Err(format!("a sandbox folder must be inside the workspace ({})", self.workspace.display()));
        }
        Ok(())
    }

    pub async fn handle(&self, req: ToolRequest) -> Result<Value, String> {
        match req {
            ToolRequest::Info => Ok(json!({
                "workspace": self.workspace.to_string_lossy(),
                "shell": lantern_tools::shell::shell_name(),
                "os": os_name(),
                "user": std::env::var("USER").unwrap_or_default(),
                "sandbox": self.can_sandbox().await,
            })),
            // File operations can block on large trees; keep them off the async workers.
            ToolRequest::FsRead { root, path, offset, limit, confine } => blocking(move || to_json(fs::read(&root, &path, offset, limit, confine))).await,
            ToolRequest::FsWrite { root, path, content, confine } => blocking(move || to_json(fs::write(&root, &path, &content, confine))).await,
            ToolRequest::FsEdit { root, path, edits, confine } => blocking(move || to_json(fs::edit(&root, &path, &edits, confine))).await,
            ToolRequest::FsList { root, path, confine } => blocking(move || to_json(fs::list(&root, path.as_deref(), confine))).await,
            ToolRequest::FsFind { root, pattern, path, limit, confine } => {
                blocking(move || to_json(fs::find(&root, &pattern, path.as_deref(), limit, confine))).await
            }
            ToolRequest::FsGrep { request, confine } => blocking(move || to_json(fs::grep(&request, confine))).await,
            ToolRequest::FsDelete { root, path, confine } => blocking(move || to_json(fs::delete(&root, &path, confine))).await,
            ToolRequest::ShellRun { mut request } => {
                if let Some(sb) = &request.sandbox {
                    self.check_sandbox(sb)?;
                    if !self.can_sandbox().await {
                        return Err("This hub can't create sandboxes: install bubblewrap (see docs/HUB.md, Sandboxes).".into());
                    }
                }
                if request.cwd.as_deref().map_or(true, str::is_empty) {
                    request.cwd = Some(self.workspace.to_string_lossy().into_owned());
                }
                to_json(self.shell.run(request).await)
            }
            ToolRequest::ShellCancel { id } => {
                self.shell.cancel(&id);
                Ok(Value::Null)
            }
        }
    }
}

fn to_json<T: Serialize>(v: Result<T, String>) -> Result<Value, String> {
    v.and_then(|x| serde_json::to_value(x).map_err(|e| e.to_string()))
}

async fn blocking<F: FnOnce() -> Result<Value, String> + Send + 'static>(f: F) -> Result<Value, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Where the hub sends tool requests.
pub enum Tools {
    Local(LocalTools),
    Agent(PathBuf),
}

impl Tools {
    pub async fn call(&self, req: ToolRequest) -> Result<Value, String> {
        match self {
            Tools::Local(local) => local.handle(req).await,
            Tools::Agent(socket) => call_agent(socket, &req).await,
        }
    }
}

#[cfg(unix)]
async fn call_agent(socket: &Path, req: &ToolRequest) -> Result<Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let stream = tokio::net::UnixStream::connect(socket)
        .await
        .map_err(|e| format!("the hub's tool runner is not available ({}): {e}", socket.display()))?;
    let (read, mut write) = stream.into_split();
    let mut line = serde_json::to_string(req).map_err(|e| e.to_string())?;
    line.push('\n');
    write.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut reply = String::new();
    BufReader::new(read).read_line(&mut reply).await.map_err(|e| e.to_string())?;
    match serde_json::from_str::<Reply>(&reply).map_err(|e| format!("bad reply from the tool runner: {e}"))? {
        Reply::Ok(v) => Ok(v),
        Reply::Err(e) => Err(e),
    }
}

#[cfg(not(unix))]
async fn call_agent(_socket: &Path, _req: &ToolRequest) -> Result<Value, String> {
    Err("a separate tool runner needs a Unix socket; run the hub on Linux".into())
}

/// `lantern-hub agent`: serves tool requests on a Unix socket.
#[cfg(unix)]
pub async fn serve_agent(socket: PathBuf, workspace: PathBuf) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let _ = std::fs::remove_file(&socket);
    if let Some(dir) = socket.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let listener = tokio::net::UnixListener::bind(&socket)?;
    // Owner and group (the hub's group) may connect; nobody else.
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o660))?;
    let tools = std::sync::Arc::new(LocalTools::new(workspace.clone()));
    eprintln!("lantern-hub agent: workspace {} on {}", workspace.display(), socket.display());
    loop {
        let (stream, _) = listener.accept().await?;
        let tools = tools.clone();
        tokio::spawn(async move {
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            if BufReader::new(read).read_line(&mut line).await.unwrap_or(0) == 0 {
                return;
            }
            let reply = match serde_json::from_str::<ToolRequest>(&line) {
                Ok(req) => match tools.handle(req).await {
                    Ok(v) => Reply::Ok(v),
                    Err(e) => Reply::Err(e),
                },
                Err(e) => Reply::Err(format!("bad request: {e}")),
            };
            let mut out = serde_json::to_string(&reply).unwrap_or_else(|_| "{\"err\":\"encode failed\"}".into());
            out.push('\n');
            let _ = write.write_all(out.as_bytes()).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_tools_write_read_and_run() {
        let dir = std::env::temp_dir().join(format!("lantern-hub-test-{}", std::process::id()));
        let tools = LocalTools::new(dir.clone());
        let root = dir.to_string_lossy().into_owned();
        tools.handle(ToolRequest::FsWrite { root: root.clone(), path: "a/b.txt".into(), content: "hello\nworld".into(), confine: false }).await.unwrap();
        let r = tools.handle(ToolRequest::FsRead { root: root.clone(), path: "a/b.txt".into(), offset: None, limit: None, confine: false }).await.unwrap();
        assert_eq!(r["content"], "hello\nworld");
        assert_eq!(r["totalLines"], 2);
        let req: ToolRequest = serde_json::from_value(json!({"op": "shell_run", "request": {"id": "t1", "command": "echo hi"}})).unwrap();
        let out = tools.handle(req).await.unwrap();
        assert!(out["stdout"].as_str().unwrap().contains("hi"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn confined_tools_and_sandboxes_stay_in_their_folder() {
        let dir = std::env::temp_dir().join(format!("lantern-hub-confine-{}", std::process::id()));
        let tools = LocalTools::new(dir.clone());
        let bot = dir.join("bots").join("b1").to_string_lossy().into_owned();
        let write = |path: &str, confine| ToolRequest::FsWrite { root: bot.clone(), path: path.into(), content: "x".into(), confine };
        assert!(tools.handle(write("notes.txt", true)).await.is_ok());
        assert!(tools.handle(write("../b2/notes.txt", true)).await.is_err());
        assert!(tools.handle(write("../b2/notes.txt", false)).await.is_ok());

        let run = |sandbox_dir: &str| {
            serde_json::from_value::<ToolRequest>(json!({"op": "shell_run", "request": {"id": "s", "command": "true", "sandbox": {"dir": sandbox_dir}}})).unwrap()
        };
        let outside = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(tools.handle(run(&outside)).await.unwrap_err().contains("inside the workspace"));
        assert!(tools.handle(run(&dir.to_string_lossy())).await.unwrap_err().contains("inside the workspace"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
