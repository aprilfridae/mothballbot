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
