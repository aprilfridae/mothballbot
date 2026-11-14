import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ChannelType, Events, type Client } from 'discord.js';
import { draftListing, type AnthropicLike } from './ai/draftListing.js';
import { loadConfig, type Config } from './config.js';
import { createDb, migrate, type Db } from './db/db.js';
import * as repo from './db/repo.js';
import type { Item, Order } from './db/repo.js';
import { createDiscordClient, wireDiscord } from './discord/bot.js';
import { handleThreadReply, mirrorMessages, ThreadGoneError, type ThreadSink } from './discord/buyerThreads.js';
import { buildStatus, type ListingDeps } from './discord/newListing.js';
import { makeReporter } from './discord/status.js';
import { ensureDiscordSetup } from './discord/setup.js';
import { announceOrders, formatToShip, handleToShipReaction, sendPendingToMom } from './discord/toShip.js';
import { startScheduler } from './jobs/schedule.js';
import { runPoll } from './jobs/schedule.js';
import { markShipped, type ShipDeps } from './orders/markShipped.js';
import { createEbay, EbayError, type EbayClient } from './platforms/ebay/client.js';
import { createListing, suggestCategory, uploadImage } from './platforms/ebay/listings.js';
import { fetchNewMessages, sendReply } from './platforms/ebay/messages.js';
import { createFulfillment, fetchNewOrders } from './platforms/ebay/orders.js';
import { researchPrice } from './ai/researchPrice.js';
import { recoverInterrupted, sendPendingDrafts } from './listings/pending.js';
import { createDraft, type PipelineDeps } from './listings/pipeline.js';
import { createMomBot, MOM_CHAT_KEY, type MomBot } from './telegram/momBot.js';
import { guarded } from './util/guard.js';

function threadSink(client: Client, cfg: Config): ThreadSink {
  return {
    async createThread(name, firstMessage) {
      const forum = await client.channels.fetch(cfg.channels.buyers);
      if (forum?.type !== ChannelType.GuildForum) throw new Error('CHANNEL_BUYERS must be a Forum channel');
      const thread = await forum.threads.create({ name, message: { content: firstMessage, allowedMentions: { parse: [] } } });
      return thread.id;
    },
    async post(threadId, text) {
      const thread = await client.channels.fetch(threadId).catch((e) => {
        if (e?.code === 10003) return null; // Discord "Unknown Channel": the thread was deleted
        throw e;
      });
      if (!thread?.isThread()) throw new ThreadGoneError(threadId);
      if (thread.archived) await thread.setArchived(false);
      await thread.send({ content: text, allowedMentions: { parse: [] } });
    },
  };
}

async function sendTo(client: Client, channelId: string, text: string): Promise<string> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) throw new Error(`Can't post in channel ${channelId}`);
  return (await channel.send(text)).id;
}

const EBAY_NOT_CONNECTED = "eBay isn't connected yet (waiting on eBay developer approval). The draft is saved; post it once eBay is set up.";

function notConnected(): never {
  throw new EbayError(0, EBAY_NOT_CONNECTED, false);
}

function pipelineDeps(
  db: Db,
  cfg: Config,
  ebay: EbayClient | null,
  anthropic: AnthropicLike,
  report: (t: string) => Promise<void>,
  onChange: (item: Item) => Promise<void>,
): PipelineDeps {
  return {
    db,
    draft: (input) => draftListing(input, anthropic),
    research: (input) => researchPrice(input, anthropic),
    readPhoto: (path) => readFile(path),
    ebay: {
      uploadImage: (file) => (ebay ? uploadImage(ebay, file) : notConnected()),
      suggestCategory: (q) => (ebay ? suggestCategory(ebay, q) : notConnected()),
      createListing: (input) => (ebay && cfg.ebay ? createListing(ebay, cfg.ebay, input) : notConnected()),
    },
    report,
    onChange,
  };
}

function listingDeps(db: Db, cfg: Config, pipeline: PipelineDeps): ListingDeps {
  return {
    db,
    ownerId: cfg.ownerDiscordId,
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
    createDraft: (itemId, photos, skipped) => createDraft(itemId, photos, skipped, pipeline),
  };
}

/** Edits your #new-listing status message to match the item. Never throws. */
function discordStatus(db: Db, discord: Client, cfg: Config) {
  return async (item: Item) => {
    if (!item.discordMessageId) return;
    await guarded(
      `Updating the status of item #${item.id}`,
      async () => {
        const momLinked = (await repo.getSetting(db, MOM_CHAT_KEY)) !== null;
        const channel = await discord.channels.fetch(cfg.channels.newListing);
        if (!channel?.isTextBased()) return;
        const msg = await channel.messages.fetch(item.discordMessageId!);
        await msg.edit(buildStatus(item, await repo.getListings(db, item.id), momLinked));
      },
      async (t) => console.error(t),
    );
  };
}

async function main() {
  const cfg = loadConfig(process.env);
  const db = createDb(cfg.databaseUrl);
  await migrate(db);

  // Log in first: the bot finds its server, owner and channels before anything else is wired.
  const discord = createDiscordClient();
  const ready = new Promise<Client<true>>((resolve) => discord.once(Events.ClientReady, resolve));
  await discord.login(cfg.discordToken);
  const client = await ready;
  console.log(`Discord connected as ${client.user.tag}`);
  const setup = await ensureDiscordSetup(client, cfg);
  const report = makeReporter(discord, cfg.channels.botStatus);
  if (setup.created.length) await report(`Set up ${setup.created.join(', ')} in ${setup.guild.name}. 👋`);

  const ebay = cfg.ebay ? createEbay(cfg.ebay) : null;
  const anthropic = new Anthropic({ apiKey: cfg.anthropicApiKey }) as unknown as AnthropicLike;

  // Mom's bot, the shipping path and the listing pipeline reference each other, so some links are bound late.
  let shipDeps: ShipDeps;
  let momBot: MomBot;
  const updateDiscord = discordStatus(db, discord, cfg);
  const sendDrafts = () =>
    sendPendingDrafts({ db, sendDraftToMom: (i) => momBot.sendDraftToMom(i), report, onSent: updateDiscord });
  const pipeline = pipelineDeps(db, cfg, ebay, anthropic, report, async (item) => {
    await updateDiscord(item);
    // New drafts go through the single draft sender; drafts Mom already has are refreshed in place.
    if (item.status === 'awaiting_mom' && item.telegramMessageId === null) await sendDrafts();
    else if (item.telegramMessageId !== null) await momBot.refreshDraft(item);
  });
  momBot = createMomBot(
    cfg.telegramToken,
    {
      db,
      linkCode: cfg.momLinkCode,
      markShipped: (orderId, by, tracking) => markShipped(orderId, by, tracking, shipDeps),
      onLinked: async () => {
        await report("Mom is connected on Telegram. ✅");
        await sendPendingToMom({ db, notifyMom: (o) => momBot.notifyMom(o), report });
        await sendDrafts();
      },
    },
    { db, pipeline },
  );
  shipDeps = {
    db,
    fulfill: { ebay: (o: Order, t, c) => (ebay ? createFulfillment(ebay, o, t, c) : notConnected()) },
    markDiscord: async (o, label) => {
      if (!o.discordMessageId) return;
      const channel = await discord.channels.fetch(cfg.channels.toShip);
      if (!channel?.isTextBased()) return;
      const msg = await channel.messages.fetch(o.discordMessageId);
      await msg.edit(`${formatToShip(o).replace('React 📦 when shipped.', '')}\n${label}`);
    },
    markTelegram: (o, label) => momBot.markMessage(o, label),
  };

  wireDiscord(
    discord,
    cfg,
    {
      listing: listingDeps(db, cfg, pipeline),
      onThreadReply: (msg) =>
        handleThreadReply(
          {
            id: msg.id,
            threadId: msg.channelId,
            authorId: msg.author.id,
            content: msg.content,
            attachmentCount: msg.attachments.size,
            react: async (e) => {
              await msg.react(e);
            },
            reply: async (t) => {
              await msg.reply(t);
            },
          },
          { db, ownerId: cfg.ownerDiscordId, send: { ebay: (conv, text) => (ebay ? sendReply(ebay, conv, text) : notConnected()) } },
        ),
      onToShipReaction: (messageId, emoji) =>
        handleToShipReaction(messageId, emoji, {
          db,
          markShipped: (id, by, tracking) => markShipped(id, by, tracking, shipDeps),
        }),
    },
    report,
  );

  process.on('unhandledRejection', (e) => {
    console.error('Unhandled error:', e);
    void report(`Unexpected error: ${(e as Error)?.message ?? e}`);
  });

  momBot.start((e) =>
    void report(`Mom's Telegram bot stopped: ${(e as Error)?.message ?? e}. Check TELEGRAM_TOKEN, then restart with \`docker compose restart app\`.`),
  );
  if ((await repo.getSetting(db, MOM_CHAT_KEY)) === null) {
    await guarded(
      "Making Mom's Telegram link",
      async () => {
        const username = await momBot.username();
        await report(`Send this link to Mom so she can connect on Telegram: https://t.me/${username}?start=${encodeURIComponent(cfg.momLinkCode)}`);
      },
      report,
    );
  }
  if (!ebay) await report(EBAY_NOT_CONNECTED.replace('The draft is saved; post it once eBay is set up.', 'Listings can be drafted and reviewed by Mom; Post, buyer messages and sales start once the eBay keys are in .env.'));

  await guarded(
    'Recovering interrupted listings',
    async () => {
      const stuck = await recoverInterrupted(db);
      for (const id of stuck) await pipeline.onChange((await repo.getItem(db, id))!);
      if (stuck.length) await report(`The bot restarted while ${stuck.length} listing(s) were being drafted or posted. Their status in #new-listing says what to do.`);
    },
    report,
  );

  const sink = threadSink(discord, cfg);
  const jobs = [
    {
      name: 'sweep-mom',
      run: async () => {
        await guarded('Sending sales to Mom', () => sendPendingToMom({ db, notifyMom: (o) => momBot.notifyMom(o), report }), report);
        await guarded('Sending listing drafts to Mom', sendDrafts, report);
      },
    },
  ];
  if (ebay && cfg.ebay) {
    const ebayCfg = cfg.ebay;
    jobs.push(
      {
        name: 'poll-ebay-messages',
        run: () =>
          runPoll(db, 'poll-ebay-messages', {
            fetch: (since) => fetchNewMessages(ebay, ebayCfg.username, since),
            handle: (msgs) => mirrorMessages(db, 'ebay', msgs, sink),
            report,
          }),
      },
      {
        name: 'poll-ebay-orders',
        run: () =>
          runPoll(db, 'poll-ebay-orders', {
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
          }),
      },
    );
  }
  const boss = await startScheduler(cfg.databaseUrl, jobs);

  const shutdown = async () => {
    console.log('Shutting down…');
    await Promise.allSettled([boss.stop(), momBot.stop(), discord.destroy()]);
    await db.end();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
