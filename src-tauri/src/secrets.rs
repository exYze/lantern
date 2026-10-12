//! Write-only secrets (API keys, bot secrets). Stored in the OS keychain where
//! one is available, otherwise in the app-private database.

use crate::db::Db;
use tauri::State;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "ios"))]
mod keychain {
    const SERVICE: &str = "Lantern";

    pub fn set(key: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, key)
            .and_then(|e| e.set_password(value))
            .map_err(|e| e.to_string())
    }

    pub fn get(key: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, key).ok()?.get_password().ok()
    }

    pub fn delete(key: &str) {
        if let Ok(entry) = keyring::Entry::new(SERVICE, key) {
            let _ = entry.delete_credential();
        }
    }

    pub const NAME: &str = "keychain";
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "ios")))]
mod keychain {
    pub fn set(_key: &str, _value: &str) -> Result<(), String> {
        Err("no keychain on this platform".into())
    }

    pub fn get(_key: &str) -> Option<String> {
        None
    }

    pub fn delete(_key: &str) {}

    pub const NAME: &str = "app-storage";
}

#[tauri::command]
pub async fn secret_set(db: State<'_, Db>, key: String, value: String) -> Result<(), String> {
    if keychain::set(&key, &value).is_ok() {
        return db.secret_delete(&key);
    }
    db.secret_set(&key, &value)
}

#[tauri::command]
pub async fn secret_get(db: State<'_, Db>, key: String) -> Result<Option<String>, String> {
    if let Some(v) = keychain::get(&key) {
        return Ok(Some(v));
    }
    db.secret_get(&key)
}

#[tauri::command]
pub async fn secret_delete(db: State<'_, Db>, key: String) -> Result<(), String> {
    keychain::delete(&key);
    db.secret_delete(&key)
}

#[tauri::command]
pub fn secret_backend() -> &'static str {
    keychain::NAME
}
