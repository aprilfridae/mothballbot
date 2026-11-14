import type { Platform, ShipTo } from '../db/repo.js';

export type { Platform } from '../db/repo.js';

export const PLATFORM_LABEL: Record<Platform, string> = { ebay: 'eBay', etsy: 'Etsy', facebook: 'FB' };

export interface PlatformMessage {
  conversationExternalId: string;
  messageExternalId: string;
  buyerUsername: string;
  body: string;
  sentAt: Date;
  item: { title: string; url: string | null } | null;
}

export interface PlatformOrder {
  externalId: string;
  itemTitle: string;
  buyer: string;
  shipTo: ShipTo | null;
  localPickup: boolean;
  shipBy: Date | null;
  lineItemIds: string[];
}

/** What every marketplace connector provides. Etsy and Facebook implement this in later parts. */
export interface PlatformConnector {
  platform: Platform;
  fetchNewMessages(since: Date): Promise<PlatformMessage[]>;
  sendReply(conversationExternalId: string, text: string): Promise<string | null>;
  fetchNewOrders(since: Date): Promise<PlatformOrder[]>;
  uploadTracking?(order: { externalId: string; lineItemIds: string[] }, tracking: string, carrier: string): Promise<void>;
}
