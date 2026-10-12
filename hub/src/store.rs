//! The hub database: synced documents with a global revision counter, paired
//! devices, one-time pairing codes and short leases (so a routine runs on only
//! one device).

use rand::Rng;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn random_token(bytes: usize) -> String {
    use base64::Engine;
    let mut buf = vec![0u8; bytes];
    rand::rng().fill(&mut buf[..]);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// Codes avoid look-alike characters (0/O, 1/I/L) so they're easy to type on a phone.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

fn normalize_code(code: &str) -> String {
    code.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

pub struct Store(Mutex<Connection>);

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Change {
    /// Collection.
    pub c: String,
    pub id: String,
    /// Document body; absent for deletions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub d: Option<Value>,
    #[serde(default)]
    pub del: bool,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rev: i64,
}

fn is_zero(v: &i64) -> bool {
    *v == 0
}

#[derive(Serialize, Debug)]
pub struct ChangePage {
    pub changes: Vec<Change>,
    /// Pass this as `since` next time.
    pub cursor: i64,
    pub more: bool,
    #[serde(rename = "hubId")]
    pub hub_id: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub created_at: i64,
    pub last_seen: i64,
    pub paired_via: String,
}

pub fn valid_collection(c: &str) -> bool {
    !c.is_empty()
        && c.len() <= 120
        && c.chars().next().is_some_and(|ch| ch.is_ascii_lowercase())
        && c.chars().all(|ch| ch.is_ascii_alphanumeric() || "_:-.".contains(ch))
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 240 && !id.chars().any(|c| c.is_control())
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS docs (
               collection TEXT NOT NULL,
               id TEXT NOT NULL,
               data TEXT,
               deleted INTEGER NOT NULL DEFAULT 0,
               rev INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               device TEXT NOT NULL DEFAULT '',
               PRIMARY KEY (collection, id)
             );
             CREATE INDEX IF NOT EXISTS docs_rev ON docs(rev);
             CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS devices (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               platform TEXT NOT NULL,
               token_hash TEXT NOT NULL UNIQUE,
               created_at INTEGER NOT NULL,
               last_seen INTEGER NOT NULL,
               paired_via TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS pair_codes (
               code_hash TEXT PRIMARY KEY,
               expires_at INTEGER NOT NULL,
               created_by TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS leases (
               key TEXT PRIMARY KEY,
               holder TEXT NOT NULL,
               expires_at INTEGER NOT NULL
             );",
        )?;
        conn.execute("INSERT OR IGNORE INTO kv (key, value) VALUES ('hub_id', ?1)", params![random_token(12)])?;
        conn.execute("INSERT OR IGNORE INTO kv (key, value) VALUES ('rev', '0')", [])?;
        Ok(Store(Mutex::new(conn)))
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A panic while holding the lock leaves the connection usable; recover it.
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn kv(conn: &Connection, key: &str) -> rusqlite::Result<String> {
        conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| r.get(0))
    }

    pub fn hub_id(&self) -> String {
        Self::kv(&self.conn(), "hub_id").unwrap_or_default()
    }

    pub fn current_rev(&self) -> i64 {
        Self::kv(&self.conn(), "rev").ok().and_then(|v| v.parse().ok()).unwrap_or(0)
    }

    // ------------------------------------------------------------ documents

    /// Stores changes from `device`; the last write wins. Returns the new revision.
    pub fn push(&self, device: &str, changes: &[Change]) -> Result<i64, String> {
        for ch in changes {
            if !valid_collection(&ch.c) || !valid_id(&ch.id) {
                return Err(format!("invalid document key {}/{}", ch.c, ch.id));
            }
        }
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut rev: i64 = Self::kv(&tx, "rev").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        let now = now_ms();
        for ch in changes {
            rev += 1;
            let deleted = ch.del || ch.d.is_none();
            let data = if deleted { None } else { ch.d.as_ref().map(|d| d.to_string()) };
            tx.execute(
                "INSERT INTO docs (collection, id, data, deleted, rev, updated_at, device) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted,
                   rev = excluded.rev, updated_at = excluded.updated_at, device = excluded.device",
                params![ch.c, ch.id, data, deleted as i64, rev, now, device],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute("UPDATE kv SET value = ?1 WHERE key = 'rev'", params![rev.to_string()]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(rev)
    }

    /// Changes after `since`, oldest first. The caller's own writes are skipped
    /// (it already has them) but still advance the cursor.
    pub fn changes(&self, since: i64, limit: usize, device: &str) -> Result<ChangePage, String> {
        let conn = self.conn();
        let hub_id = Self::kv(&conn, "hub_id").unwrap_or_default();
        let mut stmt = conn
            .prepare("SELECT collection, id, data, deleted, rev, device FROM docs WHERE rev > ?1 ORDER BY rev ASC LIMIT ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![since, limit as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)? != 0,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut changes = Vec::new();
        let mut cursor = since;
        let mut scanned = 0usize;
        for row in rows {
            let (c, id, data, del, rev, from) = row.map_err(|e| e.to_string())?;
            scanned += 1;
            cursor = rev;
            if from == device {
                continue;
            }
            let d = data.and_then(|s| serde_json::from_str(&s).ok());
            changes.push(Change { c, id, d: if del { None } else { d }, del, rev });
        }
        Ok(ChangePage { changes, cursor, more: scanned == limit, hub_id })
    }

    // ------------------------------------------------------------ devices

    /// Registers a device and returns (device id, bearer token). Only the token's hash is stored.
    pub fn add_device(&self, name: &str, platform: &str, via: &str) -> Result<(String, String), String> {
        let id = format!("dev_{}", random_token(9));
        let token = format!("lh_{}", random_token(32));
        let now = now_ms();
        self.conn()
            .execute(
                "INSERT INTO devices (id, name, platform, token_hash, created_at, last_seen, paired_via) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
                params![id, name.chars().take(80).collect::<String>(), platform.chars().take(40).collect::<String>(), sha256_hex(&token), now, via],
            )
            .map_err(|e| e.to_string())?;
        Ok((id, token))
    }

    pub fn device_for_token(&self, token: &str) -> Option<Device> {
        let conn = self.conn();
        let device = conn
            .query_row(
                "SELECT id, name, platform, created_at, last_seen, paired_via FROM devices WHERE token_hash = ?1",
                params![sha256_hex(token)],
                |r| {
                    Ok(Device {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        platform: r.get(2)?,
                        created_at: r.get(3)?,
                        last_seen: r.get(4)?,
                        paired_via: r.get(5)?,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()?;
        let now = now_ms();
        if now - device.last_seen > 60_000 {
            let _ = conn.execute("UPDATE devices SET last_seen = ?1 WHERE id = ?2", params![now, device.id]);
        }
        Some(device)
    }

    pub fn devices(&self) -> Result<Vec<Device>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT id, name, platform, created_at, last_seen, paired_via FROM devices ORDER BY last_seen DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Device {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    platform: r.get(2)?,
                    created_at: r.get(3)?,
                    last_seen: r.get(4)?,
                    paired_via: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.map(|r| r.map_err(|e| e.to_string())).collect()
    }

    pub fn remove_device(&self, id: &str) -> Result<bool, String> {
        self.conn().execute("DELETE FROM devices WHERE id = ?1", params![id]).map(|n| n > 0).map_err(|e| e.to_string())
    }

    pub fn rename_device(&self, id: &str, name: &str) -> Result<(), String> {
        self.conn()
            .execute("UPDATE devices SET name = ?1 WHERE id = ?2", params![name.chars().take(80).collect::<String>(), id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    // ------------------------------------------------------------ pairing codes

    /// Creates a one-time pairing code like `K7QM-4XRP`.
    pub fn create_pair_code(&self, ttl_ms: i64, created_by: &str) -> Result<(String, i64), String> {
        let mut rng = rand::rng();
        let raw: String = (0..8).map(|_| CODE_ALPHABET[rng.random_range(0..CODE_ALPHABET.len())] as char).collect();
        let expires = now_ms() + ttl_ms;
        let conn = self.conn();
        conn.execute("DELETE FROM pair_codes WHERE expires_at < ?1", params![now_ms()]).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO pair_codes (code_hash, expires_at, created_by) VALUES (?1, ?2, ?3)",
            params![sha256_hex(&raw), expires, created_by],
        )
        .map_err(|e| e.to_string())?;
        Ok((format!("{}-{}", &raw[..4], &raw[4..]), expires))
    }

    /// Consumes a pairing code. Returns true if it was valid and unexpired.
    pub fn redeem_pair_code(&self, code: &str) -> bool {
        let hash = sha256_hex(&normalize_code(code));
        let conn = self.conn();
        let expires: Option<i64> = conn
            .query_row("SELECT expires_at FROM pair_codes WHERE code_hash = ?1", params![hash], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        let _ = conn.execute("DELETE FROM pair_codes WHERE code_hash = ?1", params![hash]);
        expires.is_some_and(|e| e >= now_ms())
    }

    // ------------------------------------------------------------ leases

    /// Grants `key` to `holder` unless someone else holds an unexpired lease.
    pub fn lease(&self, key: &str, holder: &str, ttl_ms: i64) -> Result<bool, String> {
        let now = now_ms();
        let conn = self.conn();
        conn.execute("DELETE FROM leases WHERE expires_at < ?1", params![now]).map_err(|e| e.to_string())?;
        let current: Option<String> = conn
            .query_row("SELECT holder FROM leases WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        match current {
            Some(h) if h != holder => Ok(false),
            _ => {
                conn.execute(
                    "INSERT INTO leases (key, holder, expires_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at",
                    params![key, holder, now + ttl_ms],
                )
                .map_err(|e| e.to_string())?;
                Ok(true)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> Store {
        Store::open(Path::new(":memory:")).unwrap()
    }

    fn put(c: &str, id: &str, d: Value) -> Change {
        Change { c: c.into(), id: id.into(), d: Some(d), del: false, rev: 0 }
    }

    #[test]
    fn changes_flow_between_devices_and_skip_own_writes() {
        let s = store();
        let r1 = s.push("A", &[put("bots", "b1", json!({"name": "Lumi"}))]).unwrap();
        assert_eq!(r1, 1);
        // A doesn't get its own write back, but its cursor moves past it.
        let a = s.changes(0, 100, "A").unwrap();
        assert!(a.changes.is_empty());
        assert_eq!(a.cursor, 1);
        // B sees it.
        let b = s.changes(0, 100, "B").unwrap();
        assert_eq!(b.changes.len(), 1);
        assert_eq!(b.changes[0].d.as_ref().unwrap()["name"], "Lumi");
    }

    #[test]
    fn last_write_wins_and_deletes_are_tombstones() {
        let s = store();
        s.push("A", &[put("bots", "b1", json!({"v": 1}))]).unwrap();
        s.push("B", &[put("bots", "b1", json!({"v": 2}))]).unwrap();
        let page = s.changes(0, 100, "C").unwrap();
        assert_eq!(page.changes.len(), 1);
        assert_eq!(page.changes[0].d.as_ref().unwrap()["v"], 2);
        s.push("A", &[Change { c: "bots".into(), id: "b1".into(), d: None, del: true, rev: 0 }]).unwrap();
        let page = s.changes(page.cursor, 100, "C").unwrap();
        assert!(page.changes[0].del && page.changes[0].d.is_none());
    }

    #[test]
    fn paging_reports_more() {
        let s = store();
        let many: Vec<Change> = (0..5).map(|i| put("msg:c1", &format!("m{i}"), json!(i))).collect();
        s.push("A", &many).unwrap();
        let p1 = s.changes(0, 2, "B").unwrap();
        assert!(p1.more);
        assert_eq!(p1.changes.len(), 2);
        let p2 = s.changes(p1.cursor, 10, "B").unwrap();
        assert!(!p2.more);
        assert_eq!(p2.changes.len(), 3);
    }

    #[test]
    fn rejects_bad_keys() {
        let s = store();
        assert!(s.push("A", &[put("Bad Collection", "x", json!(1))]).is_err());
        assert!(s.push("A", &[put("bots", "", json!(1))]).is_err());
    }

    #[test]
    fn pairing_codes_are_single_use() {
        let s = store();
        let (code, _) = s.create_pair_code(60_000, "test").unwrap();
        assert!(s.redeem_pair_code(&code.to_lowercase()));
        assert!(!s.redeem_pair_code(&code));
        let (expired, _) = s.create_pair_code(-1, "test").unwrap();
        assert!(!s.redeem_pair_code(&expired));
    }

    #[test]
    fn device_tokens_authenticate() {
        let s = store();
        let (id, token) = s.add_device("Pixel", "android", "code").unwrap();
        assert_eq!(s.device_for_token(&token).unwrap().id, id);
        assert!(s.device_for_token("lh_wrong").is_none());
        assert!(s.remove_device(&id).unwrap());
        assert!(s.device_for_token(&token).is_none());
    }

    #[test]
    fn leases_go_to_the_first_holder() {
        let s = store();
        assert!(s.lease("routine:r1:1000", "A", 60_000).unwrap());
        assert!(!s.lease("routine:r1:1000", "B", 60_000).unwrap());
        assert!(s.lease("routine:r1:1000", "A", 60_000).unwrap());
    }
}
