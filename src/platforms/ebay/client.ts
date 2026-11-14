import { createTokenSource, type EbayCreds } from './auth.js';
import { EbayError } from './errors.js';

export { EbayError } from './errors.js';

export const API = 'https://api.ebay.com';
export const MEDIA_API = 'https://apim.ebay.com/commerce/media/v1_beta';

export interface EbayClient {
  /** JSON request; returns parsed body (or null for empty responses). */
  request(method: string, url: string, body?: unknown): Promise<any>;
  /** Raw request with auth; caller owns body/headers. Returns the Response for header access. */
  raw(method: string, url: string, init?: { body?: BodyInit; headers?: Record<string, string> }): Promise<Response>;
}

async function errorFrom(res: Response): Promise<EbayError> {
  const data: any = await res.json().catch(() => null);
  const msg =
    data?.errors?.[0]?.longMessage ||
    data?.errors?.[0]?.message ||
    data?.error_description ||
    `eBay request failed (${res.status})`;
  return new EbayError(res.status, msg, res.status === 401);
}

export function createEbay(creds: EbayCreds, fetchFn: typeof fetch = fetch): EbayClient {
  const tokens = createTokenSource(creds, fetchFn);

  async function raw(method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await tokens.get();
      const res = await fetchFn(url, {
        method,
        body: init.body,
        headers: { authorization: `Bearer ${token}`, ...init.headers },
      });
      if (res.status === 401 && attempt === 0) {
        tokens.invalidate();
        continue;
      }
      if (!res.ok) throw await errorFrom(res);
      return res;
    }
    throw new EbayError(401, 'eBay rejected the login token', true);
  }

  return {
    raw,
    async request(method, url, body) {
      const res = await raw(method, url, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          'content-type': 'application/json',
          'content-language': 'en-US',
          'accept-language': 'en-US',
          'x-ebay-c-marketplace-id': 'EBAY_US',
        },
      });
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    },
  };
}
