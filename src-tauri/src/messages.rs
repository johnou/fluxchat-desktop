use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Privmsg,
    Action,
    Notice,
    Join,
    Part,
    Quit,
    Nick,
    Topic,
    Info,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub connection_id: String,
    pub target: String,
    pub sender: Option<String>,
    pub message: String,
    pub kind: MessageKind,
    pub timestamp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelUserInfo {
    pub nick: String,
    #[serde(default)]
    pub modes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IrcEvent {
    Connected {
        connection_id: String,
        nickname: String,
        server: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Disconnected {
        connection_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Message {
        data: ChatMessage,
    },
    Names {
        connection_id: String,
        channel: String,
        users: Vec<ChannelUserInfo>,
    },
    Topic {
        connection_id: String,
        channel: String,
        topic: String,
        setter: Option<String>,
    },
    Error {
        connection_id: String,
        message: String,
    },
}
