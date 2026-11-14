import { describe, it, expect } from 'vitest';
import { parseIntake } from '../../src/intake/parseIntake.js';

describe('parseIntake', () => {
  it('reads a trailing dollar price', () => {
    expect(parseIntake('Nike hoodie size L $35')).toMatchObject({ ok: true, title: 'Nike hoodie size L', priceCents: 3500 });
  });

  it('reads a leading dollar price with cents', () => {
    expect(parseIntake('$35.50 vintage lamp')).toMatchObject({ ok: true, title: 'vintage lamp', priceCents: 3550 });
  });

  it('reads a price with thousands separators', () => {
    expect(parseIntake('$1,200 couch')).toMatchObject({ ok: true, title: 'couch', priceCents: 120000 });
  });

  it('treats a trailing bare number as the price', () => {
    expect(parseIntake('hoodie 35')).toMatchObject({ ok: true, title: 'hoodie', priceCents: 3500 });
  });

  it('does not treat a size number in the middle as the price', () => {
    expect(parseIntake('Jordan 11 retro $180')).toMatchObject({ ok: true, title: 'Jordan 11 retro', priceCents: 18000 });
  });

  it('accepts details without a price', () => {
    const r = parseIntake('Royal Doulton Bunnykins plate\n1936 backstamp, small chip on rim');
    expect(r).toMatchObject({ ok: true, title: 'Royal Doulton Bunnykins plate', priceCents: null });
    if (r.ok) expect(r.details).toContain('small chip');
  });

  it('keeps all lines as details and strips the price from them', () => {
    const r = parseIntake('Spode Blue Italian platter $85\n14 inch, crazing on back');
    expect(r).toMatchObject({ ok: true, title: 'Spode Blue Italian platter', priceCents: 8500 });
    if (r.ok) {
      expect(r.details).toContain('crazing on back');
      expect(r.details).not.toContain('$85');
    }
  });

  it('does not read a number on a later line as the price', () => {
    const r = parseIntake('Wedgwood jasperware vase\nmarked 1952');
    expect(r).toMatchObject({ ok: true, title: 'Wedgwood jasperware vase', priceCents: null });
  });

  it('gives a usage hint when there is a price but nothing else', () => {
    const r = parseIntake('$40');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain('backstamp');
  });

  it('gives a usage hint for empty text', () => {
    expect(parseIntake('   ').ok).toBe(false);
  });
});
