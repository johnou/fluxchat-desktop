use serde::Deserialize;

use crate::{connection::ConnectionConfig, messages::ChatMessage, state::AppState};

#[derive(Debug, Deserialize)]
pub struct ConnectArgs {
    pub server: String,
    pub port: u16,
    #[serde(default)]
    pub use_tls: bool,
    pub nickname: String,
    pub username: Option<String>,
    pub realname: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub auto_join: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectArgs {
    pub connection_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinArgs {
    pub connection_id: String,
    pub channel: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartArgs {
    pub connection_id: String,
    pub channel: String,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageArgs {
    pub connection_id: String,
    pub target: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollbackArgs {
    pub connection_id: String,
    pub target: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicArgs {
    pub connection_id: String,
    pub channel: String,
    pub topic: Option<String>,
}

#[tauri::command]
pub async fn irc_connect(
    state: tauri::State<'_, AppState>,
    args: ConnectArgs,
) -> Result<String, String> {
    let manager = state.manager();
    let config = ConnectionConfig {
        server: args.server,
        port: args.port,
        use_tls: args.use_tls,
        nickname: args.nickname,
        username: args.username,
        realname: args.realname,
        password: args.password,
        auto_join: args.auto_join,
    };
    state
        .config_store()
        .upsert(&config)
        .map_err(|e| e.to_string())?;
    match manager.find_by_config(&config) {
        Some(existing) => Ok(existing.id().to_string()),
        None => manager.connect(config).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub async fn irc_disconnect(
    state: tauri::State<'_, AppState>,
    args: DisconnectArgs,
) -> Result<(), String> {
    state
        .manager()
        .disconnect(&args.connection_id, args.reason)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn irc_join(state: tauri::State<'_, AppState>, args: JoinArgs) -> Result<(), String> {
    state
        .manager()
        .join(&args.connection_id, &args.channel)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn irc_part(state: tauri::State<'_, AppState>, args: PartArgs) -> Result<(), String> {
    state
        .manager()
        .part(&args.connection_id, &args.channel, args.reason)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn irc_send_message(
    state: tauri::State<'_, AppState>,
    args: SendMessageArgs,
) -> Result<(), String> {
    state
        .manager()
        .privmsg(&args.connection_id, &args.target, &args.message)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn irc_set_topic(
    state: tauri::State<'_, AppState>,
    args: TopicArgs,
) -> Result<(), String> {
    state
        .manager()
        .set_topic(&args.connection_id, &args.channel, args.topic)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn irc_scrollback(
    state: tauri::State<'_, AppState>,
    args: ScrollbackArgs,
) -> Result<Vec<ChatMessage>, String> {
    let storage_key = state
        .manager()
        .get(&args.connection_id)
        .map(|handle| handle.storage_key().to_string())
        .ok_or_else(|| "connection not found".to_string())?;

    state
        .manager()
        .scrollback()
        .read_last(storage_key.as_str(), &args.target, args.limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn irc_list_connections(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    Ok(state.manager().list())
}

#[tauri::command]
pub async fn irc_saved_connections(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ConnectionConfig>, String> {
    Ok(state.config_store().list())
}
