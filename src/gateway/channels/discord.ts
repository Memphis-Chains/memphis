import { Client, GatewayIntentBits, Events, type Message } from 'discord.js';

import type { ChannelAdapter, MessageHandler } from '../chat-types.js';

export function createDiscordAdapter(token: string): ChannelAdapter {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  return {
    name: 'discord',

    async start(handler: MessageHandler): Promise<void> {
      client.on(Events.MessageCreate, async (msg: Message) => {
        if (msg.author.bot) return;
        const isDm = !msg.guild;
        const mentioned = msg.mentions.users.has(client.user?.id ?? '');
        if (!isDm && !mentioned) return;

        const text = msg.content.replace(/<@!?\d+>/g, '').trim();
        if (!text) return;

        await handler({
          id: msg.id,
          channel: 'discord',
          userId: `discord:${msg.author.id}`,
          chatId: msg.channelId,
          text,
          timestamp: msg.createdAt,
        });
      });

      await new Promise<void>((resolve) => {
        client.once(Events.ClientReady, () => resolve());
        void client.login(token);
      });
    },

    async send(chatId: string, text: string): Promise<void> {
      const channel = await client.channels.fetch(chatId);
      if (!channel?.isTextBased() || !('send' in channel)) return;

      const chunks = splitText(text, 2000);
      for (const chunk of chunks) {
        await (channel as { send(text: string): Promise<unknown> }).send(chunk);
      }
    },

    async stop(): Promise<void> {
      client.destroy();
    },
  };
}

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}
