//! A small JSON document store on SQLite. The frontend owns the schema; Rust
//! only stores `(collection, id) -> json` rows and a private secrets table.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

pub struct Db(Mutex<Connection>);

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS docs (
               collection TEXT NOT NULL,
               id TEXT NOT NULL,
               data TEXT NOT NULL,
               updated_at INTEGER NOT NULL,
               PRIMARY KEY (collection, id)
             );
             CREATE TABLE IF NOT EXISTS secrets (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );",
        )?;
        Ok(Self(Mutex::new(conn)))
    }

    fn conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.0.lock().map_err(err)
    }

    pub fn secret_get(&self, key: &str) -> Result<Option<String>, String> {
        self.conn()?
            .query_row("SELECT value FROM secrets WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .map_err(err)
    }

    pub fn secret_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn()?
            .execute(
                "INSERT INTO secrets (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn secret_delete(&self, key: &str) -> Result<(), String> {
        self.conn()?
            .execute("DELETE FROM secrets WHERE key = ?1", params![key])
            .map(|_| ())
            .map_err(err)
    }
}

fn parse(data: String) -> Value {
    serde_json::from_str(&data).unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn db_put(db: State<'_, Db>, collection: String, id: String, data: Value) -> Result<(), String> {
    db.conn()?
        .execute(
            "INSERT INTO docs (collection, id, data, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            params![collection, id, data.to_string(), now_ms()],
        )
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
pub async fn db_get(db: State<'_, Db>, collection: String, id: String) -> Result<Option<Value>, String> {
    db.conn()?
        .query_row(
            "SELECT data FROM docs WHERE collection = ?1 AND id = ?2",
            params![collection, id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map(|o| o.map(parse))
        .map_err(err)
}

/// Lists a collection in insertion order (rowid is kept across upserts).
#[tauri::command]
pub async fn db_list(db: State<'_, Db>, collection: String) -> Result<Vec<Value>, String> {
    let conn = db.conn()?;
    let mut stmt = conn
        .prepare("SELECT data FROM docs WHERE collection = ?1 ORDER BY rowid ASC")
        .map_err(err)?;
    let rows = stmt
        .query_map(params![collection], |r| r.get::<_, String>(0))
        .map_err(err)?;
    rows.map(|r| r.map(parse).map_err(err)).collect()
}

#[tauri::command]
pub async fn db_delete(db: State<'_, Db>, collection: String, id: String) -> Result<(), String> {
    db.conn()?
        .execute("DELETE FROM docs WHERE collection = ?1 AND id = ?2", params![collection, id])
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
pub async fn db_clear(db: State<'_, Db>, collection: String) -> Result<(), String> {
    db.conn()?
        .execute("DELETE FROM docs WHERE collection = ?1", params![collection])
        .map(|_| ())
        .map_err(err)
}

#[derive(Serialize)]
pub struct SearchHit {
    collection: String,
    id: String,
    data: Value,
}

/// Case-insensitive substring search over every collection starting with `prefix`.
#[tauri::command]
pub async fn db_search(
    db: State<'_, Db>,
    prefix: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<SearchHit>, String> {
    let escape = |s: &str| s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let conn = db.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT collection, id, data FROM docs
             WHERE collection LIKE ?1 ESCAPE '\\' AND data LIKE ?2 ESCAPE '\\'
             ORDER BY updated_at DESC LIMIT ?3",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map(
            params![
                format!("{}%", escape(&prefix)),
                format!("%{}%", escape(&query)),
                limit.unwrap_or(50)
            ],
            |r| {
                Ok(SearchHit {
                    collection: r.get(0)?,
                    id: r.get(1)?,
                    data: parse(r.get(2)?),
                })
            },
        )
        .map_err(err)?;
    rows.map(|r| r.map_err(err)).collect()
}
