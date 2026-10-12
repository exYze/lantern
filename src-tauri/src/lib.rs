mod android_update;
mod db;
mod fs_tools;
mod http;
mod mcp_stdio;
mod secrets;
mod shell;
mod updates;

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    os: &'static str,
    arch: &'static str,
    mobile: bool,
    version: &'static str,
    shell: Option<String>,
    secret_backend: &'static str,
    hostname: Option<String>,
}

/// The computer's name, used to label this device on the user's hub.
fn hostname() -> Option<String> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return None;
    }
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !name.is_empty() {
            return Some(name);
        }
    }
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        mobile: cfg!(any(target_os = "android", target_os = "ios")),
        version: env!("CARGO_PKG_VERSION"),
        shell: shell::shell_info(),
        secret_backend: secrets::secret_backend(),
        hostname: hostname(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android_update::init());
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(db::Db::open(&dir.join("lantern.db"))?);
            app.manage(http::HttpState::new());
            app.manage(shell::ShellState::default());
            app.manage(mcp_stdio::McpState::default());
            app.manage(updates::PendingUpdate::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platform_info,
            db::db_put,
            db::db_get,
            db::db_list,
            db::db_delete,
            db::db_clear,
            db::db_search,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            http::http_request,
            http::http_stream,
            http::http_cancel,
            http::web_fetch,
            fs_tools::fs_read,
            fs_tools::fs_write,
            fs_tools::fs_edit,
            fs_tools::fs_list,
            fs_tools::fs_find,
            fs_tools::fs_grep,
            fs_tools::fs_delete,
            fs_tools::default_workspace,
            shell::shell_run,
            shell::shell_cancel,
            mcp_stdio::mcp_spawn,
            mcp_stdio::mcp_send,
            mcp_stdio::mcp_kill,
            updates::update_check,
            updates::update_install,
            android_update::apk_download,
            android_update::apk_installer_status,
            android_update::apk_open_install_settings,
            android_update::apk_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lantern");
}
