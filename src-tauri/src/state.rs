use crate::{config_store::ConfigStore, connection::ConnectionManager};

#[derive(Clone)]
pub struct AppState {
    manager: ConnectionManager,
    config_store: ConfigStore,
}

impl AppState {
    pub fn new(manager: ConnectionManager, config_store: ConfigStore) -> Self {
        Self {
            manager,
            config_store,
        }
    }

    pub fn manager(&self) -> &ConnectionManager {
        &self.manager
    }

    pub fn config_store(&self) -> &ConfigStore {
        &self.config_store
    }
}
