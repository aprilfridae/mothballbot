import { Client, Events, GatewayIntentBits, Partials, type Message } from 'discord.js';
import type { Config } from '../config.js';
import { guarded, type Reporter } from '../util/guard.js';
import { handleIntakeMessage, type ListingDeps } from './newListing.js';

export interface BotRoutes {
  listing: ListingDeps;
  /** Owner message inside a #buyers thread (Task 6). */
  onThreadReply?: (msg: Message) => Promise<void>;
  /** Reaction added in #to-ship (Task 7). */
  onToShipReaction?: (messageId: string, emoji: string, userId: string) => Promise<void>;
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });
}

export function wireDiscord(client: Client, cfg: Config, routes: BotRoutes, report: Reporter): void {
  const safe = (label: string, fn: () => Promise<unknown>) => void guarded(`Discord ${label}`, fn, report);

  client.on(Events.MessageCreate, (msg) => {
    if (msg.author.bot || msg.author.id !== cfg.ownerDiscordId) return;

    if (msg.channelId === cfg.channels.newListing) {
      safe('intake', () =>
        handleIntakeMessage(
          {
            id: msg.id,
            authorId: msg.author.id,
            content: msg.content,
            attachments: [...msg.attachments.values()].map((a) => ({
              name: a.name,
              contentType: a.contentType,
              url: a.url,
            })),
            reply: async (payload) => ({ id: (await msg.reply(payload)).id }),
          },
          routes.listing,
        ),
      );
      return;
    }

    if (msg.channel.isThread() && msg.channel.parentId === cfg.channels.buyers && routes.onThreadReply) {
      safe('thread reply', () => routes.onThreadReply!(msg));
    }
  });

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    if (user.id !== cfg.ownerDiscordId || reaction.message.channelId !== cfg.channels.toShip) return;
    if (routes.onToShipReaction) {
      safe('to-ship reaction', () => routes.onToShipReaction!(reaction.message.id, reaction.emoji.name ?? '', user.id));
    }
  });
}
