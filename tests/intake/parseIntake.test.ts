import { describe, it, expect } from 'vitest';
import { parseIntake } from '../../src/intake/parseIntake.js';

describe('parseIntake', () => {
  it('reads a trailing dollar price', () => {
    expect(parseIntake('Nike hoodie size L $35')).toEqual({ ok: true, title: 'Nike hoodie size L', priceCents: 3500 });
  });

  it('reads a leading dollar price with cents', () => {
    expect(parseIntake('$35.50 vintage lamp')).toEqual({ ok: true, title: 'vintage lamp', priceCents: 3550 });
  });

  it('reads a price with thousands separators', () => {
    expect(parseIntake('$1,200 couch')).toEqual({ ok: true, title: 'couch', priceCents: 120000 });
  });

  it('treats a trailing bare number as the price', () => {
    expect(parseIntake('hoodie 35')).toEqual({ ok: true, title: 'hoodie', priceCents: 3500 });
  });

  it('does not treat a size number in the middle as the price', () => {
    expect(parseIntake('Jordan 11 retro $180')).toEqual({ ok: true, title: 'Jordan 11 retro', priceCents: 18000 });
  });

  it('gives a usage hint when there is no price', () => {
    const r = parseIntake('hoodie');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain('Nike hoodie size L $35');
  });

  it('gives a usage hint when there is a price but no title', () => {
    expect(parseIntake('$35').ok).toBe(false);
  });
});
