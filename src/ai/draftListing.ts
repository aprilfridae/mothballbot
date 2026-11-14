import { z } from 'zod';

export const MODEL = 'claude-haiku-5-5';

export const CONDITIONS = ['NEW', 'NEW_OTHER', 'USED_EXCELLENT', 'USED_GOOD', 'USED_ACCEPTABLE'] as const;
export type Condition = (typeof CONDITIONS)[number];

const DraftSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  condition: z.enum(CONDITIONS),
  brand: z.string().nullable(),
  aspects: z.record(z.string(), z.array(z.string())),
  categoryQuery: z.string().min(1),
});

export type ListingDraft = z.infer<typeof DraftSchema>;

export interface AnthropicLike {
  messages: { create: (req: any) => Promise<{ content: Array<{ type: string; text?: string }> }> };
}

export class DraftError extends Error {}

export interface DraftInput {
  title: string;
  priceCents: number;
  photos: { mime: string; data: Buffer }[];
}

const SYSTEM = `You write marketplace listings for a small resale shop. Look at the photos and the seller's short title.
Reply with ONLY a JSON object, no other text, with these fields:
- "title": a search-friendly listing title, at most 80 characters (brand, item type, key details like size/color/model)
- "description": 2-4 short paragraphs, honest and specific; mention visible flaws; no emojis; no shipping or return terms
- "condition": one of ${CONDITIONS.join(', ')}
- "brand": the brand name, or null if unknown
- "aspects": item specifics as {"Name": ["value"]}, e.g. {"Size": ["L"], "Color": ["Black"]}
- "categoryQuery": 2-4 words describing the item category, e.g. "mens hoodie"
Never invent details you can't see or that the seller didn't state.`;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function truncateTitle(title: string, max = 80): string {
  const t = title.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : t.slice(0, max)).trim();
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new DraftError('The AI did not return a listing draft.');
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new DraftError('The AI returned a malformed listing draft.');
  }
}

export async function draftListing(input: DraftInput, client: AnthropicLike): Promise<ListingDraft> {
  const images = input.photos
    .filter((p) => IMAGE_TYPES.has(p.mime))
    .slice(0, 8)
    .map((p) => ({
      type: 'image',
      source: { type: 'base64', media_type: p.mime, data: p.data.toString('base64') },
    }));

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          ...images,
          { type: 'text', text: `Seller's title: ${input.title}\nPrice: $${(input.priceCents / 100).toFixed(2)}` },
        ],
      },
    ],
  });

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const parsed = DraftSchema.safeParse(extractJson(text));
  if (!parsed.success) throw new DraftError('The AI listing draft was missing fields or had invalid values.');
  return { ...parsed.data, title: truncateTitle(parsed.data.title) };
}
