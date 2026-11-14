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

import { extractTracking } from '../../src/shipping/detectCarrier.js';

describe('USPS barcode formats', () => {
  it.each([
    ['420627019400111899223197428490', 'USPS'],
    ['42062701234594001118992231974284', 'USPS'],
    ['42062701234524001118992231974284', null],
    ['92612999897543581234567890', 'USPS'],
  ])('%s → %s', (t, c) => {
    expect(detectCarrier(t)).toBe(c);
  });
});

describe('extractTracking', () => {
  it('pulls the tracking number out of a sentence', () => {
    expect(extractTracking('here you go: 1Z999AA10123456784 thanks!')).toEqual({ tracking: '1Z999AA10123456784', carrier: 'UPS' });
  });

  it('strips the 420+ZIP routing prefix from a scanned USPS barcode', () => {
    expect(extractTracking('420627019400111899223197428490')).toEqual({ tracking: '9400111899223197428490', carrier: 'USPS' });
  });

  it('accepts a number typed with spaces', () => {
    expect(extractTracking('9400 1118 9922 3197 4284 90')).toEqual({ tracking: '9400111899223197428490', carrier: 'USPS' });
  });

  it('returns null when there is no tracking number', () => {
    expect(extractTracking('it went out this morning')).toBeNull();
  });
});
