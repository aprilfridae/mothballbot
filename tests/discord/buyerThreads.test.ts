import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, type Db } from '../../src/db/db.js';
import { resetDb } from '../helpers/db.js';
import { threadName, mirrorMessages, type ThreadSink } from '../../src/discord/buyerThreads.js';
import type { PlatformMessage } from '../../src/platforms/types.js';

let db: Db;
beforeAll(() => {
  db = createDb(process.env.TEST_DATABASE_URL!);
});
beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await db.end();
});

function sink() {
  const threads: { id: string; name: string; first: string }[] = [];
  const posts: { threadId: string; text: string }[] = [];
  const s: ThreadSink = {
    createThread: async (name, first) => {
      const id = `t${threads.length + 1}`;
      threads.push({ id, name, first });
      return id;
    },
    post: async (threadId, text) => {
      posts.push({ threadId, text });
    },
  };
  return { s, threads, posts };
}

const msg = (id: string, conv: string, buyer: string, body: string): PlatformMessage => ({
  conversationExternalId: conv,
  messageExternalId: id,
  buyerUsername: buyer,
  body,
  sentAt: new Date(`2026-11-13T20:0${id.slice(-1)}:00Z`),
  item: { title: 'Nike Hoodie', url: 'https://www.ebay.com/itm/1' },
});

describe('threadName', () => {
  it('formats buyer and platform', () => {
    expect(threadName('sam_92', 'eBay')).toBe('buyer: sam_92 · eBay');
  });

  it('shortens long usernames but keeps the platform suffix', () => {
    const name = threadName('x'.repeat(150), 'eBay');
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith(' · eBay')).toBe(true);
  });
});

describe('mirrorMessages', () => {
  it('creates one thread per conversation and never posts a message twice', async () => {
    const { s, threads, posts } = sink();
    const batch = [msg('m1', 'C1', 'sam_92', 'Is this available?'), msg('m2', 'C1', 'sam_92', 'Will you take $30?')];
    await mirrorMessages(db, 'ebay', batch, s);
    await mirrorMessages(db, 'ebay', batch, s);
    expect(threads).toHaveLength(1);
    expect(threads[0].name).toBe('buyer: sam_92 · eBay');
    expect(threads[0].first).toContain('Is this available?');
    expect(threads[0].first).toContain('Nike Hoodie');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ threadId: 't1', text: expect.stringContaining('Will you take $30?') });
  });

  it('gives a second buyer their own thread', async () => {
    const { s, threads } = sink();
    await mirrorMessages(db, 'ebay', [msg('m1', 'C1', 'sam_92', 'hi'), msg('m3', 'C2', 'jo', 'hello')], s);
    expect(threads.map((t) => t.name)).toEqual(['buyer: sam_92 · eBay', 'buyer: jo · eBay']);
  });

  it('posts into an existing thread for a conversation seen earlier', async () => {
    const { s, threads, posts } = sink();
    await mirrorMessages(db, 'ebay', [msg('m1', 'C1', 'sam_92', 'hi')], s);
    await mirrorMessages(db, 'ebay', [msg('m2', 'C1', 'sam_92', 'still there?')], s);
    expect(threads).toHaveLength(1);
    expect(posts[0].threadId).toBe('t1');
  });

  it('does not record a message when posting to Discord fails, so the next poll retries it', async () => {
    const { s, posts } = sink();
    await mirrorMessages(db, 'ebay', [msg('m1', 'C1', 'sam_92', 'hi')], s);
    const failing: ThreadSink = { ...s, post: async () => Promise.reject(new Error('Discord down')) };
    await expect(mirrorMessages(db, 'ebay', [msg('m2', 'C1', 'sam_92', 'again')], failing)).rejects.toThrow('Discord down');
    await mirrorMessages(db, 'ebay', [msg('m2', 'C1', 'sam_92', 'again')], s);
    expect(posts.map((p) => p.text)).toEqual([expect.stringContaining('again')]);
  });
});

import { handleThreadReply, type ReplyMessage } from '../../src/discord/buyerThreads.js';
import * as repo from '../../src/db/repo.js';

describe('handleThreadReply', () => {
  function reply(over: Partial<ReplyMessage> = {}) {
    const reactions: string[] = [];
    const replies: string[] = [];
    const m: ReplyMessage = {
      id: 'd1',
      threadId: 't1',
      authorId: 'owner',
      content: 'Yes, still available!',
      react: async (e) => {
        reactions.push(e);
      },
      reply: async (t) => {
        replies.push(t);
      },
      ...over,
    };
    return { m, reactions, replies };
  }

  async function mapped() {
    const conv = await repo.upsertConversation(db, 'ebay', 'C1', 'sam_92');
    await repo.setConversationThread(db, conv.id, 't1');
    return conv;
  }

  it('sends the owner reply to the right conversation, reacts ✅ and records it', async () => {
    await mapped();
    const sent: any[] = [];
    const { m, reactions } = reply();
    await handleThreadReply(m, {
      db,
      ownerId: 'owner',
      send: { ebay: async (conv, text) => (sent.push({ conv, text }), 'ebay:M9') },
    });
    expect(sent).toEqual([{ conv: 'C1', text: 'Yes, still available!' }]);
    expect(reactions).toEqual(['✅']);
    expect(await repo.messageExists(db, 'ebay:M9')).toBe(true);
  });

  it("reacts ❌ and says why when the platform rejects the reply", async () => {
    await mapped();
    const { m, reactions, replies } = reply();
    await handleThreadReply(m, {
      db,
      ownerId: 'owner',
      send: {
        ebay: async () => {
          throw new Error('Conversation not found');
        },
      },
    });
    expect(reactions).toEqual(['❌']);
    expect(replies).toEqual(["Couldn't send: Conversation not found"]);
  });

  it('ignores threads that are not buyer conversations and non-owners', async () => {
    await mapped();
    let calls = 0;
    const deps = { db, ownerId: 'owner', send: { ebay: async () => (calls++, null) } };
    await handleThreadReply(reply({ threadId: 'other' }).m, deps);
    await handleThreadReply(reply({ authorId: 'stranger' }).m, deps);
    expect(calls).toBe(0);
  });

  it('ignores empty messages such as image-only posts', async () => {
    await mapped();
    let calls = 0;
    const { m, replies } = reply({ content: '   ' });
    await handleThreadReply(m, { db, ownerId: 'owner', send: { ebay: async () => (calls++, null) } });
    expect(calls).toBe(0);
    expect(replies[0]).toContain('only text');
  });
});

import { ThreadGoneError } from '../../src/discord/buyerThreads.js';

describe('mirrorMessages resilience', () => {
  it('recreates a buyer thread that was deleted in Discord', async () => {
    const { s, threads, posts } = sink();
    await mirrorMessages(db, 'ebay', [msg('m1', 'C1', 'sam_92', 'hi')], s);
    const gone: ThreadSink = {
      ...s,
      post: async (id, text) => {
        if (id === 't1') throw new ThreadGoneError(id);
        return s.post(id, text);
      },
    };
    await mirrorMessages(db, 'ebay', [msg('m2', 'C1', 'sam_92', 'hello again')], gone);
    expect(threads.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(threads[1].first).toContain('hello again');
    expect(posts).toHaveLength(0);
    expect((await repo.upsertConversation(db, 'ebay', 'C1', 'sam_92')).discordThreadId).toBe('t2');
  });

  it("does not let one failing message block other buyers' messages, but still fails the run", async () => {
    const { s, threads } = sink();
    const flaky: ThreadSink = {
      ...s,
      createThread: async (name, first) => {
        if (first.includes('boom')) throw new Error('Discord 500');
        return s.createThread(name, first);
      },
    };
    await expect(
      mirrorMessages(db, 'ebay', [msg('m1', 'C1', 'sam_92', 'boom'), msg('m3', 'C2', 'jo', 'hello')], flaky),
    ).rejects.toThrow('Discord 500');
    expect(threads.map((t) => t.name)).toEqual(['buyer: jo · eBay']);
  });
});

describe('handleThreadReply after a successful send', () => {
  it('never shows ❌ or "Couldn\'t send" once the platform accepted the reply', async () => {
    const conv = await repo.upsertConversation(db, 'ebay', 'C9', 'kim');
    await repo.setConversationThread(db, conv.id, 't9');
    const reactions: string[] = [];
    const replies: string[] = [];
    let sends = 0;
    await handleThreadReply(
      {
        id: 'd9',
        threadId: 't9',
        authorId: 'owner',
        content: 'yes',
        react: async (e) => {
          reactions.push(e);
          if (e === '✅') throw new Error('Missing Permissions');
        },
        reply: async (t) => void replies.push(t),
      },
      { db, ownerId: 'owner', send: { ebay: async () => (sends++, 'ebay:M10') } },
    );
    expect(sends).toBe(1);
    expect(reactions).toEqual(['✅']);
    expect(replies).toEqual([]);
  });
});
