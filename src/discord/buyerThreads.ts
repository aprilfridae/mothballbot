import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import { PLATFORM_LABEL, type Platform, type PlatformMessage } from '../platforms/types.js';

const MAX_THREAD_NAME = 100;
const MAX_POST = 2000;

/** Thrown by a ThreadSink when the thread was deleted in Discord; the conversation then gets a fresh thread. */
export class ThreadGoneError extends Error {
  constructor(threadId: string) {
    super(`Buyer thread ${threadId} no longer exists`);
  }
}

export interface ThreadSink {
  /** Creates a forum post (thread) with the given name and first message; returns the thread id. */
  createThread(name: string, firstMessage: string): Promise<string>;
  post(threadId: string, text: string): Promise<void>;
}

export function threadName(username: string, platformLabel: string): string {
  const prefix = 'buyer: ';
  const suffix = ` · ${platformLabel}`;
  const room = MAX_THREAD_NAME - prefix.length - suffix.length;
  const name = username.length > room ? username.slice(0, room - 1) + '…' : username;
  return `${prefix}${name}${suffix}`;
}

/** Buyer text is untrusted: break @everyone/@here and user/role mentions so it can never ping anyone. */
function noPings(text: string): string {
  return text.replace(/@(everyone|here)/gi, '@\u200b$1').replace(/<@/g, '<\u200b@');
}

export function formatBuyerMessage(m: PlatformMessage): string {
  const header = m.item ? (m.item.url ? `**${m.item.title}** · ${m.item.url}` : `**${m.item.title}**`) : '';
  const body = noPings(m.body.trim());
  const quoted = body
    ? body
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    : m.media?.length
      ? ''
      : '> (empty message)';
  const media = (m.media ?? []).map((x) => `📎 ${x.name} ${x.url}`).join('\n');
  const text = [header, quoted, media].filter(Boolean).join('\n');
  return text.length <= MAX_POST ? text : text.slice(0, MAX_POST - 1) + '…';
}

/**
 * Posts each new buyer message into that buyer's thread, creating the thread on first contact (or again if it
 * was deleted). A message is recorded only after Discord accepted it, so a failed post is retried on the next poll.
 */
export async function mirrorMessages(db: Db, platform: Platform, msgs: PlatformMessage[], sink: ThreadSink): Promise<void> {
  const failures: Error[] = [];
  for (const m of msgs) {
    try {
      await mirrorOne(db, platform, m, sink);
    } catch (e) {
      failures.push(e as Error);
    }
  }
  // Fail the run so the cursor stays put and the failed messages are retried; the others are already recorded.
  if (failures.length) throw failures[0];
}

async function mirrorOne(db: Db, platform: Platform, m: PlatformMessage, sink: ThreadSink): Promise<void> {
  if (await repo.messageExists(db, m.messageExternalId)) return;

  const conv = await repo.upsertConversation(db, platform, m.conversationExternalId, m.buyerUsername);
  const text = formatBuyerMessage(m);
  let posted = false;
  if (conv.discordThreadId) {
    try {
      await sink.post(conv.discordThreadId, text);
      posted = true;
    } catch (e) {
      if (!(e instanceof ThreadGoneError)) throw e;
    }
  }
  if (!posted) {
    const threadId = await sink.createThread(threadName(m.buyerUsername, PLATFORM_LABEL[platform]), text);
    await repo.setConversationThread(db, conv.id, threadId);
  }
  await repo.insertMessageIfNew(db, conv.id, m.messageExternalId, true, m.body, m.sentAt);
}

export interface ReplyMessage {
  id: string;
  threadId: string;
  authorId: string;
  content: string;
  /** Photos/files attached to the owner's reply (eBay can't receive them from here). */
  attachmentCount?: number;
  react: (emoji: string) => Promise<void>;
  reply: (text: string) => Promise<void>;
}

export interface ReplyDeps {
  db: Db;
  ownerId: string;
  /** Per-platform senders: (conversationExternalId, text) → sent message id, if the platform returns one. */
  send: Partial<Record<Platform, (conversationExternalId: string, text: string) => Promise<string | null>>>;
}

export async function handleThreadReply(m: ReplyMessage, deps: ReplyDeps): Promise<void> {
  if (m.authorId !== deps.ownerId) return;
  const conv = await repo.findConversationByThread(deps.db, m.threadId);
  if (!conv) return;

  const text = m.content.trim();
  if (!text) {
    await m.reply("Couldn't send: only text replies are supported for now.");
    return;
  }
  const send = deps.send[conv.platform];
  if (!send) {
    await m.react('❌');
    await m.reply(`Couldn't send: replying on ${PLATFORM_LABEL[conv.platform]} isn't set up yet.`);
    return;
  }

  let sentId: string | null;
  try {
    sentId = await send(conv.externalId, text);
  } catch (e) {
    await m.react('❌');
    await m.reply(`Couldn't send: ${(e as Error).message}`);
    return;
  }
  // The buyer already has the message; bookkeeping failures must not make it look unsent (and get resent).
  try {
    await repo.insertMessageIfNew(deps.db, conv.id, sentId ?? `local:${m.id}`, false, text, new Date());
  } catch (e) {
    console.error('Could not record a sent reply:', e);
  }
  try {
    await m.react('✅');
    if (m.attachmentCount) await m.reply("Sent your text, but the photos weren't sent: buyers can't receive attachments from here yet.");
  } catch (e) {
    console.error('Could not react ✅ to a sent reply:', e);
  }
}
