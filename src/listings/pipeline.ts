import { truncateTitle, type DraftInput, type ListingDraft } from '../ai/draftListing.js';
import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { Item, PriceResearch } from '../db/repo.js';
import { EbayError } from '../platforms/ebay/client.js';
import type { EbayListingInput } from '../platforms/ebay/listings.js';
import { readDraft } from './edit.js';

export interface PipelineDeps {
  db: Db;
  draft: (input: DraftInput) => Promise<ListingDraft>;
  research: (input: { details: string; draft: ListingDraft }) => Promise<PriceResearch>;
  readPhoto: (path: string) => Promise<Buffer>;
  ebay: {
    uploadImage: (file: { mime: string; data: Buffer; name: string }) => Promise<string>;
    suggestCategory: (query: string) => Promise<{ categoryId: string; requiredAspects: string[] }>;
    createListing: (input: EbayListingInput) => Promise<{ listingId: string; url: string }>;
  };
  report: (text: string) => Promise<void>;
  /** Called after every status change, so Discord and Telegram can show it. */
  onChange: (item: Item) => Promise<void>;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

export function mimeFromPath(path: string): string {
  return MIME_BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/jpeg';
}

async function changed(deps: PipelineDeps, itemId: number): Promise<Item> {
  const item = (await repo.getItem(deps.db, itemId))!;
  try {
    await deps.onChange(item);
  } catch (e) {
    console.error(`Updating views for item #${itemId} failed:`, e);
  }
  return item;
}

/** AI draft + price research for a newly saved item, then hands it to Mom (status awaiting_mom). */
export async function createDraft(
  itemId: number,
  photos: { mime: string; data: Buffer }[],
  skipped: string[],
  deps: PipelineDeps,
): Promise<Item> {
  const item = (await repo.getItem(deps.db, itemId))!;
  try {
    const draft = await deps.draft({ title: item.details || item.title, priceCents: item.priceCents, photos });
    await repo.updateItemDraft(deps.db, itemId, { ...draft, skipped });
    const research = await deps.research({ details: item.details || item.title, draft });
    await repo.setItemResearch(deps.db, itemId, research);
    if (item.priceCents === null && research.suggestedCents !== null) {
      await repo.updateItemPrice(deps.db, itemId, research.suggestedCents);
    }
    await repo.setItemStatus(deps.db, itemId, 'awaiting_mom');
  } catch (e) {
    await repo.setItemResearch(deps.db, itemId, {
      suggestedCents: null,
      lowCents: null,
      highCents: null,
      confidence: 'low',
      comparables: [],
      reasoning: `Couldn't draft this listing: ${(e as Error).message}`,
    });
    await repo.setItemStatus(deps.db, itemId, 'error');
  }
  return changed(deps, itemId);
}

function missingAspects(draft: ListingDraft, required: string[]): string[] {
  const have = new Set(Object.keys(draft.aspects).map((k) => k.toLowerCase()));
  if (draft.brand) have.add('brand');
  return required.filter((r) => !have.has(r.toLowerCase()));
}

export type PostResult = 'live' | 'error' | 'busy' | 'blocked';

/** Posts an approved draft to eBay. Exactly one concurrent caller wins; the rest get 'busy'. */
export async function postItem(itemId: number, deps: PipelineDeps): Promise<PostResult> {
  const before = await repo.getItem(deps.db, itemId);
  if (!before) return 'busy';
  if (before.priceCents === null && ['awaiting_mom', 'error'].includes(before.status)) return 'blocked';
  if (!(await repo.transitionItemStatus(deps.db, itemId, ['awaiting_mom', 'error'], 'posting'))) return 'busy';
  const item = await changed(deps, itemId);

  const stored = readDraft(item);
  try {
    if (!stored) throw new Error("This listing doesn't have a draft yet.");
    const { draft } = stored;
    const { categoryId, requiredAspects } = await deps.ebay.suggestCategory(draft.categoryQuery);
    const missing = missingAspects(draft, requiredAspects);
    if (missing.length) {
      throw new EbayError(400, `eBay needs these item specifics: ${missing.join(', ')}. Tap Edit → Item specifics to add them.`, false);
    }
    const imageUrls: string[] = [];
    for (const path of item.photos) {
      const data = await deps.readPhoto(path);
      imageUrls.push(await deps.ebay.uploadImage({ mime: mimeFromPath(path), data, name: path.split('/').pop()! }));
    }
    const res = await deps.ebay.createListing({
      sku: `item-${item.id}`,
      priceCents: item.priceCents!,
      draft: { ...draft, title: truncateTitle(draft.title) },
      imageUrls,
      categoryId,
    });
    await repo.upsertListing(deps.db, itemId, 'ebay', { externalId: res.listingId, url: res.url, status: 'live', error: null });
    await repo.setItemStatus(deps.db, itemId, 'live');
    await changed(deps, itemId);
    return 'live';
  } catch (e) {
    const message = (e as Error).message;
    await repo.upsertListing(deps.db, itemId, 'ebay', { externalId: null, url: null, status: 'error', error: message });
    await repo.setItemStatus(deps.db, itemId, 'error');
    if (e instanceof EbayError && e.isAuth) {
      await deps.report(`eBay rejected the login while posting item #${itemId}: ${message}`);
    }
    await changed(deps, itemId);
    return 'error';
  }
}

export async function rejectItem(itemId: number, deps: PipelineDeps): Promise<boolean> {
  if (!(await repo.transitionItemStatus(deps.db, itemId, ['awaiting_mom', 'error'], 'rejected'))) return false;
  await changed(deps, itemId);
  return true;
}
