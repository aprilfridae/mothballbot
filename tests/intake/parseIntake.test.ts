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

  it('never treats a bare number as the price (years, set sizes, model numbers)', () => {
    expect(parseIntake('Royal Albert teacup 1952')).toMatchObject({ title: 'Royal Albert teacup 1952', priceCents: null });
    expect(parseIntake('Noritake dinner plates set of 6')).toMatchObject({ title: 'Noritake dinner plates set of 6', priceCents: null });
  });

  it('ignores dollar amounts mentioned inside the details', () => {
    const r = parseIntake('Hummel figurine\nsticker says $5, Replacements lists $80');
    expect(r).toMatchObject({ priceCents: null });
    if (r.ok) expect(r.details).toContain('$80');
  });

  it('accepts a price on a line of its own', () => {
    expect(parseIntake('Hummel figurine\nsmall chip\n$45')).toMatchObject({ title: 'Hummel figurine', priceCents: 4500 });
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

describe('parseIntake malformed prices', () => {
  it('does not read "$1,2000" as $1', () => {
    const r = parseIntake('Spode platter $1,2000');
    expect(r).toMatchObject({ ok: true, priceCents: null });
  });

  it('still reads a price followed by a comma', () => {
    expect(parseIntake('Nike hoodie $35, size L')).toMatchObject({ priceCents: 3500 });
  });
});
