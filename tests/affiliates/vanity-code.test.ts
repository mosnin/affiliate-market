import { describe, expect, it } from 'vitest';
import { normalizeVanityCode } from '@/lib/affiliates/links';

describe('normalizeVanityCode — vanity coupon code validation', () => {
  it('lowercases and strips whitespace', () => {
    expect(normalizeVanityCode('CASEY20')).toBe('casey20');
    expect(normalizeVanityCode('  Casey 20 ')).toBe('casey20');
  });

  it('accepts letters, digits, hyphen, underscore (3–24 chars)', () => {
    expect(normalizeVanityCode('mega-deal')).toBe('mega-deal');
    expect(normalizeVanityCode('save_10')).toBe('save_10');
    expect(normalizeVanityCode('abc')).toBe('abc');
  });

  it('rejects too short, too long, or illegal chars', () => {
    expect(normalizeVanityCode('ab')).toBeNull();
    expect(normalizeVanityCode('a'.repeat(25))).toBeNull();
    expect(normalizeVanityCode('code!')).toBeNull();
    expect(normalizeVanityCode('-leadinghyphen')).toBeNull();
    expect(normalizeVanityCode('')).toBeNull();
  });
});
