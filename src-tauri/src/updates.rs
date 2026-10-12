//! Desktop auto-updates from the user's Lantern Hub. The hub serves a Tauri
//! update manifest; each installer's signature is checked against the public key
//! in tauri.conf.json before it is installed. The endpoint comes from the app
//! (the hub it is connected to), so no server address is baked into the build.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum UpdateProgress {
    Progress { downloaded: u64, total: Option<u64> },
    Installing,
}

#[cfg(desktop)]
mod imp {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;
    use tauri_plugin_updater::{Update, UpdaterExt};

    #[derive(Default)]
    pub struct PendingUpdate(Mutex<Option<Update>>);

    fn err(e: impl std::fmt::Display) -> String {
        e.to_string()
    }

    pub async fn check(app: &AppHandle, pending: &PendingUpdate, endpoint: &str) -> Result<Option<UpdateInfo>, String> {
        let url = endpoint.parse().map_err(|e| format!("bad update URL {endpoint}: {e}"))?;
        let update = app
            .updater_builder()
            .endpoints(vec![url])
            .map_err(err)?
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(err)?
            .check()
            .await
            .map_err(err)?;
        let info = update.as_ref().map(|u| UpdateInfo {
            version: u.version.clone(),
            current_version: u.current_version.clone(),
            notes: u.body.clone(),
            date: u.date.map(|d| d.to_string()),
        });
        *pending.0.lock().map_err(err)? = update;
        Ok(info)
    }

    pub async fn install(app: &AppHandle, pending: &PendingUpdate, on_event: Channel<UpdateProgress>) -> Result<(), String> {
        // Cloned, not taken: if the install fails, "Restart to update" can try again.
        let update = pending.0.lock().map_err(err)?.clone().ok_or("No update has been found yet.")?;
        let mut downloaded = 0u64;
        let progress = on_event.clone();
        update
            .download_and_install(
                move |chunk, total| {
                    downloaded += chunk as u64;
                    let _ = progress.send(UpdateProgress::Progress { downloaded, total });
                },
                move || {
                    let _ = on_event.send(UpdateProgress::Installing);
                },
            )
            .await
            .map_err(err)?;
        // Windows installers exit the app themselves; elsewhere restart into the new version.
        app.restart();
    }
}

#[cfg(desktop)]
pub use imp::PendingUpdate;

#[cfg(mobile)]
#[derive(Default)]
pub struct PendingUpdate;

#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>, endpoint: String) -> Result<Option<UpdateInfo>, String> {
    #[cfg(desktop)]
    return imp::check(&app, &pending, &endpoint).await;
    #[cfg(mobile)]
    {
        let _ = (app, pending, endpoint);
        Err("In-app updates are only available on desktop.".into())
    }
}

#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, PendingUpdate>, on_event: Channel<UpdateProgress>) -> Result<(), String> {
    #[cfg(desktop)]
    return imp::install(&app, &pending, on_event).await;
    #[cfg(mobile)]
    {
        let _ = (app, pending, on_event);
        Err("In-app updates are only available on desktop.".into())
    }
}
