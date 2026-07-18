import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Per-table mock state ───────────────────────────────────────────────────
let mockByTable: Record<
  string,
  { rows?: Array<Record<string, unknown>>; error?: { message: string } | null; single?: Record<string, unknown> | null }
> = {};

// ── Supabase mock (kept for safety; send_email tool is fully on Convex now) ─
vi.mock('@/lib/supabase', () => {
  function makeChain(_table: string): Record<string, unknown> {
    const termThen = Promise.resolve({ data: [], error: null });
    const singleThen = Promise.resolve({ data: null, error: null });
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      is: vi.fn(() => chain),
      insert: vi.fn(() => ({
        ...chain,
        then: (r: (v: unknown) => unknown, e?: (e: unknown) => unknown) => termThen.then(r, e),
        catch: (e: (x: unknown) => unknown) => termThen.catch(e),
      })),
      maybeSingle: vi.fn(() => singleThen),
      abortSignal: vi.fn(() => termThen),
      then: (r: (v: unknown) => unknown, e?: (e: unknown) => unknown) => termThen.then(r, e),
    };
    return chain;
  }
  return { supabase: { from: vi.fn((table: string) => makeChain(table)) } };
});

// ── Convex mock — send_email uses Convex for contacts, settings, and audit ──
// api.contacts.contacts.getById → Contact row (with companyId: null for workspace contacts)
// api.contacts.contacts.findByEmailInSpace → same, or null for unknowns
// api.workspace.settings.getBySpace → SpaceSetting row (businessName)
// api.contacts.activity.create, api.infra.files.listByIdsForSpace → non-fatal
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

const { sendEmailFromCRMMock } = vi.hoisted(() => ({ sendEmailFromCRMMock: vi.fn(async () => undefined) }));
vi.mock('@/lib/email', () => ({ sendEmailFromCRM: sendEmailFromCRMMock }));

import { sendEmailTool } from '@/lib/ai-tools/tools/send-email';
import type { ToolContext } from '@/lib/ai-tools/types';

function makeCtx(): ToolContext {
  return {
    userId: 'user_1',
    space: { id: 'space_1', slug: 'jane', name: 'Jane Realty', ownerId: 'u1' },
    signal: new AbortController().signal,
  };
}

beforeEach(() => {
  mockByTable = {};
  sendEmailFromCRMMock.mockClear();
  convexQueryMock.mockReset();
  convexMutationMock.mockReset();
  // Route Convex queries to mockByTable:
  //   Contact queries → Contact table single (companyId: null injected if absent).
  //   SpaceSetting → SpaceSetting table single.
  //   Mutations (activity.create) → void/null.
  convexQueryMock.mockImplementation(async (ref?: unknown) => {
    const p = typeof ref === 'function' ? (ref as () => string)() : '';
    if (p.includes('contacts.contacts.getById') || p.includes('contacts.contacts.findByEmailInSpace')) {
      const override = mockByTable['Contact'];
      const raw = override?.single !== undefined ? override.single : (override?.rows?.[0] ?? null);
      if (raw && !Object.prototype.hasOwnProperty.call(raw, 'companyId')) {
        return { ...raw, companyId: null };
      }
      return raw;
    }
    if (p.includes('workspace.settings.getBySpace')) {
      const override = mockByTable['SpaceSetting'];
      return override?.single !== undefined ? override.single : (override?.rows?.[0] ?? null);
    }
    return null;
  });
  convexMutationMock.mockResolvedValue(null);
});

describe('sendEmailTool schema', () => {
  it('requires either contactId or toEmail', () => {
    expect(() =>
      sendEmailTool.parameters.parse({ subject: 's', body: 'b' }),
    ).toThrow();
  });

  it('requires a subject + body', () => {
    expect(() =>
      sendEmailTool.parameters.parse({ toEmail: 'a@b.com', body: 'b' }),
    ).toThrow();
    expect(() =>
      sendEmailTool.parameters.parse({ toEmail: 'a@b.com', subject: 's' }),
    ).toThrow();
  });

  it('rejects malformed email addresses', () => {
    expect(() =>
      sendEmailTool.parameters.parse({ toEmail: 'not-an-email', subject: 's', body: 'b' }),
    ).toThrow();
  });

  it('caps body + subject length', () => {
    expect(() =>
      sendEmailTool.parameters.parse({
        toEmail: 'a@b.com',
        subject: 'x'.repeat(250),
        body: 'b',
      }),
    ).toThrow();
  });

  it('requires approval before the handler runs', () => {
    expect(sendEmailTool.requiresApproval).toBe(true);
  });
});

describe('sendEmailTool handler — contactId path', () => {
  it('sends to the contact\'s email on file', async () => {
    mockByTable = {
      Contact: {
        single: { id: 'c_1', email: 'jane@example.com', name: 'Jane' },
      },
      SpaceSetting: { single: { businessName: 'Jane Realty' } },
    };
    const result = await sendEmailTool.handler(
      {
        contactId: 'c_1',
        subject: 'Demo Friday',
        body: 'Looking forward to it.',
      },
      makeCtx(),
    );

    expect(sendEmailFromCRMMock).toHaveBeenCalledTimes(1);
    expect((sendEmailFromCRMMock.mock.calls as unknown[][])[0][0]).toMatchObject({
      toEmail: 'jane@example.com',
      fromName: 'Jane Realty',
      subject: 'Demo Friday',
    });
    expect(result.summary).toContain('jane@example.com');
    expect(result.display).toBe('success');
    expect((result.data as { contactId: string }).contactId).toBe('c_1');
  });

  it('refuses to send when the contact has no email', async () => {
    mockByTable = {
      Contact: {
        single: { id: 'c_2', email: null, name: 'Phoneless' },
      },
    };
    const result = await sendEmailTool.handler(
      { contactId: 'c_2', subject: 'Hi', body: 'Hi.' },
      makeCtx(),
    );
    expect(sendEmailFromCRMMock).not.toHaveBeenCalled();
    expect(result.summary).toMatch(/no email on file/);
    expect(result.display).toBe('error');
  });

  it('refuses when contactId does not exist in this space', async () => {
    mockByTable = { Contact: { single: null } };
    const result = await sendEmailTool.handler(
      { contactId: 'bogus', subject: 'Hi', body: 'Hi.' },
      makeCtx(),
    );
    expect(sendEmailFromCRMMock).not.toHaveBeenCalled();
    expect(result.summary).toMatch(/No contact with id/);
    expect(result.display).toBe('error');
  });
});

describe('sendEmailTool handler — toEmail path', () => {
  it('sends to a bare address even without a matching contact', async () => {
    mockByTable = {
      Contact: { single: null },
      SpaceSetting: { single: { businessName: 'Jane Realty' } },
    };
    const result = await sendEmailTool.handler(
      { toEmail: 'stranger@elsewhere.com', subject: 'Hi', body: 'Hi.' },
      makeCtx(),
    );
    expect(sendEmailFromCRMMock).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: 'stranger@elsewhere.com' }),
    );
    expect(result.display).toBe('success');
    expect((result.data as { contactId: string | null }).contactId).toBeNull();
  });
});

describe('sendEmailTool handler — errors', () => {
  it('surfaces a delivery failure without throwing', async () => {
    mockByTable = {
      Contact: { single: null },
      SpaceSetting: { single: null },
    };
    sendEmailFromCRMMock.mockRejectedValueOnce(new Error('Resend quota exhausted'));

    const result = await sendEmailTool.handler(
      { toEmail: 'a@b.com', subject: 'Hi', body: 'Hi.' },
      makeCtx(),
    );
    expect(result.summary).toMatch(/Send failed.*Resend quota exhausted/);
    expect(result.display).toBe('error');
  });
});
