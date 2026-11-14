import { describe, it, expect } from 'vitest';
import { researchPrice, WEB_SEARCH_TOOL } from '../../src/ai/researchPrice.js';
import type { AnthropicLike, ListingDraft } from '../../src/ai/draftListing.js';

const draft: ListingDraft = {
  title: 'Spode Blue Italian Oval Platter 14 in',
  description: 'Platter.',
  condition: 'USED_GOOD',
  brand: 'Spode',
  aspects: { Pattern: ['Blue Italian'] },
  categoryQuery: 'china platter',
};
const input = { details: 'Spode Blue Italian platter, 14 inch, crazing on back', draft };

const comp = (n: number, over: Record<string, unknown> = {}) => ({
  title: `Spode platter ${n}`,
  price: 40 + n,
  sold: true,
  site: 'eBay',
  url: `https://www.ebay.com/itm/${n}`,
  ...over,
});

function client(responses: Array<{ content: any[]; stop_reason?: string }>, calls: any[] = []): AnthropicLike {
  let i = 0;
  return {
    messages: {
      create: async (req: any) => {
        calls.push(structuredClone(req));
        const r = responses[Math.min(i++, responses.length - 1)];
        return { stop_reason: 'end_turn', ...r } as any;
      },
    },
  };
}

const answer = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

describe('researchPrice', () => {
  it('maps a JSON answer to cents and caps searches at 5', async () => {
    const calls: any[] = [];
    const r = await researchPrice(
      input,
      client(
        [
          answer({
            suggested: '$45.00',
            low: 30,
            high: '60',
            confidence: 'medium',
            comparables: [comp(1), comp(2, { sold: false, site: 'Etsy', price: '$55.50' })],
            reasoning: 'Two sold on eBay around $40-45.',
          }),
        ],
        calls,
      ),
    );
    expect(r).toEqual({
      suggestedCents: 4500,
      lowCents: 3000,
      highCents: 6000,
      confidence: 'medium',
      comparables: [
        { title: 'Spode platter 1', priceCents: 4100, sold: true, site: 'eBay', url: 'https://www.ebay.com/itm/1' },
        { title: 'Spode platter 2', priceCents: 5550, sold: false, site: 'Etsy', url: 'https://www.ebay.com/itm/2' },
      ],
      reasoning: 'Two sold on eBay around $40-45.',
    });
    expect(calls[0].model).toBe('claude-haiku-5-5');
    expect(calls[0].tools[0]).toMatchObject({ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: 5 });
    expect(calls[0].messages[0].content).toContain('crazing on back');
  });

  it('keeps at most 5 comparables and drops non-https links', async () => {
    const comps = [comp(1, { url: 'javascript:alert(1)' }), ...[2, 3, 4, 5, 6, 7].map((n) => comp(n))];
    const r = await researchPrice(input, client([answer({ suggested: 45, low: 30, high: 60, confidence: 'high', comparables: comps, reasoning: 'x' })]));
    expect(r.comparables.map((c) => c.title)).toEqual(['Spode platter 2', 'Spode platter 3', 'Spode platter 4', 'Spode platter 5', 'Spode platter 6']);
  });

  it('parses only the final text block after search activity', async () => {
    const r = await researchPrice(
      input,
      client([
        {
          content: [
            { type: 'text', text: "I'll search for { sold prices }." },
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'spode blue italian platter sold' } },
            { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
            { type: 'text', text: 'Here is the result:\n```json\n' + JSON.stringify({ suggested: 45, low: 30, high: 60, confidence: 'high', comparables: [comp(1)], reasoning: 'ok' }) + '\n```' },
          ],
        },
      ]),
    );
    expect(r.suggestedCents).toBe(4500);
  });

  it('continues a paused turn so long searches finish', async () => {
    const calls: any[] = [];
    const r = await researchPrice(
      input,
      client(
        [
          { content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }], stop_reason: 'pause_turn' },
          answer({ suggested: 45, low: 30, high: 60, confidence: 'high', comparables: [comp(1)], reasoning: 'ok' }),
        ],
        calls,
      ),
    );
    expect(r.suggestedCents).toBe(4500);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.at(-1).role).toBe('assistant');
  });

  it.each([
    ['no JSON', client([{ content: [{ type: 'text', text: 'Sorry, nothing found.' }] }])],
    ['zero comparables', client([answer({ suggested: 45, low: 30, high: 60, confidence: 'low', comparables: [], reasoning: 'guess' })])],
    [
      'a failing client',
      {
        messages: {
          create: async () => {
            throw new Error('overloaded');
          },
        },
      } as AnthropicLike,
    ],
  ])('returns no price instead of throwing on %s', async (_label, c) => {
    const r = await researchPrice(input, c);
    expect(r.suggestedCents).toBeNull();
    expect(r.comparables).toEqual([]);
    expect(r.reasoning.startsWith("Couldn't find comparables")).toBe(true);
  });
});
