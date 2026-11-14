import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
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

const tinyJpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).jpeg().toBuffer();
const input = { title: 'Nike hoodie size L', priceCents: 3500, photos: [{ mime: 'image/jpeg', data: tinyJpeg }] };

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

  it('shrinks large photos before sending them to the AI', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#884422' } })
      .jpeg({ quality: 100 })
      .toBuffer();
    const calls: any[] = [];
    await draftListing({ ...input, photos: [{ mime: 'image/jpeg', data: big }] }, fakeClient(JSON.stringify(good), calls));
    const img = calls[0].messages[0].content.find((b: any) => b.type === 'image');
    const meta = await sharp(Buffer.from(img.source.data, 'base64')).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568);
    expect(img.source.media_type).toBe('image/jpeg');
  });

  it('skips a photo it cannot read instead of failing the draft', async () => {
    const calls: any[] = [];
    const d = await draftListing(
      { ...input, photos: [{ mime: 'image/png', data: Buffer.from('not really a png') }] },
      fakeClient(JSON.stringify(good), calls),
    );
    expect(d.title).toBe(good.title);
    expect(calls[0].messages[0].content.filter((b: any) => b.type === 'image')).toHaveLength(0);
  });
});

describe('draftListing without a price', () => {
  it('sends the seller details and says the price is not set', async () => {
    const calls: any[] = [];
    await draftListing({ ...input, title: 'Spode platter\ncrazing on back', priceCents: null }, fakeClient(JSON.stringify(good), calls));
    const text = calls[0].messages[0].content.find((b: any) => b.type === 'text').text;
    expect(text).toContain('crazing on back');
    expect(text).toContain('Price: not set yet');
  });
});
