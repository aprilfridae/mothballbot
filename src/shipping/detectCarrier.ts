export type Carrier = 'USPS' | 'UPS' | 'FedEx';

export function normalizeTracking(text: string): string {
  return text.replace(/[\s-]/g, '').toUpperCase();
}

/** A scanned USPS label barcode starts with 420 + the destination ZIP (5 or 9 digits); the tracking number follows. */
function stripUspsRouting(t: string): string {
  const m = t.match(/^420(?:\d{9}|\d{5})(9\d{19,21}|9\d{25})$/);
  return m ? m[1] : t;
}

export function detectCarrier(tracking: string): Carrier | null {
  const t = stripUspsRouting(normalizeTracking(tracking));
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'UPS';
  if (/^9\d{19,21}$/.test(t) || /^9\d{25}$/.test(t) || /^[A-Z]{2}\d{9}US$/.test(t)) return 'USPS';
  if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t)) return 'FedEx';
  return null;
}

/** Finds a tracking number in whatever Mom typed or pasted ("here you go: 1Z…", a spaced USPS number, a scanned barcode). */
export function extractTracking(text: string): { tracking: string; carrier: Carrier } | null {
  const candidates: string[] = [];
  if (/^[\d\s-]+$/.test(text.trim())) candidates.push(text);
  candidates.push(...text.split(/[\s,;:!?()"']+/).map((w) => w.replace(/[.]+$/, '')));
  for (const c of candidates) {
    const tracking = stripUspsRouting(normalizeTracking(c));
    const carrier = detectCarrier(tracking);
    if (carrier) return { tracking, carrier };
  }
  return null;
}
