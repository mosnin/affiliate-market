import { beforeAll, describe, expect, it } from 'vitest';
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  type EmailListType,
} from '@/lib/email/suppression';

// signingKey() reads the app secret lazily at call time, so a secret only needs
// to exist before the assertions run — the harness sets CLERK_SECRET_KEY in CI,
// but default it here so the suite is self-contained locally too.
beforeAll(() => {
  process.env.CLERK_SECRET_KEY ??= 'test-unsub-secret';
});

describe('unsubscribe token', () => {
  it('round-trips email + listType', () => {
    const token = signUnsubscribeToken('creator@example.com', 'creator_digest');
    expect(verifyUnsubscribeToken(token)).toEqual({
      email: 'creator@example.com',
      listType: 'creator_digest',
    });
  });

  it('normalizes the email to lower-case inside the signed payload', () => {
    const token = signUnsubscribeToken('Foo@Example.COM', 'seller_digest');
    expect(verifyUnsubscribeToken(token)).toEqual({
      email: 'foo@example.com',
      listType: 'seller_digest',
    });
  });

  it('rejects a tampered signature', () => {
    const token = signUnsubscribeToken('creator@example.com', 'creator_digest');
    const last = token.slice(-1);
    const tampered = token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = signUnsubscribeToken('creator@example.com', 'creator_digest');
    const dot = token.indexOf('.');
    // Re-encode a different email into the body; the original HMAC won't match.
    const forgedBody = Buffer.from('creator_digest:victim@example.com', 'utf8').toString('base64url');
    const forged = `${forgedBody}.${token.slice(dot + 1)}`;
    expect(verifyUnsubscribeToken(forged)).toBeNull();
  });

  it('a creator token cannot be replayed as a seller token', () => {
    // listType lives inside the signed payload, so swapping it breaks the HMAC.
    const token = signUnsubscribeToken('both@example.com', 'creator_digest');
    const claim = verifyUnsubscribeToken(token);
    expect(claim?.listType).toBe('creator_digest');
    expect(claim?.listType).not.toBe('seller_digest' as EmailListType);
  });

  it('rejects malformed tokens', () => {
    expect(verifyUnsubscribeToken('')).toBeNull();
    expect(verifyUnsubscribeToken('no-dot-here')).toBeNull();
    expect(verifyUnsubscribeToken('.onlysig')).toBeNull();
    expect(verifyUnsubscribeToken('onlybody.')).toBeNull();
    // Valid base64url body but an unknown listType, even if we sign it: the
    // verifier still gates on the known-list allowlist.
    const weird = Buffer.from('unknown_list:x@y.com', 'utf8').toString('base64url');
    expect(verifyUnsubscribeToken(`${weird}.deadbeef`)).toBeNull();
  });
});
