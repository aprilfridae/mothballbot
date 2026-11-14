export type Carrier = 'USPS' | 'UPS' | 'FedEx';

export function normalizeTracking(text: string): string {
  return text.replace(/[\s-]/g, '').toUpperCase();
}

export function detectCarrier(tracking: string): Carrier | null {
  const t = normalizeTracking(tracking);
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'UPS';
  if (/^9\d{19,21}$/.test(t) || /^[A-Z]{2}\d{9}US$/.test(t)) return 'USPS';
  if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t)) return 'FedEx';
  return null;
}
