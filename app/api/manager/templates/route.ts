import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { getManagerMemberContext } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { audit } from '@/lib/audit';
import { logger } from '@/lib/logger';

// ── Shared types / schema ─────────────────────────────────────────────────────
//
// These shapes mirror the `CompanyTemplate` table introduced in Phase BP6a.
// Columns live in the DB as-is (versioned rows, not JSON blobs) so the row
// type is just the table row.

type TemplateCategory = 'follow-up' | 'intro' | 'closing' | 'demo-invite';
type TemplateChannel = 'sms' | 'email' | 'note';

type CompanyTemplateRow = {
  id: string;
  companyId: string;
  name: string;
  category: TemplateCategory;
  channel: TemplateChannel;
  subject: string | null;
  body: string;
  version: number;
  publishedAt: string | null;
  publishedVersion: number | null;
  publishedCount: number;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  category: z.enum(['follow-up', 'intro', 'closing', 'demo-invite']),
  channel: z.enum(['sms', 'email', 'note']),
  subject: z
    .union([z.string().max(200), z.null()])
    .optional(),
  body: z.string().min(1).max(5000),
});

// ── GET — any manager member may read their company's templates ──────────────

/**
 * GET /api/manager/templates
 *
 * Returns the company's template library ordered by updatedAt DESC.
 * All manager-scoped members (owner, admin, seller) can read — viewing the
 * library is a prerequisite for agents to pull published copies.
 */
export async function GET(): Promise<NextResponse> {
  const ctx = await getManagerMemberContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let data: CompanyTemplateRow[];
  try {
    data = (await convex().query(api.org.templates.listByCompany, {
      companyId: ctx.company.id,
    })) as CompanyTemplateRow[];
  } catch (error) {
    logger.error(
      '[manager/templates/GET] list failed',
      { companyId: ctx.company.id },
      error as Error,
    );
    return NextResponse.json({ error: 'Failed to load templates' }, { status: 500 });
  }

  return NextResponse.json((data ?? []) as CompanyTemplateRow[]);
}

// ── POST — create a new template (manager_owner / manager_admin only) ───────────

/**
 * POST /api/manager/templates
 *
 * Body: { name, category, channel, subject?, body }
 * Restricted to manager_owner / manager_admin. Seller members may read the
 * library but cannot author it.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { userId: clerkId } = await auth();

  const ctx = await getManagerMemberContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (ctx.membership.role !== 'manager_owner' && ctx.membership.role !== 'manager_admin') {
    return NextResponse.json(
      { error: 'Only the owner or admins can create templates' },
      { status: 403 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = createSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid data', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Normalise: non-email channels never carry a subject; for email we store
  // the provided subject (or null if absent/empty). Keeps data tidy and stops
  // stray subject text from leaking onto SMS/note renders.
  const { name, category, channel, body } = parsed.data;
  const subject =
    channel === 'email'
      ? (parsed.data.subject ?? null) || null
      : null;

  let inserted: CompanyTemplateRow | null = null;
  try {
    inserted = (await convex().mutation(api.org.templates.create, {
      companyId: ctx.company.id,
      name,
      category,
      channel,
      subject,
      body,
      createdByUserId: ctx.dbUserId,
    })) as CompanyTemplateRow;
  } catch (insertErr) {
    logger.error(
      '[manager/templates/POST] insert failed',
      { companyId: ctx.company.id },
      insertErr as Error,
    );
    return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
  }
  if (!inserted) {
    logger.error('[manager/templates/POST] insert failed', { companyId: ctx.company.id });
    return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
  }

  void audit({
    actorClerkId: clerkId ?? null,
    action: 'CREATE',
    resource: 'CompanyTemplate',
    resourceId: inserted.id,
    req,
    metadata: {
      companyId: ctx.company.id,
      name: inserted.name,
      category: inserted.category,
      channel: inserted.channel,
    },
  });

  return NextResponse.json(inserted, { status: 201 });
}
