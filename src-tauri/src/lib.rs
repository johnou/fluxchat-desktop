mod commands;
mod config_store;
mod connection;
mod messages;
mod state;
mod storage;

use commands::{
    irc_connect, irc_disconnect, irc_join, irc_list_connections, irc_part, irc_saved_connections,
    irc_scrollback, irc_send_message, irc_set_topic,
};
use config_store::ConfigStore;
use connection::ConnectionManager;
use state::AppState;
use storage::ScrollbackStore;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(debug_assertions)]
            tracy::maybe_init();
            let handle = app.handle();
            let data_root = handle.path().app_data_dir()?;
            let mut scrollback_dir = data_root.clone();
            scrollback_dir.push("scrollback");
            let scrollback = ScrollbackStore::new(scrollback_dir)?;
            let manager = ConnectionManager::new(handle.clone(), scrollback);
            let mut config_path = data_root.clone();
            config_path.push("connections.json");
            let config_store = ConfigStore::new(config_path)?;
            app.manage(AppState::new(manager, config_store));
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            irc_connect,
            irc_disconnect,
            irc_join,
            irc_part,
            irc_send_message,
            irc_set_topic,
            irc_scrollback,
            irc_list_connections,
            irc_saved_connections,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(debug_assertions)]
mod tracy {
    pub fn maybe_init() {
        if tracing::dispatcher::has_been_set() {
            return;
        }
        let _ = tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
            .try_init();
    }
}

#[cfg(not(debug_assertions))]
mod tracy {
    pub fn maybe_init() {}
}
