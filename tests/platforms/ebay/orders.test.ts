import { describe, it, expect } from 'vitest';
import { createEbay } from '../../../src/platforms/ebay/client.js';
import { fetchNewOrders, createFulfillment } from '../../../src/platforms/ebay/orders.js';
import { fakeFetch, json, tokenResponse } from '../../helpers/fakeFetch.js';

const creds = { clientId: 'id', clientSecret: 's', refreshToken: 'r' };

const shipped = {
  orderId: '12-34567-89012',
  buyer: { username: 'sam_92' },
  lineItems: [
    { lineItemId: 'L1', sku: 'item-7', title: 'Nike Hoodie Mens L', lineItemFulfillmentInstructions: { shipByDate: '2026-11-16T07:59:59.000Z' } },
  ],
  fulfillmentStartInstructions: [
    {
      shippingStep: {
        shipTo: {
          fullName: 'Sam Smith',
          contactAddress: {
            addressLine1: '123 Main St',
            addressLine2: 'Apt 4',
            city: 'Springfield',
            stateOrProvince: 'IL',
            postalCode: '62701',
            countryCode: 'US',
          },
        },
      },
    },
  ],
};

describe('fetchNewOrders', () => {
  it('maps orders created since the cursor, including the shipping address', async () => {
    const pickup = { ...shipped, orderId: 'P1', fulfillmentStartInstructions: [{ fulfillmentInstructionsType: 'PREPARE_FOR_PICKUP' }] };
    const cancelled = { ...shipped, orderId: 'X1', cancelStatus: { cancelState: 'CANCELED' } };
    const done = { ...shipped, orderId: 'F1', orderFulfillmentStatus: 'FULFILLED' };
    const f = fakeFetch([
      ['POST oauth2/token', () => tokenResponse()],
      ['GET /sell/fulfillment/v1/order', () => json({ orders: [shipped, pickup, cancelled, done] })],
    ]);
    const orders = await fetchNewOrders(createEbay(creds, f.fetch), new Date('2026-11-13T00:00:00Z'));
    expect(decodeURIComponent(f.calls[1].url)).toContain('filter=creationdate:[2026-11-13T00:00:00.000Z..]');
    expect(orders).toEqual([
      {
        externalId: '12-34567-89012',
        itemTitle: 'Nike Hoodie Mens L',
        buyer: 'sam_92',
        shipTo: { name: 'Sam Smith', line1: '123 Main St', line2: 'Apt 4', city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US' },
        localPickup: false,
        shipBy: new Date('2026-11-16T07:59:59.000Z'),
        lineItemIds: ['L1'],
        sku: 'item-7',
      },
      expect.objectContaining({ externalId: 'P1', localPickup: true, shipTo: null }),
    ]);
  });
});

describe('createFulfillment', () => {
  it('creates a shipping fulfillment with tracking for every line item', async () => {
    const f = fakeFetch([
      ['POST oauth2/token', () => tokenResponse()],
      ['POST /shipping_fulfillment', () => json(null, 201)],
    ]);
    await createFulfillment(createEbay(creds, f.fetch), { externalId: '12-34567-89012', lineItemIds: ['L1'] }, '1Z999AA10123456784', 'UPS');
    expect(f.calls[1].url).toContain('/sell/fulfillment/v1/order/12-34567-89012/shipping_fulfillment');
    expect(f.calls[1].body).toMatchObject({
      lineItems: [{ lineItemId: 'L1', quantity: 1 }],
      shippingCarrierCode: 'UPS',
      trackingNumber: '1Z999AA10123456784',
    });
  });

  it('marks shipped without tracking fields when there is no tracking', async () => {
    const f = fakeFetch([
      ['POST oauth2/token', () => tokenResponse()],
      ['POST /shipping_fulfillment', () => json(null, 201)],
    ]);
    await createFulfillment(createEbay(creds, f.fetch), { externalId: 'O1', lineItemIds: ['L1'] }, null, null);
    expect(f.calls[1].body.lineItems).toEqual([{ lineItemId: 'L1', quantity: 1 }]);
    expect(f.calls[1].body).not.toHaveProperty('trackingNumber');
    expect(f.calls[1].body).not.toHaveProperty('shippingCarrierCode');
  });
});
