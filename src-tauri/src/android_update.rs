//! Android app updates. Lantern downloads the new APK from the user's hub, checks it
//! against the SHA-256 in the hub's manifest, and hands it to Android's package
//! installer (UpdateInstallerPlugin.kt). Android itself refuses an APK that isn't
//! signed with the same key as the installed app.

use crate::http::HttpState;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};

#[derive(Serialize, Clone)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum ApkProgress {
    Progress { downloaded: u64, total: Option<u64> },
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallerStatus {
    /// Android lets Lantern install apps ("Install unknown apps" is on).
    pub can_install: bool,
    /// Updates go in without a prompt: Lantern installed itself last time (Android 12+).
    pub silent: bool,
    pub installer: String,
    pub sdk: i32,
}

fn sha256_file(path: &std::path::Path) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    let mut file = std::fs::File::open(path)?;
    std::io::copy(&mut file, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Downloads an update into the app's cache and returns its path once its checksum matches.
#[tauri::command]
pub async fn apk_download(app: AppHandle, http: State<'_, HttpState>, url: String, sha256: String, version: String, on_event: Channel<ApkProgress>) -> Result<String, String> {
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err(format!("unexpected version {version:?}"));
    }
    let expected = sha256.trim().to_ascii_lowercase();
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("Lantern_{version}.apk"));
    if path.exists() && sha256_file(&path).map_err(|e| e.to_string())? == expected {
        return Ok(path.to_string_lossy().into_owned());
    }
    // Older downloads are no longer needed.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }

    let resp = http.client.get(&url).send().await.map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let part = dir.join(format!("Lantern_{version}.apk.part"));
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut reported = 0u64;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download failed: {e}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if downloaded - reported >= 512 * 1024 {
            reported = downloaded;
            let _ = on_event.send(ApkProgress::Progress { downloaded, total });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if format!("{:x}", hasher.finalize()) != expected {
        let _ = std::fs::remove_file(&part);
        return Err("The download doesn't match the checksum your hub published, so it wasn't installed.".into());
    }
    std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(target_os = "android")]
mod imp {
    use super::*;
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("update-installer")
            .setup(|app, api| {
                let handle = api.register_android_plugin("dev.lantern.bots", "UpdateInstallerPlugin")?;
                app.manage(handle);
                Ok(())
            })
            .build()
    }

    #[derive(Serialize)]
    struct InstallArgs {
        path: String,
    }

    pub fn handle<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, PluginHandle<R>>, String> {
        app.try_state::<PluginHandle<R>>().ok_or_else(|| "the update installer isn't available".to_string())
    }

    pub fn status<R: Runtime>(app: &AppHandle<R>) -> Result<InstallerStatus, String> {
        handle(app)?.run_mobile_plugin("status", ()).map_err(|e| e.to_string())
    }

    pub fn open_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        handle(app)?.run_mobile_plugin::<()>("openInstallSettings", ()).map_err(|e| e.to_string())
    }

    pub fn install<R: Runtime>(app: &AppHandle<R>, path: String) -> Result<(), String> {
        handle(app)?.run_mobile_plugin::<()>("install", InstallArgs { path }).map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "android")]
pub use imp::init;

#[tauri::command]
pub fn apk_installer_status<R: Runtime>(app: AppHandle<R>) -> Result<InstallerStatus, String> {
    #[cfg(target_os = "android")]
    return imp::status(&app);
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("App installs are only for Android.".into())
    }
}

#[tauri::command]
pub fn apk_open_install_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return imp::open_settings(&app);
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("App installs are only for Android.".into())
    }
}

#[tauri::command]
pub async fn apk_install<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return imp::install(&app, path);
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, path);
        Err("App installs are only for Android.".into())
    }
}
