//! Lantern Hub: one shared Lantern environment for all of a person's devices.
//! It syncs bots, chats, memories, skills, routines, settings and secrets
//! between paired devices, runs bot tools in a shared workspace (files, shell,
//! a web browser, mail), takes webhooks for routines, relays the runner's live
//! replies, and serves the app's installers and update manifest.

mod agent;
mod api;
#[cfg(unix)]
mod browser;
mod config;
mod hooks;
mod mail;
mod store;
mod web;

use api::Hub;
use config::{Config, Listen};
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

const USAGE: &str = "Lantern Hub

Usage:
  lantern-hub serve                      Run the hub (settings come from LANTERN_HUB_* variables)
  lantern-hub agent --socket PATH --workspace DIR
                                         Run bot tools for the hub as the current user
  lantern-hub pair-code [--minutes N]    Print a one-time code for pairing a device (default 60 minutes)
  lantern-hub runner-token               Create the runner's device token (replaces any old one) and print it
  lantern-hub devices                    List paired devices
  lantern-hub remove-device ID           Unpair a device
  lantern-hub --version";

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn open_store(config: &Config) -> store::Store {
    std::fs::create_dir_all(&config.data_dir).unwrap_or_else(|e| fail(&format!("{}: {e}", config.data_dir.display())));
    store::Store::open(&config.data_dir.join("hub.db")).unwrap_or_else(|e| fail(&format!("opening the hub database: {e}")))
}

fn fail(msg: &str) -> ! {
    eprintln!("lantern-hub: {msg}");
    std::process::exit(1)
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config = Config::from_env();
    match args.first().map(String::as_str) {
        Some("serve") => serve(config).await,
        Some("agent") => {
            let socket = arg_value(&args, "--socket").map(PathBuf::from).unwrap_or_else(|| fail("--socket is required"));
            let workspace = arg_value(&args, "--workspace").map(PathBuf::from).unwrap_or(config.workspace);
            #[cfg(unix)]
            agent::serve_agent(socket, workspace).await.unwrap_or_else(|e| fail(&e.to_string()));
            #[cfg(not(unix))]
            {
                let _ = (socket, workspace);
                fail("the agent needs a Unix system");
            }
        }
        Some("pair-code") => {
            let minutes: i64 = arg_value(&args, "--minutes").and_then(|m| m.parse().ok()).unwrap_or(60);
            let (code, expires) = open_store(&config).create_pair_code(minutes * 60_000, "cli").unwrap_or_else(|e| fail(&e));
            let left = (expires - store::now_ms()) / 60_000;
            println!("{code}  (single use, expires in {left} minutes)");
        }
        Some("runner-token") => {
            let (_, token) = open_store(&config).reset_runner().unwrap_or_else(|e| fail(&e));
            println!("{token}");
        }
        Some("devices") => {
            for d in open_store(&config).devices().unwrap_or_else(|e| fail(&e)) {
                println!("{}  {}  ({}, paired via {})", d.id, d.name, d.platform, d.paired_via);
            }
        }
        Some("remove-device") => {
            let id = args.get(1).unwrap_or_else(|| fail("remove-device needs a device id"));
            let removed = open_store(&config).remove_device(id).unwrap_or_else(|e| fail(&e));
            println!("{}", if removed { "Removed." } else { "No such device." });
        }
        Some("--version") | Some("-V") => println!("lantern-hub {}", env!("CARGO_PKG_VERSION")),
        _ => {
            println!("{USAGE}");
            if !args.is_empty() && args[0] != "--help" && args[0] != "-h" {
                std::process::exit(2);
            }
        }
    }
}

async fn serve(config: Config) {
    let store = open_store(&config);
    let tools = match &config.agent_socket {
        Some(socket) => agent::Tools::Agent(socket.clone()),
        None => agent::Tools::Local(agent::LocalTools::new(config.workspace.clone())),
    };
    let listen = config.listen.clone();
    let public_listen = config.public_listen.clone();
    let hub = Arc::new(Hub::new(config, store, tools));

    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
    let full = api::router(hub.clone())
        .merge(web::router(hub.clone()))
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024))
        .merge(hooks::router(hub.clone()))
        .layer(cors);

    // Tells devices when the runner stops checking in.
    let watcher = hub.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            watcher.check_runner();
        }
    });

    if let Some(addr) = public_listen {
        // The plain-HTTP listener serves downloads and webhooks, never the API.
        let downloads = web::router(hub.clone()).merge(hooks::router(hub.clone()));
        let listener = tokio::net::TcpListener::bind(&addr).await.unwrap_or_else(|e| fail(&format!("{addr}: {e}")));
        eprintln!("lantern-hub: downloads on http://{addr}");
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, downloads).await {
                eprintln!("lantern-hub: downloads listener stopped: {e}");
            }
        });
    }

    eprintln!(
        "lantern-hub {}: {} ({} tool runner)",
        env!("CARGO_PKG_VERSION"),
        hub.config.name,
        if hub.config.agent_socket.is_some() { "separate" } else { "in-process" }
    );
    match listen {
        Listen::Tcp(addr) => {
            let listener = tokio::net::TcpListener::bind(&addr).await.unwrap_or_else(|e| fail(&format!("{addr}: {e}")));
            eprintln!("lantern-hub: API on http://{addr}");
            axum::serve(listener, full).await.unwrap_or_else(|e| fail(&e.to_string()));
        }
        #[cfg(unix)]
        Listen::Unix(path) => {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::remove_file(&path);
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let listener = tokio::net::UnixListener::bind(&path).unwrap_or_else(|e| fail(&format!("{}: {e}", path.display())));
            // Only the hub's user (and root, i.e. tailscaled) may connect, so Tailscale identity headers can be trusted.
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            eprintln!("lantern-hub: API on unix:{}", path.display());
            axum::serve(listener, full).await.unwrap_or_else(|e| fail(&e.to_string()));
        }
        #[cfg(not(unix))]
        Listen::Unix(_) => fail("unix sockets need a Unix system"),
    }
}
