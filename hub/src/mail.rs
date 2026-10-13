//! Bots' own mailboxes: list and read mail over IMAP, send it over SMTP. TLS
//! certificates are always verified (Mozilla's roots). Plain, unencrypted
//! connections are allowed only to a mail server on this machine (loopback),
//! such as a local bridge, so passwords never cross the network in the clear.

use futures_util::TryStreamExt;
use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use mail_parser::{MessageParser, MimeHeaders};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt::Debug;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::rustls;

const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_TEXT: usize = 60_000;

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MailAccount {
    pub address: String,
    pub username: String,
    pub password: String,
    pub imap_host: String,
    pub imap_port: u16,
    /// "tls" (default) or "none" (loopback only).
    #[serde(default)]
    pub imap_security: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    /// "tls" (default), "starttls", or "none" (loopback only).
    #[serde(default)]
    pub smtp_security: String,
}

// Keeps the password out of logs and error messages.
impl Debug for MailAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MailAccount({} via {}:{})", self.address, self.imap_host, self.imap_port)
    }
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMail {
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    pub subject: String,
    pub body: String,
    /// Message-ID of the mail this answers, to keep the thread together.
    #[serde(default)]
    pub in_reply_to: Option<String>,
}

pub fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn plain_allowed(host: &str, security: &str) -> Result<bool, String> {
    if security != "none" {
        return Ok(false);
    }
    if is_loopback(host) {
        Ok(true)
    } else {
        Err("Unencrypted mail connections are only allowed to a server on the hub itself. Use TLS.".into())
    }
}

fn tls_config() -> Arc<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(config)
}

fn address_list(addr: Option<&mail_parser::Address>) -> String {
    let Some(addr) = addr else { return String::new() };
    addr.iter()
        .map(|a| match (a.name(), a.address()) {
            (Some(n), Some(e)) => format!("{n} <{e}>"),
            (None, Some(e)) => e.to_string(),
            (Some(n), None) => n.to_string(),
            _ => String::new(),
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}\n[… message trimmed]", s.chars().take(max).collect::<String>())
    }
}

/// What a list or read needs from the mailbox.
pub enum ImapOp {
    List { folder: String, since_uid: Option<u32>, limit: usize, unread_only: bool },
    Read { folder: String, uid: u32, mark_seen: bool },
}

async fn with_imap<S>(stream: S, account: &MailAccount, op: ImapOp) -> Result<Value, String>
where
    S: AsyncRead + AsyncWrite + Unpin + Debug + Send,
{
    let mut client = async_imap::Client::new(stream);
    client.read_response().await.map_err(|e| format!("IMAP greeting: {e}"))?;
    let mut session = client.login(&account.username, &account.password).await.map_err(|(e, _)| format!("IMAP sign-in failed: {e}"))?;
    let result = match op {
        ImapOp::List { folder, since_uid, limit, unread_only } => {
            let mailbox = session.select(&folder).await.map_err(|e| format!("Opening {folder}: {e}"))?;
            let set = if unread_only {
                let mut uids: Vec<u32> = session.uid_search("UNSEEN").await.map_err(|e| e.to_string())?.into_iter().collect();
                uids.retain(|u| since_uid.is_none_or(|s| *u > s));
                uids.sort_unstable();
                let start = uids.len().saturating_sub(limit);
                uids[start..].iter().map(u32::to_string).collect::<Vec<_>>().join(",")
            } else if let Some(since) = since_uid {
                format!("{}:*", since + 1)
            } else {
                // The newest `limit` messages, by their UIDs.
                let mut uids: Vec<u32> = session.uid_search("ALL").await.map_err(|e| e.to_string())?.into_iter().collect();
                uids.sort_unstable();
                let start = uids.len().saturating_sub(limit);
                uids[start..].iter().map(u32::to_string).collect::<Vec<_>>().join(",")
            };
            let mut items = Vec::new();
            if !set.is_empty() {
                let fetches: Vec<_> = session
                    .uid_fetch(&set, "(UID FLAGS RFC822.HEADER)")
                    .await
                    .map_err(|e| e.to_string())?
                    .try_collect()
                    .await
                    .map_err(|e| e.to_string())?;
                for f in fetches {
                    let Some(uid) = f.uid else { continue };
                    // "N:*" always includes the newest message, even when it's older than N.
                    if since_uid.is_some_and(|s| uid <= s) {
                        continue;
                    }
                    let seen = f.flags().any(|fl| matches!(fl, async_imap::types::Flag::Seen));
                    let parsed = f.header().and_then(|h| MessageParser::default().parse_headers(h));
                    let (from, subject, date) = parsed
                        .as_ref()
                        .map(|m| (address_list(m.from()), m.subject().unwrap_or("").to_string(), m.date().map(|d| d.to_rfc3339()).unwrap_or_default()))
                        .unwrap_or_default();
                    items.push(json!({ "uid": uid, "from": from, "subject": subject, "date": date, "seen": seen }));
                }
            }
            // After a known message: the oldest new ones first, so none are skipped. Otherwise the newest first.
            let uid = |v: &Value| v["uid"].as_u64().unwrap_or(0);
            if since_uid.is_some() {
                items.sort_by_key(uid);
            } else {
                items.sort_by_key(|v| std::cmp::Reverse(uid(v)));
            }
            items.truncate(limit);
            Ok(json!({ "messages": items, "total": mailbox.exists, "uidNext": mailbox.uid_next }))
        }
        ImapOp::Read { folder, uid, mark_seen } => {
            session.select(&folder).await.map_err(|e| format!("Opening {folder}: {e}"))?;
            let fetches: Vec<_> = session
                .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
                .await
                .map_err(|e| e.to_string())?
                .try_collect()
                .await
                .map_err(|e| e.to_string())?;
            let raw = fetches.iter().find_map(|f| f.body().map(<[u8]>::to_vec)).ok_or_else(|| format!("No message with id {uid} in {folder}."))?;
            if mark_seen {
                let _: Vec<_> = session.uid_store(uid.to_string(), "+FLAGS (\\Seen)").await.map_err(|e| e.to_string())?.try_collect().await.map_err(|e| e.to_string())?;
            }
            let m = MessageParser::default().parse(&raw).ok_or("This message couldn't be read.")?;
            let attachments: Vec<Value> = m
                .attachments()
                .map(|a| json!({ "name": a.attachment_name().unwrap_or("attachment"), "size": a.contents().len(), "type": a.content_type().map(|c| format!("{}/{}", c.ctype(), c.subtype().unwrap_or("*"))).unwrap_or_default() }))
                .collect();
            Ok(json!({
                "uid": uid,
                "from": address_list(m.from()),
                "to": address_list(m.to()),
                "cc": address_list(m.cc()),
                "subject": m.subject().unwrap_or(""),
                "date": m.date().map(|d| d.to_rfc3339()).unwrap_or_default(),
                "messageId": m.message_id().unwrap_or(""),
                "text": clip(m.body_text(0).as_deref().unwrap_or(""), MAX_TEXT),
                "attachments": attachments,
            }))
        }
    };
    let _ = session.logout().await;
    result
}

pub async fn imap(account: &MailAccount, op: ImapOp) -> Result<Value, String> {
    let work = async {
        let tcp = TcpStream::connect((account.imap_host.as_str(), account.imap_port)).await.map_err(|e| format!("Can't reach {}:{}: {e}", account.imap_host, account.imap_port))?;
        if plain_allowed(&account.imap_host, &account.imap_security)? {
            return with_imap(tcp, account, op).await;
        }
        let name = rustls::pki_types::ServerName::try_from(account.imap_host.clone()).map_err(|e| e.to_string())?;
        let tls = tokio_rustls::TlsConnector::from(tls_config()).connect(name, tcp).await.map_err(|e| format!("TLS with {}: {e}", account.imap_host))?;
        with_imap(tls, account, op).await
    };
    tokio::time::timeout(TIMEOUT, work).await.map_err(|_| "The mail server took too long to answer.".to_string())?
}

fn mailbox(s: &str) -> Result<Mailbox, String> {
    s.trim().parse().map_err(|e| format!("Bad address \"{s}\": {e}"))
}

/// Builds the message; split out so it can be tested without a server.
pub fn build_message(account: &MailAccount, mail: &OutgoingMail) -> Result<Message, String> {
    if mail.to.is_empty() {
        return Err("Add at least one recipient.".into());
    }
    let mut b = Message::builder().from(mailbox(&account.address)?).subject(mail.subject.clone()).header(ContentType::TEXT_PLAIN);
    for to in &mail.to {
        b = b.to(mailbox(to)?);
    }
    for cc in &mail.cc {
        b = b.cc(mailbox(cc)?);
    }
    if let Some(id) = mail.in_reply_to.as_deref().filter(|s| !s.trim().is_empty()) {
        let id = if id.starts_with('<') { id.to_string() } else { format!("<{id}>") };
        b = b.in_reply_to(id.clone()).references(id);
    }
    b.body(mail.body.clone()).map_err(|e| e.to_string())
}

pub async fn send(account: &MailAccount, mail: &OutgoingMail) -> Result<Value, String> {
    let message = build_message(account, mail)?;
    let creds = Credentials::new(account.username.clone(), account.password.clone());
    let host = account.smtp_host.as_str();
    let builder = if plain_allowed(host, &account.smtp_security)? {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
    } else if account.smtp_security == "starttls" {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host).map_err(|e| e.to_string())?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::relay(host).map_err(|e| e.to_string())?
    };
    let transport = builder.port(account.smtp_port).credentials(creds).timeout(Some(TIMEOUT)).build();
    transport.send(message).await.map_err(|e| format!("Sending failed: {e}"))?;
    Ok(json!({ "sent": true, "to": mail.to, "subject": mail.subject }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> MailAccount {
        MailAccount {
            address: "Lumi <lumi@example.com>".into(),
            username: "lumi".into(),
            password: "secret-password".into(),
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            imap_security: String::new(),
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
            smtp_security: String::new(),
        }
    }

    #[test]
    fn unencrypted_mail_only_on_this_machine() {
        assert!(plain_allowed("127.0.0.1", "none").unwrap());
        assert!(plain_allowed("localhost", "none").unwrap());
        assert!(plain_allowed("mail.example.com", "none").is_err());
        assert!(!plain_allowed("mail.example.com", "tls").unwrap());
    }

    #[test]
    fn passwords_stay_out_of_debug_output() {
        assert!(!format!("{:?}", account()).contains("secret-password"));
    }

    #[test]
    fn replies_keep_the_thread() {
        let mail = OutgoingMail { to: vec!["you@example.com".into()], cc: vec![], subject: "Re: hi".into(), body: "Hello".into(), in_reply_to: Some("abc@example.com".into()) };
        let raw = String::from_utf8(build_message(&account(), &mail).unwrap().formatted()).unwrap();
        assert!(raw.contains("In-Reply-To: <abc@example.com>"));
        assert!(raw.contains("To: you@example.com"));
        assert!(build_message(&account(), &OutgoingMail { to: vec![], ..mail }).is_err());
    }
}
