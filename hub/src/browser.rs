//! A web browser for each bot: headless Chrome driven over the DevTools protocol
//! through a pipe (`--remote-debugging-pipe`). No debugging port is opened, so
//! nothing else on the machine can take control of it. The runner and the apps
//! send DevTools commands through the hub's tool API; this keeps one browser
//! per bot (with its own profile, so sign-ins stick), tracks the tab the bot is
//! on, follows tabs a click opens, and answers JavaScript dialogs.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::pipe;
use tokio::sync::oneshot;

/// Browsers nobody has used for this long are closed to free memory.
const IDLE_MS: i64 = 15 * 60_000;
/// At most this many browsers at once; opening another closes the least recently used.
const MAX_OPEN: usize = 3;
pub const WIDTH: u32 = 1280;
pub const HEIGHT: u32 = 900;

fn now_ms() -> i64 {
    crate::store::now_ms()
}

#[derive(Clone, Debug)]
struct Page {
    target: String,
    session: String,
}

struct Browser {
    pid: i32,
    writer: tokio::sync::Mutex<pipe::Sender>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    last_used: AtomicI64,
    alive: AtomicBool,
    page: Mutex<Option<Page>>,
    /// Tabs opened by the current one (a link with target=_blank), to switch to.
    popups: Mutex<Vec<String>>,
    dialogs: Mutex<Vec<String>>,
    downloads: Option<String>,
}

impl Browser {
    fn touch(&self) {
        self.last_used.store(now_ms(), Ordering::Relaxed);
    }

    async fn send(&self, method: &str, params: Value, session: Option<&str>, timeout: Duration) -> Result<Value, String> {
        if !self.alive.load(Ordering::Relaxed) {
            return Err("The browser has closed.".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        let mut bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        bytes.push(0);
        self.writer.lock().await.write_all(&bytes).await.map_err(|e| format!("browser pipe: {e}"))?;
        let reply = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => return Err("The browser closed before it answered.".into()),
            Err(_) => {
                self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                return Err(format!("The browser didn't answer {method} in time."));
            }
        };
        if let Some(err) = reply.get("error") {
            return Err(err["message"].as_str().unwrap_or("DevTools error").to_string());
        }
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    }

    /// The tab the bot is working in, creating one if there's none.
    async fn ensure_page(&self) -> Result<Page, String> {
        if let Some(p) = self.page.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return Ok(p);
        }
        let t = Duration::from_secs(15);
        let targets = self.send("Target.getTargets", json!({}), None, t).await?;
        let existing = targets["targetInfos"].as_array().and_then(|a| a.iter().find(|i| i["type"] == "page").map(|i| i["targetId"].as_str().unwrap_or_default().to_string()));
        let target = match existing {
            Some(id) if !id.is_empty() => id,
            _ => self.send("Target.createTarget", json!({ "url": "about:blank" }), None, t).await?["targetId"].as_str().unwrap_or_default().to_string(),
        };
        self.attach(&target).await
    }

    async fn attach(&self, target: &str) -> Result<Page, String> {
        let t = Duration::from_secs(15);
        let attached = self.send("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None, t).await?;
        let session = attached["sessionId"].as_str().ok_or("attach failed")?.to_string();
        // Page events let us answer dialogs; downloads go to the bot's folder.
        let _ = self.send("Page.enable", json!({}), Some(&session), t).await;
        let _ = self
            .send("Emulation.setDeviceMetricsOverride", json!({ "width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 1, "mobile": false }), Some(&session), t)
            .await;
        if let Some(dir) = &self.downloads {
            let _ = self.send("Browser.setDownloadBehavior", json!({ "behavior": "allow", "downloadPath": dir }), None, t).await;
        }
        let page = Page { target: target.to_string(), session };
        *self.page.lock().unwrap_or_else(|e| e.into_inner()) = Some(page.clone());
        Ok(page)
    }

    fn handle_event(self: &Arc<Self>, msg: &Value) {
        let method = msg["method"].as_str().unwrap_or_default();
        let params = &msg["params"];
        let current = self.page.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match method {
            "Target.targetCreated" => {
                let info = &params["targetInfo"];
                if info["type"] == "page" && current.as_ref().is_some_and(|p| info["openerId"] == p.target.as_str()) {
                    if let Some(id) = info["targetId"].as_str() {
                        self.popups.lock().unwrap_or_else(|e| e.into_inner()).push(id.to_string());
                    }
                }
            }
            "Target.targetDestroyed" | "Target.detachedFromTarget" => {
                let gone = current.as_ref().is_some_and(|p| params["targetId"] == p.target.as_str() || params["sessionId"] == p.session.as_str());
                if gone {
                    *self.page.lock().unwrap_or_else(|e| e.into_inner()) = None;
                }
            }
            "Page.javascriptDialogOpening" => {
                let text = format!("{} dialog: {}", params["type"].as_str().unwrap_or("A"), params["message"].as_str().unwrap_or(""));
                let mut d = self.dialogs.lock().unwrap_or_else(|e| e.into_inner());
                d.push(text);
                let len = d.len();
                if len > 10 {
                    d.drain(..len - 10);
                }
                drop(d);
                if let Some(session) = msg["sessionId"].as_str().map(str::to_string) {
                    let me = self.clone();
                    tokio::spawn(async move {
                        let _ = me.send("Page.handleJavaScriptDialog", json!({ "accept": true }), Some(&session), Duration::from_secs(5)).await;
                    });
                }
            }
            _ => {}
        }
    }

    /// Switches to a tab the last click opened, if any.
    async fn follow_popup(&self) -> Result<Option<Page>, String> {
        let next = self.popups.lock().unwrap_or_else(|e| e.into_inner()).pop();
        match next {
            Some(target) => {
                self.popups.lock().unwrap_or_else(|e| e.into_inner()).clear();
                self.attach(&target).await.map(Some)
            }
            None => Ok(None),
        }
    }

    fn kill(&self) {
        self.alive.store(false, Ordering::Relaxed);
        // Its own process group: the renderers and helpers go with it.
        unsafe {
            libc::kill(-self.pid, libc::SIGKILL);
        }
    }
}

fn pipe_pair() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

/// The headless Chrome to use: `LANTERN_HUB_BROWSER`, or the first one installed.
pub fn find_binary() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("LANTERN_HUB_BROWSER").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    [
        "/opt/lantern/chrome-headless-shell/chrome-headless-shell",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/lib/chromium/chromium",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
}

pub struct Browsers {
    open: Mutex<HashMap<String, Arc<Browser>>>,
    /// One launch at a time, so two callers never start two browsers for one bot.
    launching: tokio::sync::Mutex<()>,
    reaper: std::sync::Once,
}

impl Default for Browsers {
    fn default() -> Self {
        Browsers { open: Mutex::new(HashMap::new()), launching: tokio::sync::Mutex::new(()), reaper: std::sync::Once::new() }
    }
}

impl Browsers {
    pub fn available() -> bool {
        find_binary().is_some()
    }

    fn get(&self, key: &str) -> Option<Arc<Browser>> {
        let b = self.open.lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned();
        b.filter(|b| b.alive.load(Ordering::Relaxed))
    }

    pub fn close(&self, key: &str) -> bool {
        match self.open.lock().unwrap_or_else(|e| e.into_inner()).remove(key) {
            Some(b) => {
                b.kill();
                true
            }
            None => false,
        }
    }

    fn start_reaper(self: &Arc<Self>) {
        let me = self.clone();
        self.reaper.call_once(|| {
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    let idle: Vec<String> = me
                        .open
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .iter()
                        .filter(|(_, b)| !b.alive.load(Ordering::Relaxed) || now_ms() - b.last_used.load(Ordering::Relaxed) > IDLE_MS)
                        .map(|(k, _)| k.clone())
                        .collect();
                    for k in idle {
                        me.close(&k);
                    }
                }
            });
        });
    }

    async fn launch(self: &Arc<Self>, key: &str, profile: &Path, downloads: Option<&str>) -> Result<Arc<Browser>, String> {
        if let Some(b) = self.get(key) {
            return Ok(b);
        }
        let _one_at_a_time = self.launching.lock().await;
        if let Some(b) = self.get(key) {
            return Ok(b);
        }
        self.start_reaper();
        // Make room: close the least recently used browser.
        let lru = {
            let open = self.open.lock().unwrap_or_else(|e| e.into_inner());
            if open.len() >= MAX_OPEN {
                open.iter().min_by_key(|(_, b)| b.last_used.load(Ordering::Relaxed)).map(|(k, _)| k.clone())
            } else {
                None
            }
        };
        if let Some(k) = lru {
            self.close(&k);
        }

        let binary = find_binary().ok_or("No browser is installed on the hub. Rerun install.sh with LANTERN_BROWSER=1 (see docs/HUB.md, Browser).")?;
        std::fs::create_dir_all(profile).map_err(|e| format!("{}: {e}", profile.display()))?;
        if let Some(d) = downloads {
            std::fs::create_dir_all(d).map_err(|e| format!("{d}: {e}"))?;
        }
        let (child_in, to_child) = pipe_pair().map_err(|e| e.to_string())?;
        let (from_child, child_out) = pipe_pair().map_err(|e| e.to_string())?;
        let (fd_in, fd_out) = (child_in.as_raw_fd(), child_out.as_raw_fd());
        let mut cmd = std::process::Command::new(&binary);
        cmd.args([
            "--headless=new",
            "--remote-debugging-pipe",
            &format!("--user-data-dir={}", profile.display()),
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--disable-features=Translate,MediaRouter,OptimizationHints",
            "--disable-dev-shm-usage",
            &format!("--window-size={WIDTH},{HEIGHT}"),
            "--hide-scrollbars",
            "--mute-audio",
            "--password-store=basic",
            "--lang=en-US",
            "about:blank",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0);
        // DevTools talks over fds 3 (in) and 4 (out).
        unsafe {
            cmd.pre_exec(move || {
                if libc::dup2(fd_in, 3) < 0 || libc::dup2(fd_out, 4) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn().map_err(|e| format!("starting {}: {e}", binary.display()))?;
        drop(child_in);
        drop(child_out);
        let pid = child.id() as i32;
        let stderr = child.stderr.take();
        // Keep the last lines it printed, to explain a failed start.
        let log = Arc::new(Mutex::new(String::new()));
        if let Some(mut err) = stderr {
            let log = log.clone();
            std::thread::spawn(move || {
                use std::io::Read;
                let mut buf = [0u8; 4096];
                while let Ok(n) = err.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let mut l = log.lock().unwrap_or_else(|e| e.into_inner());
                    l.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if l.len() > 8000 {
                        let cut = l.len() - 4000;
                        l.drain(..cut);
                    }
                }
            });
        }
        // Reap the process when it exits so it doesn't linger as a zombie.
        std::thread::spawn(move || {
            let _ = child.wait();
        });

        let writer = pipe::Sender::from_owned_fd(to_child).map_err(|e| e.to_string())?;
        let mut reader = pipe::Receiver::from_owned_fd(from_child).map_err(|e| e.to_string())?;
        let browser = Arc::new(Browser {
            pid,
            writer: tokio::sync::Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            last_used: AtomicI64::new(now_ms()),
            alive: AtomicBool::new(true),
            page: Mutex::new(None),
            popups: Mutex::new(Vec::new()),
            dialogs: Mutex::new(Vec::new()),
            downloads: downloads.map(str::to_string),
        });
        let b = browser.clone();
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let mut chunk = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        while let Some(end) = buf.iter().position(|&c| c == 0) {
                            let raw: Vec<u8> = buf.drain(..=end).collect();
                            let Ok(msg) = serde_json::from_slice::<Value>(&raw[..raw.len() - 1]) else { continue };
                            if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                                if let Some(tx) = b.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
                                    let _ = tx.send(msg);
                                }
                            } else {
                                b.handle_event(&msg);
                            }
                        }
                    }
                }
            }
            b.alive.store(false, Ordering::Relaxed);
            b.pending.lock().unwrap_or_else(|e| e.into_inner()).clear();
        });

        if let Err(e) = browser.send("Target.setDiscoverTargets", json!({ "discover": true }), None, Duration::from_secs(20)).await {
            browser.kill();
            tokio::time::sleep(Duration::from_millis(300)).await;
            let tail = log.lock().unwrap_or_else(|e| e.into_inner()).lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(format!("The browser didn't start ({e}).{}", if tail.is_empty() { String::new() } else { format!("\n{tail}") }));
        }
        self.open.lock().unwrap_or_else(|e| e.into_inner()).insert(key.to_string(), browser.clone());
        Ok(browser)
    }

    /// Sends one DevTools command. `page` commands go to the bot's current tab.
    pub async fn call(self: &Arc<Self>, key: &str, profile: &Path, downloads: Option<&str>, method: &str, params: Value, page: bool, timeout_ms: Option<u64>) -> Result<Value, String> {
        let b = self.launch(key, profile, downloads).await?;
        b.touch();
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(1_000, 120_000));
        if !page {
            return b.send(method, params, None, timeout).await;
        }
        let p = b.ensure_page().await?;
        match b.send(method, params.clone(), Some(&p.session), timeout).await {
            // The tab went away (closed by the page itself): open a fresh one and retry once.
            Err(e) if e.contains("session") || e.contains("Session") || e.contains("No target") => {
                *b.page.lock().unwrap_or_else(|e| e.into_inner()) = None;
                let p = b.ensure_page().await?;
                b.send(method, params, Some(&p.session), timeout).await
            }
            other => other,
        }
    }

    /// Switches to a tab the last action opened. Returns whether it did.
    pub async fn follow_popup(&self, key: &str) -> Result<bool, String> {
        match self.get(key) {
            Some(b) => b.follow_popup().await.map(|p| p.is_some()),
            None => Ok(false),
        }
    }

    /// Whether the bot's browser is open, and the dialogs it answered since the last look.
    pub fn status(&self, key: &str) -> Value {
        match self.get(key) {
            Some(b) => {
                let dialogs: Vec<String> = std::mem::take(&mut *b.dialogs.lock().unwrap_or_else(|e| e.into_inner()));
                json!({ "open": true, "dialogs": dialogs, "idleMs": now_ms() - b.last_used.load(Ordering::Relaxed) })
            }
            None => json!({ "open": false }),
        }
    }
}
