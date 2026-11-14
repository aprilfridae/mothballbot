export type IntakeResult =
  | { ok: true; title: string; details: string; priceCents: number | null }
  | { ok: false; hint: string };

const HINT =
  'Send photos with what the item is on the first line, then any details (maker, pattern, era, marks, flaws). Add a backstamp photo if there is one. A price like `$35` is optional.';

const DOLLAR_PRICE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)(?!,\d)/;

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
 * First line = what the item is; everything = details for the AI. Only a `$` price counts as the owner's price,
 * and only on the first line or on a line of its own: years ("1952"), set sizes ("set of 6") and amounts quoted
 * in the details ("sticker says $5") must never become the price.
 */
export function parseIntake(text: string): IntakeResult {
  const trimmed = text.trim();
  const lines = trimmed.split('\n');

  let priceCents: number | null = null;
  let priceLine = -1;
  const onFirst = (lines[0] ?? '').match(DOLLAR_PRICE);
  if (onFirst && onFirst.index !== undefined) {
    priceCents = toCents(onFirst[1], onFirst[2]) || null;
    lines[0] = stripMatch(lines[0], onFirst);
  } else {
    priceLine = lines.findIndex((l) => /^\s*\$/.test(l) && parsePrice(l) !== null);
    if (priceLine > 0) {
      priceCents = parsePrice(lines[priceLine]);
      lines.splice(priceLine, 1);
    }
  }

  const details = lines.join('\n').trim();
  const title = (lines[0] ?? '').trim();
  if (!title) return { ok: false, hint: HINT };
  return { ok: true, title, details, priceCents };
}
