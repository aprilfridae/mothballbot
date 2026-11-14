import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const core = {
  DATABASE_URL: 'postgres://x',
  DISCORD_TOKEN: 't',
  ANTHROPIC_API_KEY: 'k',
  TELEGRAM_TOKEN: 'tg',
  MOM_LINK_CODE: 'code123',
};

const ebay = {
  EBAY_CLIENT_ID: 'a',
  EBAY_CLIENT_SECRET: 'b',
  EBAY_REFRESH_TOKEN: 'c',
  EBAY_FULFILLMENT_POLICY_ID: 'f',
  EBAY_PAYMENT_POLICY_ID: 'p',
  EBAY_RETURN_POLICY_ID: 'r',
  EBAY_MERCHANT_LOCATION_KEY: 'home',
  EBAY_USERNAME: 'mothball_shop',
};

const channels = {
  OWNER_DISCORD_ID: '1',
  CHANNEL_NEW_LISTING: '2',
  CHANNEL_BUYERS: '3',
  CHANNEL_SALES: '4',
  CHANNEL_TO_SHIP: '5',
  CHANNEL_BOT_STATUS: '6',
};

describe('loadConfig', () => {
  it('lists every missing required key', () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN[\s\S]*TELEGRAM_TOKEN/);
  });

  it('maps a full env into a typed config with a default photo dir', () => {
    const c = loadConfig({ ...core, ...ebay, ...channels });
    expect(c.channels.buyers).toBe('3');
    expect(c.ebay?.merchantLocationKey).toBe('home');
    expect(c.ebay?.username).toBe('mothball_shop');
    expect(c.photoDir).toBe('/data/photos');
  });

  it('runs without eBay until the developer account is approved', () => {
    const c = loadConfig(core);
    expect(c.ebay).toBeNull();
  });

  it('refuses a half-filled eBay section and names what is missing', () => {
    expect(() => loadConfig({ ...core, EBAY_CLIENT_ID: 'a', EBAY_CLIENT_SECRET: 'b' })).toThrow(/EBAY_REFRESH_TOKEN/);
  });

  it('leaves owner and channels empty so the bot can set them up itself', () => {
    const c = loadConfig(core);
    expect(c.ownerDiscordId).toBe('');
    expect(c.channels).toEqual({ newListing: '', buyers: '', sales: '', toShip: '', botStatus: '' });
  });
});
