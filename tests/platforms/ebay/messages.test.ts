import { describe, it, expect } from 'vitest';
import { createEbay } from '../../../src/platforms/ebay/client.js';
import { fetchNewMessages } from '../../../src/platforms/ebay/messages.js';
import { fakeFetch, json, tokenResponse } from '../../helpers/fakeFetch.js';

const creds = { clientId: 'id', clientSecret: 's', refreshToken: 'r' };

const conversations = {
  conversations: [
    {
      conversationId: 'C1',
      conversationTitle: 'Nike Hoodie Mens L',
      referenceId: '1234567890',
      referenceType: 'LISTING',
      latestMessage: { createdDate: '2026-11-13T20:05:00.000Z' },
    },
    {
      conversationId: 'OLD',
      conversationTitle: 'Old thing',
      latestMessage: { createdDate: '2026-11-01T00:00:00.000Z' },
    },
  ],
};

const conversation = {
  conversationId: 'C1',
  messages: [
    { messageId: 'M0', senderUsername: 'sam_92', messageBody: 'old msg', createdDate: '2026-11-13T19:00:00.000Z' },
    { messageId: 'M1', senderUsername: 'sam_92', messageBody: 'Is this still available?', createdDate: '2026-11-13T20:01:00.000Z' },
    { messageId: 'M2', senderUsername: 'mothball_shop', messageBody: 'Yes it is!', createdDate: '2026-11-13T20:03:00.000Z' },
  ],
};

describe('fetchNewMessages', () => {
  it('returns buyer messages newer than the cursor from recently updated conversations', async () => {
    const f = fakeFetch([
      ['POST oauth2/token', () => tokenResponse()],
      ['GET /commerce/message/v1/conversation/C1', () => json(conversation)],
      ['GET /commerce/message/v1/conversation?', () => json(conversations)],
    ]);
    const msgs = await fetchNewMessages(createEbay(creds, f.fetch), 'mothball_shop', new Date('2026-11-13T20:00:00Z'));
    expect(msgs).toEqual([
      {
        conversationExternalId: 'C1',
        messageExternalId: 'ebay:M1',
        buyerUsername: 'sam_92',
        body: 'Is this still available?',
        sentAt: new Date('2026-11-13T20:01:00.000Z'),
        item: { title: 'Nike Hoodie Mens L', url: 'https://www.ebay.com/itm/1234567890' },
        media: [],
      },
    ]);
    expect(f.calls.some((c) => c.url.includes('/conversation/OLD'))).toBe(false);
    expect(f.calls[1].url).toContain('conversation_type=FROM_MEMBERS');
  });

  it('matches the seller username case-insensitively', async () => {
    const f = fakeFetch([
      ['POST oauth2/token', () => tokenResponse()],
      ['GET /commerce/message/v1/conversation/C1', () => json(conversation)],
      ['GET /commerce/message/v1/conversation?', () => json(conversations)],
    ]);
    const msgs = await fetchNewMessages(createEbay(creds, f.fetch), 'Mothball_Shop', new Date('2026-11-13T20:00:00Z'));
    expect(msgs.map((m) => m.messageExternalId)).toEqual(['ebay:M1']);
  });
});

import { sendReply } from '../../../src/platforms/ebay/messages.js';

describe('sendReply', () => {
  it('sends text into the existing conversation and returns the prefixed message id', async () => {
    const f = fakeFetch([
      ['POST oauth2/token', () => tokenResponse()],
      ['POST /commerce/message/v1/send_message', () => json({ messageId: 'M9' })],
    ]);
    const id = await sendReply(createEbay(creds, f.fetch), 'C1', 'Yes, still available!');
    expect(id).toBe('ebay:M9');
    expect(f.calls[1].body).toEqual({ conversationId: 'C1', messageText: 'Yes, still available!' });
  });
});

describe('fetchNewMessages paging', () => {
  it('asks only for conversations since the cursor and follows next links', async () => {
    const page2 = 'https://api.ebay.com/commerce/message/v1/conversation?conversation_type=FROM_MEMBERS&offset=50&limit=50';
    const conv = (id: string) => ({ conversationId: id, latestMessage: { createdDate: '2026-11-13T20:05:00.000Z' } });
    const f = fakeFetch([
      ['POST oauth2/token', () => tokenResponse()],
      ['GET offset=50', () => json({ conversations: [conv('C2')] })],
      ['GET /commerce/message/v1/conversation/C1', () => json({ messages: [{ messageId: 'A', senderUsername: 'sam', messageBody: 'p1', createdDate: '2026-11-13T20:01:00.000Z' }], next: 'https://api.ebay.com/commerce/message/v1/conversation/C1?conversation_type=FROM_MEMBERS&offset=50' })],
      ['GET /commerce/message/v1/conversation/C2', () => json({ messages: [{ messageId: 'C', senderUsername: 'jo', messageBody: 'p3', createdDate: '2026-11-13T20:03:00.000Z' }] })],
      ['GET /commerce/message/v1/conversation?', () => json({ conversations: [conv('C1')], next: page2 })],
    ]);
    const msgs = await fetchNewMessages(createEbay(creds, f.fetch), 'shop', new Date('2026-11-13T20:00:00Z'));
    expect(f.calls[1].url).toContain('start_time=2026-11-13T20%3A00%3A00.000Z');
    expect(msgs.map((m) => m.body)).toEqual(expect.arrayContaining(['p1', 'p3']));
  });
});

describe('fetchNewMessages media', () => {
  it('includes photos a buyer attached', async () => {
    const f = fakeFetch([
      ['POST oauth2/token', () => tokenResponse()],
      ['GET /commerce/message/v1/conversation/C1', () => json({ messages: [{ messageId: 'P', senderUsername: 'sam', messageBody: '', createdDate: '2026-11-13T20:01:00.000Z', messageMedia: [{ mediaName: 'chip.jpg', mediaType: 'IMAGE', mediaUrl: 'https://i.ebayimg.com/chip.jpg' }] }] })],
      ['GET /commerce/message/v1/conversation?', () => json({ conversations: [{ conversationId: 'C1', latestMessage: { createdDate: '2026-11-13T20:05:00.000Z' } }] })],
    ]);
    const [m] = await fetchNewMessages(createEbay(creds, f.fetch), 'shop', new Date('2026-11-13T20:00:00Z'));
    expect(m.media).toEqual([{ name: 'chip.jpg', url: 'https://i.ebayimg.com/chip.jpg' }]);
  });
});
