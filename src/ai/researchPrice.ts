import { z } from 'zod';
import type { PriceResearch } from '../db/repo.js';
import { MODEL, type AnthropicLike, type ListingDraft } from './draftListing.js';

export type { PriceResearch } from '../db/repo.js';

/** Claude's basic server-side web search tool (no code-execution dependency). */
export const WEB_SEARCH_TOOL = 'web_search_20250305';
export const MAX_SEARCHES = 5;
const MAX_COMPARABLES = 5;
const MAX_CONTINUATIONS = 3;

const SYSTEM = `You price items for a small online shop that sells vintage housewares, antique china and similar collectibles.
Use web search to find what this exact item (maker, pattern, shape, size, era) has SOLD for recently. Prefer sold prices over asking prices.
Good sources: eBay sold listings, Replacements.com, WorthPoint, Etsy, Ruby Lane, auction results. Match the pattern and piece carefully; a different shape or size is not a comparable.
Account for condition (chips, cracks, crazing, wear lower the price).
Reply with ONLY a JSON object, no other text:
{"suggested": number (USD, a realistic price to list at),
 "low": number, "high": number (realistic range),
 "confidence": "low" | "medium" | "high",
 "comparables": [{"title": string, "price": number, "sold": boolean, "site": string, "url": string}] (3-5 best matches),
 "reasoning": string (one sentence)}
If you can't find reliable comparables, return "comparables": [] and explain in "reasoning".`;

const money = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : Number(v.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) {
    ctx.addIssue({ code: 'custom', message: 'not a price' });
    return z.NEVER;
  }
  return Math.round(n * 100);
});

const AnswerSchema = z.object({
  suggested: money,
  low: money,
  high: money,
  confidence: z.enum(['low', 'medium', 'high']),
  comparables: z.array(z.unknown()),
  reasoning: z.string(),
});

const ComparableSchema = z.object({
  title: z.string().min(1),
  price: money,
  sold: z.boolean(),
  site: z.string().min(1),
  url: z.string().regex(/^https:\/\//),
});

function failed(reason: string): PriceResearch {
  return {
    suggestedCents: null,
    lowCents: null,
    highCents: null,
    confidence: 'low',
    comparables: [],
    reasoning: `Couldn't find comparables: ${reason}`,
  };
}

/** The answer is the text after the last search result; citations can split it across several text blocks. */
function answerJson(content: Array<{ type: string; text?: string }>): unknown {
  const lastResult = content.map((b) => b.type).lastIndexOf('web_search_tool_result');
  const text = content
    .slice(lastResult + 1)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Looks up sold prices on the web. Never throws: any failure becomes "no price" so Mom sets it herself. */
export async function researchPrice(input: { details: string; draft: ListingDraft }, client: AnthropicLike): Promise<PriceResearch> {
  const messages: any[] = [
    {
      role: 'user',
      content: `Item details from the seller:\n${input.details}\n\nDraft listing title: ${input.draft.title}\nBrand/maker: ${
        input.draft.brand ?? 'unknown'
      }\nItem specifics: ${JSON.stringify(input.draft.aspects)}\nCondition: ${input.draft.condition}`,
    },
  ];

  try {
    let res = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages,
      tools: [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: MAX_SEARCHES }],
    });
    // Server tools can pause a long turn; send it back unchanged to let it finish.
    for (let i = 0; res.stop_reason === 'pause_turn' && i < MAX_CONTINUATIONS; i++) {
      messages.push({ role: 'assistant', content: res.content });
      res = await client.messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        messages,
        tools: [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: MAX_SEARCHES }],
      });
    }

    const parsed = AnswerSchema.safeParse(answerJson(res.content));
    if (!parsed.success) return failed('the research did not return a usable answer.');

    const comparables = parsed.data.comparables
      .map((c) => ComparableSchema.safeParse(c))
      .filter((c) => c.success)
      .slice(0, MAX_COMPARABLES)
      .map(({ data }) => ({ title: data.title, priceCents: data.price, sold: data.sold, site: data.site, url: data.url }));
    if (!comparables.length) return failed(parsed.data.reasoning || 'no matching items found.');

    return {
      suggestedCents: parsed.data.suggested,
      lowCents: parsed.data.low,
      highCents: parsed.data.high,
      confidence: parsed.data.confidence,
      comparables,
      reasoning: parsed.data.reasoning,
    };
  } catch (e) {
    console.error('Price research failed:', e);
    return {
      ...failed(''),
      reasoning: "Price research didn't work this time, so please set the price.",
      error: (e as Error).message || String(e),
    };
  }
}
