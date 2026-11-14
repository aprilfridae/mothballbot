import { describe, it, expect } from 'vitest';
import { draftListing, DraftError, type AnthropicLike } from '../../src/ai/draftListing.js';

function fakeClient(text: string, calls: any[] = []): AnthropicLike {
  return {
    messages: {
      create: async (req: any) => {
        calls.push(req);
        return { content: [{ type: 'text', text }] } as any;
      },
    },
  };
}

const good = {
  title: 'Nike Hoodie Mens Size L Black',
  description: 'Black Nike hoodie in great condition.',
  condition: 'USED_EXCELLENT',
  brand: 'Nike',
  aspects: { Size: ['L'], Color: ['Black'] },
  categoryQuery: 'mens hoodie',
};

const input = { title: 'Nike hoodie size L', priceCents: 3500, photos: [{ mime: 'image/jpeg', data: Buffer.from('x') }] };

describe('draftListing', () => {
  it('returns the parsed draft and sends photos to a haiku model', async () => {
    const calls: any[] = [];
    const d = await draftListing(input, fakeClient(JSON.stringify(good), calls));
    expect(d).toEqual(good);
    expect(calls[0].model).toBe('claude-haiku-5-5');
    const blocks = calls[0].messages[0].content;
    expect(blocks.some((b: any) => b.type === 'image' && b.source.media_type === 'image/jpeg')).toBe(true);
  });

  it('accepts JSON wrapped in a code fence', async () => {
    const d = await draftListing(input, fakeClient('```json\n' + JSON.stringify(good) + '\n```'));
    expect(d.brand).toBe('Nike');
  });

  it('truncates titles to 80 characters on a word boundary', async () => {
    const long = { ...good, title: 'Vintage '.repeat(15).trim() };
    const d = await draftListing(input, fakeClient(JSON.stringify(long)));
    expect(d.title.length).toBeLessThanOrEqual(80);
    expect(d.title.endsWith('Vintage')).toBe(true);
  });

  it('throws DraftError on malformed output', async () => {
    await expect(draftListing(input, fakeClient('sorry, I cannot'))).rejects.toBeInstanceOf(DraftError);
  });

  it('throws DraftError when the condition is not an allowed value', async () => {
    await expect(draftListing(input, fakeClient(JSON.stringify({ ...good, condition: 'MINT' })))).rejects.toBeInstanceOf(
      DraftError,
    );
  });
});
