import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import { PLATFORM_LABEL, type Platform, type PlatformMessage } from '../platforms/types.js';

const MAX_THREAD_NAME = 100;
const MAX_POST = 2000;

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

export function formatBuyerMessage(m: PlatformMessage): string {
  const header = m.item ? (m.item.url ? `**${m.item.title}** · ${m.item.url}` : `**${m.item.title}**`) : '';
  const quoted = m.body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const text = header ? `${header}\n${quoted}` : quoted;
  return text.length <= MAX_POST ? text : text.slice(0, MAX_POST - 1) + '…';
}

/**
 * Posts each new buyer message into that buyer's thread, creating the thread on first contact.
 * A message is recorded only after Discord accepted it, so a failed post is retried on the next poll.
 */
export async function mirrorMessages(db: Db, platform: Platform, msgs: PlatformMessage[], sink: ThreadSink): Promise<void> {
  for (const m of msgs) {
    if (await repo.messageExists(db, m.messageExternalId)) continue;

    const conv = await repo.upsertConversation(db, platform, m.conversationExternalId, m.buyerUsername);
    const text = formatBuyerMessage(m);
    if (conv.discordThreadId) {
      await sink.post(conv.discordThreadId, text);
    } else {
      const threadId = await sink.createThread(threadName(m.buyerUsername, PLATFORM_LABEL[platform]), text);
      await repo.setConversationThread(db, conv.id, threadId);
    }
    await repo.insertMessageIfNew(db, conv.id, m.messageExternalId, true, m.body, m.sentAt);
  }
}

export interface ReplyMessage {
  id: string;
  threadId: string;
  authorId: string;
  content: string;
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

  try {
    const sentId = await send(conv.externalId, text);
    await repo.insertMessageIfNew(deps.db, conv.id, sentId ?? `local:${m.id}`, false, text, new Date());
    await m.react('✅');
  } catch (e) {
    await m.react('❌');
    await m.reply(`Couldn't send: ${(e as Error).message}`);
  }
}
