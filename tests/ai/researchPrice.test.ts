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

  it('joins an answer that arrives split across several text blocks (citations)', async () => {
    const json = JSON.stringify({ suggested: 45, low: 30, high: 60, confidence: 'high', comparables: [comp(1)], reasoning: 'ok' });
    const cut1 = json.indexOf('"comparables"');
    const cut2 = json.indexOf('"reasoning"');
    const r = await researchPrice(
      input,
      client([
        {
          content: [
            { type: 'text', text: 'Searching {first}' },
            { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
            { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
            { type: 'text', text: json.slice(0, cut1) },
            { type: 'text', text: json.slice(cut1, cut2), citations: [{ type: 'web_search_result_location', url: 'https://x' }] },
            { type: 'text', text: json.slice(cut2) },
          ],
        },
      ]),
    );
    expect(r.suggestedCents).toBe(4500);
    expect(r.comparables).toHaveLength(1);
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
  ])('returns no price instead of throwing on %s', async (_label, c) => {
    const r = await researchPrice(input, c);
    expect(r.suggestedCents).toBeNull();
    expect(r.comparables).toEqual([]);
    expect(r.reasoning.startsWith("Couldn't find comparables")).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('flags a research service failure separately, with a friendly line for Mom', async () => {
    const failing = {
      messages: {
        create: async () => {
          throw new Error('400 web search is disabled for this organization');
        },
      },
    } as AnthropicLike;
    const r = await researchPrice(input, failing);
    expect(r.suggestedCents).toBeNull();
    expect(r.error).toContain('web search is disabled');
    expect(r.reasoning).toBe("Price research didn't work this time, so please set the price.");
  });
});

describe('researchPrice safeguards', () => {
  const searches = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ type: 'server_tool_use', id: `s${i}`, name: 'web_search', input: { query: 'q' } }));

  it('counts searches across a paused turn so the total stays at 5', async () => {
    const calls: any[] = [];
    await researchPrice(
      input,
      client(
        [
          { content: searches(4), stop_reason: 'pause_turn' },
          answer({ suggested: 45, low: 30, high: 60, confidence: 'high', comparables: [comp(1)], reasoning: 'ok' }),
        ],
        calls,
      ),
    );
    expect(calls[1].tools[0].max_uses).toBe(1);
  });

  it('stops continuing once all 5 searches are used', async () => {
    const calls: any[] = [];
    const r = await researchPrice(input, client([{ content: searches(5), stop_reason: 'pause_turn' }], calls));
    expect(calls).toHaveLength(1);
    expect(r.suggestedCents).toBeNull();
  });

  it('fixes a range that is backwards or does not contain the suggestion', async () => {
    const r = await researchPrice(input, client([answer({ suggested: 80, low: 60, high: 30, confidence: 'medium', comparables: [comp(1)], reasoning: 'ok' })]));
    expect([r.lowCents, r.suggestedCents, r.highCents]).toEqual([3000, 8000, 8000]);
  });

  it('keeps only comparables whose links came from the actual search results', async () => {
    const r = await researchPrice(
      input,
      client([
        {
          content: [
            ...searches(1),
            {
              type: 'web_search_tool_result',
              tool_use_id: 's0',
              content: [{ type: 'web_search_result', url: 'https://www.ebay.com/itm/1', title: 't' }],
            },
            {
              type: 'text',
              text: JSON.stringify({ suggested: 45, low: 30, high: 60, confidence: 'high', comparables: [comp(1), comp(2)], reasoning: 'ok' }),
            },
          ],
        },
      ]),
    );
    expect(r.comparables.map((c) => c.url)).toEqual(['https://www.ebay.com/itm/1']);
  });

  it("keeps the model's explanation when it finds nothing", async () => {
    const r = await researchPrice(
      input,
      client([answer({ suggested: null, low: null, high: null, confidence: 'low', comparables: [], reasoning: 'This pattern rarely sells online.' })]),
    );
    expect(r.reasoning).toBe("Couldn't find comparables: This pattern rarely sells online.");
  });
});
