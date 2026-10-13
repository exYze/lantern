//! The hub's HTTP API (`/api/v1`). Every route except `info` and `pair` needs a
//! device token: `Authorization: Bearer lh_…`.

use crate::agent::{ToolRequest, Tools};
use crate::config::Config;
use crate::store::{now_ms, Change, Device, Store};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

/// What devices hear on `/api/v1/events`.
#[derive(Clone, Debug)]
pub enum HubEvent {
    /// Documents changed: a device (or the hub itself) pushed revision `rev`.
    Change { rev: i64, device: String },
    /// A reply the runner is still writing (not stored until it's done).
    Live { device: String, message: Value },
    /// A notification from the runner for devices that aren't looking.
    Notify { title: String, body: String },
    /// The runner came online or went away.
    Runner(Value),
}

/// The runner: the hub's always-on device that runs bots while no app is open.
#[derive(Clone, Debug)]
pub struct RunnerState {
    pub device: String,
    pub version: String,
    pub last_seen: i64,
    /// Whether devices were last told it's online.
    pub announced: bool,
}

/// A runner that hasn't checked in for this long is offline (it checks in every 30 seconds).
const RUNNER_TIMEOUT_MS: i64 = 90_000;

pub struct Hub {
    pub config: Config,
    pub store: Store,
    pub tools: Tools,
    /// Changes, live replies and notifications, for `/api/v1/events`.
    pub events: broadcast::Sender<HubEvent>,
    pub runner: Mutex<Option<RunnerState>>,
    /// Failed pairing attempts in the current minute: (window start, count).
    pair_failures: Mutex<(i64, u32)>,
    /// Webhook calls per routine in the current minute: (window start, count).
    pub hook_calls: Mutex<HashMap<String, (i64, u32)>>,
}

impl Hub {
    pub fn new(config: Config, store: Store, tools: Tools) -> Self {
        let (events, _) = broadcast::channel(512);
        Hub { config, store, tools, events, runner: Mutex::new(None), pair_failures: Mutex::new((0, 0)), hook_calls: Mutex::new(HashMap::new()) }
    }

    pub fn runner_status(&self) -> Value {
        match &*self.runner.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(r) => json!({ "online": now_ms() - r.last_seen < RUNNER_TIMEOUT_MS, "version": r.version, "lastSeen": r.last_seen }),
            None => json!({ "online": false }),
        }
    }

    /// Tells devices when the runner stops checking in (called every few seconds).
    pub fn check_runner(&self) {
        let mut guard = self.runner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = guard.as_mut() {
            if r.announced && now_ms() - r.last_seen >= RUNNER_TIMEOUT_MS {
                r.announced = false;
                drop(guard);
                let _ = self.events.send(HubEvent::Runner(self.runner_status()));
            }
        }
    }

    /// True when `tailscale serve` says the request comes from one of the hub
    /// owner's devices. `tailscale serve` sets these headers itself (replacing
    /// any sent by the client), and only it can reach the API socket.
    pub fn from_owner_device(&self, headers: &HeaderMap) -> bool {
        let Some(owner) = self.config.tailscale_owner.as_deref() else { return false };
        let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim);
        let Some(source) = header("x-forwarded-for").and_then(|v| v.rsplit(',').next()).map(str::trim) else { return false };
        // The hub's own node belongs to the owner too, but a request from it is a
        // bot's command running here, not a device being paired.
        if self.config.self_addrs.iter().any(|a| a == source) || source.starts_with("127.") || source == "::1" {
            return false;
        }
        header("tailscale-user-login").is_some_and(|login| login.eq_ignore_ascii_case(owner))
    }
}

pub type Shared = Arc<Hub>;

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

fn internal(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, msg.into())
}

type ApiResult<T> = Result<T, ApiError>;

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ").map(str::trim)
}

fn auth(hub: &Hub, headers: &HeaderMap) -> ApiResult<Device> {
    bearer(headers)
        .and_then(|t| hub.store.device_for_token(t))
        .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "This device isn't paired with the hub (or was removed). Pair it again in Settings → Hub.".into()))
}

pub fn router(hub: Shared) -> Router {
    Router::new()
        .route("/api/v1/info", get(info))
        .route("/api/v1/live", post(live))
        .route("/api/v1/notify", post(notify))
        .route("/api/v1/runner", post(runner_checkin))
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/me", get(me))
        .route("/api/v1/changes", get(changes))
        .route("/api/v1/push", post(push))
        .route("/api/v1/events", get(events))
        .route("/api/v1/lease", post(lease))
        .route("/api/v1/devices", get(devices))
        .route("/api/v1/devices/{id}", delete(remove_device).patch(rename_device))
        .route("/api/v1/pair-codes", post(pair_code))
        .route("/api/v1/tools", post(tools))
        .with_state(hub)
}

// ------------------------------------------------------------------ pairing

async fn info(State(hub): State<Shared>, headers: HeaderMap) -> Json<Value> {
    let device = bearer(&headers).and_then(|t| hub.store.device_for_token(t));
    let mut out = json!({
        "app": "lantern-hub",
        "name": hub.config.name,
        "version": env!("CARGO_PKG_VERSION"),
        "hubId": hub.store.hub_id(),
        "canAutoPair": hub.from_owner_device(&headers),
        "device": device,
    });
    if device.is_some() {
        out["runner"] = hub.runner_status();
        out["hookUrls"] = json!(hub.config.hook_urls);
    }
    Json(out)
}

#[derive(Deserialize)]
struct PairRequest {
    code: Option<String>,
    name: String,
    platform: String,
}

async fn pair(State(hub): State<Shared>, headers: HeaderMap, Json(req): Json<PairRequest>) -> ApiResult<Json<Value>> {
    let code = req.code.as_deref().map(str::trim).filter(|c| !c.is_empty());
    let via = if let Some(code) = code {
        {
            let mut f = hub.pair_failures.lock().unwrap_or_else(|e| e.into_inner());
            let now = now_ms();
            if now - f.0 > 60_000 {
                *f = (now, 0);
            }
            if f.1 >= 10 {
                return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "Too many wrong codes. Wait a minute and try again.".into()));
            }
        }
        if !hub.store.redeem_pair_code(code) {
            hub.pair_failures.lock().unwrap_or_else(|e| e.into_inner()).1 += 1;
            return Err(ApiError(StatusCode::UNAUTHORIZED, "That pairing code is wrong or has expired.".into()));
        }
        "code"
    } else if hub.from_owner_device(&headers) {
        "tailscale"
    } else {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Enter a pairing code from a connected device (Settings → Hub → Add a device), or run `lantern-hubctl pair-code` on the hub.".into(),
        ));
    };
    let name = if req.name.trim().is_empty() { "Device".to_string() } else { req.name.trim().to_string() };
    let (device_id, token) = hub.store.add_device(&name, &req.platform, via).map_err(internal)?;
    Ok(Json(json!({ "deviceId": device_id, "token": token, "hubId": hub.store.hub_id(), "name": hub.config.name })))
}

async fn me(State(hub): State<Shared>, headers: HeaderMap) -> ApiResult<Json<Device>> {
    Ok(Json(auth(&hub, &headers)?))
}

async fn pair_code(State(hub): State<Shared>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let device = auth(&hub, &headers)?;
    let (code, expires_at) = hub.store.create_pair_code(15 * 60_000, &device.id).map_err(internal)?;
    Ok(Json(json!({ "code": code, "expiresAt": expires_at })))
}

async fn devices(State(hub): State<Shared>, headers: HeaderMap) -> ApiResult<Json<Vec<Device>>> {
    auth(&hub, &headers)?;
    Ok(Json(hub.store.devices().map_err(internal)?))
}

async fn remove_device(State(hub): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    auth(&hub, &headers)?;
    Ok(Json(json!({ "removed": hub.store.remove_device(&id).map_err(internal)? })))
}

#[derive(Deserialize)]
struct Rename {
    name: String,
}

async fn rename_device(State(hub): State<Shared>, headers: HeaderMap, Path(id): Path<String>, Json(body): Json<Rename>) -> ApiResult<Json<Value>> {
    auth(&hub, &headers)?;
    hub.store.rename_device(&id, body.name.trim()).map_err(internal)?;
    Ok(Json(json!({})))
}

// ------------------------------------------------------------------ sync

#[derive(Deserialize)]
struct ChangesQuery {
    since: Option<i64>,
    limit: Option<usize>,
}

async fn changes(State(hub): State<Shared>, headers: HeaderMap, Query(q): Query<ChangesQuery>) -> ApiResult<Response> {
    let device = auth(&hub, &headers)?;
    let limit = q.limit.unwrap_or(500).clamp(1, 5000);
    let page = hub.store.changes(q.since.unwrap_or(0), limit, &device.id).map_err(internal)?;
    Ok(Json(page).into_response())
}

#[derive(Deserialize)]
struct PushBody {
    changes: Vec<Change>,
}

async fn push(State(hub): State<Shared>, headers: HeaderMap, Json(body): Json<PushBody>) -> ApiResult<Json<Value>> {
    let device = auth(&hub, &headers)?;
    if body.changes.is_empty() {
        return Ok(Json(json!({ "rev": hub.store.current_rev() })));
    }
    let rev = hub.store.push(&device.id, &body.changes).map_err(bad)?;
    let _ = hub.events.send(HubEvent::Change { rev, device: device.id });
    Ok(Json(json!({ "rev": rev })))
}

async fn events(State(hub): State<Shared>, headers: HeaderMap) -> ApiResult<impl IntoResponse> {
    auth(&hub, &headers)?;
    let token = bearer(&headers).unwrap_or_default().to_string();
    let hello = Event::default().event("hello").data(json!({ "rev": hub.store.current_rev(), "hubId": hub.store.hub_id() }).to_string());
    let checker = hub.clone();
    let updates = BroadcastStream::new(hub.events.subscribe())
        // A device removed while connected stops getting events at the next change.
        .take_while(move |_| checker.store.device_for_token(&token).is_some())
        .filter_map(|r| {
            let event = match r {
                Ok(HubEvent::Change { rev, device }) => Event::default().event("change").data(json!({ "rev": rev, "device": device }).to_string()),
                Ok(HubEvent::Live { device, message }) => Event::default().event("live").data(json!({ "type": "live", "device": device, "message": message }).to_string()),
                Ok(HubEvent::Notify { title, body }) => Event::default().event("notify").data(json!({ "type": "notify", "title": title, "body": body }).to_string()),
                Ok(HubEvent::Runner(status)) => Event::default().event("runner").data(json!({ "type": "runner", "runner": status }).to_string()),
                // A lagging client missed some events: a plain change makes it pull.
                Err(_) => Event::default().event("change").data(json!({ "rev": 0, "device": "" }).to_string()),
            };
            Some(Ok::<_, Infallible>(event))
        });
    let stream = tokio_stream::once(Ok::<_, Infallible>(hello)).chain(updates);
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(20))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseBody {
    key: String,
    ttl_ms: Option<i64>,
}

async fn lease(State(hub): State<Shared>, headers: HeaderMap, Json(body): Json<LeaseBody>) -> ApiResult<Json<Value>> {
    let device = auth(&hub, &headers)?;
    let ttl = body.ttl_ms.unwrap_or(3_600_000).clamp(1_000, 86_400_000);
    let granted = hub.store.lease(&body.key, &device.id, ttl).map_err(internal)?;
    Ok(Json(json!({ "granted": granted })))
}

// ------------------------------------------------------------------ runner

#[derive(Deserialize)]
struct LiveBody {
    message: Value,
}

/// Relays a reply that's still being written to every other device.
async fn live(State(hub): State<Shared>, headers: HeaderMap, Json(body): Json<LiveBody>) -> ApiResult<Json<Value>> {
    let device = auth(&hub, &headers)?;
    if body.message.to_string().len() > 512 * 1024 {
        return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "live message too large".into()));
    }
    let _ = hub.events.send(HubEvent::Live { device: device.id, message: body.message });
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
struct NotifyBody {
    title: String,
    #[serde(default)]
    body: String,
}

async fn notify(State(hub): State<Shared>, headers: HeaderMap, Json(n): Json<NotifyBody>) -> ApiResult<Json<Value>> {
    auth(&hub, &headers)?;
    let clip = |s: &str, n: usize| s.chars().take(n).collect::<String>();
    let _ = hub.events.send(HubEvent::Notify { title: clip(&n.title, 200), body: clip(&n.body, 1000) });
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
struct RunnerCheckin {
    #[serde(default)]
    version: String,
}

/// The runner checks in every 30 seconds; devices hear when it comes online.
async fn runner_checkin(State(hub): State<Shared>, headers: HeaderMap, Json(body): Json<RunnerCheckin>) -> ApiResult<Json<Value>> {
    let device = auth(&hub, &headers)?;
    if device.platform != "runner" {
        return Err(ApiError(StatusCode::FORBIDDEN, "Only the hub's runner checks in here.".into()));
    }
    let came_online = {
        let mut guard = hub.runner.lock().unwrap_or_else(|e| e.into_inner());
        let was = guard.as_ref().is_some_and(|r| r.announced && r.device == device.id);
        *guard = Some(RunnerState { device: device.id, version: body.version.chars().take(40).collect(), last_seen: now_ms(), announced: true });
        !was
    };
    if came_online {
        let _ = hub.events.send(HubEvent::Runner(hub.runner_status()));
    }
    Ok(Json(json!({})))
}

// ------------------------------------------------------------------ tools

async fn tools(State(hub): State<Shared>, headers: HeaderMap, Json(req): Json<ToolRequest>) -> ApiResult<Json<Value>> {
    auth(&hub, &headers)?;
    // Tool failures (missing file, bad regex…) are normal results for the bot, not server errors.
    hub.tools.call(req).await.map(Json).map_err(|e| ApiError(StatusCode::UNPROCESSABLE_ENTITY, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::LocalTools;
    use axum::http::HeaderValue;

    fn hub(owner: Option<&str>) -> Hub {
        let mut config = Config::from_env();
        config.tailscale_owner = owner.map(str::to_string);
        config.self_addrs = vec!["100.64.0.9".into()];
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        Hub::new(config, store, Tools::Local(LocalTools::new(std::env::temp_dir().join("lantern-hub-api-test"))))
    }

    fn headers(login: &str, from: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("tailscale-user-login", HeaderValue::from_str(login).unwrap());
        h.insert("x-forwarded-for", HeaderValue::from_str(from).unwrap());
        h
    }

    #[test]
    fn owner_devices_pair_without_a_code() {
        assert!(hub(Some("me@github")).from_owner_device(&headers("me@github", "100.64.0.5")));
    }

    #[test]
    fn other_people_and_unconfigured_hubs_need_a_code() {
        assert!(!hub(Some("me@github")).from_owner_device(&headers("friend@github", "100.64.0.5")));
        assert!(!hub(None).from_owner_device(&headers("me@github", "100.64.0.5")));
        assert!(!hub(Some("me@github")).from_owner_device(&HeaderMap::new()));
    }

    #[test]
    fn requests_from_the_hub_itself_are_not_devices() {
        let h = hub(Some("me@github"));
        assert!(!h.from_owner_device(&headers("me@github", "100.64.0.9")));
        assert!(!h.from_owner_device(&headers("me@github", "127.0.0.1")));
    }
}
