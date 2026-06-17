/**
 * Phase 7 — tests for the inline draft-and-send endpoint that backs the
 * /cola home action sheet.
 *
 * Two modes share the route: 'preview' (call OpenAI, return composed
 * subject+body) and 'send' (insert AgentDraft, call sendDraft, flip
 * status). Tests cover the mode dispatch, the contract shape, error
 * paths the UI actually handles, and the boundary between deal context
 * (looks up Deal → contactId) and person context (looks up Contact).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase mock ─────────────────────────────────────────────────────────
// Deal / Contact / ContactActivity still ride Supabase (enrichContext + the
// targeted id/contact lookups). The AgentDraft insert + status flip moved to
// Convex (api.agent.drafts.create / updateForSpace) — see the Convex mock and
// `insertResult` wiring below; AgentDraft is no longer a Supabase table here.
interface TableMock {
  single?: Record<string, unknown> | null;
  rows?: Array<Record<string, unknown>>;
  /** Drives the Convex AgentDraft `create` mutation's returned row. */
  insertResult?: Record<string, unknown> | null;
  insertError?: { message: string } | null;
}
let mockByTable: Record<string, TableMock> = {};
let lastInsertedDraft: Record<string, unknown> | null = null;
let lastDraftStatusUpdate: Record<string, unknown> | null = null;

vi.mock('@/lib/supabase', () => {
  function makeChain(table: string): Record<string, unknown> {
    const override = mockByTable[table] ?? {};
    const rows = override.rows ?? [];
    const single = override.single;

    const termThen = Promise.resolve({ data: rows, error: null });
    const singleThen = Promise.resolve({ data: single ?? null, error: null });

    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    chain.select = vi.fn(pass);
    chain.eq = vi.fn(pass);
    chain.is = vi.fn(pass);
    chain.order = vi.fn(pass);
    chain.limit = vi.fn(pass);
    chain.update = vi.fn(pass);
    chain.insert = vi.fn(pass);
    chain.maybeSingle = vi.fn(() => singleThen);
    chain.single = vi.fn(() => singleThen);
    chain.then = (r: (v: unknown) => unknown, e?: (e: unknown) => unknown) => termThen.then(r, e);
    return chain;
  }
  return { supabase: { from: vi.fn((table: string) => makeChain(table)) } };
});

// ── Convex mock ───────────────────────────────────────────────────────────
// The AgentDraft create + status-flip writes. `create` returns the inserted
// row (id taken from mockByTable.AgentDraft.insertResult, falling back to a
// default); `updateForSpace` records the patch the route sent. `api` is a
// path proxy so we branch on the dotted fn path regardless of call order.
const { convexMutationMock } = vi.hoisted(() => ({
  convexMutationMock: vi.fn(),
}));
vi.mock('@/lib/convex-server', () => {
  const makePath = (path: string): unknown =>
    new Proxy(() => path, {
      get: (_t, p) => (typeof p === 'string' ? makePath(`${path}.${p}`) : path),
    });
  return {
    api: new Proxy({}, { get: (_t, p) => (typeof p === 'string' ? makePath(p) : undefined) }),
    convex: () => ({ query: vi.fn(), mutation: convexMutationMock }),
  };
});

// ── Auth + space mocks ────────────────────────────────────────────────────
vi.mock('@/lib/api-auth', () => ({
  requireAuth: vi.fn(async () => ({ userId: 'clerk_1' })),
}));
vi.mock('@/lib/space', () => ({
  getSpaceForUser: vi.fn(async () => ({ id: 's_1', slug: 'jane', name: 'Jane Realty', ownerId: 'u1' })),
}));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── OpenAI client mock ────────────────────────────────────────────────────
const { openaiCreateMock } = vi.hoisted(() => ({
  openaiCreateMock: vi.fn(async () => ({
    choices: [{ message: { content: JSON.stringify({ subject: 'Quick check-in', body: "Wanted to circle back on the Chen deal. Free for a 15-min call this week?" }) } }],
  })),
}));
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreateMock } },
  })),
}));

// ── Delivery mock ─────────────────────────────────────────────────────────
const { sendDraftMock } = vi.hoisted(() => ({
  sendDraftMock: vi.fn(async () => ({ sent: true, method: 'email' as const })),
}));
vi.mock('@/lib/delivery', () => ({ sendDraft: sendDraftMock }));

// ── Voice samples mock ────────────────────────────────────────────────────
// The compose route now pulls voice samples per request. Mocked at the
// helper boundary — getRecentVoiceSamples has its own focused tests in
// draft-voice.test.ts; here we just control what the route sees so we can
// assert the prompt array shape changes when samples are present.
const { getRecentVoiceSamplesMock } = vi.hoisted(() => ({
  getRecentVoiceSamplesMock: vi.fn(async () => [] as Array<{ subject: string | null; body: string }>),
}));
vi.mock('@/lib/draft-voice', () => ({
  getRecentVoiceSamples: getRecentVoiceSamplesMock,
}));

import { POST } from '@/app/api/agent/quick-draft/route';

function makeReq(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/agent/quick-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockByTable = {};
  lastInsertedDraft = null;
  lastDraftStatusUpdate = null;
  openaiCreateMock.mockClear();
  sendDraftMock.mockClear();
  getRecentVoiceSamplesMock.mockReset();
  getRecentVoiceSamplesMock.mockResolvedValue([]);
  process.env.OPENAI_API_KEY = 'test-key';

  // Route the AgentDraft Convex writes:
  //   - create:         capture the inserted draft args, return the configured
  //                     row ({ id, ...args }), honoring insertResult.
  //   - updateForSpace: capture the patch the status-flip sent.
  convexMutationMock.mockReset();
  convexMutationMock.mockImplementation(async (ref: unknown, args: Record<string, unknown>) => {
    const path = typeof ref === 'function' ? (ref as () => string)() : '';
    if (path.includes('drafts.create')) {
      lastInsertedDraft = args;
      const insertResult = mockByTable.AgentDraft?.insertResult;
      return { id: 'draft_new', ...args, ...(insertResult ?? {}) };
    }
    if (path.includes('drafts.updateForSpace')) {
      lastDraftStatusUpdate = args.patch as Record<string, unknown>;
      return { id: (args.id as string) ?? 'draft_new', ...((args.patch as Record<string, unknown>) ?? {}) };
    }
    return null;
  });
});

describe('POST /api/agent/quick-draft — preview mode', () => {
  it('rejects unknown intent', async () => {
    const res = await POST(makeReq({ context: 'deal', id: 'd_1', intent: 'sabotage' }) as never);
    expect(res.status).toBe(400);
  });

  it('rejects unknown context', async () => {
    const res = await POST(makeReq({ context: 'cthulhu', id: 'x', intent: 'check-in' }) as never);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the deal is not in the seller space', async () => {
    mockByTable.Deal = { single: null };
    const res = await POST(makeReq({ context: 'deal', id: 'd_missing', intent: 'check-in' }) as never);
    expect(res.status).toBe(404);
  });

  it('composes an email draft for a deal context', async () => {
    mockByTable.Deal = {
      single: { id: 'd_chen', title: 'Chen', contactId: 'c_chen', updatedAt: '2026-04-15T00:00:00Z' },
    };
    mockByTable.ContactActivity = { rows: [] };

    const res = await POST(makeReq({ context: 'deal', id: 'd_chen', intent: 'check-in' }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channel).toBe('email');
    expect(body.subject).toBeTruthy();
    expect(body.body).toContain('Chen');
    expect(body.contactId).toBe('c_chen');
    expect(body.dealId).toBe('d_chen');
    expect(openaiCreateMock).toHaveBeenCalledOnce();
  });

  it('composes a note draft for log-call intent (channel coerced to note)', async () => {
    openaiCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ subject: null, body: 'Called Chen — wants to revisit pricing next week.' }) } }],
    } as never);
    mockByTable.Deal = {
      single: { id: 'd_chen', title: 'Chen', contactId: 'c_chen', updatedAt: '2026-04-20T00:00:00Z' },
    };
    mockByTable.ContactActivity = { rows: [] };

    const res = await POST(makeReq({ context: 'deal', id: 'd_chen', intent: 'log-call' }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channel).toBe('note');
    expect(body.subject).toBeNull();
    expect(body.body).toMatch(/Chen/);
  });

  it('composes against a person context', async () => {
    mockByTable.Contact = { single: { id: 'p_sarah', name: 'Sarah', lastContactedAt: null } };
    mockByTable.ContactActivity = { rows: [] };
    const res = await POST(makeReq({ context: 'person', id: 'p_sarah', intent: 'reach-out' }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contactId).toBe('p_sarah');
    expect(body.dealId).toBeNull();
    expect(body.subjectLabel).toBe('Sarah');
  });

  it('returns 502 when OpenAI yields nothing usable', async () => {
    openaiCreateMock.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ subject: 's', body: '' }) } }] } as never);
    mockByTable.Deal = { single: { id: 'd_x', title: 'X', contactId: null, updatedAt: null } };
    const res = await POST(makeReq({ context: 'deal', id: 'd_x', intent: 'check-in' }) as never);
    expect(res.status).toBe(502);
  });

  it('returns 502 when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    mockByTable.Deal = { single: { id: 'd_x', title: 'X', contactId: null, updatedAt: null } };
    const res = await POST(makeReq({ context: 'deal', id: 'd_x', intent: 'check-in' }) as never);
    expect(res.status).toBe(502);
  });
});

describe('POST /api/agent/quick-draft — voice wiring', () => {
  it('does NOT include a voice block when there are 0 samples (current behavior preserved)', async () => {
    getRecentVoiceSamplesMock.mockResolvedValueOnce([]);
    mockByTable.Deal = {
      single: { id: 'd_chen', title: 'Chen', contactId: 'c_chen', updatedAt: null },
    };
    mockByTable.ContactActivity = { rows: [] };

    const res = await POST(makeReq({ context: 'deal', id: 'd_chen', intent: 'check-in' }) as never);
    expect(res.status).toBe(200);
    expect(openaiCreateMock).toHaveBeenCalledOnce();

    const args = (openaiCreateMock.mock.calls[0] as unknown as [{ messages: Array<{ role: string; content: string }> }])[0];
    const systemMessages = args.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toContain('You are Cola');
    // No reference to the voice block label.
    expect(args.messages.some((m) => m.content.includes("seller's voice"))).toBe(false);
  });

  it('appends a voice block AFTER the SYSTEM_PROMPT when samples exist, with raw bodies and the recipient-leak instruction', async () => {
    // The samples here include a name in the body — the helper does NOT
    // scrub it. The prompt instruction is what stops the model from
    // re-using "Sam" or "Chen" in the new draft. Pin both: the raw body
    // arrives in the prompt, and the instruction is present and specific.
    getRecentVoiceSamplesMock.mockResolvedValueOnce([
      { subject: 's1', body: 'Hi Sam, got your note. Quick yes from me.' },
      { subject: 's2', body: 'Tuesday at 3 works. See you there. — Maya' },
    ]);
    mockByTable.Deal = {
      single: { id: 'd_chen', title: 'Chen', contactId: 'c_chen', updatedAt: null },
    };
    mockByTable.ContactActivity = { rows: [] };

    const res = await POST(makeReq({ context: 'deal', id: 'd_chen', intent: 'check-in' }) as never);
    expect(res.status).toBe(200);

    const args = (openaiCreateMock.mock.calls[0] as unknown as [{ messages: Array<{ role: string; content: string }> }])[0];
    const systemMessages = args.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(2);
    // SYSTEM_PROMPT is first, voice block second — order matters for the model.
    expect(systemMessages[0].content).toContain('You are Cola');
    // Raw bodies pass through verbatim, including the names. The prompt
    // does the work, not a regex.
    expect(systemMessages[1].content).toContain('Hi Sam, got your note. Quick yes from me.');
    expect(systemMessages[1].content).toContain('Tuesday at 3 works. See you there. — Maya');
    // The instruction is specific to the failure mode (recipient name +
    // deal/product/date reuse), not generic safety hedging.
    expect(systemMessages[1].content).toMatch(/do NOT address the new recipient by any name/i);
    expect(systemMessages[1].content).toMatch(/deal, product, address, date/i);
  });

  it('skips voice samples for note channel (log-call intent)', async () => {
    // Even if the helper would return samples, the route must not request
    // them for non-email channels — note voice is different.
    mockByTable.Deal = {
      single: { id: 'd_chen', title: 'Chen', contactId: 'c_chen', updatedAt: null },
    };
    mockByTable.ContactActivity = { rows: [] };
    openaiCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ subject: null, body: 'Called Chen.' }) } }],
    } as never);

    const res = await POST(makeReq({ context: 'deal', id: 'd_chen', intent: 'log-call' }) as never);
    expect(res.status).toBe(200);

    const args = (openaiCreateMock.mock.calls[0] as unknown as [{ messages: Array<{ role: string; content: string }> }])[0];
    const systemMessages = args.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
  });
});

describe('POST /api/agent/quick-draft — send mode', () => {
  it('inserts a pending AgentDraft, fires sendDraft, flips status to sent', async () => {
    mockByTable.Deal = { single: { id: 'd_chen', title: 'Chen', contactId: 'c_chen', updatedAt: null } };
    mockByTable.AgentDraft = { insertResult: { id: 'draft_quick' } };
    mockByTable.Contact = { single: { name: 'David Chen', email: 'david@example.com', phone: null } };

    const res = await POST(
      makeReq({
        mode: 'send',
        context: 'deal',
        id: 'd_chen',
        intent: 'check-in',
        channel: 'email',
        subject: 'Quick check-in',
        body: 'Wanted to circle back.',
      }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('draft_quick');
    expect(body.status).toBe('sent');
    expect(body.deliveryResult.sent).toBe(true);

    expect(lastInsertedDraft).toMatchObject({
      spaceId: 's_1',
      contactId: 'c_chen',
      dealId: 'd_chen',
      channel: 'email',
      status: 'pending',
      subject: 'Quick check-in',
    });
    expect(sendDraftMock).toHaveBeenCalledOnce();
    expect(lastDraftStatusUpdate).toMatchObject({ status: 'sent' });
  });

  it('marks the draft approved (not sent) when delivery is unconfigured', async () => {
    sendDraftMock.mockResolvedValueOnce({ sent: false, error: 'not_configured' } as never);
    mockByTable.Deal = { single: { id: 'd_chen', title: 'Chen', contactId: 'c_chen', updatedAt: null } };
    mockByTable.AgentDraft = { insertResult: { id: 'draft_unconf' } };
    mockByTable.Contact = { single: { name: 'David', email: null, phone: null } };

    const res = await POST(
      makeReq({
        mode: 'send',
        context: 'deal',
        id: 'd_chen',
        intent: 'check-in',
        channel: 'email',
        subject: 's',
        body: 'b',
      }) as never,
    );
    const body = await res.json();
    expect(body.status).toBe('approved');
    expect(body.deliveryResult.sent).toBe(false);
  });

  it('rejects send with empty body', async () => {
    mockByTable.Deal = { single: { id: 'd_chen', title: 'Chen', contactId: 'c_chen', updatedAt: null } };
    const res = await POST(
      makeReq({
        mode: 'send',
        context: 'deal',
        id: 'd_chen',
        intent: 'check-in',
        channel: 'email',
        subject: 's',
        body: '   ',
      }) as never,
    );
    expect(res.status).toBe(400);
  });

  it('rejects email send without a subject', async () => {
    mockByTable.Deal = { single: { id: 'd_chen', title: 'Chen', contactId: 'c_chen', updatedAt: null } };
    const res = await POST(
      makeReq({
        mode: 'send',
        context: 'deal',
        id: 'd_chen',
        intent: 'check-in',
        channel: 'email',
        body: 'b',
      }) as never,
    );
    expect(res.status).toBe(400);
  });

  it('logs a note (channel: note) without requiring a subject', async () => {
    mockByTable.Deal = { single: { id: 'd_chen', title: 'Chen', contactId: 'c_chen', updatedAt: null } };
    mockByTable.AgentDraft = { insertResult: { id: 'draft_note' } };
    mockByTable.Contact = { single: { name: 'David', email: null, phone: null } };

    const res = await POST(
      makeReq({
        mode: 'send',
        context: 'deal',
        id: 'd_chen',
        intent: 'log-call',
        channel: 'note',
        body: 'Called David. Wants pricing.',
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(lastInsertedDraft).toMatchObject({ channel: 'note', subject: null });
  });
});
