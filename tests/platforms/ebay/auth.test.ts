import { describe, it, expect } from 'vitest';
import { SCOPES } from '../../../src/platforms/ebay/auth.js';
import { readFileSync } from 'node:fs';

describe('eBay OAuth scopes', () => {
  it('includes the base scope (Taxonomy) and every scope is in the README consent URL', () => {
    expect(SCOPES).toContain('https://api.ebay.com/oauth/api_scope');
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const consent = readme.split('\n').find((l) => l.includes('auth.ebay.com/oauth2/authorize'))!;
    const scopes = decodeURIComponent(consent.split('scope=')[1].trim()).split(' ');
    expect(scopes.sort()).toEqual([...SCOPES].sort());
  });
});
