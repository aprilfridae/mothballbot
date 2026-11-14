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
