import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ChannelType, Events, type Client } from 'discord.js';
import { draftListing, type AnthropicLike } from './ai/draftListing.js';
import { loadConfig, type Config } from './config.js';
import { createDb, migrate, type Db } from './db/db.js';
import type { Order } from './db/repo.js';
import { createDiscordClient, wireDiscord } from './discord/bot.js';
import { handleThreadReply, mirrorMessages, ThreadGoneError, type ThreadSink } from './discord/buyerThreads.js';
import type { ListingDeps } from './discord/newListing.js';
import { makeReporter } from './discord/status.js';
import { announceOrders, formatToShip, handleToShipReaction, sendPendingToMom } from './discord/toShip.js';
import { startScheduler } from './jobs/schedule.js';
import { runPoll } from './jobs/schedule.js';
import { markShipped, type ShipDeps } from './orders/markShipped.js';
import { createEbay, type EbayClient } from './platforms/ebay/client.js';
import { createListing, suggestCategory, uploadImage } from './platforms/ebay/listings.js';
import { fetchNewMessages, sendReply } from './platforms/ebay/messages.js';
import { createFulfillment, fetchNewOrders } from './platforms/ebay/orders.js';
import { createMomBot } from './telegram/momBot.js';
import { guarded } from './util/guard.js';

function threadSink(client: Client, cfg: Config): ThreadSink {
  return {
    async createThread(name, firstMessage) {
      const forum = await client.channels.fetch(cfg.channels.buyers);
      if (forum?.type !== ChannelType.GuildForum) throw new Error('CHANNEL_BUYERS must be a Forum channel');
      const thread = await forum.threads.create({ name, message: { content: firstMessage } });
      return thread.id;
    },
    async post(threadId, text) {
      const thread = await client.channels.fetch(threadId).catch((e) => {
        if (e?.code === 10003) return null; // Discord "Unknown Channel": the thread was deleted
        throw e;
      });
      if (!thread?.isThread()) throw new ThreadGoneError(threadId);
      if (thread.archived) await thread.setArchived(false);
      await thread.send(text);
    },
  };
}

async function sendTo(client: Client, channelId: string, text: string): Promise<string> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) throw new Error(`Can't post in channel ${channelId}`);
  return (await channel.send(text)).id;
}

function listingDeps(db: Db, cfg: Config, ebay: EbayClient, anthropic: AnthropicLike, report: (t: string) => Promise<void>): ListingDeps {
  return {
    db,
    ownerId: cfg.ownerDiscordId,
    draft: (input) => draftListing(input, anthropic),
    downloadPhoto: async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't download a photo from Discord (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
    savePhoto: async (folder, name, data) => {
      const path = join(cfg.photoDir, folder, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
      return path;
    },
    readPhoto: (path) => readFile(path),
    ebay: {
      uploadImage: (file) => uploadImage(ebay, file),
      suggestCategory: (q) => suggestCategory(ebay, q),
      createListing: (input) => createListing(ebay, cfg.ebay, input),
    },
    report,
  };
}

async function main() {
  const cfg = loadConfig(process.env);
  const db = createDb(cfg.databaseUrl);
  await migrate(db);

  const ebay = createEbay(cfg.ebay);
  const anthropic = new Anthropic({ apiKey: cfg.anthropicApiKey }) as unknown as AnthropicLike;
  const discord = createDiscordClient();
  const report = makeReporter(discord, cfg.channels.botStatus);

  // Mom's bot and the shipping path reference each other, so the bot is created first with a late-bound markShipped.
  let shipDeps: ShipDeps;
  const momBot = createMomBot(cfg.telegramToken, {
    db,
    linkCode: cfg.momLinkCode,
    markShipped: (orderId, by, tracking) => markShipped(orderId, by, tracking, shipDeps),
    onLinked: () => sendPendingToMom({ db, notifyMom: (o) => momBot.notifyMom(o), report }),
  });
  shipDeps = {
    db,
    fulfill: { ebay: (o: Order, t, c) => createFulfillment(ebay, o, t, c) },
    markDiscord: async (o, label) => {
      if (!o.discordMessageId) return;
      const channel = await discord.channels.fetch(cfg.channels.toShip);
      if (!channel?.isTextBased()) return;
      const msg = await channel.messages.fetch(o.discordMessageId);
      await msg.edit(`${formatToShip(o).replace('React 📦 when shipped.', '')}\n${label}`);
    },
    markTelegram: (o, label) => momBot.markMessage(o, label),
  };

  wireDiscord(discord, cfg, {
    listing: listingDeps(db, cfg, ebay, anthropic, report),
    onThreadReply: (msg) =>
      handleThreadReply(
        {
          id: msg.id,
          threadId: msg.channelId,
          authorId: msg.author.id,
          content: msg.content,
          react: async (e) => {
            await msg.react(e);
          },
          reply: async (t) => {
            await msg.reply(t);
          },
        },
        { db, ownerId: cfg.ownerDiscordId, send: { ebay: (conv, text) => sendReply(ebay, conv, text) } },
      ),
    onToShipReaction: (messageId, emoji) =>
      handleToShipReaction(messageId, emoji, {
        db,
        markShipped: (id, by, tracking) => markShipped(id, by, tracking, shipDeps),
      }),
  }, report);

  process.on('unhandledRejection', (e) => {
    console.error('Unhandled error:', e);
    void report(`Unexpected error: ${(e as Error)?.message ?? e}`);
  });

  const sink = threadSink(discord, cfg);
  discord.once(Events.ClientReady, async (c) => {
    console.log(`Discord connected as ${c.user.tag}`);
    momBot.start((e) =>
      void report(`Mom's Telegram bot stopped: ${(e as Error)?.message ?? e}. Check TELEGRAM_TOKEN, then restart with \`docker compose restart app\`.`),
    );
    const boss = await startScheduler(cfg.databaseUrl, [
      {
        name: 'poll-ebay-messages',
        run: () =>
          runPoll(db, 'poll-ebay-messages', {
            fetch: (since) => fetchNewMessages(ebay, cfg.ebay.username, since),
            handle: (msgs) => mirrorMessages(db, 'ebay', msgs, sink),
            report,
          }),
      },
      {
        name: 'poll-ebay-orders',
        run: async () => {
          await runPoll(db, 'poll-ebay-orders', {
            fetch: (since) => fetchNewOrders(ebay, since),
            handle: (orders) =>
              announceOrders('ebay', orders, {
                db,
                postToShip: (text) => sendTo(discord, cfg.channels.toShip, text),
                postSale: async (text) => {
                  await sendTo(discord, cfg.channels.sales, text);
                },
                notifyMom: (o) => momBot.notifyMom(o),
              }),
            report,
          });
          await guarded('Sending sales to Mom', () => sendPendingToMom({ db, notifyMom: (o) => momBot.notifyMom(o), report }), report);
        },
      },
    ]);

    const shutdown = async () => {
      console.log('Shutting down…');
      await Promise.allSettled([boss.stop(), momBot.stop(), discord.destroy()]);
      await db.end();
      process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });

  await discord.login(cfg.discordToken);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
