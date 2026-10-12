//! File tools for bots (see `lantern_tools::fs`). On mobile every path must stay
//! inside the workspace (the app sandbox), and so must a call with `confine`
//! (an isolated subagent's folder); otherwise the approval flow in the frontend
//! decides what is allowed.

use lantern_tools::fs::{self, DirEntry, Edit, GrepRequest, ReadResult};
use tauri::{AppHandle, Manager};

fn restricted() -> bool {
    cfg!(any(target_os = "android", target_os = "ios"))
}

fn confined(confine: Option<bool>) -> bool {
    restricted() || confine.unwrap_or(false)
}

#[tauri::command]
pub async fn fs_read(root: String, path: String, offset: Option<usize>, limit: Option<usize>, confine: Option<bool>) -> Result<ReadResult, String> {
    fs::read(&root, &path, offset, limit, confined(confine))
}

#[tauri::command]
pub async fn fs_write(root: String, path: String, content: String, confine: Option<bool>) -> Result<String, String> {
    fs::write(&root, &path, &content, confined(confine))
}

#[tauri::command]
pub async fn fs_edit(root: String, path: String, edits: Vec<Edit>, confine: Option<bool>) -> Result<String, String> {
    fs::edit(&root, &path, &edits, confined(confine))
}

#[tauri::command]
pub async fn fs_list(root: String, path: Option<String>, confine: Option<bool>) -> Result<Vec<DirEntry>, String> {
    fs::list(&root, path.as_deref(), confined(confine))
}

#[tauri::command]
pub async fn fs_find(root: String, pattern: String, path: Option<String>, limit: Option<usize>, confine: Option<bool>) -> Result<Vec<String>, String> {
    fs::find(&root, &pattern, path.as_deref(), limit, confined(confine))
}

#[tauri::command]
pub async fn fs_grep(request: GrepRequest, confine: Option<bool>) -> Result<String, String> {
    fs::grep(&request, confined(confine))
}

#[tauri::command]
pub async fn fs_delete(root: String, path: String, confine: Option<bool>) -> Result<String, String> {
    fs::delete(&root, &path, confined(confine))
}

/// Returns (and creates) the default workspace folder for bots.
#[tauri::command]
pub fn default_workspace(app: AppHandle) -> Result<String, String> {
    let dir = if restricted() {
        app.path().app_data_dir().map_err(|e| e.to_string())?.join("workspace")
    } else {
        app.path()
            .document_dir()
            .or_else(|_| app.path().home_dir())
            .map_err(|e| e.to_string())?
            .join("Lantern")
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}
