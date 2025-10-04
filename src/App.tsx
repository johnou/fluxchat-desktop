import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type MessageKind =
  | "privmsg"
  | "action"
  | "notice"
  | "join"
  | "part"
  | "quit"
  | "nick"
  | "topic"
  | "info"
  | "error";

interface ChatMessage {
  connection_id: string;
  target: string;
  sender?: string | null;
  message: string;
  kind: MessageKind;
  timestamp: number;
  metadata?: unknown;
}

type IrcEvent =
  | {
      type: "connected";
      connection_id: string;
      nickname: string;
      server: string;
      message?: string | null;
    }
  | {
      type: "disconnected";
      connection_id: string;
      reason?: string | null;
    }
  | {
      type: "message";
      data: ChatMessage;
    }
  | {
      type: "names";
      connection_id: string;
      channel: string;
      users: ChannelUserPayload[];
    }
  | {
      type: "topic";
      connection_id: string;
      channel: string;
      topic: string;
      setter?: string | null;
    }
  | {
      type: "error";
      connection_id: string;
      message: string;
    };

type BufferKind = "status" | "channel" | "query";

interface BufferState {
  name: string;
  kind: BufferKind;
  messages: ChatMessage[];
  users: ChannelUser[];
  topic?: string;
  unread: boolean;
  loaded: boolean;
  loading: boolean;
}

interface ConnectionState {
  id: string;
  server: string;
  nickname: string;
  connected: boolean;
  buffers: Record<string, BufferState>;
}

type ConnectionsState = Record<string, ConnectionState>;

type ActiveSelection = { connectionId: string; buffer: string } | null;

type ActiveSnapshot = { connectionId: string | null; buffer: string | null };

interface ConnectFormState {
  server: string;
  port: string;
  useTls: boolean;
  nickname: string;
  username: string;
  realname: string;
  password: string;
  autoJoin: string;
}

interface SavedConnection {
  server: string;
  port: number;
  useTls: boolean;
  nickname: string;
  username?: string | null;
  realname?: string | null;
  password?: string | null;
  autoJoin: string[];
}

interface ChannelUserPayload {
  nick: string;
  modes: string[];
}

type ChannelUser = ChannelUserPayload;

const QUIT_REASONS = [
  "ran out of caffeine",
  "recompiled the kernel",
  "rage quitting (brb)",
  "caught a segfault",
  "gone to chase buffers",
  "lost in /dev/null",
  "beaming up to HQ",
  "writing another script",
  "napping in a screen session",
  "enjoying a netsplit",
];

const MESSAGE_LIMIT = 500;
const DEFAULT_CONNECT_FORM: ConnectFormState = {
  server: "irc.libera.chat",
  port: "6697",
  useTls: true,
  nickname: "fluxuser",
  username: "",
  realname: "Flux User",
  password: "",
  autoJoin: "#fluxchat",
};

function randomQuitReason(): string {
  return QUIT_REASONS[Math.floor(Math.random() * QUIT_REASONS.length)] ?? "lost connection";
}

function App() {
  const [connections, setConnections] = useState<ConnectionsState>({});
  const [active, setActive] = useState<ActiveSelection>(null);
  const [connectForm, setConnectForm] = useState<ConnectFormState>(
    DEFAULT_CONNECT_FORM,
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [showConnectForm, setShowConnectForm] = useState(true);
  const [messageInput, setMessageInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const activeRef = useRef<ActiveSnapshot>({ connectionId: null, buffer: null });
  const savedDefaultsLoaded = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messageInputRef = useRef<HTMLInputElement | null>(null);
  const [isEditingTopic, setIsEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const [joinDrafts, setJoinDrafts] = useState<Record<string, string>>({});
  const [queryDrafts, setQueryDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    activeRef.current = active
      ? { connectionId: active.connectionId, buffer: active.buffer }
      : { connectionId: null, buffer: null };
  }, [active]);

  const refreshSavedConnections = useCallback(() => {
    invoke<SavedConnection[]>("irc_saved_connections")
      .then((list) => {
        setSavedConnections(list);
        if (!savedDefaultsLoaded.current && list.length > 0) {
          const last = list[list.length - 1];
          setConnectForm({
            server: last.server,
            port: String(last.port),
            useTls: last.useTls,
            nickname: last.nickname,
            username: last.username ?? "",
            realname: last.realname ?? "",
            password: last.password ?? "",
            autoJoin: last.autoJoin.join(", "),
          });
          savedDefaultsLoaded.current = true;
        }
      })
      .catch((error) => {
        console.error("Failed to load saved connections", error);
        setStatus(`Failed to load saved connections: ${String(error)}`);
      });
  }, []);

  useEffect(() => {
    refreshSavedConnections();
  }, [refreshSavedConnections]);

  const focusMessageInput = useCallback(() => {
    requestAnimationFrame(() => {
      messageInputRef.current?.focus();
    });
  }, []);

  const loadBufferIfNeeded = useCallback(
    (connectionId: string, bufferName: string) => {
      setConnections((prev) => {
        const connection = prev[connectionId];
        if (!connection) {
          return prev;
        }
        const existing = connection.buffers[bufferName];
        if (!existing || existing.loaded || existing.loading) {
          return prev;
        }
        return {
          ...prev,
          [connectionId]: {
            ...connection,
            buffers: {
              ...connection.buffers,
              [bufferName]: { ...existing, loading: true },
            },
          },
        };
      });

      invoke<ChatMessage[]>("irc_scrollback", {
        args: {
          connectionId,
          target: bufferName,
          limit: MESSAGE_LIMIT,
        },
      })
        .then((history) => {
          setConnections((prev) => {
            const connection = prev[connectionId];
            if (!connection) {
              return prev;
            }
            const existing = connection.buffers[bufferName];
            if (!existing) {
              return prev;
            }
            const buffer: BufferState = {
              ...existing,
              loading: false,
              loaded: true,
              messages: mergeHistory(existing.messages, history),
              unread: isBufferActive(
                activeRef.current,
                connectionId,
                bufferName,
              )
                ? false
                : existing.unread,
            };
            return {
              ...prev,
              [connectionId]: {
                ...connection,
                buffers: {
                  ...connection.buffers,
                  [bufferName]: buffer,
                },
              },
            };
          });
        })
        .catch((error) => {
          console.error(error);
          setStatus(
            `Failed to load scrollback for ${bufferName}: ${String(error)}`,
          );
          setConnections((prev) => {
            const connection = prev[connectionId];
            if (!connection) {
              return prev;
            }
            const existing = connection.buffers[bufferName];
            if (!existing) {
              return prev;
            }
            return {
              ...prev,
              [connectionId]: {
                ...connection,
                buffers: {
                  ...connection.buffers,
                  [bufferName]: { ...existing, loading: false, loaded: true },
                },
              },
            };
          });
        });
    },
    [],
  );

  const handleEvent = useCallback((payload: IrcEvent) => {
    const activeSnapshot = activeRef.current;
    setConnections((prev) => applyEvent(prev, payload, activeSnapshot));
    switch (payload.type) {
      case "connected":
        setStatus(`Connected to ${payload.server}`);
        setActive((current) =>
          current ?? {
            connectionId: payload.connection_id,
            buffer: "*server",
          },
        );
        break;
      case "error":
        setStatus(payload.message);
        break;
      case "disconnected":
        setStatus(
          payload.reason
            ? `Disconnected: ${payload.reason}`
            : "Disconnected",
        );
        break;
      default:
        break;
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    listen<IrcEvent>("irc://event", (event) => {
      handleEvent(event.payload);
    })
      .then((fn) => {
        if (!mounted) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((error) => {
        console.error("Failed to bind IRC event handler", error);
        setStatus(`Failed to subscribe to IRC events: ${String(error)}`);
      });

    return () => {
      mounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleEvent]);

  useEffect(() => {
    if (!active) {
      return;
    }
    loadBufferIfNeeded(active.connectionId, active.buffer);
  }, [active, loadBufferIfNeeded]);

  useEffect(() => {
    if (!status) {
      return;
    }
    const timer = window.setTimeout(() => setStatus(null), 5000);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (!messagesEndRef.current) {
      return;
    }
    messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [active, connections]);

  const activeConnection = active ? connections[active.connectionId] : undefined;
  const activeBuffer =
    active && activeConnection ? activeConnection.buffers[active.buffer] : undefined;
  const activeMessages = activeBuffer?.messages ?? [];
  const activeUsers = activeBuffer?.users ?? [];

  useEffect(() => {
    setIsEditingTopic(false);
    setTopicDraft(activeBuffer?.topic ?? "");
  }, [activeConnection?.id, activeBuffer?.name, activeBuffer?.topic]);

  const sortedConnections = useMemo(() => {
    return Object.values(connections).sort((a, b) =>
      a.server.localeCompare(b.server, undefined, { sensitivity: "base" }),
    );
  }, [connections]);

  const handleSelectBuffer = useCallback(
    (connectionId: string, bufferName: string) => {
      setActive({ connectionId, buffer: bufferName });
      setStatus(null);
      setConnections((prev) => {
        const connection = prev[connectionId];
        if (!connection) {
          return prev;
        }
        const existing = connection.buffers[bufferName];
        if (!existing) {
          return prev;
        }
        return {
          ...prev,
          [connectionId]: {
            ...connection,
            buffers: {
              ...connection.buffers,
              [bufferName]: { ...existing, unread: false },
            },
          },
        };
      });
      loadBufferIfNeeded(connectionId, bufferName);
    },
    [loadBufferIfNeeded],
  );

  const handleApplySaved = useCallback(
    (saved: SavedConnection) => {
      setConnectForm({
        server: saved.server,
        port: String(saved.port),
        useTls: saved.useTls,
        nickname: saved.nickname,
        username: saved.username ?? "",
        realname: saved.realname ?? "",
        password: saved.password ?? "",
        autoJoin: saved.autoJoin.join(", "),
      });
      setShowConnectForm(true);
    },
    [],
  );

  const disconnectConnection = useCallback(
    async (connectionId: string) => {
      setConnections((prev) => {
        const existing = prev[connectionId];
        if (!existing) {
          return prev;
        }
        return {
          ...prev,
          [connectionId]: {
            ...existing,
            connected: false,
          },
        };
      });
      try {
        await invoke("irc_disconnect", {
          args: {
            connectionId,
            reason: randomQuitReason(),
          },
        });
      } catch (error) {
        console.error(error);
        setStatus(`Failed to disconnect: ${String(error)}`);
        setConnections((prev) => {
          const existing = prev[connectionId];
          if (!existing) {
            return prev;
          }
          return {
            ...prev,
            [connectionId]: {
              ...existing,
              connected: true,
            },
          };
        });
      }
    },
    [],
  );

  const handleOpenQuery = useCallback(
    (nickname: string) => {
      if (!activeConnection || !nickname || !activeConnection.connected) {
        return;
      }
      setConnections((prev) => {
        const connection = prev[activeConnection.id];
        if (!connection) {
          return prev;
        }
        if (connection.buffers[nickname]) {
          return prev;
        }
        return {
          ...prev,
          [activeConnection.id]: {
            ...connection,
            buffers: {
              ...connection.buffers,
              [nickname]: createBuffer(nickname, "query"),
            },
          },
        };
      });
      setActive({ connectionId: activeConnection.id, buffer: nickname });
      loadBufferIfNeeded(activeConnection.id, nickname);
      focusMessageInput();
    },
    [activeConnection, focusMessageInput, loadBufferIfNeeded],
  );

  const handleConnectSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!connectForm.server.trim() || !connectForm.nickname.trim()) {
        setStatus("Server and nickname are required");
        return;
      }
      const port = parseInt(connectForm.port, 10);
      if (Number.isNaN(port)) {
        setStatus("Port must be a number");
        return;
      }
      const autoJoin = connectForm.autoJoin
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      setIsConnecting(true);
      try {
        const connectionId = await invoke<string>("irc_connect", {
          args: {
            server: connectForm.server.trim(),
            port,
            use_tls: connectForm.useTls,
            nickname: connectForm.nickname.trim(),
            username: connectForm.username.trim() || undefined,
            realname: connectForm.realname.trim() || undefined,
            password: connectForm.password || undefined,
            auto_join: autoJoin,
          },
        });
        setStatus(`Connecting to ${connectForm.server.trim()}...`);
        setShowConnectForm(false);
        setActive((current) =>
          current ?? {
            connectionId,
            buffer: "*server",
          },
        );
        refreshSavedConnections();
      } catch (error) {
        console.error(error);
        setStatus(`Connection failed: ${String(error)}`);
      } finally {
        setIsConnecting(false);
      }
    },
    [connectForm, refreshSavedConnections],
  );

  const handleMessageSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!activeConnection || !activeBuffer) {
        return;
      }
      const raw = messageInput;
      const trimmed = raw.trim();
      if (!trimmed) {
        setMessageInput("");
        return;
      }
      if (trimmed.startsWith("/")) {
        await handleSlashCommand(trimmed, activeConnection, activeBuffer, setStatus);
      } else {
        try {
          await invoke("irc_send_message", {
            args: {
              connectionId: activeConnection.id,
              target: activeBuffer.name,
              message: raw,
            },
          });
        } catch (error) {
          console.error(error);
          setStatus(`Failed to send message: ${String(error)}`);
        }
      }
      setMessageInput("");
    },
    [activeBuffer, activeConnection, messageInput],
  );

  const handleTopicEdit = useCallback(() => {
    if (!activeBuffer || activeBuffer.kind !== "channel") {
      return;
    }
    setTopicDraft(activeBuffer.topic ?? "");
    setIsEditingTopic(true);
  }, [activeBuffer]);

  const handleTopicCancel = useCallback(() => {
    setTopicDraft(activeBuffer?.topic ?? "");
    setIsEditingTopic(false);
  }, [activeBuffer]);

  const handleTopicSave = useCallback(async () => {
    if (!activeConnection || !activeBuffer || activeBuffer.kind !== "channel") {
      return;
    }
    try {
      await invoke("irc_set_topic", {
        args: {
          connectionId: activeConnection.id,
          channel: activeBuffer.name,
          topic: topicDraft.trim() || undefined,
        },
      });
      setIsEditingTopic(false);
    } catch (error) {
      console.error(error);
      setStatus(`Failed to update topic: ${String(error)}`);
    }
  }, [activeBuffer, activeConnection, topicDraft]);

  const handleJoinDraftChange = useCallback((connectionId: string, value: string) => {
    setJoinDrafts((prev) => ({ ...prev, [connectionId]: value }));
  }, []);

  const handleQueryDraftChange = useCallback((connectionId: string, value: string) => {
    setQueryDrafts((prev) => ({ ...prev, [connectionId]: value }));
  }, []);

  const handleJoinSubmit = useCallback(
    (connectionId: string) => async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const connection = connections[connectionId];
      if (!connection || !connection.connected) {
        return;
      }
      const channel = (joinDrafts[connectionId] ?? "").trim();
      if (!channel) {
        return;
      }
      try {
        await invoke("irc_join", {
          args: {
            connectionId,
            channel,
          },
        });
        setJoinDrafts((prev) => ({ ...prev, [connectionId]: "" }));
        const inputEl = event.currentTarget.querySelector<HTMLInputElement>('input');
        inputEl?.blur();
        setActive({ connectionId, buffer: channel });
        loadBufferIfNeeded(connectionId, channel);
        focusMessageInput();
      } catch (error) {
        console.error(error);
        setStatus(`Failed to join ${channel}: ${String(error)}`);
      }
    },
    [connections, joinDrafts, loadBufferIfNeeded, focusMessageInput],
  );

  const handleOpenQueryDraft = useCallback(
    (connectionId: string) => (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const nickname = (queryDrafts[connectionId] ?? "").trim();
      if (!nickname) {
        return;
      }
      const connection = connections[connectionId];
      if (!connection || !connection.connected) {
        return;
      }
      setConnections((prev) => {
        const connection = prev[connectionId];
        if (!connection || !connection.connected) {
          return prev;
        }
        if (connection.buffers[nickname]) {
          return prev;
        }
        return {
          ...prev,
          [connectionId]: {
            ...connection,
            buffers: {
              ...connection.buffers,
              [nickname]: createBuffer(nickname, "query"),
            },
          },
        };
      });
      setQueryDrafts((prev) => ({ ...prev, [connectionId]: "" }));
      setActive({ connectionId, buffer: nickname });
      loadBufferIfNeeded(connectionId, nickname);
      const inputEl = event.currentTarget.querySelector<HTMLInputElement>('input');
      inputEl?.blur();
      focusMessageInput();
    },
    [connections, focusMessageInput, loadBufferIfNeeded, queryDrafts],
  );

  const handleCloseBuffer = useCallback(
    async (connectionId: string, bufferName: string) => {
      if (bufferName === "*server") {
        return;
      }
      const connection = connections[connectionId];
      if (!connection) {
        return;
      }
      const buffer = connection.buffers[bufferName];
      if (!buffer) {
        return;
      }
      if (buffer.kind === "channel") {
        try {
          await invoke("irc_part", {
            args: {
              connectionId,
              channel: buffer.name,
              reason: undefined,
            },
          });
        } catch (error) {
          console.error(error);
          setStatus(`Failed to part ${buffer.name}: ${String(error)}`);
          return;
        }
      }
      let fallback: ActiveSelection | undefined;
      setConnections((prev) => {
        const current = prev[connectionId];
        if (!current) {
          return prev;
        }
        if (!current.buffers[bufferName]) {
          return prev;
        }
        const { [bufferName]: _removed, ...rest } = current.buffers;
        const nextConnection: ConnectionState = {
          ...current,
          buffers: rest,
        };
        if (active?.connectionId === connectionId && active.buffer === bufferName) {
          const fallbackName = rest["*server"]
            ? "*server"
            : Object.keys(rest)[0] ?? null;
          fallback = fallbackName ? { connectionId, buffer: fallbackName } : null;
        }
        return {
          ...prev,
          [connectionId]: nextConnection,
        };
      });
      if (fallback !== undefined) {
        setActive(fallback ?? null);
        if (fallback) {
          loadBufferIfNeeded(fallback.connectionId, fallback.buffer);
        }
      }
    },
    [active, connections, loadBufferIfNeeded],
  );

  const renderBuffers = (connection: ConnectionState) => {
    const buffers = Object.values(connection.buffers).sort((a, b) => {
      if (a.name === b.name) {
        return 0;
      }
      if (a.name === "*server") {
        return -1;
      }
      if (b.name === "*server") {
        return 1;
      }
      if (a.kind === b.kind) {
        return a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
        });
      }
      if (a.kind === "channel" && b.kind !== "channel") {
        return -1;
      }
      if (a.kind !== "channel" && b.kind === "channel") {
        return 1;
      }
      return a.name.localeCompare(b.name, undefined, {
        sensitivity: "base",
      });
    });

    return buffers.map((buffer) => {
      const isActive =
        active?.connectionId === connection.id && active.buffer === buffer.name;
      const buttonClasses = ["buffer-pill"];
      if (isActive) {
        buttonClasses.push("active");
      }
      if (buffer.unread && !isActive) {
        buttonClasses.push("unread");
      }
      const closable = buffer.name !== "*server";
      return (
        <div key={`${connection.id}-${buffer.name}`} className="buffer-row">
          <button
            className={buttonClasses.join(" ")}
            onClick={() => handleSelectBuffer(connection.id, buffer.name)}
          >
            <span className="buffer-name">{bufferLabel(buffer)}</span>
            {buffer.unread && !isActive ? <span className="unread-dot" /> : null}
          </button>
          {closable ? (
            <button
              type="button"
              className="buffer-close"
              onClick={(event) => {
                event.stopPropagation();
                void handleCloseBuffer(connection.id, buffer.name);
              }}
              title="Close"
            >
              ×
            </button>
          ) : null}
        </div>
      );
    });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div>
            <h1>FluxChat</h1>
            <p className="tagline">Classic IRC for the modern desktop</p>
          </div>
          <button
            className="ghost-button"
            onClick={() => setShowConnectForm((value) => !value)}
          >
            {showConnectForm ? "Hide" : "Manage Connections"}
          </button>
        </header>

        {showConnectForm ? (
          <form className="connect-form" onSubmit={handleConnectSubmit}>
            <label>
              Server
              <input
                value={connectForm.server}
                onChange={(event) =>
                  setConnectForm((prev) => ({
                    ...prev,
                    server: event.target.value,
                  }))
                }
                placeholder="irc.example.net"
                required
              />
            </label>
            <div className="form-row">
              <label>
                Port
                <input
                  value={connectForm.port}
                  onChange={(event) =>
                    setConnectForm((prev) => ({
                      ...prev,
                      port: event.target.value,
                    }))
                  }
                  inputMode="numeric"
                  pattern="[0-9]*"
                  required
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={connectForm.useTls}
                  onChange={(event) =>
                    setConnectForm((prev) => ({
                      ...prev,
                      useTls: event.target.checked,
                    }))
                  }
                />
                TLS
              </label>
            </div>
            <label>
              Nickname
              <input
                value={connectForm.nickname}
                onChange={(event) =>
                  setConnectForm((prev) => ({
                    ...prev,
                    nickname: event.target.value,
                  }))
                }
                required
              />
            </label>
            <label>
              Username
              <input
                value={connectForm.username}
                onChange={(event) =>
                  setConnectForm((prev) => ({
                    ...prev,
                    username: event.target.value,
                  }))
                }
                placeholder="Optional"
              />
            </label>
            <label>
              Real name
              <input
                value={connectForm.realname}
                onChange={(event) =>
                  setConnectForm((prev) => ({
                    ...prev,
                    realname: event.target.value,
                  }))
                }
                placeholder="Optional"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={connectForm.password}
                onChange={(event) =>
                  setConnectForm((prev) => ({
                    ...prev,
                    password: event.target.value,
                  }))
                }
                placeholder="Optional"
              />
            </label>
            <label>
              Auto-join channels
              <input
                value={connectForm.autoJoin}
                onChange={(event) =>
                  setConnectForm((prev) => ({
                    ...prev,
                    autoJoin: event.target.value,
                  }))
                }
                placeholder="#channel1, #channel2"
              />
            </label>
            <button className="primary" type="submit" disabled={isConnecting}>
              {isConnecting ? "Connecting…" : "Connect"}
            </button>
            {savedConnections.length > 0 ? (
              <div className="saved-connections">
                <div className="saved-connections-header">Saved Servers</div>
                <div className="saved-connections-grid">
                  {savedConnections.map((saved) => {
                    const key = `${saved.server}:${saved.port}:${saved.nickname}`;
                    return (
                      <button
                        key={key}
                        type="button"
                        className="saved-connection"
                        onClick={() => handleApplySaved(saved)}
                      >
                        <span className="saved-title">{saved.server}:{saved.port}</span>
                        <span className="saved-subtitle">as {saved.nickname}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </form>
        ) : null}

        <div className="connection-list">
          {sortedConnections.map((connection) => (
            <div key={connection.id} className="connection-section">
              <div className="connection-title">
                <span className={connection.connected ? "connected" : "disconnected"}>
                  ●
                </span>
                <div>
                  <strong>{connection.server}</strong>
                  <div className="subtitle">as {connection.nickname}</div>
                </div>
                <button
                  type="button"
                  className="ghost-button small"
                  onClick={() => disconnectConnection(connection.id)}
                  disabled={!connection.connected}
                >
                  {connection.connected ? "Disconnect" : "Disconnected"}
                </button>
              </div>
              <div className="buffer-list">{renderBuffers(connection)}</div>
              <div className="connection-tools">
                <form
                  className="sidebar-form"
                  onSubmit={handleJoinSubmit(connection.id)}
                >
                  <input
                    value={joinDrafts[connection.id] ?? ""}
                    onChange={(event) => handleJoinDraftChange(connection.id, event.target.value)}
                    placeholder="#channel (press Enter)"
                    disabled={!connection.connected}
                  />
                </form>
                <form
                  className="sidebar-form"
                  onSubmit={handleOpenQueryDraft(connection.id)}
                >
                  <input
                    value={queryDrafts[connection.id] ?? ""}
                    onChange={(event) => handleQueryDraftChange(connection.id, event.target.value)}
                    placeholder="Message nick (press Enter)"
                    disabled={!connection.connected}
                  />
                </form>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <section className="chat-pane">
        <header className="chat-header">
          <div className="chat-meta">
            <h2>
              {activeBuffer ? bufferLabel(activeBuffer) : "No channel selected"}
            </h2>
            {activeBuffer?.kind === "channel" ? (
              isEditingTopic ? (
                <div className="topic-editor">
                  <input
                    value={topicDraft}
                    onChange={(event) => setTopicDraft(event.target.value)}
                    placeholder="Set channel topic"
                  />
                  <div className="topic-actions">
                    <button type="button" onClick={handleTopicSave}>
                      Save
                    </button>
                    <button type="button" onClick={handleTopicCancel}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="topic-row">
                  <p className="topic" title={activeBuffer.topic ?? "No topic"}>
                    {activeBuffer.topic ?? "No topic set"}
                  </p>
                  <button
                    type="button"
                    className="ghost-button small"
                    onClick={handleTopicEdit}
                  >
                    Edit
                  </button>
                </div>
              )
            ) : null}
          </div>
        </header>
        <div className="message-list">
          {activeMessages.map((msg, index) => (
            <div
              key={`${msg.timestamp}-${msg.kind}-${msg.sender ?? ""}-${index}`}
              className={`message message-${msg.kind}${(msg.metadata as Record<string, unknown> | undefined)?.mention ? " message-mention" : ""}`}
            >
              <span className="message-time">{formatTime(msg.timestamp)}</span>
              {renderMessage(msg, activeConnection?.nickname ?? "")}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
        <footer className="message-input">
          <form onSubmit={handleMessageSubmit}>
            <input
              ref={messageInputRef}
              value={messageInput}
              onChange={(event) => setMessageInput(event.target.value)}
              placeholder={activeBuffer ? `Message ${bufferLabel(activeBuffer)}` : "Select a channel to chat"}
              disabled={!activeBuffer}
            />
            <button type="submit" disabled={!activeBuffer}>
              Send
            </button>
          </form>
        </footer>
        {status ? <div className="status-bar">{status}</div> : null}
      </section>

      <aside className="userlist">
        <header className="userlist-header">
          <h3>Users</h3>
          <span>{activeUsers.length}</span>
        </header>
        <div className="userlist-body">
          {activeUsers.map((user) => {
            const badge = modeBadge(user.modes);
            return (
              <button
                key={user.nick.toLowerCase()}
                className="userlist-item"
                type="button"
                onDoubleClick={() => handleOpenQuery(user.nick)}
                title={user.modes.join(", ")}
              >
                {badge ? (
                  <span className={`user-badge user-badge--${badge.className}`}>
                    {badge.symbol}
                  </span>
                ) : null}
                <span>{user.nick}</span>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

export default App;

function applyEvent(
  prev: ConnectionsState,
  payload: IrcEvent,
  active: ActiveSnapshot,
): ConnectionsState {
  const next: ConnectionsState = { ...prev };

  switch (payload.type) {
    case "connected": {
      const id = payload.connection_id;
      const storageKey = connectionStorageKey(payload.server, payload.nickname);
      let existing = prev[id];
      const existingEntry = Object.entries(next).find(
        ([existingId, conn]) =>
          existingId !== id && connectionStorageKey(conn.server, conn.nickname) === storageKey,
      );
      if (existingEntry) {
        existing = existingEntry[1];
        delete next[existingEntry[0]];
      }
      const connection = cloneConnection(
        existing,
        id,
        payload.server,
        payload.nickname,
      );
      const serverBuffer = cloneBuffer(connection.buffers["*server"], "*server");
      if (payload.message) {
        serverBuffer.messages = appendMessage(
          serverBuffer.messages,
          makeSystemMessage(id, "*server", payload.message, "info"),
        );
        serverBuffer.unread = !isBufferActive(active, id, "*server");
      }
      connection.buffers["*server"] = serverBuffer;
      connection.connected = true;
      next[id] = connection;
      return next;
    }
    case "disconnected": {
      const id = payload.connection_id;
      const existing = prev[id];
      const connection = cloneConnection(existing, id, existing?.server, existing?.nickname);
      const serverBuffer = cloneBuffer(connection.buffers["*server"], "*server");
      const reason = payload.reason ? `Disconnected: ${payload.reason}` : "Disconnected";
      serverBuffer.messages = appendMessage(
        serverBuffer.messages,
        makeSystemMessage(id, "*server", reason, "info"),
      );
      serverBuffer.unread = !isBufferActive(active, id, "*server");
      connection.buffers["*server"] = serverBuffer;
      connection.connected = false;
      next[id] = connection;
      return next;
    }
    case "error": {
      const id = payload.connection_id;
      const existing = prev[id];
      const connection = cloneConnection(existing, id, existing?.server, existing?.nickname);
      const serverBuffer = cloneBuffer(connection.buffers["*server"], "*server");
      serverBuffer.messages = appendMessage(
        serverBuffer.messages,
        makeSystemMessage(id, "*server", payload.message, "error"),
      );
      serverBuffer.unread = !isBufferActive(active, id, "*server");
      connection.buffers["*server"] = serverBuffer;
      next[id] = connection;
      return next;
    }
    case "topic": {
      const id = payload.connection_id;
      const existing = prev[id];
      const connection = cloneConnection(existing, id, existing?.server, existing?.nickname);
      const bufferName = payload.channel;
      const buffer = cloneBuffer(connection.buffers[bufferName], bufferName);
      buffer.topic = payload.topic;
      buffer.unread = !isBufferActive(active, id, bufferName) || buffer.unread;
      connection.buffers[bufferName] = buffer;
      next[id] = connection;
      return next;
    }
    case "names": {
      const id = payload.connection_id;
      const existing = prev[id];
      const connection = cloneConnection(existing, id, existing?.server, existing?.nickname);
      const bufferName = payload.channel;
      const buffer = cloneBuffer(connection.buffers[bufferName], bufferName);
      buffer.users = normalizeUsers(payload.users);
      connection.buffers[bufferName] = buffer;
      next[id] = connection;
      return next;
    }
    case "message": {
      const msg = payload.data;
      const id = msg.connection_id;
      const existing = prev[id];
      const connection = cloneConnection(existing, id, existing?.server, existing?.nickname ?? msg.sender ?? "unknown");
      const normalized = annotateMessage(msg, connection);
      let bufferName = resolveBufferName(connection, normalized);
      if (bufferName === "*server" && !connection.buffers["*server"]) {
        const fallbacks = [connection.server, "*"];
        for (const key of fallbacks) {
          if (connection.buffers[key]) {
            connection.buffers["*server"] = connection.buffers[key];
            delete connection.buffers[key];
            break;
          }
        }
        bufferName = "*server";
      } else if (
        bufferName === connection.server ||
        bufferName === "*"
      ) {
        bufferName = "*server";
      }
      const buffer = cloneBuffer(connection.buffers[bufferName], bufferName);
      buffer.messages = appendMessage(buffer.messages, normalized);
      const mentioned = isMention(normalized, connection.nickname);
      buffer.unread = !isBufferActive(active, id, bufferName) || mentioned;

      if (buffer.kind === "channel") {
        if (msg.kind === "join" && msg.sender) {
          buffer.users = addUser(buffer.users, msg.sender);
        }
        if (msg.kind === "part" && msg.sender) {
          buffer.users = removeUser(buffer.users, msg.sender);
        }
      }

      connection.buffers[bufferName] = buffer;
      next[id] = connection;
      return next;
    }
    default:
      return prev;
  }
}

function cloneConnection(
  existing: ConnectionState | undefined,
  id: string,
  server?: string,
  nickname?: string,
): ConnectionState {
  if (existing) {
    return {
      ...existing,
      server: server ?? existing.server,
      nickname: nickname ?? existing.nickname,
      buffers: { ...existing.buffers },
    };
  }
  return {
    id,
    server: server ?? "unknown",
    nickname: nickname ?? "unknown",
    connected: false,
    buffers: {
      "*server": createBuffer("*server", "status"),
    },
  };
}

function connectionStorageKey(server: string, nickname: string): string {
  return `${server.toLowerCase()}::${nickname.toLowerCase()}`;
}

function createBuffer(name: string, kind: BufferKind): BufferState {
  return {
    name,
    kind,
    messages: [],
    users: [],
    topic: undefined,
    unread: false,
    loaded: false,
    loading: false,
  };
}

function cloneBuffer(
  buffer: BufferState | undefined,
  name: string,
): BufferState {
  if (buffer) {
    return {
      ...buffer,
      messages: buffer.messages.slice(),
      users: buffer.users.slice(),
    };
  }
  return createBuffer(name, deriveBufferKind(name));
}

function deriveBufferKind(name: string): BufferKind {
  if (name === "*server") {
    return "status";
  }
  if (name.startsWith("#") || name.startsWith("&")) {
    return "channel";
  }
  return "query";
}

function resolveBufferName(
  connection: ConnectionState,
  msg: ChatMessage,
): string {
  if (msg.kind === "info" || msg.kind === "error" || msg.kind === "quit") {
    return "*server";
  }
  const target = msg.target;
  if (target === "*" || equalsIgnoreCase(target, connection.server)) {
    return "*server";
  }
  if (target.startsWith("#") || target.startsWith("&")) {
    return target;
  }
  const nickname = connection.nickname;
  if (msg.sender && equalsIgnoreCase(target, nickname)) {
    return msg.sender;
  }
  if (!msg.sender && equalsIgnoreCase(target, nickname)) {
    return "*server";
  }
  return target;
}

function annotateMessage(msg: ChatMessage, connection: ConnectionState): ChatMessage {
  const mention = isMention(msg, connection.nickname);
  if (!mention) {
    return msg;
  }
  const existingMeta = (msg.metadata as Record<string, unknown> | undefined) ?? {};
  return {
    ...msg,
    metadata: {
      ...existingMeta,
      mention: true,
    },
  };
}

function isMention(msg: ChatMessage, nickname: string): boolean {
  if (msg.kind !== "privmsg") {
    return false;
  }
  if (!nickname) {
    return false;
  }
  return msg.message.toLowerCase().includes(nickname.toLowerCase());
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

function makeSystemMessage(
  connectionId: string,
  target: string,
  message: string,
  kind: MessageKind,
): ChatMessage {
  return {
    connection_id: connectionId,
    target,
    sender: null,
    message,
    kind,
    timestamp: Date.now(),
  };
}

function findLastIndex<T>(items: T[], predicate: (value: T, index: number) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i], i)) {
      return i;
    }
  }
  return -1;
}

function clipMessages(messages: ChatMessage[], limit = MESSAGE_LIMIT): ChatMessage[] {
  if (messages.length <= limit) {
    return messages;
  }
  return messages.slice(messages.length - limit);
}

function appendMessage(
  messages: ChatMessage[],
  msg: ChatMessage,
  limit = MESSAGE_LIMIT,
): ChatMessage[] {
  const index = findLastIndex(messages, (existing) => canMergeMessages(existing, msg));
  if (index !== -1) {
    const existing = messages[index];
    const existingMeta = (existing.metadata as Record<string, unknown> | undefined) ?? {};
    const repeatCount = Number(existingMeta.repeatCount ?? 1) + 1;
    const merged: ChatMessage = {
      ...existing,
      timestamp: msg.timestamp,
      metadata: {
        ...existingMeta,
        repeatCount,
      },
    };
    const withoutExisting = [...messages.slice(0, index), ...messages.slice(index + 1)];
    return clipMessages([...withoutExisting, merged], limit);
  }
  const meta =
    msg.metadata && typeof msg.metadata === "object"
      ? { ...(msg.metadata as Record<string, unknown>) }
      : {};
  const next: ChatMessage = {
    ...msg,
    metadata: meta,
  };
  return clipMessages([...messages, next], limit);
}

function canMergeMessages(a: ChatMessage, b: ChatMessage): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "privmsg" || a.kind === "action") {
    return false;
  }
  if (a.sender ?? "" !== b.sender ?? "") {
    return false;
  }
  if (a.target !== b.target) {
    return false;
  }
  return a.message === b.message;
}

function mergeHistory(
  existing: ChatMessage[],
  history: ChatMessage[],
): ChatMessage[] {
  const lookup = new Map<string, ChatMessage>();
  const add = (msg: ChatMessage) => {
    lookup.set(messageKey(msg), msg);
  };
  history.forEach(add);
  existing.forEach(add);
  return Array.from(lookup.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function messageKey(msg: ChatMessage): string {
  return [
    msg.timestamp,
    msg.target,
    msg.kind,
    msg.sender ?? "",
    msg.message,
  ].join("|");
}

function isBufferActive(
  active: ActiveSnapshot,
  connectionId: string,
  bufferName: string,
): boolean {
  return active.connectionId === connectionId && active.buffer === bufferName;
}

function addUser(users: ChannelUser[], nick: string, modes: string[] = []): ChannelUser[] {
  if (users.some((user) => equalsIgnoreCase(user.nick, nick))) {
    return users;
  }
  return sortUsers([...users, { nick, modes }]);
}

function removeUser(users: ChannelUser[], nick: string): ChannelUser[] {
  return users.filter((user) => !equalsIgnoreCase(user.nick, nick));
}

function sortUsers(users: ChannelUser[]): ChannelUser[] {
  return users
    .slice()
    .sort((a, b) => a.nick.localeCompare(b.nick, undefined, { sensitivity: "base" }));
}

function normalizeUsers(users: ChannelUserPayload[]): ChannelUser[] {
  return sortUsers(users.map((user) => ({ ...user })));
}

const MODE_ORDER = ["owner", "admin", "op", "halfop", "voice"] as const;
const MODE_META: Record<string, { symbol: string; className: string }> = {
  owner: { symbol: "~", className: "owner" },
  admin: { symbol: "&", className: "admin" },
  op: { symbol: "@", className: "op" },
  halfop: { symbol: "%", className: "halfop" },
  voice: { symbol: "+", className: "voice" },
};

function modeBadge(modes: string[]): { symbol: string; className: string } | null {
  for (const mode of MODE_ORDER) {
    if (modes.includes(mode)) {
      return MODE_META[mode];
    }
  }
  return null;
}

function bufferLabel(buffer: BufferState): string {
  if (buffer.name === "*server") {
    return "Server";
  }
  return buffer.name;
}

function renderMessage(msg: ChatMessage, nickname: string) {
  const sender = msg.sender ?? "";
  const repeatCount = ((msg.metadata as Record<string, unknown> | undefined)?.repeatCount ?? 1) as number;
  const repeatBadge = repeatCount > 1 ? (
    <span className="message-repeat">×{repeatCount}</span>
  ) : null;
  switch (msg.kind) {
    case "action":
      return (
        <span className="message-body">
          <span className="message-sender">* {sender}</span>
          <span className="message-text"> {msg.message}</span>
          {repeatBadge}
        </span>
      );
    case "join":
    case "part":
    case "quit":
    case "topic":
    case "info":
      return (
        <span className="message-body system">
          <span className="message-text">{msg.message}</span>
          {repeatBadge}
        </span>
      );
    case "notice":
      return (
        <span className="message-body notice">
          <span className="message-sender">{sender || "-"}</span>
          <span className="message-text"> {msg.message}</span>
          {repeatBadge}
        </span>
      );
    case "error":
      return (
        <span className="message-body error">
          <span className="message-text">{msg.message}</span>
          {repeatBadge}
        </span>
      );
    case "privmsg":
    default:
      return (
        <span className="message-body">
          <span className={`message-sender${sender === nickname ? " self" : ""}`}>
            {sender || ""}
          </span>
          <span className="message-text"> {msg.message}</span>
          {repeatBadge}
        </span>
      );
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function handleSlashCommand(
  raw: string,
  connection: ConnectionState,
  buffer: BufferState,
  setStatus: (value: string | null) => void,
) {
  const [command, ...rest] = raw.slice(1).split(/\s+/);
  const lower = command.toLowerCase();
  const args = rest.join(" ");
  try {
    switch (lower) {
      case "join": {
        const channel = rest[0];
        if (!channel) {
          setStatus("Usage: /join #channel");
          return;
        }
        await invoke("irc_join", {
          args: {
            connectionId: connection.id,
            channel,
          },
        });
        return;
      }
      case "part": {
        const channel = rest[0] ?? buffer.name;
        const reason = rest.slice(1).join(" ") || undefined;
        await invoke("irc_part", {
          args: {
            connectionId: connection.id,
            channel,
            reason,
          },
        });
        return;
      }
      case "quit": {
        const reason = args || randomQuitReason();
        await invoke("irc_disconnect", {
          args: {
            connectionId: connection.id,
            reason,
          },
        });
        return;
      }
      case "msg": {
        const target = rest[0];
        const text = rest.slice(1).join(" ");
        if (!target || !text) {
          setStatus("Usage: /msg nick message");
          return;
        }
        await invoke("irc_send_message", {
          args: {
            connectionId: connection.id,
            target,
            message: text,
          },
        });
        return;
      }
      case "me": {
        const action = args;
        if (!action) {
          setStatus("Usage: /me action text");
          return;
        }
        await invoke("irc_send_message", {
          args: {
            connectionId: connection.id,
            target: buffer.name,
            message: `\u0001ACTION ${action}\u0001`,
          },
        });
        return;
      }
      default:
        setStatus(`Unknown command: /${command}`);
    }
  } catch (error) {
    console.error(error);
    setStatus(`Command failed: ${String(error)}`);
  }
}
