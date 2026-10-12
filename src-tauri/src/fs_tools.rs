//! File tools for bots (see `lantern_tools::fs`). On mobile every path must stay
//! inside the workspace (the app sandbox); on desktop the approval flow in the
//! frontend decides what is allowed.

use lantern_tools::fs::{self, DirEntry, Edit, GrepRequest, ReadResult};
use tauri::{AppHandle, Manager};

fn restricted() -> bool {
    cfg!(any(target_os = "android", target_os = "ios"))
}

#[tauri::command]
pub async fn fs_read(root: String, path: String, offset: Option<usize>, limit: Option<usize>) -> Result<ReadResult, String> {
    fs::read(&root, &path, offset, limit, restricted())
}

#[tauri::command]
pub async fn fs_write(root: String, path: String, content: String) -> Result<String, String> {
    fs::write(&root, &path, &content, restricted())
}

#[tauri::command]
pub async fn fs_edit(root: String, path: String, edits: Vec<Edit>) -> Result<String, String> {
    fs::edit(&root, &path, &edits, restricted())
}

#[tauri::command]
pub async fn fs_list(root: String, path: Option<String>) -> Result<Vec<DirEntry>, String> {
    fs::list(&root, path.as_deref(), restricted())
}

#[tauri::command]
pub async fn fs_find(root: String, pattern: String, path: Option<String>, limit: Option<usize>) -> Result<Vec<String>, String> {
    fs::find(&root, &pattern, path.as_deref(), limit, restricted())
}

#[tauri::command]
pub async fn fs_grep(request: GrepRequest) -> Result<String, String> {
    fs::grep(&request, restricted())
}

#[tauri::command]
pub async fn fs_delete(root: String, path: String) -> Result<String, String> {
    fs::delete(&root, &path, restricted())
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
