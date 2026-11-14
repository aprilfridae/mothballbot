import { Bot, InlineKeyboard, InputFile, InputMediaBuilder } from 'grammy';
import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { Order, Platform, ShipTo } from '../db/repo.js';
import type { ShipResult } from '../orders/markShipped.js';
import { PLATFORM_LABEL } from '../platforms/types.js';
import { detectCarrier, normalizeTracking } from '../shipping/detectCarrier.js';
import type { Item } from '../db/repo.js';
import {
  albumPhotos,
  conditionKeyboard,
  draftKeyboard,
  fieldKeyboard,
  formatDraftForMom,
  handleListingCallback,
  handleListingText,
  type KeyRows,
  type MomAction,
  type MomListingDeps,
} from './momListings.js';

export const MOM_CHAT_KEY = 'telegram.momChatId';

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
  return [a.name, a.line1, a.line2, `${a.city}, ${a.state} ${a.postalCode}`].filter(Boolean).join('\n');
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
  if (!detectCarrier(text)) {
    return "That doesn't look like a tracking number. Copy it from the shipping label or receipt and reply again.";
  }
  const r = await deps.markShipped(order.id, 'mom', normalizeTracking(text));
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
  listingText: (chatId: number, text: string) => Promise<MomAction | null>,
): Promise<MomAction | null> {
  if (replyToId !== null && (await repo.findOrderByTelegramMessage(deps.db, replyToId))) {
    const answer = await handleMomReply(chatId, replyToId, text, deps);
    return answer ? { answer } : null;
  }
  const action = await listingText(chatId, text);
  if (action) return action;
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
      await bot.api.sendMessage(chatId, action.prompt, { reply_markup: { force_reply: true, input_field_placeholder: 'Type here…' } });
    }
  }

  bot.command('start', async (ctx) => {
    const answer = await handleStart(ctx.chat.id, ctx.match ?? '', deps);
    if (answer) await ctx.reply(answer);
  });

  bot.on('callback_query:data', async (ctx) => {
    const chatId = ctx.chat?.id ?? ctx.from.id;
    try {
      const listingAction = await handleListingCallback(chatId, ctx.callbackQuery.data, listings);
      if (listingAction) {
        await ctx.answerCallbackQuery(listingAction.answer ? { text: listingAction.answer } : undefined);
        await perform(chatId, listingAction);
        return;
      }
      const answer = await handleShippedCallback(chatId, ctx.callbackQuery.data, deps);
      await ctx.answerCallbackQuery(answer ? { text: answer } : undefined);
    } catch (e) {
      // Always answer, so Mom never sees an endless spinner.
      await ctx.answerCallbackQuery({ text: 'Something went wrong. Try again in a minute.' }).catch(() => {});
      throw e;
    }
  });

  bot.on('message:text', async (ctx) => {
    const action = await routeMomText(
      ctx.chat.id,
      ctx.message.reply_to_message?.message_id ?? null,
      ctx.message.text,
      deps,
      (chatId, text) => handleListingText(chatId, text, listings),
    );
    if (!action) return;
    if (action.answer) await ctx.reply(action.answer, { reply_parameters: { message_id: ctx.message.message_id } });
    await perform(ctx.chat.id, { ...action, answer: undefined });
  });

  bot.catch((err) => console.error('Telegram bot error:', err.error));

  return {
    async sendDraftToMom(item) {
      const chatId = await momChatId(deps.db);
      if (chatId === null) return null;
      const photos = albumPhotos(item);
      const files = await Promise.all(photos.map(async (p) => new InputFile(await listings.pipeline.readPhoto(p))));
      if (files.length === 1) await bot.api.sendPhoto(chatId, files[0]);
      else if (files.length > 1) await bot.api.sendMediaGroup(chatId, files.map((f) => InputMediaBuilder.photo(f)));
      const sent = await bot.api.sendMessage(chatId, await draftText(item), {
        reply_markup: toKeyboard(draftKeyboard(item)),
        link_preview_options: { is_disabled: true },
      });
      return sent.message_id;
    },
    refreshDraft,
    async notifyMom(order) {
      const chatId = await momChatId(deps.db);
      if (chatId === null) return null;
      const sent = await bot.api.sendMessage(chatId, formatSaleForMom(order), {
        reply_markup: new InlineKeyboard().text('📦 Shipped', `ship:${order.id}`),
      });
      return sent.message_id;
    },
    async markMessage(order, label) {
      const chatId = await momChatId(deps.db);
      if (chatId === null || order.telegramMessageId === null) return;
      await bot.api.editMessageText(chatId, order.telegramMessageId, `${formatSaleForMom(order)}\n\n${label}`, {
        reply_markup: new InlineKeyboard(),
      });
    },
    start(onError) {
      bot.start({ allowed_updates: ['message', 'callback_query'] }).catch(onError);
    },
    stop: () => bot.stop(),
  };
}
