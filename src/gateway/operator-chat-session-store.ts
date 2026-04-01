import type { SessionMetadata, SessionStore } from './chat-types.js';
import type { SqliteOperatorChatSessionRepository } from '../infra/storage/sqlite/repositories/operator-chat-session-repository.js';
import type { ChatMessage } from '../providers/index.js';

const SESSION_DEPTH = 10;

function toChatMessage(
  message: ReturnType<SqliteOperatorChatSessionRepository['listMessages']>[number],
): ChatMessage | null {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant':
      return { role: 'assistant', content: message.content };
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? 'tool-call',
        content: message.content,
      };
    default:
      return null;
  }
}

export function createOperatorChatSessionStore(
  repo: SqliteOperatorChatSessionRepository,
): SessionStore {
  return {
    get(conversationId: string): ChatMessage[] {
      return repo
        .listMessages(conversationId, SESSION_DEPTH * 2)
        .map((message) => toChatMessage(message))
        .filter((message): message is ChatMessage => message !== null);
    },
    append(
      conversationId: string,
      userText: string,
      assistantReply: string,
      metadata?: SessionMetadata,
    ): void {
      repo.appendMessages(conversationId, [
        {
          role: 'user',
          content: userText,
          displayContent: userText,
          provider: metadata?.channel,
        },
        {
          role: 'assistant',
          content: assistantReply,
          displayContent: assistantReply,
          provider: metadata?.channel,
        },
      ]);
    },
  };
}
