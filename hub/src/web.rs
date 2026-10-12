//! Downloads page, installer files and the desktop update manifest.
//!
//! Each release lives in `<releases>/<version>/` with the installers and a
//! `release.json` (written by `scripts/publish-hub.mjs`) that lists the files,
//! their checksums and updater signatures.

use crate::api::Shared;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::Path;
use tower_http::services::ServeDir;

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseFile {
    pub name: String,
    /// windows | macos | linux | android | ios
    pub platform: String,
    /// nsis | msi | dmg | app | deb | rpm | appimage | apk | ios-sim
    pub kind: String,
    #[serde(default)]
    pub arch: String,
    pub size: u64,
    pub sha256: String,
    /// Tauri updater signature (desktop installers only).
    #[serde(default)]
    pub signature: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    pub pub_date: String,
    pub files: Vec<ReleaseFile>,
}

fn version_key(v: &str) -> Vec<u64> {
    v.split(['-', '+']).next().unwrap_or("").split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

/// Every published release, newest first.
pub fn load_releases(dir: &Path) -> Vec<Release> {
    let mut out: Vec<Release> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| std::fs::read_to_string(e.path().join("release.json")).ok())
        .filter_map(|s| serde_json::from_str::<Release>(&s).ok())
        .collect();
    out.sort_by(|a, b| version_key(&b.version).cmp(&version_key(&a.version)));
    out
}

/// The URL clients used to reach us, so manifests work over Tailscale and the LAN alike.
fn base_url(headers: &HeaderMap) -> String {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("localhost");
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(if host.ends_with(".ts.net") { "https" } else { "http" });
    format!("{proto}://{host}")
}

fn file_url(base: &str, version: &str, name: &str) -> String {
    let enc: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "-_.~".contains(c) { c.to_string() } else { format!("%{:02X}", c as u32) })
        .collect();
    format!("{base}/downloads/{version}/{enc}")
}

pub fn router(hub: Shared) -> Router {
    let files = ServeDir::new(hub.config.releases_dir.clone());
    Router::new()
        .route("/", get(page))
        .route("/updates/latest.json", get(manifest))
        .route("/healthz", get(|| async { "ok" }))
        .nest_service("/downloads", files)
        .with_state(hub)
}

/// Tauri's static update manifest. Keys are `{os}-{arch}[-{installer}]`; the
/// updater picks the entry matching how the running app was installed.
async fn manifest(State(hub): State<Shared>, headers: HeaderMap) -> Response {
    let Some(rel) = load_releases(&hub.config.releases_dir).into_iter().next() else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "no releases published yet" }))).into_response();
    };
    let base = base_url(&headers);
    let mut platforms = Map::new();
    let mut add = |key: &str, f: &ReleaseFile| {
        let mut entry = json!({ "url": file_url(&base, &rel.version, &f.name) });
        if let Some(sig) = &f.signature {
            entry["signature"] = Value::String(sig.clone());
        } else {
            entry["sha256"] = Value::String(f.sha256.clone());
        }
        platforms.insert(key.to_string(), entry);
    };
    for f in &rel.files {
        let signed = f.signature.is_some();
        match (f.platform.as_str(), f.kind.as_str()) {
            ("windows", "nsis") if signed => {
                add("windows-x86_64-nsis", f);
                add("windows-x86_64", f);
            }
            ("windows", "msi") if signed => add("windows-x86_64-msi", f),
            ("linux", "appimage") if signed => {
                add("linux-x86_64-appimage", f);
                add("linux-x86_64", f);
            }
            ("linux", "deb") if signed => add("linux-x86_64-deb", f),
            ("linux", "rpm") if signed => add("linux-x86_64-rpm", f),
            // The macOS build is universal: one archive serves both architectures.
            ("macos", "app") if signed => {
                for key in ["darwin-aarch64-app", "darwin-x86_64-app", "darwin-aarch64", "darwin-x86_64"] {
                    add(key, f);
                }
            }
            // Not used by the Tauri updater; the Android app checks it to offer a download.
            ("android", "apk") => add("android-universal", f),
            _ => {}
        }
    }
    Json(json!({ "version": rel.version, "notes": rel.notes, "pub_date": rel.pub_date, "platforms": platforms })).into_response()
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn human_size(n: u64) -> String {
    if n >= 1 << 20 {
        format!("{:.1} MB", n as f64 / (1 << 20) as f64)
    } else {
        format!("{} KB", (n + 1023) / 1024)
    }
}

struct Card {
    id: &'static str,
    title: &'static str,
    /// (kind, label) in display order; the first available one is the main button.
    kinds: &'static [(&'static str, &'static str)],
    how: &'static str,
}

const CARDS: &[Card] = &[
    Card {
        id: "windows",
        title: "Windows",
        kinds: &[("nsis", "Installer (.exe)"), ("msi", "MSI package")],
        how: "Run the installer. Windows SmartScreen may warn because the app isn't code-signed: choose <b>More info → Run anyway</b>. Lantern updates itself after this.",
    },
    Card {
        id: "macos",
        title: "macOS",
        kinds: &[("dmg", "Disk image (.dmg)")],
        how: "Open the disk image and drag Lantern to Applications. The app isn't notarized, so the first time <b>right-click Lantern → Open</b> (or run <code>xattr -dr com.apple.quarantine /Applications/Lantern.app</code>). Universal: Apple silicon and Intel.",
    },
    Card {
        id: "linux",
        title: "Linux",
        kinds: &[("appimage", "AppImage"), ("deb", "Debian / Ubuntu (.deb)"), ("rpm", "Fedora / RHEL (.rpm)")],
        how: "AppImage: <code>chmod +x Lantern_*.AppImage</code> and run it. Or install the package: <code>sudo apt install ./Lantern_*.deb</code> / <code>sudo dnf install ./Lantern-*.rpm</code>.",
    },
    Card {
        id: "android",
        title: "Android",
        kinds: &[("apk", "APK")],
        how: "Download the APK on your phone and open it. Allow your browser to install unknown apps when asked. Android 8.0 or newer.",
    },
    Card {
        id: "ios",
        title: "iOS",
        kinds: &[("ios-sim", "Simulator build (.zip)")],
        how: "iPhones only install apps signed with an Apple developer account. This build runs in the iOS Simulator on a Mac: unzip it and run <code>xcrun simctl install booted Lantern.app</code>.",
    },
];

async fn page(State(hub): State<Shared>, headers: HeaderMap) -> Html<String> {
    let releases = load_releases(&hub.config.releases_dir);
    let name = esc(&hub.config.name);
    let hub_url = esc(&hub.config.public_url.clone().unwrap_or_else(|| base_url(&headers)));
    let mut body = String::new();

    match releases.first() {
        None => body.push_str("<p class=\"muted\">No builds have been published to this hub yet.</p>"),
        Some(rel) => {
            body.push_str(&format!(
                "<p class=\"meta\">Version <b>{}</b> · {}</p>",
                esc(&rel.version),
                esc(rel.pub_date.get(..10).unwrap_or(&rel.pub_date))
            ));
            if !rel.notes.trim().is_empty() {
                body.push_str(&format!("<p class=\"notes\">{}</p>", esc(rel.notes.trim())));
            }
            body.push_str("<div class=\"grid\">");
            for card in CARDS {
                let files: Vec<(&ReleaseFile, &str)> = card
                    .kinds
                    .iter()
                    .filter_map(|(kind, label)| rel.files.iter().find(|f| f.platform == card.id && f.kind == *kind).map(|f| (f, *label)))
                    .collect();
                if files.is_empty() {
                    continue;
                }
                body.push_str(&format!("<section class=\"card\" data-os=\"{}\"><h2>{}</h2>", card.id, card.title));
                for (i, (f, label)) in files.iter().enumerate() {
                    let url = file_url("", &rel.version, &f.name);
                    body.push_str(&format!(
                        "<a class=\"btn{}\" href=\"{url}\" download>{label}<span>{}</span></a>",
                        if i == 0 { " primary" } else { "" },
                        human_size(f.size)
                    ));
                }
                body.push_str(&format!("<p class=\"how\">{}</p><details><summary>SHA-256</summary>", card.how));
                for (f, _) in &files {
                    body.push_str(&format!("<code class=\"sum\">{}<br>{}</code>", esc(&f.name), esc(&f.sha256)));
                }
                body.push_str("</details></section>");
            }
            body.push_str("</div>");
            if releases.len() > 1 {
                body.push_str("<details class=\"older\"><summary>Older versions</summary><ul>");
                for r in releases.iter().skip(1) {
                    let links: Vec<String> = r
                        .files
                        .iter()
                        .map(|f| format!("<a href=\"{}\">{}</a>", file_url("", &r.version, &f.name), esc(&f.name)))
                        .collect();
                    body.push_str(&format!("<li><b>{}</b> — {}</li>", esc(&r.version), links.join(" · ")));
                }
                body.push_str("</ul></details>");
            }
        }
    }

    Html(format!(
        r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name} · Downloads</title>
<style>
:root {{ --bg:#f6f4ef; --fg:#1f1d2b; --muted:#6b6880; --card:#fff; --line:#e4e0d6; --accent:#5a3da6; --accent-fg:#fff; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#15131d; --fg:#ece9f6; --muted:#9a96ad; --card:#1f1c2a; --line:#2f2b3d; --accent:#a58cf0; --accent-fg:#15131d; }} }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }}
main {{ max-width:1040px; margin:0 auto; padding:40px 16px 64px; }}
header {{ display:flex; align-items:center; gap:14px; margin-bottom:8px; }}
header svg {{ width:44px; height:44px; flex:none; }}
h1 {{ font-size:28px; margin:0; }}
h2 {{ font-size:19px; margin:0 0 12px; }}
.meta, .muted, .how, summary {{ color:var(--muted); }}
.notes {{ white-space:pre-wrap; }}
.grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:16px; margin-top:24px; }}
.card {{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; }}
.card.mine {{ border-color:var(--accent); box-shadow:0 0 0 2px var(--accent) inset; }}
.btn {{ display:flex; justify-content:space-between; gap:12px; padding:10px 14px; margin:8px 0; border-radius:10px; border:1px solid var(--line); color:var(--fg); text-decoration:none; font-weight:600; }}
.btn span {{ font-weight:400; color:var(--muted); }}
.btn.primary {{ background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }}
.btn.primary span {{ color:inherit; opacity:.8; }}
.how {{ font-size:14px; }}
code {{ font-size:13px; background:rgba(127,127,127,.14); padding:1px 5px; border-radius:5px; word-break:break-all; }}
.sum {{ display:block; margin-top:6px; background:none; padding:0; }}
.connect {{ margin-top:32px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; }}
.older {{ margin-top:24px; }}
</style>
</head>
<body>
<main>
<header>
<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#3b2f80"/><path d="M24 18h16M28 14h8" stroke="#f6d27a" stroke-width="3" stroke-linecap="round"/><rect x="20" y="20" width="24" height="30" rx="8" fill="none" stroke="#f6d27a" stroke-width="3"/><circle cx="32" cy="35" r="7" fill="#ffd36b"/><path d="M22 52h20" stroke="#f6d27a" stroke-width="3" stroke-linecap="round"/></svg>
<h1>{name}</h1>
</header>
<p class="muted">Lantern for all your devices. Every device paired with this hub shares the same bots, chats, memories, skills, routines and workspace.</p>
{body}
<section class="connect">
<h2>Connect a device</h2>
<p>Open Lantern and choose <b>Connect to a Lantern Hub</b> (or <b>Settings → Hub</b>). Hub address: <code>{hub_url}</code></p>
<p class="muted">Devices signed in to the hub owner's Tailscale account connect with one tap. Anything else needs a pairing code from an already connected device (Settings → Hub → Add a device).</p>
</section>
</main>
<script>
(function () {{
  var ua = navigator.userAgent, os = /Android/i.test(ua) ? "android" : /iPhone|iPad/i.test(ua) ? "ios" : /Mac/i.test(ua) ? "macos" : /Win/i.test(ua) ? "windows" : /Linux/i.test(ua) ? "linux" : "";
  var card = document.querySelector('[data-os="' + os + '"]');
  if (card) {{ card.classList.add("mine"); card.parentNode.insertBefore(card, card.parentNode.firstChild); }}
}})();
</script>
</body>
</html>"##
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_sort_numerically() {
        assert!(version_key("0.10.0") > version_key("0.9.3"));
        assert!(version_key("1.0.0-beta") == version_key("1.0.0"));
    }

    #[test]
    fn file_urls_are_encoded() {
        assert_eq!(file_url("https://h", "0.2.0", "Lantern 0.2.0.exe"), "https://h/downloads/0.2.0/Lantern%200.2.0.exe");
    }
}
