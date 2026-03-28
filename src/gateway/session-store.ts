import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { SessionStore } from './chat-types.js';
import { createPinoLogger } from '../infra/logging/pino.js';
import type { ChatMessage } from '../providers/index.js';

const log = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });
const SESSION_DEPTH = 10;

type SerializedSession = {
  chatId: string;
  channel?: string;
  messages: ChatMessage[];
  updatedAt: string;
};

export function createFileSessionStore(dataDir: string): SessionStore {
  const sessionsDir = join(dataDir, 'sessions');
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const cache = new Map<string, ChatMessage[]>();

  function filePath(chatId: string): string {
    const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(sessionsDir, `${safe}.json`);
  }

  function load(chatId: string): ChatMessage[] {
    if (cache.has(chatId)) return cache.get(chatId)!;

    const fp = filePath(chatId);
    try {
      if (existsSync(fp)) {
        const data = JSON.parse(readFileSync(fp, 'utf-8')) as SerializedSession;
        cache.set(chatId, data.messages);
        return data.messages;
      }
    } catch (err) {
      log.warn({ chatId, err }, 'failed to load session — starting fresh');
    }

    cache.set(chatId, []);
    return cache.get(chatId)!;
  }

  function save(chatId: string, messages: ChatMessage[], channel?: string): void {
    const fp = filePath(chatId);
    const data: SerializedSession = {
      chatId,
      channel,
      messages,
      updatedAt: new Date().toISOString(),
    };
    try {
      writeFileSync(fp, JSON.stringify(data, null, 2));
    } catch (err) {
      log.error({ chatId, err }, 'failed to save session');
    }
  }

  return {
    get(chatId: string): ChatMessage[] {
      return load(chatId);
    },
    append(chatId: string, userText: string, assistantReply: string, channel?: string): void {
      const history = load(chatId);
      history.push({ role: 'user', content: userText });
      history.push({ role: 'assistant', content: assistantReply });
      if (history.length > SESSION_DEPTH * 2) {
        history.splice(0, history.length - SESSION_DEPTH * 2);
      }
      cache.set(chatId, history);
      save(chatId, history, channel);
    },
  };
}

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, ChatMessage[]>();

  return {
    get(chatId: string): ChatMessage[] {
      if (!sessions.has(chatId)) sessions.set(chatId, []);
      return sessions.get(chatId)!;
    },
    append(chatId: string, userText: string, assistantReply: string): void {
      const history = this.get(chatId);
      history.push({ role: 'user', content: userText });
      history.push({ role: 'assistant', content: assistantReply });
      if (history.length > SESSION_DEPTH * 2) {
        history.splice(0, history.length - SESSION_DEPTH * 2);
      }
    },
  };
}
