import { Bot, InlineKeyboard } from 'grammy';
import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { Order, Platform, ShipTo } from '../db/repo.js';
import type { ShipResult } from '../orders/markShipped.js';
import { PLATFORM_LABEL } from '../platforms/types.js';
import { detectCarrier, normalizeTracking } from '../shipping/detectCarrier.js';

export const MOM_CHAT_KEY = 'telegram.momChatId';

export interface MomDeps {
  db: Db;
  linkCode: string;
  markShipped: (orderId: number, by: 'mom', tracking: string | null) => Promise<ShipResult>;
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

export interface MomBot {
  /** Sends the sale to Mom; returns the Telegram message id, or null if she hasn't connected yet. */
  notifyMom(order: Order): Promise<number | null>;
  /** Edits a sale message to show its shipped status and removes the button. */
  markMessage(order: Order, label: string): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export function createMomBot(token: string, deps: MomDeps): MomBot {
  const bot = new Bot(token);

  bot.command('start', async (ctx) => {
    const answer = await handleStart(ctx.chat.id, ctx.match ?? '', deps);
    if (answer) await ctx.reply(answer);
  });

  bot.on('callback_query:data', async (ctx) => {
    const chatId = ctx.chat?.id ?? ctx.from.id;
    const answer = await handleShippedCallback(chatId, ctx.callbackQuery.data, deps);
    await ctx.answerCallbackQuery(answer ? { text: answer } : undefined);
  });

  bot.on('message:text', async (ctx) => {
    const answer = await handleMomReply(ctx.chat.id, ctx.message.reply_to_message?.message_id ?? null, ctx.message.text, deps);
    if (answer) await ctx.reply(answer, { reply_parameters: { message_id: ctx.message.message_id } });
  });

  bot.catch((err) => console.error('Telegram bot error:', err.error));

  return {
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
    start() {
      void bot.start({ allowed_updates: ['message', 'callback_query'] });
    },
    stop: () => bot.stop(),
  };
}
