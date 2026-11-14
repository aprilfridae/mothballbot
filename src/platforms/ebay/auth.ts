import type { Config } from '../../config.js';
import { EbayError } from './errors.js';

export const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

/** OAuth scopes the refresh token must have been granted (see README for how to mint it). */
export const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/commerce.message',
];

export type EbayCreds = Pick<Config['ebay'], 'clientId' | 'clientSecret' | 'refreshToken'>;

export function createTokenSource(creds: EbayCreds, fetchFn: typeof fetch) {
  let cached: { token: string; expiresAt: number } | null = null;

  async function refresh(): Promise<string> {
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        scope: SCOPES.join(' '),
      }).toString(),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const msg = data.error_description || data.error || `eBay login failed (${res.status})`;
      throw new EbayError(res.status, `eBay login failed: ${msg}`, true);
    }
    cached = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) - 60) * 1000 };
    return cached.token;
  }

  let inFlight: Promise<string> | null = null;

  return {
    async get(): Promise<string> {
      if (cached && Date.now() < cached.expiresAt) return cached.token;
      // Concurrent callers share one refresh instead of each minting a token.
      inFlight ??= refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    invalidate() {
      cached = null;
    },
  };
}
