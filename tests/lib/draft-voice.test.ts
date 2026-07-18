/**
 * Voice-sample helper tests.
 *
 * The voice-sample read moved from Supabase to Convex: getRecentVoiceSamples
 * now calls `convex().query(api.agent.drafts.voiceSamples, …)`. The filter
 * shape that the old test pinned on the Supabase chain
 * (spaceId, channel='email', feedback_action='edited_and_approved',
 *  edit_distance > threshold, status in (sent, approved), updatedAt >= cutoff,
 *  order updatedAt desc, limit 3) now lives INSIDE the Convex query handler —
 * the lib only forwards { spaceId, editDistanceThreshold, cutoff, limit }.
 * So we assert on the args the lib forwards (the load-bearing contract a
 * refactor could break — drop the cutoff and you leak stale voice; drop the
 * threshold and you train on greeting-tweaks), and on the values the helper
 * returns from the rows the query hands back ({ subject, content }).
 *
 * Covers:
 *   - empty result when nothing matches
 *   - single sample is suppressed (MIN_SAMPLES = 2)
 *   - the forwarded query args: spaceId, edit_distance threshold (>=12),
 *     60-day cutoff, limit 3
 *   - cap at 3
 *   - cache hit (no second Convex call) and cache reset
 *   - returned shape: only subject + body, no PII columns
 *   - voice samples pass through unmodified — recipient-name leak protection
 *     is the prompt instruction, not a regex on the body
 *   - truncation at sentence boundary or with ellipsis
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Convex mock ─────────────────────────────────────────────────────────────
// The query is steered per test via convexQueryMock; `api` is a path proxy so
// any api.<domain>.<module>.<fn> access stringifies to its dotted path.
const { convexQueryMock } = vi.hoisted(() => ({
  convexQueryMock: vi.fn(),
}));
vi.mock('@/lib/convex-server', () => {
  const makePath = (path: string): unknown =>
    new Proxy(() => path, {
      get: (_t, p) => (typeof p === 'string' ? makePath(`${path}.${p}`) : path),
    });
  return {
    api: new Proxy({}, { get: (_t, p) => (typeof p === 'string' ? makePath(p) : undefined) }),
    convex: () => ({ query: convexQueryMock, mutation: vi.fn() }),
  };
});

import {
  getRecentVoiceSamples,
  __resetDraftVoiceCacheForTests,
} from '@/lib/draft-voice';

const NOW = new Date('2026-05-01T12:00:00Z');

/** The args object forwarded to the voiceSamples query (2nd arg of query). */
function queryArgs(call = 0): Record<string, unknown> {
  return convexQueryMock.mock.calls[call][1] as Record<string, unknown>;
}

beforeEach(() => {
  __resetDraftVoiceCacheForTests();
  convexQueryMock.mockReset();
  convexQueryMock.mockResolvedValue([]);
});

describe('getRecentVoiceSamples — empty cases', () => {
  it('returns [] when the query returns no rows', async () => {
    convexQueryMock.mockResolvedValue([]);
    const out = await getRecentVoiceSamples('s_1', { now: NOW });
    expect(out).toEqual([]);
  });

  it('returns [] when only one matching row exists (MIN_SAMPLES guard)', async () => {
    convexQueryMock.mockResolvedValue([
      { subject: 'Hi', content: 'Wanted to circle back. Call me when free.' },
    ]);
    const out = await getRecentVoiceSamples('s_1', { now: NOW });
    expect(out).toEqual([]);
  });

  it('returns [] when the Convex query throws (fail-closed, not crash)', async () => {
    convexQueryMock.mockRejectedValue(new Error('boom'));
    const out = await getRecentVoiceSamples('s_1', { now: NOW });
    expect(out).toEqual([]);
  });
});

describe('getRecentVoiceSamples — query args', () => {
  it('forwards spaceId, edit_distance threshold (>=12), a 60-day cutoff, and limit 3', async () => {
    convexQueryMock.mockResolvedValue([
      { subject: 'a', content: 'one. two.' },
      { subject: 'b', content: 'three. four.' },
    ]);
    await getRecentVoiceSamples('s_1', { now: NOW });

    expect(convexQueryMock).toHaveBeenCalledTimes(1);
    const args = queryArgs();

    // Space scope — dropping it would leak another tenant's voice. Hard fail.
    expect(args.spaceId).toBe('s_1');

    // edit_distance threshold — below this the edits are greeting tweaks/typos
    // that don't teach voice. The query filters `> threshold` server-side.
    expect(typeof args.editDistanceThreshold).toBe('number');
    expect(args.editDistanceThreshold as number).toBeGreaterThanOrEqual(12);

    // 60-day cutoff — anything older is stale voice. The query filters
    // `updatedAt >= cutoff` server-side.
    const cutoffDate = new Date(args.cutoff as string);
    const expected = new Date(NOW.getTime() - 60 * 86_400_000);
    expect(Math.abs(cutoffDate.getTime() - expected.getTime())).toBeLessThan(2_000);

    // Cap of 3 (the query orders updatedAt desc and limits).
    expect(args.limit).toBe(3);
  });
});

describe('getRecentVoiceSamples — return shape and cap', () => {
  it('caps at 3 samples', async () => {
    // The query already limits to 3; the helper maps the rows it receives.
    convexQueryMock.mockResolvedValue([
      { subject: 's1', content: 'one. one.' },
      { subject: 's2', content: 'two. two.' },
      { subject: 's3', content: 'three. three.' },
    ]);
    const out = await getRecentVoiceSamples('s_1', { now: NOW });
    expect(out).toHaveLength(3);
    expect(out[0].subject).toBe('s1');
  });

  it('returns only subject+body — no other columns leak through', async () => {
    // The Convex query already projects to subject+content only (PII scoping);
    // even if extra keys came back, the helper maps to exactly { subject, body }.
    convexQueryMock.mockResolvedValue([
      {
        subject: 'a',
        content: 'one. one.',
        contactId: 'c_should_not_leak',
        dealId: 'd_should_not_leak',
        reasoning: 'should_not_leak',
      },
      { subject: 'b', content: 'two. two.', contactId: 'c2' },
    ]);
    const out = await getRecentVoiceSamples('s_1', { now: NOW });
    expect(out).toHaveLength(2);
    for (const s of out) {
      expect(Object.keys(s).sort()).toEqual(['body', 'subject']);
    }
  });
});

describe('getRecentVoiceSamples — body is passed through unmodified', () => {
  it('returns the stored content verbatim — recipient-name leak defense lives in the prompt, not here', async () => {
    // The helper does not regex-scrub names. A regex catches "Hi Sam," and
    // misses "Hey Sam!", "Sam—", "Sam, thanks" — that's theater. The real
    // defense is the system message at the compose call site telling the
    // model not to reuse names from samples. Pin that behavior: bodies
    // arrive at the model the same way they were written.
    const a = 'Hi Sam,\n\nWanted to circle back. Talk soon.\n\n— Maya';
    const b = 'Hey Jane! Quick check-in. Free Tuesday?\n\nMaya Chen';
    convexQueryMock.mockResolvedValue([
      { subject: 's1', content: a },
      { subject: 's2', content: b },
    ]);
    const out = await getRecentVoiceSamples('s_1', { now: NOW });
    expect(out[0].body).toBe(a);
    expect(out[1].body).toBe(b);
  });
});

describe('getRecentVoiceSamples — truncation', () => {
  it('cuts at a sentence boundary when the body exceeds 400 chars', async () => {
    const longSentence = 'a'.repeat(150);
    // 150 + 2 + 150 + 2 + 150 + 2 + 14 = 470 chars — exceeds 400.
    // Sentence boundary (".") at index 152, 304, 456. minBoundary = 300, so
    // the boundary at 304 should be picked.
    const body =
      `${longSentence}. ${longSentence}. ${longSentence}. tail tail tail`;
    convexQueryMock.mockResolvedValue([
      { subject: 'a', content: body },
      { subject: 'b', content: 'short. body.' },
    ]);
    const out = await getRecentVoiceSamples('s_1', { now: NOW });
    expect(out[0].body.length).toBeLessThanOrEqual(400);
    // Must end on a period (sentence boundary), not mid-word.
    expect(out[0].body.endsWith('.')).toBe(true);
    expect(out[0].body).not.toContain('tail');
  });

  it('hard-cuts with an ellipsis when no sentence boundary is found late enough', async () => {
    const wall = 'a'.repeat(500);
    convexQueryMock.mockResolvedValue([
      { subject: 'a', content: wall },
      { subject: 'b', content: 'short. body.' },
    ]);
    const out = await getRecentVoiceSamples('s_1', { now: NOW });
    expect(out[0].body.length).toBeLessThanOrEqual(401);
    expect(out[0].body.endsWith('…')).toBe(true);
  });

  it('leaves short bodies untouched', async () => {
    convexQueryMock.mockResolvedValue([
      { subject: 'a', content: 'Sounds good. Talk soon, all set.' },
      { subject: 'b', content: 'Confirming Tuesday at 3. Bringing the file.' },
    ]);
    const out = await getRecentVoiceSamples('s_1', { now: NOW });
    expect(out[0].body).toBe('Sounds good. Talk soon, all set.');
    expect(out[1].body).toBe('Confirming Tuesday at 3. Bringing the file.');
  });
});

describe('getRecentVoiceSamples — cache', () => {
  it('serves second call from cache (no extra Convex round-trip)', async () => {
    convexQueryMock.mockResolvedValue([
      { subject: 'a', content: 'one. one.' },
      { subject: 'b', content: 'two. two.' },
    ]);

    const a = await getRecentVoiceSamples('s_1', { now: NOW });
    const callsAfterFirst = convexQueryMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const b = await getRecentVoiceSamples('s_1', { now: NOW });
    expect(convexQueryMock.mock.calls.length).toBe(callsAfterFirst);
    expect(b).toEqual(a);
  });

  it('caches the empty result too — transient empties do not hammer the DB', async () => {
    convexQueryMock.mockResolvedValue([]);

    await getRecentVoiceSamples('s_1', { now: NOW });
    const callsAfterFirst = convexQueryMock.mock.calls.length;
    await getRecentVoiceSamples('s_1', { now: NOW });
    expect(convexQueryMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('keys cache by spaceId — different spaces do not collide', async () => {
    convexQueryMock.mockResolvedValueOnce([
      { subject: 'a', content: 'one. one.' },
      { subject: 'b', content: 'two. two.' },
    ]);
    const out1 = await getRecentVoiceSamples('s_1', { now: NOW });

    convexQueryMock.mockResolvedValueOnce([
      { subject: 'x', content: 'tenant-2 alpha. tenant-2 alpha.' },
      { subject: 'y', content: 'tenant-2 beta. tenant-2 beta.' },
    ]);
    const out2 = await getRecentVoiceSamples('s_2', { now: NOW });

    expect(out1[0].subject).toBe('a');
    expect(out2[0].subject).toBe('x');
  });

  it('__resetDraftVoiceCacheForTests forces re-query', async () => {
    convexQueryMock.mockResolvedValue([
      { subject: 'a', content: 'one. one.' },
      { subject: 'b', content: 'two. two.' },
    ]);

    await getRecentVoiceSamples('s_1', { now: NOW });
    const callsAfterFirst = convexQueryMock.mock.calls.length;

    await getRecentVoiceSamples('s_1', { now: NOW });
    expect(convexQueryMock.mock.calls.length).toBe(callsAfterFirst);

    __resetDraftVoiceCacheForTests();
    await getRecentVoiceSamples('s_1', { now: NOW });
    expect(convexQueryMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
