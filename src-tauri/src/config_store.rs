use std::{fs, path::PathBuf, sync::Arc};

use anyhow::Context;
use parking_lot::RwLock;

use crate::connection::ConnectionConfig;

#[derive(Clone)]
pub struct ConfigStore {
    path: Arc<PathBuf>,
    connections: Arc<RwLock<Vec<ConnectionConfig>>>,
}

impl ConfigStore {
    pub fn new(path: PathBuf) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create config directory at {}", parent.display())
            })?;
        }
        let connections = if path.exists() {
            let data = fs::read_to_string(&path)
                .with_context(|| format!("failed to read config file {}", path.display()))?;
            serde_json::from_str(&data)
                .with_context(|| format!("failed to parse config file {}", path.display()))?
        } else {
            Vec::new()
        };
        Ok(Self {
            path: Arc::new(path),
            connections: Arc::new(RwLock::new(connections)),
        })
    }

    pub fn list(&self) -> Vec<ConnectionConfig> {
        self.connections.read().clone()
    }

    pub fn upsert(&self, config: &ConnectionConfig) -> anyhow::Result<()> {
        let mut guard = self.connections.write();
        if let Some(existing) = guard.iter_mut().find(|existing| {
            existing.server == config.server
                && existing.port == config.port
                && existing.nickname == config.nickname
        }) {
            *existing = config.clone();
        } else {
            guard.push(config.clone());
        }
        guard.sort_by(|a, b| {
            let server_cmp = a.server.cmp(&b.server);
            if server_cmp != std::cmp::Ordering::Equal {
                return server_cmp;
            }
            let port_cmp = a.port.cmp(&b.port);
            if port_cmp != std::cmp::Ordering::Equal {
                return port_cmp;
            }
            a.nickname.cmp(&b.nickname)
        });
        drop(guard);
        self.persist()
    }

    fn persist(&self) -> anyhow::Result<()> {
        let guard = self.connections.read();
        let data = serde_json::to_string_pretty(&*guard).context("failed to serialize configs")?;
        fs::write(&*self.path, data)
            .with_context(|| format!("failed to write config file {}", self.path.display()))?;
        Ok(())
    }
}
