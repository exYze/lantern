mod db;
mod fs_tools;
mod http;
mod mcp_stdio;
mod secrets;
mod shell;

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
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lantern");
}
