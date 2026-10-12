//! Runs shell commands for bots (desktop only; see `lantern_tools::shell`).

use lantern_tools::shell::{ShellRequest, ShellResult, ShellRunner};
use tauri::State;

#[derive(Default)]
pub struct ShellState(ShellRunner);

/// The shell bots get, shown to the model in its system prompt.
#[tauri::command]
pub fn shell_info() -> Option<String> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        None
    } else {
        Some(lantern_tools::shell::shell_name())
    }
}

#[tauri::command]
pub fn shell_cancel(state: State<'_, ShellState>, id: String) {
    state.0.cancel(&id);
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn shell_run(_state: State<'_, ShellState>, _request: ShellRequest) -> Result<ShellResult, String> {
    Err("Running shell commands is not available on mobile.".into())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn shell_run(state: State<'_, ShellState>, request: ShellRequest) -> Result<ShellResult, String> {
    state.0.run(request).await
}
