/**
 * BP6d — tests for the company-template library + publish fan-out.
 *
 * Runs alongside BP6a (schema), BP6b (APIs) and BP6c (UI) agents, so some
 * route files may not yet exist when this test is first authored; dynamic
 * imports are used so the module-resolution failures surface as test
 * failures rather than import-time crashes that take the whole file out.
 *
 * Mock shape mirrors tests/lib/manager-reviews.test.ts (table-keyed chain
 * mock + per-test override of the auth state). The only new wrinkle is
 * the publish fan-out: the route reads N CompanyMembership rows then
 * runs an upsert-style flow against MessageTemplate. We keep the supabase
 * chain lax (any combination of select/eq/in/is/insert/update/delete
 * resolves through the same thenable), and steer the fan-out by mocking
 * the agent list directly — option (b) from the test plan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase table-keyed chain mock ───────────────────────────────────────
interface TableMock {
  rows?: Array<Record<string, unknown>>;
  single?: Record<string, unknown> | null;
  error?: { message: string; code?: string } | null;
  insertError?: { message: string; code?: string } | null;
  updateError?: { message: string; code?: string } | null;
}
let mockByTable: Record<string, TableMock> = {};

// Per-table call counters — used by the publish fan-out assertions when the
// caller prefers (a) counting chain calls over (b) inspecting the agent list.
const fromCalls: Record<string, number> = {};
const insertCalls: Record<string, Array<Record<string, unknown>>> = {};
const updateCalls: Record<string, Array<Record<string, unknown>>> = {};
const deleteCalls: Record<string, number> = {};

vi.mock('@/lib/supabase', () => {
  function makeChain(table: string): Record<string, unknown> {
    fromCalls[table] = (fromCalls[table] ?? 0) + 1;

    const override = mockByTable[table] ?? {};
    const rows = override.rows ?? [];
    const single = override.single;
    const error = override.error ?? null;
    const insertError = override.insertError ?? null;
    const updateError = override.updateError ?? null;

    const termThen = Promise.resolve({ data: rows, error });
    const singleThen = Promise.resolve({ data: single ?? rows[0] ?? null, error });
    const insertThen = Promise.resolve({
      data: insertError ? null : single ?? rows[0] ?? null,
      error: insertError,
    });
    const updateThen = Promise.resolve({
      data: updateError ? null : single ?? rows[0] ?? null,
      error: updateError,
    });

    const chain: Record<string, unknown> = {};
    const pass = (): Record<string, unknown> => chain;
    chain.select = vi.fn(pass);
    chain.eq = vi.fn(pass);
    chain.neq = vi.fn(pass);
    chain.in = vi.fn(pass);
    chain.is = vi.fn(pass);
    chain.not = vi.fn(pass);
    chain.order = vi.fn(pass);
    chain.limit = vi.fn(pass);
    chain.update = vi.fn((payload: Record<string, unknown>) => {
      updateCalls[table] = updateCalls[table] ?? [];
      updateCalls[table].push(payload);
      return {
        ...chain,
        select: vi.fn(() => ({
          single: vi.fn(() => updateThen),
          maybeSingle: vi.fn(() => updateThen),
        })),
        then: (r: (v: unknown) => unknown, e?: (e: unknown) => unknown) =>
          updateThen.then(r, e),
      };
    });
    chain.delete = vi.fn(() => {
      deleteCalls[table] = (deleteCalls[table] ?? 0) + 1;
      return {
        ...chain,
        then: (r: (v: unknown) => unknown, e?: (e: unknown) => unknown) =>
          termThen.then(r, e),
      };
    });
    chain.insert = vi.fn((payload: Record<string, unknown> | Array<Record<string, unknown>>) => {
      insertCalls[table] = insertCalls[table] ?? [];
      if (Array.isArray(payload)) {
        insertCalls[table].push(...payload);
      } else {
        insertCalls[table].push(payload);
      }
      return {
        ...chain,
        select: vi.fn(() => ({
          single: vi.fn(() => insertThen),
          maybeSingle: vi.fn(() => insertThen),
        })),
        then: (r: (v: unknown) => unknown, e?: (e: unknown) => unknown) =>
          insertThen.then(r, e),
      };
    });
    chain.upsert = vi.fn((payload: Record<string, unknown> | Array<Record<string, unknown>>) => {
      insertCalls[table] = insertCalls[table] ?? [];
      if (Array.isArray(payload)) {
        insertCalls[table].push(...payload);
      } else {
        insertCalls[table].push(payload);
      }
      return {
        ...chain,
        select: vi.fn(() => ({
          single: vi.fn(() => insertThen),
          maybeSingle: vi.fn(() => insertThen),
        })),
        then: (r: (v: unknown) => unknown, e?: (e: unknown) => unknown) =>
          insertThen.then(r, e),
      };
    });
    chain.returns = vi.fn(pass);
    chain.maybeSingle = vi.fn(() => singleThen);
    chain.single = vi.fn(() => singleThen);
    chain.then = (r: (v: unknown) => unknown, e?: (e: unknown) => unknown) =>
      termThen.then(r, e);
    return chain;
  }
  return { supabase: { from: vi.fn((table: string) => makeChain(table)) } };
});

// ── Convex mock — the publish fan-out's MessageTemplate ops moved off ──────
// Supabase. The route reads existing copies via
// api.support.templates.findCopiesBySource (query) and writes via
// api.support.templates.{createFromSource,updateFromSource} (mutations).
// CompanyTemplate / CompanyMembership / Space stay on Supabase (above). `api`
// is a path proxy so any api.<domain>.<module>.<fn> access stringifies to its
// dotted path, letting the mutation mock branch on String(ref). The query
// returns the existing MessageTemplate copies a test seeds; the mutations
// return the create/update result shapes the route expects.
const convexExistingCopies: Array<Record<string, unknown>> = [];

// Per-test state for org.templates.* + org.memberships.* + workspace.spaces.* queries.
const convexTemplateState: {
  row: Record<string, unknown> | null;
  list: Array<Record<string, unknown>>;
} = { row: null, list: [] };
const convexMembershipsState: { rows: Array<Record<string, unknown>> } = { rows: [] };
const convexSpacesState: { rows: Array<Record<string, unknown>> } = { rows: [] };

// Capture args for org.templates.* mutations so tests can assert on payloads.
const convexOrgMutArgs: {
  create: Array<Record<string, unknown>>;
  applyPatch: Array<Record<string, unknown>>;
  deleteCount: number;
  stampPublished: Array<Record<string, unknown>>;
} = { create: [], applyPatch: [], deleteCount: 0, stampPublished: [] };

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

// ── Auth / permission mocks (per-test override) ───────────────────────────
type ManagerRole = 'manager_owner' | 'manager_admin' | 'seller_member' | null;
interface AuthState {
  clerkId: string | null;
  dbUserId: string;
  companyRole: ManagerRole;
  companyId: string;
}
let authState: AuthState = {
  clerkId: 'clerk_1',
  dbUserId: 'u_1',
  companyRole: 'manager_owner',
  companyId: 'b_1',
};

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: authState.clerkId })),
}));

vi.mock('@/lib/api-auth', () => ({
  requireAuth: vi.fn(async () => {
    if (!authState.clerkId) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
    return { userId: authState.clerkId };
  }),
}));

vi.mock('@/lib/permissions', () => ({
  requireManager: vi.fn(async () => {
    if (!authState.companyRole || authState.companyRole === 'seller_member') {
      throw new Error('Forbidden: manager access required');
    }
    return {
      membership: { id: 'm_1', role: authState.companyRole, userId: authState.dbUserId, companyId: authState.companyId },
      company: { id: authState.companyId, name: 'Test Company', ownerId: authState.dbUserId },
      dbUserId: authState.dbUserId,
    };
  }),
  getManagerMemberContext: vi.fn(async () => {
    if (!authState.companyRole) return null;
    return {
      membership: { id: 'm_1', role: authState.companyRole, userId: authState.dbUserId, companyId: authState.companyId },
      company: { id: authState.companyId, name: 'Test Company', ownerId: authState.dbUserId },
      dbUserId: authState.dbUserId,
    };
  }),
}));

vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────
function jsonReq(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function postReq(url: string, body: unknown): Request {
  return jsonReq(url, 'POST', body);
}
function patchReq(url: string, body: unknown): Request {
  return jsonReq(url, 'PATCH', body);
}
function deleteReq(url: string): Request {
  return new Request(url, { method: 'DELETE' });
}

// Per-test capture of the MessageTemplate writes the route fans out, keyed by
// the Convex fn name (createFromSource / updateFromSource), so the publish
// assertions can inspect payloads the way the old Supabase insert/update
// counters did.
const convexCreateArgs: Array<Record<string, unknown>> = [];
const convexUpdateArgs: Array<Record<string, unknown>> = [];
// Capture args from org.templates mutations so assertions can inspect payloads.
const convexTemplateCreateArgs: Array<Record<string, unknown>> = [];
const convexTemplatePatchArgs: Array<Record<string, unknown>> = [];
const convexTemplateDeleteArgs: Array<Record<string, unknown>> = [];
const convexTemplateStampArgs: Array<Record<string, unknown>> = [];

beforeEach(() => {
  mockByTable = {};
  for (const key of Object.keys(fromCalls)) delete fromCalls[key];
  for (const key of Object.keys(insertCalls)) delete insertCalls[key];
  for (const key of Object.keys(updateCalls)) delete updateCalls[key];
  for (const key of Object.keys(deleteCalls)) delete deleteCalls[key];
  convexExistingCopies.length = 0;
  convexCreateArgs.length = 0;
  convexUpdateArgs.length = 0;
  convexTemplateCreateArgs.length = 0;
  convexTemplatePatchArgs.length = 0;
  convexTemplateDeleteArgs.length = 0;
  convexTemplateStampArgs.length = 0;
  convexQueryMock.mockReset();
  convexMutationMock.mockReset();
  // Route Convex queries by path:
  //   org.templates.getByIdScoped → mockByTable.CompanyTemplate.single
  //   org.memberships.listByCompany → mockByTable.CompanyMembership.rows
  //   workspace.spaces.listByCompanyId → mockByTable.Space.rows
  //   support.templates.findCopiesBySource → convexExistingCopies
  convexQueryMock.mockImplementation(async (ref?: unknown) => {
    const p = typeof ref === 'function' ? (ref as () => string)() : '';
    if (p.includes('org.templates.getByIdScoped')) {
      const override = mockByTable['CompanyTemplate'];
      return override?.single !== undefined ? override.single : (override?.rows?.[0] ?? null);
    }
    if (p.includes('org.templates.listByCompany')) {
      return mockByTable['CompanyTemplate']?.rows ?? [];
    }
    if (p.includes('org.memberships.listByCompany')) {
      return mockByTable['CompanyMembership']?.rows ?? [];
    }
    if (p.includes('workspace.spaces.listByCompanyId')) {
      return mockByTable['Space']?.rows ?? [];
    }
    if (p.includes('support.templates.findCopiesBySource')) {
      return convexExistingCopies;
    }
    return null;
  });
  // Route Convex mutations by path, capturing args for assertions:
  //   org.templates.create → return mockByTable.CompanyTemplate.single (the inserted row)
  //   org.templates.applyPatch → return mockByTable.CompanyTemplate.single (the updated row)
  //   org.templates.deleteByIdScoped → return templateId string (non-null = found)
  //   org.templates.stampPublished → no-op (stamp success)
  //   support.templates.createFromSource → return { id }
  //   support.templates.updateFromSource → return { updated: true }
  convexMutationMock.mockImplementation(async (ref: unknown, args: Record<string, unknown>) => {
    const p = typeof ref === 'function' ? String((ref as () => string)()) : String(ref);
    if (p.includes('org.templates.create')) {
      convexTemplateCreateArgs.push(args);
      const override = mockByTable['CompanyTemplate'];
      return override?.single !== undefined ? override.single : (override?.rows?.[0] ?? null);
    }
    if (p.includes('org.templates.applyPatch')) {
      convexTemplatePatchArgs.push(args);
      const override = mockByTable['CompanyTemplate'];
      const base = override?.single !== undefined ? override.single : (override?.rows?.[0] ?? null);
      // Merge the patch into the base row so the route's `updated` check passes.
      return base ? { ...base, ...((args.patch as Record<string, unknown>) ?? {}) } : null;
    }
    if (p.includes('org.templates.deleteByIdScoped')) {
      convexTemplateDeleteArgs.push(args);
      // Return the templateId string to signal found; null = 404.
      const override = mockByTable['CompanyTemplate'];
      const row = override?.single !== undefined ? override.single : (override?.rows?.[0] ?? null);
      return row ? (args.id as string) : null;
    }
    if (p.includes('org.templates.stampPublished')) {
      convexTemplateStampArgs.push(args);
      return undefined;
    }
    if (p.includes('support.templates.createFromSource')) {
      convexCreateArgs.push(args);
      return { id: `mt_${convexCreateArgs.length}` };
    }
    if (p.includes('support.templates.updateFromSource')) {
      convexUpdateArgs.push(args);
      return { updated: true };
    }
    return undefined;
  });
  authState = {
    clerkId: 'clerk_1',
    dbUserId: 'u_1',
    companyRole: 'manager_owner',
    companyId: 'b_1',
  };
});

// A fully-formed CompanyTemplate row — used as the `single` payload the
// supabase mock returns from `.single()`/`.maybeSingle()` calls on the
// CompanyTemplate table. Version/publish counters default to an initial
// (unpublished) state; tests override fields as needed.
function makeTemplateRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 't_1',
    companyId: 'b_1',
    name: 'Follow-up #1',
    category: 'follow-up',
    channel: 'email',
    subject: 'Checking in',
    body: 'Hi {{firstName}}, just checking in.',
    version: 1,
    publishedAt: null,
    publishedCount: 0,
    createdByUserId: 'u_1',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/manager/templates
// ──────────────────────────────────────────────────────────────────────────
describe('POST /api/manager/templates', () => {
  async function invoke(body: unknown): Promise<Response> {
    const mod = await import('@/app/api/manager/templates/route');
    return mod.POST(postReq('http://x/api/manager/templates', body) as never);
  }

  it('403 when caller role is seller_member', async () => {
    authState.companyRole = 'seller_member';
    const res = await invoke({
      name: 'Intro',
      category: 'intro',
      channel: 'email',
      subject: 'Hi',
      body: 'Welcome!',
    });
    expect(res.status).toBe(403);
  });

  it('400 when name is missing', async () => {
    const res = await invoke({
      // no name
      category: 'intro',
      channel: 'email',
      subject: 'Hi',
      body: 'Welcome!',
    });
    expect(res.status).toBe(400);
  });

  it('400 when body > 5000 chars', async () => {
    const res = await invoke({
      name: 'Huge',
      category: 'intro',
      channel: 'email',
      subject: 'Hi',
      body: 'x'.repeat(5001),
    });
    expect(res.status).toBe(400);
  });

  it('400 when category is not in the enum', async () => {
    const res = await invoke({
      name: 'Bad category',
      category: 'bogus-category',
      channel: 'email',
      subject: 'Hi',
      body: 'Welcome!',
    });
    expect(res.status).toBe(400);
  });

  it('201 on happy path — inserted row has version=1', async () => {
    // The route inserts and selects the row back. Steer the CompanyTemplate
    // `single` payload so the returned body matches what we'd expect the DB
    // to have written.
    mockByTable.CompanyTemplate = {
      single: makeTemplateRow({
        id: 't_new',
        name: 'Intro #1',
        category: 'intro',
        channel: 'email',
        subject: 'Hi',
        body: 'Welcome!',
        version: 1,
        publishedAt: null,
        publishedCount: 0,
      }),
    };

    const res = await invoke({
      name: 'Intro #1',
      category: 'intro',
      channel: 'email',
      subject: 'Hi',
      body: 'Welcome!',
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.version).toBe(1);

    // The Convex create mutation should have been called with the payload.
    // The route derives version=1 on the Convex side (Convex schema sets it),
    // but we verify the returned row (from mockByTable) carries version=1.
    expect(convexTemplateCreateArgs.length).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /api/manager/templates/[id]
// ──────────────────────────────────────────────────────────────────────────
describe('PATCH /api/manager/templates/[id]', () => {
  async function invoke(id: string, body: unknown): Promise<Response> {
    // The [id]/route.ts file is owned by BP6b. If it doesn't exist yet,
    // the dynamic import will throw — which we want (per plan: don't paper
    // over). The test harness reports module-resolution as a test failure.
    const mod = await import('@/app/api/manager/templates/[id]/route');
    return mod.PATCH(patchReq(`http://x/api/manager/templates/${id}`, body) as never, {
      params: Promise.resolve({ id }),
    });
  }

  it('404 when row not in caller company', async () => {
    mockByTable.CompanyTemplate = { single: null };
    const res = await invoke('t_missing', { body: 'new body' });
    expect(res.status).toBe(404);
  });

  it('version increments when body changes (1 → 2)', async () => {
    // First .single() = lookup of existing row at version 1.
    // The route then PATCHes; our mock's .update(...).select().single() will
    // return the same `single` payload (good enough — we assert on the update
    // payload, not the response body).
    mockByTable.CompanyTemplate = {
      single: makeTemplateRow({
        id: 't_1',
        companyId: 'b_1',
        body: 'OLD body',
        version: 1,
      }),
    };

    const res = await invoke('t_1', { body: 'NEW body' });
    // Happy path should be 200. If the API diverged and returns something
    // else, the assertion below will make that obvious.
    expect(res.status).toBe(200);

    // The Convex applyPatch mutation receives { id, companyId, patch }.
    // The patch object carries the incremented version and the new body.
    expect(convexTemplatePatchArgs.length).toBeGreaterThanOrEqual(1);
    const patchCall = convexTemplatePatchArgs[convexTemplatePatchArgs.length - 1] ?? {};
    const patch = (patchCall.patch ?? {}) as Record<string, unknown>;
    expect(patch.version).toBe(2);
    expect(patch.body).toBe('NEW body');
  });

  it('empty patch body → 400 rather than bumping version', async () => {
    // Row exists so we can be sure the 400 comes from validation, not the
    // not-found branch.
    mockByTable.CompanyTemplate = {
      single: makeTemplateRow({ id: 't_1', companyId: 'b_1', version: 1 }),
    };

    const res = await invoke('t_1', {});
    expect(res.status).toBe(400);

    // And no Convex applyPatch mutation should have fired — version must NOT
    // have been bumped just because `updatedAt` would change.
    expect(convexTemplatePatchArgs.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// DELETE /api/manager/templates/[id]
// ──────────────────────────────────────────────────────────────────────────
describe('DELETE /api/manager/templates/[id]', () => {
  async function invoke(id: string): Promise<Response> {
    const mod = await import('@/app/api/manager/templates/[id]/route');
    return mod.DELETE(deleteReq(`http://x/api/manager/templates/${id}`) as never, {
      params: Promise.resolve({ id }),
    });
  }

  it('204 on happy path', async () => {
    mockByTable.CompanyTemplate = {
      single: makeTemplateRow({ id: 't_1', companyId: 'b_1' }),
    };
    const res = await invoke('t_1');
    expect(res.status).toBe(204);
    expect(convexTemplateDeleteArgs.length).toBeGreaterThanOrEqual(1);
  });

  it('404 when row not in company', async () => {
    mockByTable.CompanyTemplate = { single: null };
    const res = await invoke('t_missing');
    expect(res.status).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/manager/templates/[id]/publish
// ──────────────────────────────────────────────────────────────────────────
describe('POST /api/manager/templates/[id]/publish', () => {
  async function invoke(id: string): Promise<Response> {
    const mod = await import('@/app/api/manager/templates/[id]/publish/route');
    return mod.POST(postReq(`http://x/api/manager/templates/${id}/publish`, {}) as never, {
      params: Promise.resolve({ id }),
    });
  }

  it('404 when template not found', async () => {
    mockByTable.CompanyTemplate = { single: null };
    const res = await invoke('t_missing');
    expect(res.status).toBe(404);
  });

  it('403 when caller role is seller_member', async () => {
    authState.companyRole = 'seller_member';
    // Seed template so the failure definitely comes from the role gate.
    mockByTable.CompanyTemplate = {
      single: makeTemplateRow({ id: 't_1', companyId: 'b_1' }),
    };
    const res = await invoke('t_1');
    expect(res.status).toBe(403);
  });

  it('happy path: pushes to 2 agents, skips 1 with sourceVersion=null; publishedCount=2', async () => {
    // Template exists.
    mockByTable.CompanyTemplate = {
      single: makeTemplateRow({
        id: 't_1',
        companyId: 'b_1',
        version: 3,
        body: 'Hello {{firstName}}',
      }),
    };

    // CompanyMembership list — three seller_member rows.
    mockByTable.CompanyMembership = {
      rows: [
        { id: 'm_a', userId: 'u_a', companyId: 'b_1', role: 'seller_member' },
        { id: 'm_b', userId: 'u_b', companyId: 'b_1', role: 'seller_member' },
        { id: 'm_c', userId: 'u_c', companyId: 'b_1', role: 'seller_member' },
      ],
    };

    // Space rows — each agent has one space in company b_1.
    mockByTable.Space = {
      rows: [
        { id: 'space_a', ownerId: 'u_a', companyId: 'b_1' },
        { id: 'space_b', ownerId: 'u_b', companyId: 'b_1' },
        { id: 'space_c', ownerId: 'u_c', companyId: 'b_1' },
      ],
    };

    // Existing MessageTemplate copies (from findCopiesBySource), keyed by
    // spaceId. Agent c's copy has sourceVersion=null (locally edited) — it
    // should be skipped; a and b update.
    convexExistingCopies.push(
      { id: 'mt_a', spaceId: 'space_a', sourceTemplateId: 't_1', sourceVersion: 2 },
      { id: 'mt_b', spaceId: 'space_b', sourceTemplateId: 't_1', sourceVersion: 2 },
      { id: 'mt_c', spaceId: 'space_c', sourceTemplateId: 't_1', sourceVersion: null },
    );

    const res = await invoke('t_1');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pushed: number; skipped: number; publishedAt: string };
    expect(json.pushed).toBe(2);
    expect(json.skipped).toBe(1);
    expect(typeof json.publishedAt).toBe('string');
    // a and b were unedited → updateFromSource fired for each; none inserted.
    expect(convexUpdateArgs).toHaveLength(2);
    expect(convexCreateArgs).toHaveLength(0);

    // CompanyTemplate should have been stamped with publishedCount=2 (and
    // publishedAt set) via the stampPublished Convex mutation.
    expect(convexTemplateStampArgs.length).toBeGreaterThanOrEqual(1);
    const lastStamp = convexTemplateStampArgs[convexTemplateStampArgs.length - 1] ?? {};
    expect(lastStamp.publishedCount).toBe(2);
    expect(lastStamp.publishedAt).toBeTruthy();
  });

  it('pushes into a fresh agent (no prior MessageTemplate) via INSERT', async () => {
    // Template exists.
    mockByTable.CompanyTemplate = {
      single: makeTemplateRow({
        id: 't_1',
        companyId: 'b_1',
        version: 5,
      }),
    };
    // One agent in the company.
    mockByTable.CompanyMembership = {
      rows: [
        { id: 'm_fresh', userId: 'u_fresh', companyId: 'b_1', role: 'seller_member' },
      ],
    };
    // Agent's space.
    mockByTable.Space = {
      rows: [{ id: 'space_fresh', ownerId: 'u_fresh', companyId: 'b_1' }],
    };
    // No MessageTemplate copy exists for this agent yet — findCopiesBySource
    // returns nothing (the default empty seed), so the fresh-insert branch runs.
    convexExistingCopies.length = 0;

    const res = await invoke('t_1');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pushed: number; skipped: number };
    // The spec says fresh copies ARE inserted, so we assert pushed>=1.
    expect(json.pushed).toBeGreaterThanOrEqual(1);

    // And at least one createFromSource should have fanned out, carrying the
    // source linkage + version. (MessageTemplate has no userId column — the
    // route scopes the copy by spaceId, not userId, so we assert on that.)
    expect(convexCreateArgs.length).toBeGreaterThanOrEqual(1);
    const payload = convexCreateArgs[0] ?? {};
    expect(payload.spaceId).toBe('space_fresh');
    expect(payload.sourceTemplateId).toBe('t_1');
    expect(payload.sourceVersion).toBe(5);
  });
});
