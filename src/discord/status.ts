import type { Client } from 'discord.js';

/** Returns a function that posts a warning to #bot-status. Never throws: a broken status channel must not crash the caller. */
export function makeReporter(client: Client, channelId: string) {
  return async (text: string): Promise<void> => {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isSendable()) await channel.send(`⚠️ ${text}`);
    } catch (e) {
      console.error('Could not post to #bot-status:', text, e);
    }
  };
}
