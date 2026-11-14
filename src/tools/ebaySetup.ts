/**
 * One-time eBay setup helper. Run inside the app container:
 *   docker compose run --rm app node dist/tools/ebaySetup.js 95112 "San Jose" CA
 * It prints your business policy IDs (copy them into .env) and creates the "ship from" location.
 */
import { API, EbayError, createEbay, type EbayClient } from '../platforms/ebay/client.js';

export async function listPolicies(ebay: EbayClient) {
  const q = 'marketplace_id=EBAY_US';
  const [f, p, r] = await Promise.all([
    ebay.request('GET', `${API}/sell/account/v1/fulfillment_policy?${q}`),
    ebay.request('GET', `${API}/sell/account/v1/payment_policy?${q}`),
    ebay.request('GET', `${API}/sell/account/v1/return_policy?${q}`),
  ]);
  return {
    fulfillment: (f?.fulfillmentPolicies ?? []).map((x: any) => ({ id: x.fulfillmentPolicyId, name: x.name })),
    payment: (p?.paymentPolicies ?? []).map((x: any) => ({ id: x.paymentPolicyId, name: x.name })),
    return: (r?.returnPolicies ?? []).map((x: any) => ({ id: x.returnPolicyId, name: x.name })),
  };
}

export async function ensureLocation(
  ebay: EbayClient,
  key: string,
  address: { city: string; stateOrProvince: string; postalCode: string },
): Promise<'created' | 'exists'> {
  const url = `${API}/sell/inventory/v1/location/${encodeURIComponent(key)}`;
  try {
    await ebay.request('GET', url);
    return 'exists';
  } catch (e) {
    if (!(e instanceof EbayError) || e.status !== 404) throw e;
  }
  await ebay.request('POST', url, {
    location: { address: { ...address, country: 'US' } },
    locationTypes: ['WAREHOUSE'],
    merchantLocationStatus: 'ENABLED',
    name: 'Home',
  });
  return 'created';
}

async function cli() {
  const [postalCode, city, stateOrProvince] = process.argv.slice(2);
  const env = process.env;
  const missing = ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_REFRESH_TOKEN', 'EBAY_MERCHANT_LOCATION_KEY'].filter((k) => !env[k]);
  if (missing.length || !postalCode || !city || !stateOrProvince) {
    console.error(`Usage: node dist/tools/ebaySetup.js <zip> <city> <state>\nNeeds in .env: ${missing.join(', ') || 'ok'}`);
    process.exit(1);
  }
  const ebay = createEbay({
    clientId: env.EBAY_CLIENT_ID!,
    clientSecret: env.EBAY_CLIENT_SECRET!,
    refreshToken: env.EBAY_REFRESH_TOKEN!,
  });
  const policies = await listPolicies(ebay);
  for (const [kind, list] of Object.entries(policies)) {
    console.log(`\n${kind} policies:`);
    for (const p of list) console.log(`  ${p.id}  ${p.name}`);
    if (!list.length) console.log('  (none — create one in Seller Hub → Account → Business policies)');
  }
  const r = await ensureLocation(ebay, env.EBAY_MERCHANT_LOCATION_KEY!, { postalCode, city, stateOrProvince });
  console.log(`\nShip-from location "${env.EBAY_MERCHANT_LOCATION_KEY}": ${r}`);
}

if (process.argv[1]?.endsWith('ebaySetup.js')) {
  cli().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
