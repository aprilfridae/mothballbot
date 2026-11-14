export interface Config {
  databaseUrl: string;
  discordToken: string;
  ownerDiscordId: string;
  channels: { newListing: string; buyers: string; sales: string; toShip: string; botStatus: string };
  /** null until the eBay developer account is approved and its keys are filled in. */
  ebay: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
    merchantLocationKey: string;
    username: string;
  } | null;
  anthropicApiKey: string;
  telegramToken: string;
  momLinkCode: string;
  photoDir: string;
}

export type EbayConfig = NonNullable<Config['ebay']>;

const REQUIRED = ['DATABASE_URL', 'DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'TELEGRAM_TOKEN', 'MOM_LINK_CODE'] as const;

const EBAY_KEYS = [
  'EBAY_CLIENT_ID',
  'EBAY_CLIENT_SECRET',
  'EBAY_REFRESH_TOKEN',
  'EBAY_FULFILLMENT_POLICY_ID',
  'EBAY_PAYMENT_POLICY_ID',
  'EBAY_RETURN_POLICY_ID',
  'EBAY_MERCHANT_LOCATION_KEY',
  'EBAY_USERNAME',
] as const;

/**
 * Owner and channel IDs are optional: when left empty, the bot uses the Discord server's owner and finds or
 * creates its channels by name. eBay is optional as a whole, so everything else can run while approval is pending.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const has = (k: string) => Boolean(env[k]?.trim());
  const get = (k: string) => env[k]?.trim() ?? '';
  const missing: string[] = REQUIRED.filter((k) => !has(k));
  const ebaySet = EBAY_KEYS.filter(has);
  if (ebaySet.length && ebaySet.length < EBAY_KEYS.length) missing.push(...EBAY_KEYS.filter((k) => !has(k)));
  if (missing.length) {
    throw new Error(`Missing required settings in .env: ${missing.join(', ')}`);
  }
  return {
    databaseUrl: get('DATABASE_URL'),
    discordToken: get('DISCORD_TOKEN'),
    ownerDiscordId: get('OWNER_DISCORD_ID'),
    channels: {
      newListing: get('CHANNEL_NEW_LISTING'),
      buyers: get('CHANNEL_BUYERS'),
      sales: get('CHANNEL_SALES'),
      toShip: get('CHANNEL_TO_SHIP'),
      botStatus: get('CHANNEL_BOT_STATUS'),
    },
    ebay: ebaySet.length
      ? {
          clientId: get('EBAY_CLIENT_ID'),
          clientSecret: get('EBAY_CLIENT_SECRET'),
          refreshToken: get('EBAY_REFRESH_TOKEN'),
          fulfillmentPolicyId: get('EBAY_FULFILLMENT_POLICY_ID'),
          paymentPolicyId: get('EBAY_PAYMENT_POLICY_ID'),
          returnPolicyId: get('EBAY_RETURN_POLICY_ID'),
          merchantLocationKey: get('EBAY_MERCHANT_LOCATION_KEY'),
          username: get('EBAY_USERNAME'),
        }
      : null,
    anthropicApiKey: get('ANTHROPIC_API_KEY'),
    telegramToken: get('TELEGRAM_TOKEN'),
    momLinkCode: get('MOM_LINK_CODE'),
    photoDir: get('PHOTO_DIR') || '/data/photos',
  };
}
