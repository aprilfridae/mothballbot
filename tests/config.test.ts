import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const full = {
  DATABASE_URL: 'postgres://x',
  DISCORD_TOKEN: 't',
  OWNER_DISCORD_ID: '1',
  CHANNEL_NEW_LISTING: '2',
  CHANNEL_BUYERS: '3',
  CHANNEL_SALES: '4',
  CHANNEL_TO_SHIP: '5',
  CHANNEL_BOT_STATUS: '6',
  EBAY_CLIENT_ID: 'a',
  EBAY_CLIENT_SECRET: 'b',
  EBAY_REFRESH_TOKEN: 'c',
  EBAY_FULFILLMENT_POLICY_ID: 'f',
  EBAY_PAYMENT_POLICY_ID: 'p',
  EBAY_RETURN_POLICY_ID: 'r',
  EBAY_MERCHANT_LOCATION_KEY: 'home',
  ANTHROPIC_API_KEY: 'k',
  TELEGRAM_TOKEN: 'tg',
  MOM_LINK_CODE: 'code123',
};

describe('loadConfig', () => {
  it('lists every missing key', () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN[\s\S]*EBAY_REFRESH_TOKEN|EBAY_REFRESH_TOKEN[\s\S]*DISCORD_TOKEN/);
  });

  it('maps env into a typed config with a default photo dir', () => {
    const c = loadConfig(full);
    expect(c.channels.buyers).toBe('3');
    expect(c.ebay.merchantLocationKey).toBe('home');
    expect(c.photoDir).toBe('/data/photos');
  });
});
