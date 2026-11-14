import { describe, it, expect } from 'vitest';
import { planChannels, CHANNEL_SPECS, inviteUrl } from '../../src/discord/setup.js';

describe('planChannels', () => {
  it('reuses channels that already exist by name and creates the rest', () => {
    const plan = planChannels([
      { id: '10', name: 'new-listing', isForum: false },
      { id: '11', name: 'buyers', isForum: true },
      { id: '12', name: 'general', isForum: false },
    ]);
    expect(plan.found).toEqual({ newListing: '10', buyers: '11' });
    expect(plan.create.map((c) => c.name)).toEqual(['sales', 'to-ship', 'bot-status']);
  });

  it('does not reuse a text channel called "buyers" because buyer threads need a forum', () => {
    const plan = planChannels([{ id: '11', name: 'buyers', isForum: false }]);
    expect(plan.found.buyers).toBeUndefined();
    expect(plan.create.find((c) => c.key === 'buyers')).toEqual({ key: 'buyers', name: 'buyer-threads', forum: true });
  });

  it('knows all five channels', () => {
    expect(CHANNEL_SPECS.map((c) => c.key)).toEqual(['newListing', 'buyers', 'sales', 'toShip', 'botStatus']);
  });
});

describe('inviteUrl', () => {
  it('asks only for the permissions the bot needs', () => {
    const url = new URL(inviteUrl('1570987890622726296'));
    expect(url.searchParams.get('client_id')).toBe('1570987890622726296');
    expect(url.searchParams.get('scope')).toBe('bot');
    const perms = BigInt(url.searchParams.get('permissions')!);
    for (const bit of [4n, 6n, 10n, 11n, 14n, 15n, 16n, 34n, 35n, 38n]) expect((perms >> bit) & 1n).toBe(1n);
    expect((perms >> 3n) & 1n).toBe(0n); // never Administrator
  });
});
