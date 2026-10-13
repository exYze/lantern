//! Webhooks that start routines: `POST /hooks/<routine id>/<key>`. The call is
//! stored as an `events` document; the runner (or an open app) picks it up and
//! runs the routine with the request's body. Routines can also require a
//! signature (GitHub, Gitea, Linear, Sentry and GitLab styles) with a signing
//! secret the user saves in the app.

use crate::api::{HubEvent, Shared};
use crate::store::{now_ms, Change};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use rand::Rng;
use serde_json::{json, Map, Value};
use sha2::Sha256;

const MAX_BODY: usize = 1024 * 1024;
const STORED_BODY: usize = 256 * 1024;
const CALLS_PER_MINUTE: u32 = 30;

pub fn router(hub: Shared) -> Router {
    Router::new()
        .route("/hooks/{id}", post(with_header_key))
        .route("/hooks/{id}/{key}", post(with_path_key))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(hub)
}

type Reply = (StatusCode, Json<Value>);

fn reply(status: StatusCode, message: &str) -> Reply {
    (status, Json(json!({ "error": message })))
}

async fn with_path_key(State(hub): State<Shared>, Path((id, key)): Path<(String, String)>, headers: HeaderMap, RawQuery(query): RawQuery, body: Bytes) -> Reply {
    accept(&hub, &id, &key, &headers, query, &body)
}

async fn with_header_key(State(hub): State<Shared>, Path(id): Path<String>, headers: HeaderMap, RawQuery(query): RawQuery, body: Bytes) -> Reply {
    let key = headers.get("x-lantern-key").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    accept(&hub, &id, &key, &headers, query, &body)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// Checks the request against the routine's signing secret, in whichever style the sender uses.
pub fn signature_ok(headers: &HeaderMap, body: &[u8], secret: &str) -> bool {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim);
    // GitLab sends the secret itself rather than a signature.
    if let Some(token) = header("x-gitlab-token") {
        return constant_time_eq(token.as_bytes(), secret.as_bytes());
    }
    let candidates = [
        header("x-hub-signature-256").and_then(|v| v.strip_prefix("sha256=")),
        header("x-lantern-signature").and_then(|v| v.strip_prefix("sha256=")),
        header("x-gitea-signature"),
        header("linear-signature"),
        header("sentry-hook-signature"),
    ];
    candidates.into_iter().flatten().any(|hex| {
        let Some(sig) = hex_decode(hex) else { return false };
        let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else { return false };
        mac.update(body);
        mac.verify_slice(&sig).is_ok()
    })
}

/// The headers worth showing the bot: what sent it and what kind of event it is. Never credentials.
fn interesting_headers(headers: &HeaderMap) -> Map<String, Value> {
    let prefixes = ["x-github-", "x-gitlab-", "x-gitea-", "linear-", "sentry-", "x-pagerduty-", "x-event-", "x-request-id"];
    let mut out = Map::new();
    for (name, value) in headers {
        let n = name.as_str();
        let keep = n == "content-type" || n == "user-agent" || (prefixes.iter().any(|p| n.starts_with(p)) && !n.contains("signature") && !n.contains("token"));
        if keep {
            if let Ok(v) = value.to_str() {
                out.insert(n.to_string(), Value::String(v.chars().take(500).collect()));
            }
        }
    }
    out
}

fn accept(hub: &Shared, id: &str, key: &str, headers: &HeaderMap, query: Option<String>, body: &[u8]) -> Reply {
    let not_found = || reply(StatusCode::NOT_FOUND, "No such webhook.");
    let Some(routine) = hub.store.get_doc("routines", id) else { return not_found() };
    let trigger = &routine["trigger"];
    let expected = trigger["key"].as_str().unwrap_or_default();
    if trigger["kind"] != "webhook" || expected.is_empty() || !constant_time_eq(expected.as_bytes(), key.as_bytes()) {
        return not_found();
    }
    if routine["enabled"] == Value::Bool(false) {
        return reply(StatusCode::CONFLICT, "This routine is paused.");
    }
    {
        let mut calls = hub.hook_calls.lock().unwrap_or_else(|e| e.into_inner());
        let now = now_ms();
        let entry = calls.entry(id.to_string()).or_insert((now, 0));
        if now - entry.0 > 60_000 {
            *entry = (now, 0);
        }
        entry.1 += 1;
        if entry.1 > CALLS_PER_MINUTE {
            return reply(StatusCode::TOO_MANY_REQUESTS, "Too many calls; try again in a minute.");
        }
    }
    if let Some(secret) = hub.store.get_doc("secret", &format!("routine:{id}:signing")).and_then(|d| d["v"].as_str().map(str::to_string)) {
        if !signature_ok(headers, body, &secret) {
            return reply(StatusCode::UNAUTHORIZED, "The signature doesn't match this webhook's signing secret.");
        }
    }

    let text = String::from_utf8_lossy(&body[..body.len().min(STORED_BODY)]).into_owned();
    let event_id = format!("evt_{:016x}", rand::rng().random::<u64>());
    let event = json!({
        "id": event_id,
        "routineId": id,
        "source": "webhook",
        "receivedAt": now_ms(),
        "headers": interesting_headers(headers),
        "query": query.unwrap_or_default(),
        "body": text,
    });
    match hub.store.push("hub", &[Change { c: "events".into(), id: event_id.clone(), d: Some(event), del: false, rev: 0 }]) {
        Ok(rev) => {
            let _ = hub.events.send(HubEvent::Change { rev, device: "hub".into() });
            (StatusCode::ACCEPTED, Json(json!({ "accepted": true, "event": event_id })))
        }
        Err(e) => reply(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn sign(secret: &str, body: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body);
        mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn github_style_signatures_verify() {
        let body = br#"{"action":"opened"}"#;
        let mut h = HeaderMap::new();
        h.insert("x-hub-signature-256", HeaderValue::from_str(&format!("sha256={}", sign("s3cret", body))).unwrap());
        assert!(signature_ok(&h, body, "s3cret"));
        assert!(!signature_ok(&h, body, "other"));
        assert!(!signature_ok(&h, b"tampered", "s3cret"));
        assert!(!signature_ok(&HeaderMap::new(), body, "s3cret"));
    }

    #[test]
    fn plain_hex_and_gitlab_tokens_verify() {
        let body = b"payload";
        let mut h = HeaderMap::new();
        h.insert("linear-signature", HeaderValue::from_str(&sign("k", body)).unwrap());
        assert!(signature_ok(&h, body, "k"));
        let mut g = HeaderMap::new();
        g.insert("x-gitlab-token", HeaderValue::from_static("k"));
        assert!(signature_ok(&g, body, "k"));
        assert!(!signature_ok(&g, body, "nope"));
    }

    #[test]
    fn credentials_never_reach_the_bot() {
        let mut h = HeaderMap::new();
        h.insert("authorization", HeaderValue::from_static("Bearer x"));
        h.insert("x-gitlab-token", HeaderValue::from_static("x"));
        h.insert("x-github-event", HeaderValue::from_static("push"));
        let kept = interesting_headers(&h);
        assert!(kept.contains_key("x-github-event"));
        assert!(!kept.contains_key("authorization") && !kept.contains_key("x-gitlab-token"));
    }
}
