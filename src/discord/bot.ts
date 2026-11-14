import { Client, Events, GatewayIntentBits, Partials, type Message } from 'discord.js';
import type { Config } from '../config.js';
import { handleButton, handleEditModal, handleIntakeMessage, type ListingDeps } from './newListing.js';

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

export function wireDiscord(client: Client, cfg: Config, routes: BotRoutes): void {
  const safe = (label: string, fn: () => Promise<unknown>) =>
    fn().catch((e) => console.error(`Discord handler failed (${label}):`, e));

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

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isButton()) {
      safe('button', () =>
        handleButton(
          {
            customId: interaction.customId,
            userId: interaction.user.id,
            deferUpdate: () => interaction.deferUpdate(),
            editReply: (p) => interaction.editReply(p),
            showModal: (m) => interaction.showModal(m),
            update: (p) => interaction.update(p),
          },
          routes.listing,
        ),
      );
    } else if (interaction.isModalSubmit() && interaction.isFromMessage()) {
      safe('edit modal', () =>
        handleEditModal(
          {
            customId: interaction.customId,
            userId: interaction.user.id,
            field: (id) => interaction.fields.getTextInputValue(id),
            update: (p) => interaction.update(p),
            reply: (p) => interaction.reply(p),
          },
          routes.listing,
        ),
      );
    }
  });

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    if (user.id !== cfg.ownerDiscordId || reaction.message.channelId !== cfg.channels.toShip) return;
    if (routes.onToShipReaction) {
      safe('to-ship reaction', () => routes.onToShipReaction!(reaction.message.id, reaction.emoji.name ?? '', user.id));
    }
  });
}
