/**
 * Web push: env-gating + subscribe-route validation.
 *
 *  1. lib/push.ts must cleanly no-op (return 0, never throw, never call
 *     web-push) when the VAPID env vars are missing.
 *  2. POST /api/push/subscribe must reject malformed input before touching
 *     the database, and persist a well-formed subscription.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ── Mocks shared across both suites ──────────────────────────────────────────

const { sendNotificationMock, setVapidDetailsMock } = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(),
  setVapidDetailsMock: vi.fn(),
}));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: setVapidDetailsMock,
    sendNotification: sendNotificationMock,
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// PushSubscription reads/writes moved from Supabase to Convex. lib/push.ts now
// calls convex().query(api.notifications.push.listBySpace) and
// convex().mutation(api.notifications.push.deleteByIds); the subscribe route
// calls convex().mutation(api.notifications.push.upsert). `api` is a path proxy
// so any api.<domain>.<fn> access yields a harmless stub; behaviour is steered
// by the query/mutation mocks below.
const { convexQueryMock, convexMutationMock } = vi.hoisted(() => ({
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
}));
vi.mock('@/lib/convex-server', () => {
  const makePath = (path: string): unknown =>
    new Proxy(() => path, {
      get: (_t, p) => (typeof p === 'string' ? makePath(`${path}.${p}`) : path),
    });
  return {
    api: new Proxy({}, { get: (_t, p) => (typeof p === 'string' ? makePath(p) : undefined) }),
    convex: () => ({ query: convexQueryMock, mutation: convexMutationMock }),
  };
});

const { requireSpaceOwnerMock } = vi.hoisted(() => ({ requireSpaceOwnerMock: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ requireSpaceOwner: requireSpaceOwnerMock }));

// server-only is a no-op import in tests but must be stubbed so lib/push loads.
vi.mock('server-only', () => ({}));

// ── 1. Gating: no VAPID env → no-op ──────────────────────────────────────────

describe('lib/push gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  it('reports push as not configured when env is missing', async () => {
    const { isPushConfigured } = await import('@/lib/push');
    expect(isPushConfigured()).toBe(false);
  });

  it('sendPushToSpace no-ops without throwing and never calls web-push', async () => {
    const { sendPushToSpace } = await import('@/lib/push');
    const sent = await sendPushToSpace('space-1', { title: 'hi', body: 'there' });
    expect(sent).toBe(0);
    expect(setVapidDetailsMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
    // It must not even query the DB when unconfigured.
    expect(convexQueryMock).not.toHaveBeenCalled();
  });
});

// ── 2. Subscribe route validation ────────────────────────────────────────────

function makeReq(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/push/subscribe', {
    method,
    headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('POST /api/push/subscribe validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSpaceOwnerMock.mockResolvedValue({ userId: 'user-1', space: { id: 'space-1' } });
  });

  it('rejects a missing slug with 400', async () => {
    const { POST } = await import('@/app/api/push/subscribe/route');
    const res = await POST(makeReq('POST', { subscription: {} }));
    expect(res.status).toBe(400);
  });

  it('rejects an incomplete subscription with 400', async () => {
    const { POST } = await import('@/app/api/push/subscribe/route');
    const res = await POST(
      makeReq('POST', { slug: 'acme', subscription: { endpoint: 'https://x', keys: { p256dh: 'p' } } }),
    );
    expect(res.status).toBe(400);
    // Validation fails before any DB write.
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('passes through the auth response when not authorized', async () => {
    requireSpaceOwnerMock.mockResolvedValueOnce(
      NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    );
    const { POST } = await import('@/app/api/push/subscribe/route');
    const res = await POST(makeReq('POST', { slug: 'acme', subscription: {} }));
    expect(res.status).toBe(403);
  });

  it('upserts a well-formed subscription and returns ok', async () => {
    convexMutationMock.mockResolvedValue(undefined);

    const { POST } = await import('@/app/api/push/subscribe/route');
    const res = await POST(
      makeReq('POST', {
        slug: 'acme',
        subscription: { endpoint: 'https://push/x', keys: { p256dh: 'pkey', auth: 'akey' } },
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    // The upsert mutation is called with the well-formed subscription fields.
    expect(convexMutationMock).toHaveBeenCalledTimes(1);
    const [, mutArgs] = convexMutationMock.mock.calls[0];
    expect(mutArgs).toMatchObject({
      spaceId: 'space-1',
      endpoint: 'https://push/x',
      p256dh: 'pkey',
      auth: 'akey',
    });
  });
});
