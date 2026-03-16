/**
 * Agent Communication Routes
 *
 * Robert <-> Soul message passing via localhost API.
 * No auth — bound to 127.0.0.1 only.
 */

import { readFile, writeFile } from 'node:fs/promises';

import type { FastifyInstance } from 'fastify';

interface AgentMessage {
  from: 'robert' | 'soul';
  to: 'robert' | 'soul';
  message: string;
  timestamp: string;
}

const MESSAGE_FILE = '/tmp/agent-communication.json';
const MAX_MESSAGES = 100;

const VALID_AGENTS = new Set(['robert', 'soul']);

async function loadMessages(): Promise<AgentMessage[]> {
  try {
    return JSON.parse(await readFile(MESSAGE_FILE, 'utf-8')) as AgentMessage[];
  } catch {
    return [];
  }
}

async function saveMessages(messages: AgentMessage[]): Promise<void> {
  const trimmed = messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages;
  await writeFile(MESSAGE_FILE, JSON.stringify(trimmed, null, 2));
}

export function registerAgentRoutes(app: FastifyInstance): void {
  app.post<{ Body: { from?: string; to?: string; message?: string } }>(
    '/api/agent/message',
    async (request, reply) => {
      const { from, to, message } = request.body;

      if (!from || !to || !message) {
        return reply.status(400).send({ ok: false, error: 'Missing from, to, or message' });
      }
      if (!VALID_AGENTS.has(from) || !VALID_AGENTS.has(to)) {
        return reply.status(400).send({ ok: false, error: 'from/to must be robert or soul' });
      }

      const entry: AgentMessage = {
        from: from as AgentMessage['from'],
        to: to as AgentMessage['to'],
        message,
        timestamp: new Date().toISOString(),
      };

      const messages = await loadMessages();
      messages.push(entry);
      await saveMessages(messages);

      return { ok: true, message: entry };
    },
  );

  app.get<{ Querystring: { agent?: string } }>(
    '/api/agent/messages',
    async (request, reply) => {
      const { agent } = request.query;
      if (!agent || !VALID_AGENTS.has(agent)) {
        return reply.status(400).send({ ok: false, error: 'agent must be robert or soul' });
      }

      const messages = await loadMessages();
      return { ok: true, messages: messages.filter((m) => m.to === agent) };
    },
  );

  app.get('/api/agent/status', async () => ({
    ok: true,
    agents: ['robert', 'soul'],
    timestamp: new Date().toISOString(),
  }));
}
