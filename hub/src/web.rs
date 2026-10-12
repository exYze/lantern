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
use serde_json::{json, Map};
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
/// Behind `tailscale serve` (proxying to a Unix socket) Host is "localhost"; the real name
/// arrives in X-Forwarded-Host.
fn base_url(headers: &HeaderMap) -> String {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim).filter(|v| !v.is_empty());
    let host = get("x-forwarded-host").or_else(|| get(header::HOST.as_str())).unwrap_or("localhost");
    let proto = get("x-forwarded-proto").unwrap_or(if host.ends_with(".ts.net") { "https" } else { "http" });
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
        .route("/assets/archivo.woff2", get(|| async { font(ARCHIVO) }))
        .route("/assets/plex-mono.woff2", get(|| async { font(PLEX_MONO) }))
        .nest_service("/downloads", files)
        .with_state(hub)
}

// The downloads page uses Lantern's typefaces (SIL Open Font License, see hub/assets/fonts).
const ARCHIVO: &[u8] = include_bytes!("../assets/fonts/archivo.woff2");
const PLEX_MONO: &[u8] = include_bytes!("../assets/fonts/plex-mono.woff2");

fn font(bytes: &'static [u8]) -> Response {
    ([(header::CONTENT_TYPE, "font/woff2"), (header::CACHE_CONTROL, "public, max-age=604800")], bytes).into_response()
}

/// Tauri's static update manifest. Keys are `{os}-{arch}[-{installer}]`; the
/// updater picks the entry matching how the running app was installed.
async fn manifest(State(hub): State<Shared>, headers: HeaderMap) -> Response {
    match load_releases(&hub.config.releases_dir).first() {
        Some(rel) => Json(manifest_json(rel, &base_url(&headers))).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "no releases published yet" }))).into_response(),
    }
}

fn manifest_json(rel: &Release, base: &str) -> serde_json::Value {
    let mut platforms = Map::new();
    let mut add = |key: &str, f: &ReleaseFile| {
        // Tauri's updater parses every entry and requires a `signature` string in each, so entries
        // it never installs (the Android APK) get an empty one.
        let entry = json!({
            "url": file_url(base, &rel.version, &f.name),
            "signature": f.signature.clone().unwrap_or_default(),
            "sha256": f.sha256,
        });
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
    json!({ "version": rel.version, "notes": rel.notes, "pub_date": rel.pub_date, "platforms": platforms })
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
                "<p class=\"meta\"><span class=\"stamp\">Version {}</span> {}</p>",
                esc(&rel.version),
                esc(rel.pub_date.get(..10).unwrap_or(&rel.pub_date))
            ));
            if !rel.notes.trim().is_empty() {
                body.push_str(&format!("<p class=\"notes\">{}</p>", esc(rel.notes.trim())));
            }
            body.push_str("<div class=\"rows\">");
            for card in CARDS {
                let files: Vec<(&ReleaseFile, &str)> = card
                    .kinds
                    .iter()
                    .filter_map(|(kind, label)| rel.files.iter().find(|f| f.platform == card.id && f.kind == *kind).map(|f| (f, *label)))
                    .collect();
                if files.is_empty() {
                    continue;
                }
                body.push_str(&format!("<section class=\"platform\" data-os=\"{}\"><h2>{}</h2><div class=\"files\">", card.id, card.title));
                for (i, (f, label)) in files.iter().enumerate() {
                    let url = file_url("", &rel.version, &f.name);
                    body.push_str(&format!(
                        "<a class=\"{}\" href=\"{url}\" download>{label}<span>{}</span></a>",
                        if i == 0 { "btn" } else { "alt" },
                        human_size(f.size)
                    ));
                }
                body.push_str(&format!("</div><div class=\"how\"><p>{}</p><details><summary>SHA-256</summary>", card.how));
                for (f, _) in &files {
                    body.push_str(&format!("<code class=\"sum\">{}<br>{}</code>", esc(&f.name), esc(&f.sha256)));
                }
                body.push_str("</details></div></section>");
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
                    body.push_str(&format!("<li><b>{}</b>: {}</li>", esc(&r.version), links.join(" · ")));
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
@font-face {{ font-family:"Archivo"; src:url(/assets/archivo.woff2) format("woff2-variations"); font-weight:100 900; font-stretch:62% 125%; font-display:swap; }}
@font-face {{ font-family:"IBM Plex Mono"; src:url(/assets/plex-mono.woff2) format("woff2"); font-weight:400; font-display:swap; }}
:root {{ --bg:#f6f6f3; --fg:#191d1b; --muted:#5b625e; --line:#dcded8; --rule:#191d1b; --band:#1f3b2f; --band-fg:#eef2ec; --band-muted:#a8bcae; --btn:#bf4512; --btn-hover:#a33a0f; --btn-fg:#fff; --code:#ecece7; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#121614; --fg:#e6ebe7; --muted:#9ba59f; --line:#2a322e; --rule:#e6ebe7; --band:#16291f; --band-fg:#e6ece7; --band-muted:#9bb2a3; --btn:#f08a3c; --btn-hover:#f59e57; --btn-fg:#1a1006; --code:#1a1f1c; }} }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 "Archivo",system-ui,-apple-system,"Segoe UI",sans-serif; }}
code, .sum {{ font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace; }}
.band {{ background:var(--band); color:var(--band-fg); }}
.band-inner {{ max-width:1040px; margin:0 auto; padding:36px 16px 40px; display:grid; gap:18px; }}
.brand {{ display:flex; align-items:center; gap:10px; font-weight:750; font-stretch:87.5%; font-size:19px; }}
.brand svg {{ width:30px; height:30px; flex:none; }}
h1 {{ margin:0; font-size:clamp(34px,6vw,56px); line-height:1.02; font-weight:750; font-stretch:87.5%; letter-spacing:-0.01em; }}
.band p {{ margin:0; max-width:56ch; color:var(--band-muted); }}
main {{ max-width:1040px; margin:0 auto; padding:28px 16px 64px; }}
h2 {{ font-size:22px; line-height:1.15; margin:0; font-weight:700; font-stretch:87.5%; }}
.stamp {{ font-size:11px; font-weight:700; font-stretch:87.5%; text-transform:uppercase; letter-spacing:0.08em; }}
.meta {{ color:var(--muted); margin:0; }}
.meta .stamp {{ color:var(--fg); margin-right:6px; }}
.notes {{ white-space:pre-wrap; max-width:60ch; }}
.rows {{ margin-top:22px; border-top:2px solid var(--rule); }}
.platform {{ display:grid; grid-template-columns:150px minmax(220px,280px) 1fr; gap:12px 28px; padding:20px 0; border-bottom:1px solid var(--line); align-items:start; }}
.platform .here {{ display:block; margin-top:6px; color:var(--muted); }}
.files {{ display:flex; flex-direction:column; gap:8px; }}
.btn {{ display:flex; justify-content:space-between; gap:12px; padding:9px 14px; border-radius:6px; border:1.5px solid var(--fg); color:var(--fg); text-decoration:none; font-weight:650; }}
.btn:hover {{ background:var(--code); }}
.btn span {{ font-weight:400; color:var(--muted); }}
.mine .btn {{ background:var(--btn); border-color:var(--btn); color:var(--btn-fg); }}
.mine .btn:hover {{ background:var(--btn-hover); border-color:var(--btn-hover); }}
.mine .btn span {{ color:inherit; opacity:.85; }}
.alt {{ display:flex; justify-content:space-between; gap:12px; color:var(--fg); text-decoration:underline; text-underline-offset:3px; font-weight:600; padding:0 2px; }}
.alt span {{ color:var(--muted); text-decoration:none; font-weight:400; }}
.how p {{ margin:0 0 6px; font-size:14.5px; color:var(--muted); }}
.how b {{ color:var(--fg); }}
summary {{ cursor:pointer; color:var(--muted); font-size:13px; }}
code {{ font-size:13px; background:var(--code); padding:1px 5px; border-radius:3px; overflow-wrap:anywhere; }}
.sum {{ display:block; margin-top:6px; background:none; padding:0; font-size:12px; color:var(--muted); word-break:break-all; }}
.connect {{ margin-top:44px; display:grid; grid-template-columns:150px 1fr; gap:12px 28px; }}
.connect p {{ margin:0 0 10px; max-width:64ch; }}
.connect .muted {{ color:var(--muted); }}
.older {{ margin-top:28px; }}
.older ul {{ padding-left:18px; }}
.older a {{ color:var(--fg); }}
a:focus-visible {{ outline:2px solid var(--btn); outline-offset:2px; }}
@media (max-width:760px) {{ .platform, .connect {{ grid-template-columns:1fr; }} }}
</style>
</head>
<body>
<div class="band"><div class="band-inner">
<div class="brand"><svg viewBox="0 0 1024 1024" aria-hidden="true"><rect x="32" y="32" width="960" height="960" rx="196" fill="#ECEFE8" fill-opacity=".12"/><path d="M380 262 Q512 118 644 262" fill="none" stroke="#ECEFE8" stroke-width="32" stroke-linecap="round"/><path d="M404 250 H620 L684 326 H340 Z" fill="#ECEFE8"/><rect x="384" y="356" width="256" height="350" rx="104" fill="#F4DDAA"/><rect x="338" y="340" width="30" height="392" rx="15" fill="#ECEFE8"/><rect x="656" y="340" width="30" height="392" rx="15" fill="#ECEFE8"/><path d="M512 410 C566 480 576 560 512 622 C448 560 458 480 512 410 Z" fill="#E8630A"/><rect x="330" y="706" width="364" height="96" rx="22" fill="#ECEFE8"/></svg>Lantern</div>
<h1>{name}</h1>
<p>Lantern for every device you own. Each one you connect to this hub gets the same bots, chats, memories, skills and workspace.</p>
</div></div>
<main>
{body}
<section class="connect">
<h2>Connect a device</h2>
<div>
<p>Open Lantern and choose <b>Connect to a Lantern Hub</b>, or go to <b>Settings → Hub</b>. The address is <code>{hub_url}</code></p>
<p class="muted">Devices signed in to the hub owner's Tailscale account connect with one tap. Anything else needs a pairing code from a device that's already connected (Settings → Hub → Add a device).</p>
</div>
</section>
</main>
<script>
(function () {{
  var ua = navigator.userAgent, os = /Android/i.test(ua) ? "android" : /iPhone|iPad/i.test(ua) ? "ios" : /Mac/i.test(ua) ? "macos" : /Win/i.test(ua) ? "windows" : /Linux/i.test(ua) ? "linux" : "";
  var row = document.querySelector('[data-os="' + os + '"]');
  if (row) {{
    var note = document.createElement("span");
    note.className = "stamp here";
    note.textContent = "This device";
    row.querySelector("h2").appendChild(note);
    row.classList.add("mine");
    row.parentNode.insertBefore(row, row.parentNode.firstChild);
  }}
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
    fn every_manifest_entry_has_a_signature() {
        // Tauri rejects the whole manifest if any platform entry lacks a `signature` string.
        let file = |name: &str, platform: &str, kind: &str, sig: Option<&str>| ReleaseFile {
            name: name.into(),
            platform: platform.into(),
            kind: kind.into(),
            arch: String::new(),
            size: 1,
            sha256: "00".into(),
            signature: sig.map(str::to_string),
        };
        let release = Release {
            version: "1.0.0".into(),
            notes: String::new(),
            pub_date: "2026-01-01T00:00:00Z".into(),
            files: vec![file("a.exe", "windows", "nsis", Some("sig")), file("a.apk", "android", "apk", None)],
        };
        let m = manifest_json(&release, "https://hub");
        let platforms = m["platforms"].as_object().unwrap();
        assert!(platforms.contains_key("windows-x86_64-nsis") && platforms.contains_key("android-universal"));
        for (key, entry) in platforms {
            assert!(entry["signature"].is_string(), "{key} has no signature field");
        }
        assert_eq!(platforms["android-universal"]["url"], "https://hub/downloads/1.0.0/a.apk");
    }

    #[test]
    fn base_url_prefers_the_forwarded_host() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "localhost".parse().unwrap());
        h.insert("x-forwarded-host", "lantern.example.ts.net".parse().unwrap());
        h.insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(base_url(&h), "https://lantern.example.ts.net");
        let mut lan = HeaderMap::new();
        lan.insert(header::HOST, "10.0.0.5".parse().unwrap());
        assert_eq!(base_url(&lan), "http://10.0.0.5");
    }

    #[test]
    fn file_urls_are_encoded() {
        assert_eq!(file_url("https://h", "0.2.0", "Lantern 0.2.0.exe"), "https://h/downloads/0.2.0/Lantern%200.2.0.exe");
    }
}
