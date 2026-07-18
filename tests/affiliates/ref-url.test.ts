import { describe, expect, it } from 'vitest';
import { appendRefToUrl } from '@/lib/affiliates/ref-url';

describe('appendRefToUrl — cross-domain attribution passthrough', () => {
  it('appends ?via= to a clean URL', () => {
    expect(appendRefToUrl('https://acme.dev', 'abc123')).toBe('https://acme.dev/?via=abc123');
    expect(appendRefToUrl('https://acme.dev/pricing', 'abc123')).toBe(
      'https://acme.dev/pricing?via=abc123',
    );
  });

  it('preserves existing query params', () => {
    expect(appendRefToUrl('https://acme.dev/?utm_source=x', 'abc')).toBe(
      'https://acme.dev/?utm_source=x&via=abc',
    );
  });

  it('never overwrites an existing via param', () => {
    expect(appendRefToUrl('https://acme.dev/?via=original', 'other')).toBe(
      'https://acme.dev/?via=original',
    );
  });

  it('passes through when there is no code or an invalid URL', () => {
    expect(appendRefToUrl('https://acme.dev', null)).toBe('https://acme.dev');
    expect(appendRefToUrl('https://acme.dev', '')).toBe('https://acme.dev');
    expect(appendRefToUrl('not a url', 'abc')).toBe('not a url');
  });
});
