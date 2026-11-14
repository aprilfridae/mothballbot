import { describe, it, expect } from 'vitest';
import { createEbay, EbayError } from '../../../src/platforms/ebay/client.js';
import { createListing, suggestCategory, uploadImage } from '../../../src/platforms/ebay/listings.js';
import { fakeFetch, json, tokenResponse } from '../../helpers/fakeFetch.js';
import type { ListingDraft } from '../../../src/ai/draftListing.js';

const cfg = {
  clientId: 'id',
  clientSecret: 'secret',
  refreshToken: 'refresh',
  fulfillmentPolicyId: 'FP',
  paymentPolicyId: 'PP',
  returnPolicyId: 'RP',
  merchantLocationKey: 'home',
};

const draft: ListingDraft = {
  title: 'Nike Hoodie Mens L',
  description: 'Nice hoodie.',
  condition: 'USED_EXCELLENT',
  brand: 'Nike',
  aspects: { Size: ['L'] },
  categoryQuery: 'mens hoodie',
};

const listingRoutes = (publish = () => json({ listingId: '1234567890' })) =>
  [
    ['POST identity/v1/oauth2/token', () => tokenResponse()],
    ['PUT inventory_item/item-7', () => new Response(null, { status: 204 })],
    ['GET /sell/inventory/v1/offer?sku=item-7', () => json({ errors: [{ errorId: 25713, message: 'This Offer is not available.' }] }, 404)],
    ['POST /offer/OFF1/publish', publish],
    ['POST /sell/inventory/v1/offer', () => json({ offerId: 'OFF1' }, 201)],
  ] as Array<[string, any]>;

const item = { sku: 'item-7', priceCents: 3500, draft, imageUrls: ['https://i.ebayimg.com/1.jpg'], categoryId: '155183' };

describe('createListing', () => {
  it('creates the inventory item, offer and publishes it in order', async () => {
    const f = fakeFetch(listingRoutes());
    const ebay = createEbay(cfg, f.fetch);
    const res = await createListing(ebay, cfg, item);
    expect(res).toEqual({ listingId: '1234567890', url: 'https://www.ebay.com/itm/1234567890' });
    expect(f.calls.map((c) => c.method + ' ' + new URL(c.url).pathname)).toEqual([
      'POST /identity/v1/oauth2/token',
      'PUT /sell/inventory/v1/inventory_item/item-7',
      'GET /sell/inventory/v1/offer',
      'POST /sell/inventory/v1/offer',
      'POST /sell/inventory/v1/offer/OFF1/publish',
    ]);
    const inv = f.calls[1].body;
    expect(inv.condition).toBe('USED_EXCELLENT');
    expect(inv.product.title).toBe('Nike Hoodie Mens L');
    expect(inv.product.aspects).toEqual({ Size: ['L'], Brand: ['Nike'] });
    expect(inv.product.imageUrls).toEqual(['https://i.ebayimg.com/1.jpg']);
    const offer = f.calls[3].body;
    expect(offer.pricingSummary.price).toEqual({ value: '35.00', currency: 'USD' });
    expect(offer.listingPolicies).toEqual({ fulfillmentPolicyId: 'FP', paymentPolicyId: 'PP', returnPolicyId: 'RP' });
    expect(offer.merchantLocationKey).toBe('home');
    expect(offer.format).toBe('FIXED_PRICE');
    expect(offer.marketplaceId).toBe('EBAY_US');
    expect(offer.categoryId).toBe('155183');
    expect(f.calls[1].headers['authorization']).toBe('Bearer tok');
    expect(f.calls[1].headers['content-language']).toBe('en-US');
  });

  it('updates the existing offer instead of creating a duplicate when retrying', async () => {
    const f = fakeFetch([
      ['POST identity/v1/oauth2/token', () => tokenResponse()],
      ['PUT inventory_item/item-7', () => new Response(null, { status: 204 })],
      ['GET /sell/inventory/v1/offer?sku=item-7', () => json({ offers: [{ offerId: 'OFF1' }] })],
      ['PUT /sell/inventory/v1/offer/OFF1', () => new Response(null, { status: 204 })],
      ['POST /offer/OFF1/publish', () => json({ listingId: '1234567890' })],
    ]);
    await createListing(createEbay(cfg, f.fetch), cfg, item);
    expect(f.calls.some((c) => c.method === 'POST' && c.url.endsWith('/sell/inventory/v1/offer'))).toBe(false);
    expect(f.calls.find((c) => c.method === 'PUT' && c.url.includes('/offer/OFF1'))?.body.pricingSummary.price.value).toBe('35.00');
  });

  it('uses the category-specific condition when given', async () => {
    const f = fakeFetch(listingRoutes());
    await createListing(createEbay(cfg, f.fetch), cfg, { ...item, ebayCondition: 'PRE_OWNED_EXCELLENT' });
    expect(f.calls[1].body.condition).toBe('PRE_OWNED_EXCELLENT');
  });

  it('reuses the access token while it is valid', async () => {
    const f = fakeFetch(listingRoutes());
    const ebay = createEbay(cfg, f.fetch);
    await createListing(ebay, cfg, item);
    await createListing(ebay, cfg, item);
    expect(f.calls.filter((c) => c.url.includes('oauth2/token'))).toHaveLength(1);
  });

  it("surfaces eBay's error message when publishing fails", async () => {
    const f = fakeFetch(
      listingRoutes(() => json({ errors: [{ errorId: 25002, message: 'Item specific Brand is missing' }] }, 400)),
    );
    const err = await createListing(createEbay(cfg, f.fetch), cfg, item).catch((e) => e);
    expect(err).toBeInstanceOf(EbayError);
    expect(err.message).toBe('Item specific Brand is missing');
    expect(err.isAuth).toBe(false);
  });

  it('flags an expired refresh token as an auth error', async () => {
    const f = fakeFetch([
      ['POST identity/v1/oauth2/token', () => json({ error: 'invalid_grant', error_description: 'expired' }, 400)],
    ]);
    const err = await createListing(createEbay(cfg, f.fetch), cfg, item).catch((e) => e);
    expect(err).toBeInstanceOf(EbayError);
    expect(err.isAuth).toBe(true);
  });

  it('refreshes the token once and retries on a 401', async () => {
    let first = true;
    const f = fakeFetch([
      ['POST identity/v1/oauth2/token', () => tokenResponse()],
      [
        'PUT inventory_item/item-7',
        () => {
          if (first) {
            first = false;
            return json({ errors: [{ message: 'Invalid access token' }] }, 401);
          }
          return new Response(null, { status: 204 });
        },
      ],
      ...listingRoutes().slice(2),
    ]);
    const res = await createListing(createEbay(cfg, f.fetch), cfg, item);
    expect(res.listingId).toBe('1234567890');
    expect(f.calls.filter((c) => c.url.includes('oauth2/token'))).toHaveLength(2);
  });
});

describe('suggestCategory', () => {
  it('returns the first suggestion and its required aspect names', async () => {
    const f = fakeFetch([
      ['POST identity/v1/oauth2/token', () => tokenResponse()],
      [
        'GET get_category_suggestions',
        () => json({ categorySuggestions: [{ category: { categoryId: '155183' } }, { category: { categoryId: '1' } }] }),
      ],
      [
        'GET get_item_condition_policies',
        () => json({ itemConditionPolicies: [{ categoryId: '155183', itemConditions: [{ conditionId: '1000', conditionDescription: 'New' }] }] }),
      ],
      [
        'GET get_item_aspects_for_category',
        () =>
          json({
            aspects: [
              { localizedAspectName: 'Brand', aspectConstraint: { aspectRequired: true } },
              { localizedAspectName: 'Size', aspectConstraint: { aspectRequired: true } },
              { localizedAspectName: 'Color', aspectConstraint: { aspectRequired: false } },
            ],
          }),
      ],
    ]);
    const res = await suggestCategory(createEbay(cfg, f.fetch), 'mens hoodie');
    expect(res).toEqual({ categoryId: '155183', requiredAspects: ['Brand', 'Size'], conditions: [{ conditionId: '1000', conditionDescription: 'New' }] });
    expect(f.calls[1].url).toContain('/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=mens+hoodie');
  });
});

describe('uploadImage', () => {
  it('uploads to eBay Picture Services and returns the hosted URL', async () => {
    const f = fakeFetch([
      ['POST identity/v1/oauth2/token', () => tokenResponse()],
      [
        'POST create_image_from_file',
        () =>
          new Response(null, {
            status: 201,
            headers: { location: 'https://apim.ebay.com/commerce/media/v1_beta/image/IMG1' },
          }),
      ],
      ['GET /commerce/media/v1_beta/image/IMG1', () => json({ imageUrl: 'https://i.ebayimg.com/IMG1.jpg' })],
    ]);
    const url = await uploadImage(createEbay(cfg, f.fetch), { mime: 'image/jpeg', data: Buffer.from('x'), name: 'a.jpg' });
    expect(url).toBe('https://i.ebayimg.com/IMG1.jpg');
    expect(f.calls[1].body).toBeInstanceOf(FormData);
  });
});

describe('suggestCategory without condition data', () => {
  it('still works when the condition lookup fails', async () => {
    const f = fakeFetch([
      ['POST identity/v1/oauth2/token', () => tokenResponse()],
      ['GET get_category_suggestions', () => json({ categorySuggestions: [{ category: { categoryId: '5' } }] })],
      ['GET get_item_condition_policies', () => json({ errors: [{ message: 'nope' }] }, 403)],
      ['GET get_item_aspects_for_category', () => json({ aspects: [] })],
    ]);
    expect(await suggestCategory(createEbay(cfg, f.fetch), 'x')).toEqual({ categoryId: '5', requiredAspects: [], conditions: null });
  });
});
