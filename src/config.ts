export interface Config {
  databaseUrl: string;
  discordToken: string;
  ownerDiscordId: string;
  channels: { newListing: string; buyers: string; sales: string; toShip: string; botStatus: string };
  ebay: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
    merchantLocationKey: string;
  };
  anthropicApiKey: string;
  telegramToken: string;
  momLinkCode: string;
  photoDir: string;
}

const REQUIRED = [
  'DATABASE_URL',
  'DISCORD_TOKEN',
  'OWNER_DISCORD_ID',
  'CHANNEL_NEW_LISTING',
  'CHANNEL_BUYERS',
  'CHANNEL_SALES',
  'CHANNEL_TO_SHIP',
  'CHANNEL_BOT_STATUS',
  'EBAY_CLIENT_ID',
  'EBAY_CLIENT_SECRET',
  'EBAY_REFRESH_TOKEN',
  'EBAY_FULFILLMENT_POLICY_ID',
  'EBAY_PAYMENT_POLICY_ID',
  'EBAY_RETURN_POLICY_ID',
  'EBAY_MERCHANT_LOCATION_KEY',
  'ANTHROPIC_API_KEY',
  'TELEGRAM_TOKEN',
  'MOM_LINK_CODE',
] as const;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length) {
    throw new Error(`Missing required settings in .env: ${missing.join(', ')}`);
  }
  const e = (k: (typeof REQUIRED)[number]) => env[k]!.trim();
  return {
    databaseUrl: e('DATABASE_URL'),
    discordToken: e('DISCORD_TOKEN'),
    ownerDiscordId: e('OWNER_DISCORD_ID'),
    channels: {
      newListing: e('CHANNEL_NEW_LISTING'),
      buyers: e('CHANNEL_BUYERS'),
      sales: e('CHANNEL_SALES'),
      toShip: e('CHANNEL_TO_SHIP'),
      botStatus: e('CHANNEL_BOT_STATUS'),
    },
    ebay: {
      clientId: e('EBAY_CLIENT_ID'),
      clientSecret: e('EBAY_CLIENT_SECRET'),
      refreshToken: e('EBAY_REFRESH_TOKEN'),
      fulfillmentPolicyId: e('EBAY_FULFILLMENT_POLICY_ID'),
      paymentPolicyId: e('EBAY_PAYMENT_POLICY_ID'),
      returnPolicyId: e('EBAY_RETURN_POLICY_ID'),
      merchantLocationKey: e('EBAY_MERCHANT_LOCATION_KEY'),
    },
    anthropicApiKey: e('ANTHROPIC_API_KEY'),
    telegramToken: e('TELEGRAM_TOKEN'),
    momLinkCode: e('MOM_LINK_CODE'),
    photoDir: env.PHOTO_DIR?.trim() || '/data/photos',
  };
}
