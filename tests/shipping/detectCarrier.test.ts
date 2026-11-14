import { describe, it, expect } from 'vitest';
import { detectCarrier } from '../../src/shipping/detectCarrier.js';

describe('detectCarrier', () => {
  it.each([
    ['1Z999AA10123456784', 'UPS'],
    ['1z999aa10123456784', 'UPS'],
    ['9400111899223197428490', 'USPS'],
    ['9405 5036 9930 0123 4567 89', 'USPS'],
    ['EA123456789US', 'USPS'],
    ['123456789012', 'FedEx'],
    ['123456789012345', 'FedEx'],
  ])('%s → %s', (tracking, carrier) => {
    expect(detectCarrier(tracking)).toBe(carrier);
  });

  it.each(['hello', '12345', 'shipped', ''])('%s → null', (t) => {
    expect(detectCarrier(t)).toBeNull();
  });
});
