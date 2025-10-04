use std::{path::PathBuf, sync::Arc};

use anyhow::Context;
use tokio::{fs, io::AsyncWriteExt};

use crate::messages::ChatMessage;

#[derive(Clone)]
pub struct ScrollbackStore {
    base_dir: Arc<PathBuf>,
}

impl ScrollbackStore {
    pub fn new(base_dir: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&base_dir).with_context(|| {
            format!(
                "failed to create scrollback directory at {}",
                base_dir.display()
            )
        })?;
        Ok(Self {
            base_dir: Arc::new(base_dir),
        })
    }

    fn target_path(&self, storage_key: &str, target: &str) -> PathBuf {
        let target = sanitize_component(target);
        let mut path = self.base_dir.as_ref().clone();
        path.push(sanitize_component(storage_key));
        path.push(format!("{target}.jsonl"));
        path
    }

    pub async fn append(&self, storage_key: &str, message: &ChatMessage) -> anyhow::Result<()> {
        let path = self.target_path(storage_key, &message.target);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.with_context(|| {
                format!("failed to create parent directories for {}", path.display())
            })?;
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .with_context(|| format!("failed to open scrollback file {}", path.display()))?;
        let mut line = serde_json::to_string(message)?;
        line.push('\n');
        file.write_all(line.as_bytes())
            .await
            .with_context(|| format!("failed to write scrollback {}", path.display()))?;
        file.flush().await.ok();
        Ok(())
    }

    pub async fn read_last(
        &self,
        storage_key: &str,
        target: &str,
        limit: Option<usize>,
    ) -> anyhow::Result<Vec<ChatMessage>> {
        let path = self.target_path(storage_key, target);
        let data = match fs::read_to_string(&path).await {
            Ok(data) => data,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => {
                return Err(err)
                    .with_context(|| format!("failed to read scrollback file {}", path.display()))
            }
        };
        let mut messages = Vec::new();
        for line in data.lines() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<ChatMessage>(line) {
                Ok(msg) => messages.push(msg),
                Err(err) => {
                    tracing::warn!("failed to parse scrollback line: {err}");
                }
            }
        }
        if let Some(limit) = limit {
            if messages.len() > limit {
                messages = messages.split_off(messages.len() - limit);
            }
        }
        Ok(messages)
    }
}

fn sanitize_component(input: &str) -> String {
    let mut s = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => s.push(c),
            _ => s.push('_'),
        }
    }
    if s.is_empty() {
        s.push('_');
    }
    s
}
