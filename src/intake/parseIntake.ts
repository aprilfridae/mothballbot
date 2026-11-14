export type IntakeResult = { ok: true; title: string; priceCents: number } | { ok: false; hint: string };

const HINT = 'Send photos with a title and price, like: `Nike hoodie size L $35`';

const DOLLAR_PRICE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)/;
const TRAILING_NUMBER = /(?:^|\s)(\d+)(?:\.(\d{1,2}))?\s*$/;

function toCents(whole: string, fraction: string | undefined): number {
  const dollars = Number(whole.replace(/,/g, ''));
  const cents = fraction ? Number(fraction.padEnd(2, '0')) : 0;
  return dollars * 100 + cents;
}

export function parseIntake(text: string): IntakeResult {
  const trimmed = text.trim();
  const match = trimmed.match(DOLLAR_PRICE) ?? trimmed.match(TRAILING_NUMBER);
  if (!match || match.index === undefined) return { ok: false, hint: HINT };

  const priceCents = toCents(match[1], match[2]);
  const title = (trimmed.slice(0, match.index) + ' ' + trimmed.slice(match.index + match[0].length))
    .replace(/\s+/g, ' ')
    .trim();

  if (!title || priceCents <= 0) return { ok: false, hint: HINT };
  return { ok: true, title, priceCents };
}
