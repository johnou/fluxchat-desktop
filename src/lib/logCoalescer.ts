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

export type ChatMessage = {
  connection_id: string;
  target: string;
  sender?: string | null;
  message: string;
  kind: MessageKind;
  timestamp: number;
  metadata?: unknown;
};

const DEFAULT_LIMIT = 500;

type MetadataRecord = Record<string, unknown>;

function coerceMetadata(meta: unknown): MetadataRecord | undefined {
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    return { ...(meta as MetadataRecord) };
  }
  return undefined;
}

function cloneMessage(msg: ChatMessage): ChatMessage {
  const clone: ChatMessage = { ...msg };
  const meta = coerceMetadata(msg.metadata);
  if (meta) {
    clone.metadata = meta;
  } else {
    delete clone.metadata;
  }
  return clone;
}

function clip(messages: ChatMessage[], limit: number): ChatMessage[] {
  if (messages.length <= limit) {
    return messages;
  }
  return messages.slice(messages.length - limit);
}

function findLastIndex(
  messages: ChatMessage[],
  predicate: (value: ChatMessage, index: number) => boolean,
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (predicate(messages[i], i)) {
      return i;
    }
  }
  return -1;
}

export function canMergeMessages(a: ChatMessage, b: ChatMessage): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "privmsg" || a.kind === "action") {
    return false;
  }
  if ((a.sender ?? "") !== (b.sender ?? "")) {
    return false;
  }
  if (a.target !== b.target) {
    return false;
  }
  return a.message === b.message;
}

export function appendMessage(
  messages: ChatMessage[],
  message: ChatMessage,
  limit = DEFAULT_LIMIT,
): ChatMessage[] {
  const candidate = cloneMessage(message);
  const index = findLastIndex(messages, (existing) => canMergeMessages(existing, candidate));
  if (index !== -1) {
    const existing = messages[index];
    const mergedMeta = coerceMetadata(existing.metadata) ?? {};
    const repeatCount = Number(mergedMeta.repeatCount ?? 1) + 1;
    mergedMeta.repeatCount = repeatCount;
    const merged: ChatMessage = {
      ...existing,
      timestamp: candidate.timestamp,
      metadata: mergedMeta,
    };
    const withoutExisting = [...messages.slice(0, index), ...messages.slice(index + 1)];
    return clip([...withoutExisting, merged], limit);
  }
  return clip([...messages, candidate], limit);
}
