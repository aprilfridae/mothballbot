import { Bot, InlineKeyboard, InputFile, InputMediaBuilder } from 'grammy';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { deliverDraft } from '../listings/pending.js';
import { salePhoto } from '../orders/sku.js';
import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { Order, Platform, ShipTo } from '../db/repo.js';
import type { ShipResult } from '../orders/markShipped.js';
import { PLATFORM_LABEL } from '../platforms/types.js';
import { extractTracking } from '../shipping/detectCarrier.js';
import type { Item } from '../db/repo.js';
import {
  albumPhotos,
  conditionKeyboard,
  draftKeyboard,
  earlyAnswer,
  fieldKeyboard,
  formatDraftForMom,
  handleListingCallback,
  handleListingText,
  setEditPrompt,
  type KeyRows,
  type MomAction,
  type MomListingDeps,
} from './momListings.js';

import { MOM_CHAT_KEY } from './keys.js';

export { MOM_CHAT_KEY } from './keys.js';

export interface MomDeps {
  db: Db;
  linkCode: string;
  markShipped: (orderId: number, by: 'mom', tracking: string | null) => Promise<ShipResult>;
  /** Called right after Mom connects, to send her any sales she missed. */
  onLinked?: () => Promise<void>;
}

async function momChatId(db: Db): Promise<number | null> {
  const v = await repo.getSetting(db, MOM_CHAT_KEY);
  return v ? Number(v) : null;
}

export function formatAddress(a: ShipTo): string {
  const country = a.country && a.country !== 'US' ? a.country : null;
  return [a.name, a.line1, a.line2, `${a.city}, ${a.state} ${a.postalCode}`, country].filter(Boolean).join('\n');
}

export function formatShipBy(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
}

export function formatSaleForMom(o: {
  platform: Platform;
  itemTitle: string;
  buyer: string;
  shipTo: ShipTo | null;
  localPickup: boolean;
  shipBy: Date | null;
}): string {
  const lines = [`📦 New sale on ${PLATFORM_LABEL[o.platform]}`, '', o.itemTitle, `Buyer: ${o.buyer}`, ''];
  if (o.localPickup || !o.shipTo) lines.push('Local pickup');
  else lines.push('Ship to:', formatAddress(o.shipTo));
  if (o.shipBy) lines.push('', `Ship by: ${formatShipBy(o.shipBy)}`);
  lines.push('', 'Tap Shipped when it goes out. To add tracking, reply to this message with the tracking number.');
  return lines.join('\n');
}

/** /start <code>. Only the right code links a chat, and once Mom is linked nobody else can take her place. */
export async function handleStart(chatId: number, payload: string, deps: MomDeps): Promise<string | null> {
  if (payload.trim() !== deps.linkCode) return null;
  const current = await momChatId(deps.db);
  if (current !== null && current !== chatId) return null;
  await repo.setSetting(deps.db, MOM_CHAT_KEY, String(chatId));
  if (deps.onLinked) {
    // Run after the welcome reply is sent, so pending sales arrive below it.
    setTimeout(() => void deps.onLinked!().catch((e) => console.error('Sending pending sales to Mom failed:', e)), 0);
  }
  return "You're connected 👋 You'll get a message here for every sale.";
}

export async function handleShippedCallback(chatId: number, data: string, deps: MomDeps): Promise<string | null> {
  if (chatId !== (await momChatId(deps.db))) return null;
  const m = data.match(/^ship:(\d+)$/);
  if (!m) return null;
  const result = await deps.markShipped(Number(m[1]), 'mom', null);
  return result === 'already' ? 'Already marked shipped' : 'Marked shipped';
}

export async function handleMomReply(
  chatId: number,
  replyToMessageId: number | null,
  text: string,
  deps: MomDeps,
): Promise<string | null> {
  if (chatId !== (await momChatId(deps.db))) return null;
  if (replyToMessageId === null) {
    return 'To mark something shipped or add tracking, reply to the sale message (swipe left on it, or long-press → Reply).';
  }
  const order = await repo.findOrderByTelegramMessage(deps.db, replyToMessageId);
  if (!order) return "I couldn't find the sale for that message.";

  if (/^\s*shipped\W*\s*$/i.test(text)) {
    const r = await deps.markShipped(order.id, 'mom', null);
    return r === 'already' ? 'That one was already marked shipped 👍' : 'Got it ✅ marked shipped.';
  }
  const found = extractTracking(text);
  if (!found) {
    return "That doesn't look like a tracking number. Copy it from the shipping label or receipt and reply again.";
  }
  const r = await deps.markShipped(order.id, 'mom', found.tracking);
  return r === 'already' ? 'That one already has tracking 👍' : `Got it ✅ ${order.itemTitle} marked shipped with tracking.`;
}

/**
 * Mom's typed text: a reply to a sale message is always about shipping; otherwise it feeds an active listing
 * edit; otherwise she gets the usual hint.
 */
export async function routeMomText(
  chatId: number,
  replyToId: number | null,
  text: string,
  deps: MomDeps,
  listingText: (chatId: number, replyToId: number | null, text: string) => Promise<MomAction | null>,
): Promise<MomAction | null> {
  if (replyToId !== null && (await repo.findOrderByTelegramMessage(deps.db, replyToId))) {
    const answer = await handleMomReply(chatId, replyToId, text, deps);
    return answer ? { answer } : null;
  }
  const action = await listingText(chatId, replyToId, text);
  if (action) return action;
  if (replyToId !== null && (await repo.findItemByTelegramMessage(deps.db, replyToId))) {
    return { answer: 'To change this listing, tap ✏️ Edit on it and pick what to change.' };
  }
  const answer = await handleMomReply(chatId, replyToId, text, deps);
  return answer ? { answer } : null;
}

export interface MomBot {
  /** Sends a draft (photo album + text with buttons) to Mom; null if she hasn't connected yet. */
  sendDraftToMom(item: Item): Promise<number | null>;
  /** Re-renders a draft message after a change. */
  refreshDraft(item: Item): Promise<void>;
  /** Sends the sale to Mom; returns the Telegram message id, or null if she hasn't connected yet. */
  notifyMom(order: Order): Promise<number | null>;
  /** Edits a sale message to show its shipped status and removes the button. */
  markMessage(order: Order, label: string): Promise<void>;
  /** Starts long polling; a polling crash (bad token, second instance) is passed to onError instead of killing the app. */
  start(onError: (e: unknown) => void): void;
  /** The bot's @username (for Mom's start link). */
  username(): Promise<string>;
  stop(): Promise<void>;
}

function toKeyboard(rows: KeyRows): InlineKeyboard {
  const kb = new InlineKeyboard();
  rows.forEach((row, i) => {
    for (const b of row) kb.text(b.text, b.data);
    if (i < rows.length - 1) kb.row();
  });
  return kb;
}

export function createMomBot(token: string, deps: MomDeps, listings: MomListingDeps): MomBot {
  const bot = new Bot(token);

  async function draftText(item: Item): Promise<string> {
    const ebay = (await repo.getListings(deps.db, item.id)).find((l) => l.platform === 'ebay');
    return formatDraftForMom(item, ebay?.status === 'error' ? ebay.error : null, ebay?.status === 'live' ? ebay.url : null);
  }

  async function refreshDraft(item: Item): Promise<void> {
    const chatId = await momChatId(deps.db);
    if (chatId === null || item.telegramMessageId === null) return;
    try {
      await bot.api.editMessageText(chatId, item.telegramMessageId, await draftText(item), {
        reply_markup: toKeyboard(draftKeyboard(item)),
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      // Telegram refuses edits that change nothing; that's fine.
      if (!String((e as Error).message).includes('message is not modified')) throw e;
    }
  }

  async function perform(chatId: number, action: MomAction): Promise<void> {
    if (action.refresh !== undefined) {
      const item = await repo.getItem(deps.db, action.refresh);
      if (item) await refreshDraft(item);
    }
    if (action.keyboard && action.itemId !== undefined) {
      const item = await repo.getItem(deps.db, action.itemId);
      if (item?.telegramMessageId) {
        const rows =
          action.keyboard === 'fields' ? fieldKeyboard(item.id) : action.keyboard === 'conditions' ? conditionKeyboard(item.id) : draftKeyboard(item);
        await bot.api
          .editMessageReplyMarkup(chatId, item.telegramMessageId, { reply_markup: toKeyboard(rows) })
          .catch((e) => {
            if (!String(e.message).includes('message is not modified')) throw e;
          });
      }
    }
    if (action.prompt) {
      const sent = await bot.api.sendMessage(chatId, action.prompt, {
        reply_markup: { force_reply: true, input_field_placeholder: 'Type here…' },
      });
      await setEditPrompt(deps.db, sent.message_id);
    }
  }

  bot.command('start', async (ctx) => {
    const answer = await handleStart(ctx.chat.id, ctx.match ?? '', deps);
    if (answer) await ctx.reply(answer);
  });

  bot.on('callback_query:data', async (ctx) => {
    const chatId = ctx.chat?.id ?? ctx.from.id;
    const data = ctx.callbackQuery.data;
    const early = (await repo.getSetting(deps.db, MOM_CHAT_KEY)) === String(chatId) ? earlyAnswer(data) : null;

    const handle = async () => {
      try {
        const listingAction = await handleListingCallback(chatId, data, listings);
        if (listingAction) {
          if (!early) await ctx.answerCallbackQuery(listingAction.answer ? { text: listingAction.answer } : undefined);
          // The tap was already answered; outcomes without a refreshed draft (e.g. "set a price first") go as a message.
          else if (listingAction.answer && listingAction.refresh === undefined) await bot.api.sendMessage(chatId, listingAction.answer);
          await perform(chatId, listingAction);
          return;
        }
        const answer = await handleShippedCallback(chatId, data, deps);
        await ctx.answerCallbackQuery(answer ? { text: answer } : undefined);
      } catch (e) {
        // Always answer, so Mom never sees an endless spinner.
        if (early) await bot.api.sendMessage(chatId, 'Something went wrong. Try again in a minute.').catch(() => {});
        else await ctx.answerCallbackQuery({ text: 'Something went wrong. Try again in a minute.' }).catch(() => {});
        console.error('Telegram button failed:', e);
      }
    };

    if (early) {
      await ctx.answerCallbackQuery({ text: early });
      // Posting uploads photos for a while; run it in the background so Mom's other taps aren't stuck behind it.
      void handle();
    } else {
      await handle();
    }
  });

  bot.on('message:text', async (ctx) => {
    try {
      const action = await routeMomText(
        ctx.chat.id,
        ctx.message.reply_to_message?.message_id ?? null,
        ctx.message.text,
        deps,
        (chatId, replyToId, text) => handleListingText(chatId, replyToId, text, listings),
      );
      if (!action) return;
      if (action.answer) await ctx.reply(action.answer, { reply_parameters: { message_id: ctx.message.message_id } });
      await perform(ctx.chat.id, { ...action, answer: undefined });
    } catch (e) {
      console.error('Handling a Telegram message failed:', e);
      if ((await repo.getSetting(deps.db, MOM_CHAT_KEY)) === String(ctx.chat.id)) {
        await ctx.reply("Sorry, that didn't work. Try again in a minute.").catch(() => {});
      }
    }
  });

  bot.catch((err) => console.error('Telegram bot error:', err.error));

  return {
    async sendDraftToMom(item) {
      const chatId = await momChatId(deps.db);
      if (chatId === null) return null;
      return deliverDraft(
        async () => {
          // Re-encode so big camera originals stay under Telegram's photo limits.
          const files = await Promise.all(
            albumPhotos(item).map(async (p) => {
              const data = await sharp(await listings.pipeline.readPhoto(p))
                .rotate()
                .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer();
              return new InputFile(data, 'photo.jpg');
            }),
          );
          if (files.length === 1) await bot.api.sendPhoto(chatId, files[0]);
          else if (files.length > 1) await bot.api.sendMediaGroup(chatId, files.map((f) => InputMediaBuilder.photo(f)));
        },
        async (note) => {
          const text = await draftText(item);
          const sent = await bot.api.sendMessage(chatId, note ? `${text}\n${note}`.slice(0, 4096) : text, {
            reply_markup: toKeyboard(draftKeyboard(item)),
            link_preview_options: { is_disabled: true },
          });
          return sent.message_id;
        },
      );
    },
    refreshDraft,
    async notifyMom(order) {
      const chatId = await momChatId(deps.db);
      if (chatId === null) return null;
      const keyboard = new InlineKeyboard().text('📦 Shipped', `ship:${order.id}`);
      const text = formatSaleForMom(order);
      // Show the item's photo with the sale when the bot listed it; fall back to text if that fails.
      const photo = await salePhoto(deps.db, order.sku);
      if (photo && text.length <= 1024) {
        try {
          const data = await sharp(await readFile(photo))
            .rotate()
            .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
          const sent = await bot.api.sendPhoto(chatId, new InputFile(data, 'item.jpg'), { caption: text, reply_markup: keyboard });
          return sent.message_id;
        } catch (e) {
          console.error('Sending the sale photo failed; sending text instead:', e);
        }
      }
      const sent = await bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
      return sent.message_id;
    },
    async markMessage(order, label) {
      const chatId = await momChatId(deps.db);
      if (chatId === null || order.telegramMessageId === null) return;
      const text = `${formatSaleForMom(order)}\n\n${label}`;
      // Sale messages sent with a photo have a caption instead of text.
      try {
        await bot.api.editMessageText(chatId, order.telegramMessageId, text, { reply_markup: new InlineKeyboard() });
      } catch {
        await bot.api.editMessageCaption(chatId, order.telegramMessageId, { caption: text.slice(0, 1024), reply_markup: new InlineKeyboard() });
      }
    },
    start(onError) {
      bot.start({ allowed_updates: ['message', 'callback_query'] }).catch(onError);
    },
    stop: () => bot.stop(),
    username: async () => (await bot.api.getMe()).username,
  };
}
