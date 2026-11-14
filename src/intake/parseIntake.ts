export type IntakeResult =
  | { ok: true; title: string; details: string; priceCents: number | null }
  | { ok: false; hint: string };

const HINT =
  'Send photos with what the item is on the first line, then any details (maker, pattern, era, marks, flaws). Add a backstamp photo if there is one. A price like `$35` is optional.';

const DOLLAR_PRICE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)/;
const TRAILING_NUMBER = /(?:^|\s)(\d+)(?:\.(\d{1,2}))?\s*$/;

function toCents(whole: string, fraction: string | undefined): number {
  const dollars = Number(whole.replace(/,/g, ''));
  const cents = fraction ? Number(fraction.padEnd(2, '0')) : 0;
  return dollars * 100 + cents;
}

/** Parses a standalone price like "35", "$35.50" or "$1,200"; null if it isn't one. */
export function parsePrice(text: string): number | null {
  const m = text.trim().match(/^\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const cents = toCents(m[1], m[2]);
  return cents > 0 ? cents : null;
}

function stripMatch(text: string, m: RegExpMatchArray): string {
  return (text.slice(0, m.index!) + ' ' + text.slice(m.index! + m[0].length)).replace(/[ \t]+/g, ' ').trim();
}

/**
 * First line = what the item is; everything = details for the AI. A `$` price anywhere is taken as the owner's
 * price; a bare trailing number only counts on the first line (so "marked 1952" on line 2 is not a price).
 */
export function parseIntake(text: string): IntakeResult {
  const trimmed = text.trim();
  const lines = trimmed.split('\n');
  const first = lines[0] ?? '';

  let details = trimmed;
  let priceCents: number | null = null;
  const dollar = trimmed.match(DOLLAR_PRICE);
  const bare = dollar ? null : first.match(TRAILING_NUMBER);
  const m = dollar ?? bare;
  if (m && m.index !== undefined) {
    priceCents = toCents(m[1], m[2]) || null;
    details = stripMatch(trimmed, m);
  }

  const title = (details.split('\n')[0] ?? '').trim();
  if (!title) return { ok: false, hint: HINT };
  return { ok: true, title, details, priceCents };
}
