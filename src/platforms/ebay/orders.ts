import type { PlatformOrder } from '../types.js';
import { API, type EbayClient } from './client.js';

const BASE = `${API}/sell/fulfillment/v1`;

function mapOrder(o: any): PlatformOrder {
  const shipTo = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
  const addr = shipTo?.contactAddress;
  const shipByRaw = o.lineItems?.find((l: any) => l.lineItemFulfillmentInstructions?.shipByDate)?.lineItemFulfillmentInstructions
    ?.shipByDate;
  return {
    externalId: o.orderId,
    itemTitle: (o.lineItems ?? []).map((l: any) => l.title).join(', ') || 'eBay order',
    buyer: o.buyer?.username ?? 'unknown buyer',
    shipTo: addr
      ? {
          name: shipTo.fullName ?? '',
          line1: addr.addressLine1 ?? '',
          ...(addr.addressLine2 ? { line2: addr.addressLine2 } : {}),
          city: addr.city ?? '',
          state: addr.stateOrProvince ?? '',
          postalCode: addr.postalCode ?? '',
        }
      : null,
    localPickup: !addr,
    shipBy: shipByRaw ? new Date(shipByRaw) : null,
    lineItemIds: (o.lineItems ?? []).map((l: any) => l.lineItemId),
  };
}

export async function fetchNewOrders(ebay: EbayClient, since: Date): Promise<PlatformOrder[]> {
  const filter = `creationdate:[${since.toISOString()}..]`;
  const res = await ebay.request('GET', `${BASE}/order?${new URLSearchParams({ filter, limit: '50' })}`);
  return (res?.orders ?? [])
    .filter((o: any) => o.cancelStatus?.cancelState !== 'CANCELED')
    .map(mapOrder);
}

/** Marks the order shipped on eBay (the buyer gets notified); tracking is added when known. */
export async function createFulfillment(
  ebay: EbayClient,
  order: { externalId: string; lineItemIds: string[] },
  tracking: string | null,
  carrier: string | null,
): Promise<void> {
  await ebay.request('POST', `${BASE}/order/${encodeURIComponent(order.externalId)}/shipping_fulfillment`, {
    lineItems: order.lineItemIds.map((lineItemId) => ({ lineItemId, quantity: 1 })),
    shippedDate: new Date().toISOString(),
    ...(tracking && carrier ? { shippingCarrierCode: carrier, trackingNumber: tracking } : {}),
  });
}
