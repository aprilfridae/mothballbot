import { describe, it, expect } from 'vitest';
import { createEbay } from '../../src/platforms/ebay/client.js';
import { listPolicies, ensureLocation } from '../../src/tools/ebaySetup.js';
import { fakeFetch, json, tokenResponse } from '../helpers/fakeFetch.js';

const creds = { clientId: 'id', clientSecret: 's', refreshToken: 'r' };

describe('ebay setup helper', () => {
  it('lists fulfillment, payment and return policies with their ids', async () => {
    const f = fakeFetch([
      ['POST oauth2/token', () => tokenResponse()],
      ['GET fulfillment_policy', () => json({ fulfillmentPolicies: [{ fulfillmentPolicyId: 'F1', name: 'USPS Ground' }] })],
      ['GET payment_policy', () => json({ paymentPolicies: [{ paymentPolicyId: 'P1', name: 'Managed' }] })],
      ['GET return_policy', () => json({ returnPolicies: [{ returnPolicyId: 'R1', name: '30 days' }] })],
    ]);
    expect(await listPolicies(createEbay(creds, f.fetch))).toEqual({
      fulfillment: [{ id: 'F1', name: 'USPS Ground' }],
      payment: [{ id: 'P1', name: 'Managed' }],
      return: [{ id: 'R1', name: '30 days' }],
    });
    expect(f.calls[1].url).toContain('marketplace_id=EBAY_US');
  });

  it('creates the inventory location only when it does not exist yet', async () => {
    const created: any[] = [];
    let exists = false;
    const f = fakeFetch([
      ['POST oauth2/token', () => tokenResponse()],
      ['GET /sell/inventory/v1/location/home', () => (exists ? json({ merchantLocationKey: 'home' }) : json({ errors: [{ message: 'not found' }] }, 404))],
      ['POST /sell/inventory/v1/location/home', (c) => (created.push(c.body), new Response(null, { status: 204 }))],
    ]);
    const ebay = createEbay(creds, f.fetch);
    expect(await ensureLocation(ebay, 'home', { city: 'San Jose', stateOrProvince: 'CA', postalCode: '95112' })).toBe('created');
    expect(created[0]).toMatchObject({
      location: { address: { city: 'San Jose', stateOrProvince: 'CA', postalCode: '95112', country: 'US' } },
      merchantLocationStatus: 'ENABLED',
      locationTypes: ['WAREHOUSE'],
    });
    exists = true;
    expect(await ensureLocation(ebay, 'home', { city: 'San Jose', stateOrProvince: 'CA', postalCode: '95112' })).toBe('exists');
    expect(created).toHaveLength(1);
  });
});
