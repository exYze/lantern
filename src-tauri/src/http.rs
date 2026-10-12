//! HTTP for LLM endpoints, MCP-over-HTTP and web fetch. Requests are made from
//! Rust so they are not subject to webview CORS or mobile cleartext policies,
//! which matters for LAN servers such as Ollama or llama.cpp.

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, State};
use tokio::sync::oneshot;

pub struct HttpState {
    pub(crate) client: reqwest::Client,
    cancels: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

impl HttpState {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .user_agent(concat!("Lantern/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("failed to build HTTP client");
        Self { client, cancels: Arc::default() }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    #[serde(default = "default_method")]
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<String>,
    body_base64: Option<String>,
    timeout_ms: Option<u64>,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum StreamEvent {
    Response { status: u16, headers: HashMap<String, String> },
    Chunk(String),
    Done,
    Error(String),
}

/// Formats an error with its source chain ("error sending request: connection refused").
pub fn describe(e: &(dyn std::error::Error + 'static)) -> String {
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        let s_msg = s.to_string();
        if !msg.contains(&s_msg) {
            msg.push_str(": ");
            msg.push_str(&s_msg);
        }
        source = s.source();
    }
    msg
}

fn build(client: &reqwest::Client, req: HttpRequest) -> Result<reqwest::RequestBuilder, String> {
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut rb = client.request(method, &req.url);
    for (k, v) in &req.headers {
        rb = rb.header(k, v);
    }
    if let Some(b64) = req.body_base64 {
        rb = rb.body(STANDARD.decode(b64).map_err(|e| e.to_string())?);
    } else if let Some(body) = req.body {
        rb = rb.body(body);
    }
    if let Some(ms) = req.timeout_ms {
        rb = rb.timeout(Duration::from_millis(ms));
    }
    Ok(rb)
}

fn header_map(h: &reqwest::header::HeaderMap) -> HashMap<String, String> {
    h.iter()
        .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect()
}

/// Takes the longest complete UTF-8 prefix out of `buf`, leaving a split
/// multi-byte character for the next chunk.
fn take_utf8(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let s = s.to_owned();
            buf.clear();
            s
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let s = String::from_utf8_lossy(&buf[..valid]).into_owned();
            buf.drain(..valid);
            s
        }
        Err(_) => {
            let s = String::from_utf8_lossy(buf).into_owned();
            buf.clear();
            s
        }
    }
}

#[tauri::command]
pub async fn http_request(state: State<'_, HttpState>, request: HttpRequest) -> Result<HttpResponse, String> {
    let resp = build(&state.client, request)?.send().await.map_err(|e| describe(&e))?;
    let status = resp.status().as_u16();
    let headers = header_map(resp.headers());
    let body = resp.text().await.map_err(|e| describe(&e))?;
    Ok(HttpResponse { status, headers, body })
}

/// Starts a streaming request and returns immediately; events arrive on `on_event`.
#[tauri::command]
pub async fn http_stream(
    state: State<'_, HttpState>,
    id: String,
    request: HttpRequest,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let rb = build(&state.client, request)?;
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    state.cancels.lock().map_err(|e| e.to_string())?.insert(id.clone(), cancel_tx);
    let cancels = state.cancels.clone();

    tauri::async_runtime::spawn(async move {
        let work = async {
            let resp = match rb.send().await {
                Ok(r) => r,
                Err(e) => {
                    let _ = on_event.send(StreamEvent::Error(describe(&e)));
                    return;
                }
            };
            let _ = on_event.send(StreamEvent::Response {
                status: resp.status().as_u16(),
                headers: header_map(resp.headers()),
            });
            let mut stream = resp.bytes_stream();
            let mut pending: Vec<u8> = Vec::new();
            while let Some(item) = stream.next().await {
                match item {
                    Ok(bytes) => {
                        pending.extend_from_slice(&bytes);
                        let text = take_utf8(&mut pending);
                        if !text.is_empty() && on_event.send(StreamEvent::Chunk(text)).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        let _ = on_event.send(StreamEvent::Error(describe(&e)));
                        return;
                    }
                }
            }
            if !pending.is_empty() {
                let _ = on_event.send(StreamEvent::Chunk(String::from_utf8_lossy(&pending).into_owned()));
            }
            let _ = on_event.send(StreamEvent::Done);
        };
        tokio::select! {
            _ = work => {}
            _ = &mut cancel_rx => {}
        }
        if let Ok(mut map) = cancels.lock() {
            map.remove(&id);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn http_cancel(state: State<'_, HttpState>, id: String) {
    if let Some(tx) = state.cancels.lock().ok().and_then(|mut m| m.remove(&id)) {
        let _ = tx.send(());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPage {
    url: String,
    status: u16,
    content_type: String,
    title: Option<String>,
    text: String,
    truncated: bool,
}

/// Fetches a URL and returns readable text (HTML is converted to plain text).
#[tauri::command]
pub async fn web_fetch(state: State<'_, HttpState>, url: String, max_chars: Option<usize>) -> Result<FetchedPage, String> {
    let resp = state
        .client
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5")
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .map_err(|e| describe(&e))?;
    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| describe(&e))?;
    let is_html = content_type.contains("html") || (content_type.is_empty() && bytes.starts_with(b"<"));
    let is_text = is_html
        || content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("javascript");

    let (title, text) = if is_html {
        let raw = String::from_utf8_lossy(&bytes);
        let title = regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>")
            .ok()
            .and_then(|re| re.captures(&raw).map(|c| c[1].trim().to_string()));
        let text = html2text::from_read(&bytes[..], 100).unwrap_or_else(|_| raw.into_owned());
        (title, text)
    } else if is_text {
        (None, String::from_utf8_lossy(&bytes).into_owned())
    } else {
        (None, format!("[binary content: {content_type}, {} bytes]", bytes.len()))
    };

    let max = max_chars.unwrap_or(40_000);
    let truncated = text.chars().count() > max;
    let text = if truncated { text.chars().take(max).collect() } else { text };
    Ok(FetchedPage { url: final_url, status, content_type, title, text, truncated })
}
