import type { PlatformMessage } from '../types.js';
import { API, type EbayClient } from './client.js';

const BASE = `${API}/commerce/message/v1`;

/** eBay message ids are prefixed so they can never collide with other platforms' ids in the shared messages table. */
export const ebayMessageId = (id: string) => `ebay:${id}`;

const MAX_PAGES = 10;

/** Follows eBay's `next` links so busy inboxes aren't cut off at one page. */
async function allPages(ebay: EbayClient, firstUrl: string, key: string): Promise<any[]> {
  const items: any[] = [];
  let url: string | undefined = firstUrl;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await ebay.request('GET', url);
    items.push(...(res?.[key] ?? []));
    url = res?.next || undefined;
  }
  return items;
}

export async function fetchNewMessages(ebay: EbayClient, sellerUsername: string, since: Date): Promise<PlatformMessage[]> {
  const seller = sellerUsername.toLowerCase();
  const conversations = await allPages(
    ebay,
    `${BASE}/conversation?${new URLSearchParams({
      conversation_type: 'FROM_MEMBERS',
      start_time: since.toISOString(),
      limit: '50',
    })}`,
    'conversations',
  );

  const out: PlatformMessage[] = [];
  for (const conv of conversations) {
    const latest = conv.latestMessage?.createdDate ? new Date(conv.latestMessage.createdDate) : null;
    if (!latest || latest <= since) continue;

    const messages = await allPages(
      ebay,
      `${BASE}/conversation/${encodeURIComponent(conv.conversationId)}?${new URLSearchParams({
        conversation_type: 'FROM_MEMBERS',
        limit: '50',
      })}`,
      'messages',
    );
    const item =
      conv.referenceType === 'LISTING' && conv.referenceId
        ? { title: conv.conversationTitle ?? 'Listing', url: `https://www.ebay.com/itm/${conv.referenceId}` }
        : conv.conversationTitle
          ? { title: conv.conversationTitle, url: null }
          : null;

    for (const m of messages) {
      const sentAt = new Date(m.createdDate);
      if (sentAt <= since) continue;
      if (!m.senderUsername || m.senderUsername.toLowerCase() === seller) continue;
      out.push({
        conversationExternalId: conv.conversationId,
        messageExternalId: ebayMessageId(m.messageId),
        buyerUsername: m.senderUsername,
        body: m.messageBody ?? '',
        sentAt,
        item,
      });
    }
  }
  return out.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
}

/** Sends a reply into an existing eBay conversation; returns the (prefixed) message id when eBay gives one. */
export async function sendReply(ebay: EbayClient, conversationExternalId: string, text: string): Promise<string | null> {
  const res = await ebay.request('POST', `${BASE}/send_message`, {
    conversationId: conversationExternalId,
    messageText: text,
  });
  return res?.messageId ? ebayMessageId(res.messageId) : null;
}
