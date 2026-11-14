import type { ListingDraft } from '../../ai/draftListing.js';
import type { Config } from '../../config.js';
import { API, MEDIA_API, EbayError, type EbayClient } from './client.js';

export async function uploadImage(ebay: EbayClient, file: { mime: string; data: Buffer; name: string }): Promise<string> {
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(file.data)], { type: file.mime }), file.name);
  const res = await ebay.raw('POST', `${MEDIA_API}/image/create_image_from_file`, { body: form });
  const location = res.headers.get('location');
  if (!location) throw new EbayError(res.status, 'eBay did not return an image ID for the upload', false);
  const image = await ebay.request('GET', location);
  if (!image?.imageUrl) throw new EbayError(200, 'eBay did not return a URL for the uploaded image', false);
  return image.imageUrl;
}

export async function suggestCategory(
  ebay: EbayClient,
  query: string,
): Promise<{ categoryId: string; requiredAspects: string[] }> {
  const base = `${API}/commerce/taxonomy/v1/category_tree/0`;
  const sugg = await ebay.request('GET', `${base}/get_category_suggestions?${new URLSearchParams({ q: query })}`);
  const categoryId: string | undefined = sugg?.categorySuggestions?.[0]?.category?.categoryId;
  if (!categoryId) throw new EbayError(200, `eBay had no category for "${query}"`, false);
  const aspects = await ebay.request(
    'GET',
    `${base}/get_item_aspects_for_category?${new URLSearchParams({ category_id: categoryId })}`,
  );
  const requiredAspects = (aspects?.aspects ?? [])
    .filter((a: any) => a?.aspectConstraint?.aspectRequired)
    .map((a: any) => a.localizedAspectName as string);
  return { categoryId, requiredAspects };
}

async function findOfferId(ebay: EbayClient, sku: string): Promise<string | null> {
  try {
    const res = await ebay.request('GET', `${API}/sell/inventory/v1/offer?${new URLSearchParams({ sku })}`);
    return res?.offers?.[0]?.offerId ?? null;
  } catch (e) {
    if (e instanceof EbayError && e.status === 404) return null;
    throw e;
  }
}

export interface EbayListingInput {
  sku: string;
  priceCents: number;
  draft: ListingDraft;
  imageUrls: string[];
  categoryId: string;
}

export async function createListing(
  ebay: EbayClient,
  cfg: Config['ebay'],
  item: EbayListingInput,
): Promise<{ listingId: string; url: string }> {
  const { draft } = item;
  const aspects: Record<string, string[]> = { ...draft.aspects };
  if (draft.brand && !aspects.Brand) aspects.Brand = [draft.brand];

  await ebay.request('PUT', `${API}/sell/inventory/v1/inventory_item/${encodeURIComponent(item.sku)}`, {
    availability: { shipToLocationAvailability: { quantity: 1 } },
    condition: draft.condition,
    product: {
      title: draft.title,
      description: draft.description,
      aspects,
      imageUrls: item.imageUrls,
    },
  });

  const offerBody = {
    sku: item.sku,
    marketplaceId: 'EBAY_US',
    format: 'FIXED_PRICE',
    availableQuantity: 1,
    categoryId: item.categoryId,
    listingDescription: draft.description,
    listingPolicies: {
      fulfillmentPolicyId: cfg.fulfillmentPolicyId,
      paymentPolicyId: cfg.paymentPolicyId,
      returnPolicyId: cfg.returnPolicyId,
    },
    merchantLocationKey: cfg.merchantLocationKey,
    pricingSummary: { price: { value: (item.priceCents / 100).toFixed(2), currency: 'USD' } },
  };

  // A retry after a failed publish must update the offer already created for this SKU, not make a second one.
  const existingId = await findOfferId(ebay, item.sku);
  let offerId: string;
  if (existingId) {
    await ebay.request('PUT', `${API}/sell/inventory/v1/offer/${existingId}`, offerBody);
    offerId = existingId;
  } else {
    offerId = (await ebay.request('POST', `${API}/sell/inventory/v1/offer`, offerBody)).offerId;
  }

  const published = await ebay.request('POST', `${API}/sell/inventory/v1/offer/${offerId}/publish`);
  return { listingId: published.listingId, url: `https://www.ebay.com/itm/${published.listingId}` };
}
