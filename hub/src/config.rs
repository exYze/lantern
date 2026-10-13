//! Hub settings, read from environment variables (see hub/lantern-hub.env).

use std::path::PathBuf;

#[derive(Clone, Debug)]
#[cfg_attr(not(unix), allow(dead_code))]
pub enum Listen {
    Tcp(String),
    Unix(PathBuf),
}

impl Listen {
    fn parse(s: &str) -> Self {
        match s.strip_prefix("unix:") {
            Some(path) => Listen::Unix(PathBuf::from(path)),
            None => Listen::Tcp(s.to_string()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    /// Display name shown in the app and on the downloads page.
    pub name: String,
    /// Directory holding hub.db.
    pub data_dir: PathBuf,
    /// The full API. Put it behind `tailscale serve` (HTTPS) on a socket only
    /// root and the hub can open when `tailscale_owner` is set.
    pub listen: Listen,
    /// Optional plain-HTTP listener that serves only the downloads page and files.
    pub public_listen: Option<String>,
    /// Release folders (one per version, each with a release.json).
    pub releases_dir: PathBuf,
    /// Where bot tools run: a `lantern-hub agent` socket (separate user), or in-process.
    pub agent_socket: Option<PathBuf>,
    /// Workspace for in-process tools (ignored when an agent is configured).
    pub workspace: PathBuf,
    /// The address devices should use, shown on the downloads page (e.g. the HTTPS Tailscale name).
    pub public_url: Option<String>,
    /// Tailscale login (e.g. `alice@`) whose devices may pair without a code.
    /// Only safe when the API is reachable solely through `tailscale serve`.
    pub tailscale_owner: Option<String>,
    /// This server's own Tailscale addresses. Requests from them (e.g. a bot's
    /// shell command on the hub) never count as the owner's device.
    pub self_addrs: Vec<String>,
    /// Base addresses where `/hooks/...` can be reached (tailnet, LAN, a Funnel), shown in the app.
    pub hook_urls: Vec<String>,
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> Self {
        let data_dir = PathBuf::from(env("LANTERN_HUB_DATA").unwrap_or_else(|| "./hub-data".into()));
        let list = |key: &str| env(key).map(|s| s.split([',', ' ']).filter(|a| !a.is_empty()).map(|a| a.trim_end_matches('/').to_string()).collect::<Vec<_>>());
        let public_url = env("LANTERN_HUB_PUBLIC_URL");
        Config {
            hook_urls: list("LANTERN_HUB_HOOK_URLS").unwrap_or_else(|| public_url.iter().map(|u| u.trim_end_matches('/').to_string()).collect()),
            name: env("LANTERN_HUB_NAME").unwrap_or_else(|| "Lantern Hub".into()),
            listen: Listen::parse(&env("LANTERN_HUB_LISTEN").unwrap_or_else(|| "127.0.0.1:8780".into())),
            public_listen: env("LANTERN_HUB_PUBLIC_LISTEN"),
            releases_dir: env("LANTERN_HUB_RELEASES").map(PathBuf::from).unwrap_or_else(|| data_dir.join("releases")),
            agent_socket: env("LANTERN_HUB_AGENT").map(|s| PathBuf::from(s.strip_prefix("unix:").unwrap_or(&s))),
            workspace: env("LANTERN_HUB_WORKSPACE").map(PathBuf::from).unwrap_or_else(|| data_dir.join("workspace")),
            public_url,
            tailscale_owner: env("LANTERN_HUB_TAILSCALE_OWNER"),
            self_addrs: env("LANTERN_HUB_SELF_ADDRS")
                .map(|s| s.split([',', ' ']).filter(|a| !a.is_empty()).map(str::to_string).collect())
                .unwrap_or_default(),
            data_dir,
        }
    }
}
