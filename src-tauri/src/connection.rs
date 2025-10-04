use std::{collections::HashMap, sync::Arc, time::SystemTime};

use anyhow::{anyhow, Context};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter},
    net::TcpStream,
    select,
    sync::mpsc,
};
use tokio_native_tls::native_tls;
use uuid::Uuid;

use crate::{
    messages::{ChannelUserInfo, ChatMessage, IrcEvent, MessageKind},
    storage::ScrollbackStore,
};
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub server: String,
    pub port: u16,
    pub use_tls: bool,
    pub nickname: String,
    pub username: Option<String>,
    pub realname: Option<String>,
    pub password: Option<String>,
    pub auto_join: Vec<String>,
}

impl ConnectionConfig {
    pub fn storage_key(&self) -> String {
        format!("{}:{}:{}", self.server, self.port, self.nickname)
    }
}

#[derive(Debug)]
pub enum ConnectionCommand {
    Join(String),
    Part {
        channel: String,
        reason: Option<String>,
    },
    Privmsg {
        target: String,
        message: String,
    },
    Topic {
        channel: String,
        topic: Option<String>,
    },
    Quit {
        reason: Option<String>,
    },
}

#[derive(Clone)]
pub struct ConnectionHandle {
    inner: Arc<ConnectionInner>,
}

struct ConnectionInner {
    id: String,
    #[allow(dead_code)]
    config: ConnectionConfig,
    storage_key: String,
    sender: mpsc::UnboundedSender<ConnectionCommand>,
    #[allow(dead_code)]
    task: tauri::async_runtime::JoinHandle<()>,
}

impl ConnectionHandle {
    pub fn id(&self) -> &str {
        &self.inner.id
    }

    pub fn storage_key(&self) -> &str {
        &self.inner.storage_key
    }

    pub fn send_command(&self, cmd: ConnectionCommand) -> anyhow::Result<()> {
        self.inner
            .sender
            .send(cmd)
            .map_err(|_| anyhow!("connection channel closed"))
    }

    pub fn disconnect(&self, reason: Option<String>) -> anyhow::Result<()> {
        self.send_command(ConnectionCommand::Quit { reason })
    }

}

#[derive(Clone)]
pub struct ConnectionManager {
    inner: Arc<ConnectionManagerInner>,
}

struct ConnectionManagerInner {
    app_handle: tauri::AppHandle,
    scrollback: ScrollbackStore,
    connections: Mutex<HashMap<String, ConnectionHandle>>,
}

impl ConnectionManager {
    pub fn new(app_handle: tauri::AppHandle, scrollback: ScrollbackStore) -> Self {
        Self {
            inner: Arc::new(ConnectionManagerInner {
                app_handle,
                scrollback,
                connections: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn list(&self) -> Vec<String> {
        self.inner
            .connections
            .lock()
            .keys()
            .cloned()
            .collect::<Vec<_>>()
    }

    pub fn get(&self, id: &str) -> Option<ConnectionHandle> {
        self.inner.connections.lock().get(id).cloned()
    }

    pub fn remove(&self, id: &str) -> Option<ConnectionHandle> {
        self.inner.connections.lock().remove(id)
    }

    pub fn add(&self, handle: ConnectionHandle) {
        self.inner
            .connections
            .lock()
            .insert(handle.id().to_string(), handle);
    }

    pub fn find_by_config(&self, config: &ConnectionConfig) -> Option<ConnectionHandle> {
        let storage_key = config.storage_key();
        self.inner
            .connections
            .lock()
            .values()
            .find(|conn| conn.storage_key() == storage_key)
            .cloned()
    }

    pub fn disconnect(&self, id: &str, reason: Option<String>) -> anyhow::Result<()> {
        if let Some(handle) = self.remove(id) {
            handle.disconnect(reason.clone())?;
            let _ = self.inner.app_handle.emit(
                "irc://event",
                IrcEvent::Disconnected {
                    connection_id: id.to_string(),
                    reason: reason.clone(),
                },
            );
            // also drop connection entry from state so we know indicator should update
            // Scrollback remains on disk; nothing else to do.
        }
        Ok(())
    }

    pub fn scrollback(&self) -> ScrollbackStore {
        self.inner.scrollback.clone()
    }

    pub fn join(&self, id: &str, channel: &str) -> anyhow::Result<()> {
        if let Some(handle) = self.get(id) {
            handle.send_command(ConnectionCommand::Join(channel.to_string()))?;
            Ok(())
        } else {
            Err(anyhow!("connection not found"))
        }
    }

    pub fn part(&self, id: &str, channel: &str, reason: Option<String>) -> anyhow::Result<()> {
        if let Some(handle) = self.get(id) {
            handle.send_command(ConnectionCommand::Part {
                channel: channel.to_string(),
                reason,
            })?;
            Ok(())
        } else {
            Err(anyhow!("connection not found"))
        }
    }

    pub fn privmsg(&self, id: &str, target: &str, message: &str) -> anyhow::Result<()> {
        if let Some(handle) = self.get(id) {
            handle.send_command(ConnectionCommand::Privmsg {
                target: target.to_string(),
                message: message.to_string(),
            })?;
            Ok(())
        } else {
            Err(anyhow!("connection not found"))
        }
    }

    pub fn set_topic(&self, id: &str, channel: &str, topic: Option<String>) -> anyhow::Result<()> {
        if let Some(handle) = self.get(id) {
            handle.send_command(ConnectionCommand::Topic {
                channel: channel.to_string(),
                topic,
            })?;
            Ok(())
        } else {
            Err(anyhow!("connection not found"))
        }
    }

    pub fn connect(&self, config: ConnectionConfig) -> anyhow::Result<String> {
        let id = Uuid::new_v4().to_string();
        let storage_key = config.storage_key();
        let (tx, rx) = mpsc::unbounded_channel();
        let app_handle = self.inner.app_handle.clone();
        let scrollback = self.inner.scrollback.clone();
        let connection_id = id.clone();
        let worker_config = config.clone();
        let worker_storage_key = storage_key.clone();
        let task = tauri::async_runtime::spawn(async move {
            connection_task(
                connection_id,
                worker_storage_key,
                worker_config,
                app_handle,
                scrollback,
                rx,
            )
            .await;
        });
        let handle = ConnectionHandle {
            inner: Arc::new(ConnectionInner {
                id,
                config,
                storage_key,
                sender: tx,
                task,
            }),
        };
        let id = handle.id().to_string();
        self.add(handle);
        Ok(id)
    }
}

async fn connection_task(
    id: String,
    storage_key: String,
    config: ConnectionConfig,
    app_handle: tauri::AppHandle,
    scrollback: ScrollbackStore,
    mut command_rx: mpsc::UnboundedReceiver<ConnectionCommand>,
) {
    let addr = format!("{}:{}", config.server, config.port);
    let stream = match connect_stream(&config).await {
        Ok(stream) => stream,
        Err(err) => {
            tracing::error!("failed to connect to {addr}: {err}");
            let _ = app_handle.emit(
                "irc://event",
                IrcEvent::Error {
                    connection_id: id.clone(),
                    message: format!("failed to connect: {err}"),
                },
            );
            return;
        }
    };

    let (reader, writer) = stream;
    let mut writer = BufWriter::new(writer);
    let mut disconnected = false;

    if let Err(err) = perform_handshake(&config, &mut writer).await {
        tracing::error!("handshake failed: {err}");
        let _ = app_handle.emit(
            "irc://event",
            IrcEvent::Error {
                connection_id: id.clone(),
                message: format!("handshake failed: {err}"),
            },
        );
        return;
    }

    let _ = app_handle.emit(
        "irc://event",
        IrcEvent::Connected {
            connection_id: id.clone(),
            nickname: config.nickname.clone(),
            server: config.server.clone(),
            message: Some("connected".to_string()),
        },
    );

    let mut lines = BufReader::new(reader).lines();
    loop {
        select! {
            maybe_line = lines.next_line() => {
                match maybe_line {
                    Ok(Some(line)) => {
                        if let Err(err) = handle_line(
                            &id,
                            storage_key.as_str(),
                            &config,
                            &app_handle,
                            &scrollback,
                            &mut writer,
                            &line,
                        )
                        .await
                        {
                            tracing::error!("failed to handle line: {err}");
                        }
                    }
                    Ok(None) => {
                        tracing::info!("connection closed");
                        let _ = app_handle.emit(
                            "irc://event",
                            IrcEvent::Disconnected {
                                connection_id: id.clone(),
                                reason: Some("connection closed".into()),
                            },
                        );
                        disconnected = true;
                        break;
                    }
                    Err(err) => {
                        tracing::error!("io error: {err}");
                        let _ = app_handle.emit(
                            "irc://event",
                            IrcEvent::Disconnected {
                                connection_id: id.clone(),
                                reason: Some(format!("read error: {err}")),
                            },
                        );
                        disconnected = true;
                        break;
                    }
                }
            }
            Some(cmd) = command_rx.recv() => {
                match cmd {
                    ConnectionCommand::Join(channel) => {
                        let _ = write_line(&mut writer, &format!("JOIN {channel}")).await;
                    }
                    ConnectionCommand::Part { channel, reason } => {
                        if let Some(reason) = reason {
                            let _ = write_line(&mut writer, &format!("PART {channel} :{reason}")).await;
                        } else {
                            let _ = write_line(&mut writer, &format!("PART {channel}")).await;
                        }
                    }
                    ConnectionCommand::Privmsg { target, message } => {
                        let _ = write_line(&mut writer, &format!("PRIVMSG {target} :{message}")).await;
                        let echo = ChatMessage {
                            connection_id: id.clone(),
                            target: target.clone(),
                            sender: Some(config.nickname.clone()),
                            message,
                            kind: MessageKind::Privmsg,
                            timestamp: current_timestamp(),
                            metadata: None,
                        };
                        scrollback.append(storage_key.as_str(), &echo).await.ok();
                        let _ = app_handle.emit("irc://event", IrcEvent::Message { data: echo });
                    }
                    ConnectionCommand::Topic { channel, topic } => {
                        match topic {
                            Some(topic) => {
                                let _ = write_line(&mut writer, &format!("TOPIC {channel} :{topic}")).await;
                            }
                            None => {
                                let _ = write_line(&mut writer, &format!("TOPIC {channel}" )).await;
                            }
                        }
                    }
                    ConnectionCommand::Quit { reason } => {
                        if let Some(ref reason_text) = reason {
                            let _ = write_line(&mut writer, &format!("QUIT :{reason_text}")).await;
                        } else {
                            let _ = write_line(&mut writer, "QUIT").await;
                        }
                        let _ = writer.flush().await;
                        let _ = app_handle.emit(
                            "irc://event",
                            IrcEvent::Disconnected {
                                connection_id: id.clone(),
                                reason: reason.clone(),
                            },
                        );
                        disconnected = true;
                        break;
                    }
                }
            }
            else => {
                // both streams closed
                break;
            }
        }
    }

    if !disconnected {
        let _ = app_handle.emit(
            "irc://event",
            IrcEvent::Disconnected {
                connection_id: id,
                reason: Some("connection closed".into()),
            },
        );
    }
}

type AnyReader = Box<dyn tokio::io::AsyncRead + Send + Unpin>;
type AnyWriter = Box<dyn tokio::io::AsyncWrite + Send + Unpin>;

async fn connect_stream(config: &ConnectionConfig) -> anyhow::Result<(AnyReader, AnyWriter)> {
    let addr = format!("{}:{}", config.server, config.port);
    let stream = TcpStream::connect(&addr)
        .await
        .with_context(|| format!("failed to connect to {addr}"))?;
    stream.set_nodelay(true)?;
    if config.use_tls {
        let connector = native_tls::TlsConnector::new()?;
        let connector = tokio_native_tls::TlsConnector::from(connector);
        let tls_stream = connector
            .connect(&config.server, stream)
            .await
            .with_context(|| format!("failed to establish tls stream to {}", config.server))?;
        let (read_half, write_half) = tokio::io::split(tls_stream);
        Ok((Box::new(read_half), Box::new(write_half)))
    } else {
        let (read_half, write_half) = stream.into_split();
        Ok((Box::new(read_half), Box::new(write_half)))
    }
}

async fn perform_handshake(
    config: &ConnectionConfig,
    writer: &mut BufWriter<AnyWriter>,
) -> anyhow::Result<()> {
    if let Some(pass) = &config.password {
        write_line(writer, &format!("PASS {pass}")).await?;
    }
    write_line(writer, &format!("NICK {}", config.nickname)).await?;
    let username = config
        .username
        .clone()
        .unwrap_or_else(|| config.nickname.clone());
    let realname = config
        .realname
        .clone()
        .unwrap_or_else(|| config.nickname.clone());
    write_line(writer, &format!("USER {username} 0 * :{realname}")).await?;
    Ok(())
}

async fn write_line(writer: &mut BufWriter<AnyWriter>, line: &str) -> anyhow::Result<()> {
    writer
        .write_all(line.as_bytes())
        .await
        .context("failed to write line")?;
    writer
        .write_all(b"\r\n")
        .await
        .context("failed to write line ending")?;
    writer.flush().await.context("failed to flush writer")?;
    Ok(())
}

async fn handle_line(
    connection_id: &str,
    storage_key: &str,
    config: &ConnectionConfig,
    app_handle: &tauri::AppHandle,
    scrollback: &ScrollbackStore,
    writer: &mut BufWriter<AnyWriter>,
    line: &str,
) -> anyhow::Result<()> {
    let parsed = parse_message(line);
    match parsed.command.as_str() {
        "PING" => {
            if let Some(arg) = parsed
                .params
                .get(0)
                .cloned()
                .or_else(|| parsed.trailing.clone())
            {
                let _ = write_line(writer, &format!("PONG :{arg}")).await;
            }
        }
        "001" => {
            // Welcome
            let _ = app_handle.emit(
                "irc://event",
                IrcEvent::Connected {
                    connection_id: connection_id.to_string(),
                    nickname: config.nickname.clone(),
                    server: config.server.clone(),
                    message: Some("welcome".into()),
                },
            );
            for channel in &config.auto_join {
                let _ = write_line(writer, &format!("JOIN {channel}")).await;
            }
        }
        "353" => {
            if parsed.params.len() >= 3 {
                let channel = parsed.params[2].clone();
                let users = parsed
                    .trailing
                    .as_deref()
                    .unwrap_or_default()
                    .split_whitespace()
                    .map(parse_channel_user)
                    .collect::<Vec<_>>();
                let _ = app_handle.emit(
                    "irc://event",
                    IrcEvent::Names {
                        connection_id: connection_id.to_string(),
                        channel,
                        users,
                    },
                );
            }
        }
        "332" => {
            if parsed.params.len() >= 2 {
                let channel = parsed.params[1].clone();
                let topic = parsed.trailing.clone().unwrap_or_default();
                let _ = app_handle.emit(
                    "irc://event",
                    IrcEvent::Topic {
                        connection_id: connection_id.to_string(),
                        channel: channel.clone(),
                        topic: topic.clone(),
                        setter: None,
                    },
                );
                let msg = ChatMessage {
                    connection_id: connection_id.to_string(),
                    target: channel.clone(),
                    sender: None,
                    message: format!("Topic: {topic}"),
                    kind: MessageKind::Topic,
                    timestamp: current_timestamp(),
                    metadata: None,
                };
                scrollback.append(storage_key, &msg).await.ok();
                let _ = app_handle.emit("irc://event", IrcEvent::Message { data: msg });
            }
        }
        "PRIVMSG" => {
            if let Some(target_raw) = parsed.params.get(0).cloned() {
                let mut message = parsed
                    .trailing
                    .clone()
                    .or_else(|| parsed.params.get(1).cloned())
                    .unwrap_or_default();
                let kind = if message.starts_with('\u{1}') && message.ends_with('\u{1}') {
                    let body = message.trim_matches('\u{1}');
                    if let Some(rest) = body.strip_prefix("ACTION ") {
                        message = rest.to_string();
                        MessageKind::Action
                    } else {
                        MessageKind::Privmsg
                    }
                } else {
                    MessageKind::Privmsg
                };
                let mut msg = ChatMessage {
                    connection_id: connection_id.to_string(),
                    target: target_raw.clone(),
                    sender: parsed.prefix.and_then(extract_nick),
                    message,
                    kind,
                    timestamp: current_timestamp(),
                    metadata: None,
                };
                if let Some(sender) = &msg.sender {
                    if equals_ignore_case(&msg.target, &config.nickname) {
                        msg.target = sender.clone();
                    }
                }
                scrollback.append(storage_key, &msg).await.ok();
                let _ = app_handle.emit("irc://event", IrcEvent::Message { data: msg });
            }
        }
        "NOTICE" => {
            if let Some(target) = parsed.params.get(0).cloned() {
                let message = parsed
                    .trailing
                    .clone()
                    .or_else(|| parsed.params.get(1).cloned())
                    .unwrap_or_default();
                let msg = ChatMessage {
                    connection_id: connection_id.to_string(),
                    target,
                    sender: parsed.prefix.and_then(extract_nick),
                    message,
                    kind: MessageKind::Notice,
                    timestamp: current_timestamp(),
                    metadata: None,
                };
                scrollback.append(storage_key, &msg).await.ok();
                let _ = app_handle.emit("irc://event", IrcEvent::Message { data: msg });
            }
        }
        "JOIN" => {
            let channel = parsed
                .params
                .get(0)
                .cloned()
                .or_else(|| parsed.trailing.clone())
                .unwrap_or_default();
            let nick = parsed.prefix.as_ref().and_then(|p| extract_nick(p.clone()));
            let nick = nick.unwrap_or_else(|| config.nickname.clone());
            let msg = ChatMessage {
                connection_id: connection_id.to_string(),
                target: channel.clone(),
                sender: Some(nick.clone()),
                message: format!("{nick} joined {channel}"),
                kind: MessageKind::Join,
                timestamp: current_timestamp(),
                metadata: None,
            };
            scrollback.append(storage_key, &msg).await.ok();
            let _ = app_handle.emit("irc://event", IrcEvent::Message { data: msg });
        }
        "PART" => {
            if let Some(channel) = parsed.params.get(0) {
                let nick = parsed
                    .prefix
                    .as_ref()
                    .and_then(|p| extract_nick(p.clone()))
                    .unwrap_or_else(|| config.nickname.clone());
                let reason = parsed
                    .params
                    .get(1)
                    .cloned()
                    .or_else(|| parsed.trailing.clone())
                    .unwrap_or_default();
                let mut text = format!("{nick} left {channel}");
                if !reason.is_empty() {
                    text.push_str(&format!(" ({reason})"));
                }
                let msg = ChatMessage {
                    connection_id: connection_id.to_string(),
                    target: channel.clone(),
                    sender: Some(nick.clone()),
                    message: text,
                    kind: MessageKind::Part,
                    timestamp: current_timestamp(),
                    metadata: None,
                };
                scrollback.append(storage_key, &msg).await.ok();
                let _ = app_handle.emit("irc://event", IrcEvent::Message { data: msg });
            }
        }
        "QUIT" => {
            let nick = parsed
                .prefix
                .as_ref()
                .and_then(|p| extract_nick(p.clone()))
                .unwrap_or_else(|| config.nickname.clone());
            let reason = parsed
                .params
                .get(0)
                .cloned()
                .or_else(|| parsed.trailing.clone())
                .unwrap_or_default();
            let text = if reason.is_empty() {
                format!("{nick} quit")
            } else {
                format!("{nick} quit: {reason}")
            };
            let msg = ChatMessage {
                connection_id: connection_id.to_string(),
                target: nick.clone(),
                sender: Some(nick),
                message: text,
                kind: MessageKind::Quit,
                timestamp: current_timestamp(),
                metadata: None,
            };
            scrollback.append(storage_key, &msg).await.ok();
            let _ = app_handle.emit("irc://event", IrcEvent::Message { data: msg });
        }
        "433" => {
            let _ = app_handle.emit(
                "irc://event",
                IrcEvent::Error {
                    connection_id: connection_id.to_string(),
                    message: "nickname already in use".into(),
                },
            );
        }
        _ => {}
    }
    Ok(())
}

fn extract_nick(prefix: String) -> Option<String> {
    prefix
        .split('!')
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn equals_ignore_case(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn parse_channel_user(entry: &str) -> ChannelUserInfo {
    let mut modes = Vec::new();
    let mut nick_start = 0;
    for (idx, ch) in entry.char_indices() {
        let mode = match ch {
            '~' => Some("owner"),
            '&' => Some("admin"),
            '@' => Some("op"),
            '%' => Some("halfop"),
            '+' => Some("voice"),
            _ => None,
        };
        if let Some(mode) = mode {
            modes.push(mode.to_string());
            nick_start = idx + ch.len_utf8();
        } else {
            break;
        }
    }
    let nick = entry[nick_start..].to_string();
    ChannelUserInfo { nick, modes }
}

#[derive(Debug)]
struct ParsedMessage {
    prefix: Option<String>,
    command: String,
    params: Vec<String>,
    trailing: Option<String>,
}

fn parse_message(line: &str) -> ParsedMessage {
    let mut rest = line.trim().to_string();
    let mut prefix = None;
    if rest.starts_with(':') {
        if let Some(idx) = rest.find(' ') {
            prefix = Some(rest[1..idx].to_string());
            rest = rest[idx + 1..].to_string();
        } else {
            return ParsedMessage {
                prefix,
                command: rest,
                params: Vec::new(),
                trailing: None,
            };
        }
    }
    let mut trailing = None;
    let mut parts = rest.splitn(2, " :");
    let head = parts.next().unwrap_or("");
    if let Some(t) = parts.next() {
        trailing = Some(t.to_string());
    }
    let mut iter = head.split_whitespace();
    let command = iter.next().unwrap_or("").to_string();
    let params = iter.map(|s| s.to_string()).collect();
    ParsedMessage {
        prefix,
        command,
        params,
        trailing,
    }
}

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
