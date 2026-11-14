import { describe, it, expect } from 'vitest';
import { chooseCondition } from '../../../src/platforms/ebay/conditions.js';

const apparel = [
  { conditionId: '1000', conditionDescription: 'New with tags' },
  { conditionId: '1500', conditionDescription: 'New without tags' },
  { conditionId: '2990', conditionDescription: 'Pre-owned - Excellent' },
  { conditionId: '3000', conditionDescription: 'Pre-owned - Good' },
  { conditionId: '3010', conditionDescription: 'Pre-owned - Fair' },
];
const china = [
  { conditionId: '1000', conditionDescription: 'New' },
  { conditionId: '3000', conditionDescription: 'Used' },
];

describe('chooseCondition', () => {
  it('maps to the category’s own wording (clothing uses Pre-owned grades)', () => {
    expect(chooseCondition('USED_GOOD', apparel)).toBe('USED_EXCELLENT'); // id 3000 = "Pre-owned - Good" here
    expect(chooseCondition('USED_EXCELLENT', apparel)).toBe('PRE_OWNED_EXCELLENT');
    expect(chooseCondition('USED_ACCEPTABLE', apparel)).toBe('PRE_OWNED_FAIR');
    expect(chooseCondition('NEW_OTHER', apparel)).toBe('NEW_OTHER');
  });

  it('falls back to plain "Used" when the category has only New/Used', () => {
    expect(chooseCondition('USED_GOOD', china)).toBe('USED_EXCELLENT');
    expect(chooseCondition('USED_ACCEPTABLE', china)).toBe('USED_EXCELLENT');
    expect(chooseCondition('NEW', china)).toBe('NEW');
  });

  it('keeps the draft condition when the category policy is unknown', () => {
    expect(chooseCondition('USED_GOOD', null)).toBe('USED_GOOD');
    expect(chooseCondition('USED_GOOD', [])).toBe('USED_GOOD');
  });
});
