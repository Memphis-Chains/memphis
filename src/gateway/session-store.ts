import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { SessionMetadata, SessionStore } from './chat-types.js';
import { createPinoLogger } from '../infra/logging/pino.js';
import type { ChatMessage } from '../providers/index.js';

const log = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });
const SESSION_DEPTH = 10;

type SerializedSession = {
  conversationId: string;
  actorId?: string;
  channel?: string;
  replyTargetId?: string;
  messages: ChatMessage[];
  updatedAt: string;
};

export function createFileSessionStore(dataDir: string): SessionStore {
  const sessionsDir = join(dataDir, 'sessions');
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const cache = new Map<string, ChatMessage[]>();

  function filePath(conversationId: string): string {
    const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(sessionsDir, `${safe}.json`);
  }

  function load(conversationId: string): ChatMessage[] {
    if (cache.has(conversationId)) return cache.get(conversationId)!;

    const fp = filePath(conversationId);
    try {
      if (existsSync(fp)) {
        const data = JSON.parse(readFileSync(fp, 'utf-8')) as SerializedSession;
        cache.set(conversationId, data.messages);
        return data.messages;
      }
    } catch (err) {
      log.warn({ conversationId, err }, 'failed to load session — starting fresh');
    }

    cache.set(conversationId, []);
    return cache.get(conversationId)!;
  }

  function save(conversationId: string, messages: ChatMessage[], metadata?: SessionMetadata): void {
    const fp = filePath(conversationId);
    const data: SerializedSession = {
      conversationId,
      actorId: metadata?.actorId,
      channel: metadata?.channel,
      replyTargetId: metadata?.replyTargetId,
      messages,
      updatedAt: new Date().toISOString(),
    };
    try {
      writeFileSync(fp, JSON.stringify(data, null, 2));
    } catch (err) {
      log.error({ conversationId, err }, 'failed to save session');
    }
  }

  return {
    get(conversationId: string): ChatMessage[] {
      return load(conversationId);
    },
    append(
      conversationId: string,
      userText: string,
      assistantReply: string,
      metadata?: SessionMetadata,
    ): void {
      const history = load(conversationId);
      history.push({ role: 'user', content: userText });
      history.push({ role: 'assistant', content: assistantReply });
      if (history.length > SESSION_DEPTH * 2) {
        history.splice(0, history.length - SESSION_DEPTH * 2);
      }
      cache.set(conversationId, history);
      save(conversationId, history, metadata);
    },
  };
}

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, ChatMessage[]>();

  return {
    get(conversationId: string): ChatMessage[] {
      if (!sessions.has(conversationId)) sessions.set(conversationId, []);
      return sessions.get(conversationId)!;
    },
    append(conversationId: string, userText: string, assistantReply: string): void {
      const history = this.get(conversationId);
      history.push({ role: 'user', content: userText });
      history.push({ role: 'assistant', content: assistantReply });
      if (history.length > SESSION_DEPTH * 2) {
        history.splice(0, history.length - SESSION_DEPTH * 2);
      }
    },
  };
}
