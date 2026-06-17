import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAdmin, logAdminAction } from '@/lib/admin';
import { checkRateLimit } from '@/lib/rate-limit';
import { scoreLeadApplicationDynamic } from '@/lib/lead-scoring';
import type { LeadScoringResult } from '@/lib/lead-scoring';
import { getFormConfigs } from '@/lib/form-builder';
import { formConfigSchema, type IntakeFormConfig } from '@/lib/form-config-schema';
import type { ScoringModel } from '@/lib/scoring/scoring-model-types';
import type { ApplicationData } from '@/lib/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  let admin: { userId: string };
  try {
    admin = await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { allowed } = await checkRateLimit(`retry-scoring:${admin.userId}`, 20, 60);
  if (!allowed) {
    return NextResponse.json({ error: 'Too many retries. Try again shortly.' }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const contactId = typeof body.contactId === 'string' ? body.contactId : '';
  if (!contactId || !UUID_RE.test(contactId)) {
    return NextResponse.json({ error: 'Invalid contactId' }, { status: 400 });
  }

  try {
    const contactRow = await convex().query(api.contacts.contacts.getById, { id: contactId });
    if (!contactRow) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    // Compose the embedded Space(id, companyId) lib-side (the old PostgREST join).
    const spaceRow = await convex().query(api.workspace.spaces.getById, {
      id: contactRow.spaceId,
    });

    const contact = {
      ...(contactRow as unknown as {
        id: string;
        spaceId: string;
        name: string;
        email: string | null;
        phone: string | null;
        budget: number | null;
        leadType: 'rental' | 'buyer';
        formLeadType: 'rental' | 'buyer' | null;
        applicationData: Record<string, unknown> | null;
        formConfigSnapshot: IntakeFormConfig | null;
        scoringStatus: string;
      }),
      Space: spaceRow
        ? { id: spaceRow.id, companyId: spaceRow.companyId }
        : (null as { id: string; companyId: string | null } | null),
    };

    const oldStatus = contact.scoringStatus;
    const resolvedLeadType: 'rental' | 'buyer' =
      contact.formLeadType ?? contact.leadType ?? 'rental';

    // Mark as pending immediately so the UI reflects in-flight state
    await convex().mutation(api.contacts.contacts.update, {
      id: contact.id,
      patch: { scoringStatus: 'pending' },
    });

    // Resolve form config: prefer the snapshot stored with the contact,
    // fall back to current configured form for the space.
    let formConfig: IntakeFormConfig | null = null;
    if (contact.formConfigSnapshot) {
      const parsed = formConfigSchema.safeParse(contact.formConfigSnapshot);
      if (parsed.success) formConfig = parsed.data;
    }
    if (!formConfig && contact.Space) {
      try {
        const dual = await getFormConfigs(contact.spaceId, contact.Space.companyId);
        formConfig = resolvedLeadType === 'buyer' ? dual.buyer : dual.rental;
      } catch (err) {
        console.warn('[retry-scoring] getFormConfigs failed', { err });
      }
    }

    // Resolve scoring model
    let scoringModel: ScoringModel | null = null;
    try {
      const scoringColumn =
        resolvedLeadType === 'buyer' ? 'buyerScoringModel' : 'rentalScoringModel';
      const settingRow = await convex().query(api.workspace.settings.getBySpace, {
        spaceId: contact.spaceId,
      });
      if (settingRow) {
        scoringModel = (settingRow as Record<string, unknown>)[scoringColumn] as
          | ScoringModel
          | null;
      }
    } catch (err) {
      console.warn('[retry-scoring] scoring model fetch failed', { err });
    }

    const applicationData = (contact.applicationData ?? {}) as Record<string, unknown>;

    let scoring: LeadScoringResult;
    try {
      scoring = await scoreLeadApplicationDynamic({
        contactId: contact.id,
        formConfig,
        answers: formConfig
          ? (applicationData as Record<string, string | string[] | number | boolean>)
          : undefined,
        name: contact.name,
        email: contact.email,
        phone: contact.phone ?? '',
        budget: contact.budget,
        applicationData: !formConfig
          ? (applicationData as ApplicationData | null)
          : undefined,
        leadType: resolvedLeadType,
        scoringModel,
      });
    } catch (err) {
      console.error('[retry-scoring] scoring threw', { contactId: contact.id, err });
      await convex().mutation(api.contacts.contacts.update, {
        id: contact.id,
        patch: {
          scoringStatus: 'failed',
          scoreSummary: 'Scoring unavailable right now.',
        },
      });

      await logAdminAction({
        actor: admin.userId,
        action: 'retry_scoring',
        target: contact.id,
        details: { oldStatus, newStatus: 'failed', error: err instanceof Error ? err.message : String(err) },
      });

      return NextResponse.json(
        { success: false, scoringStatus: 'failed', error: 'Scoring failed' },
        { status: 200 },
      );
    }

    await convex().mutation(api.contacts.contacts.update, {
      id: contact.id,
      patch: {
        scoringStatus: scoring.scoringStatus,
        leadScore: scoring.leadScore,
        scoreLabel: scoring.scoreLabel,
        scoreSummary: scoring.scoreSummary,
        scoreDetails: scoring.scoreDetails,
      },
    });

    await logAdminAction({
      actor: admin.userId,
      action: 'retry_scoring',
      target: contact.id,
      details: { oldStatus, newStatus: scoring.scoringStatus, scoreLabel: scoring.scoreLabel },
    });

    return NextResponse.json({
      success: true,
      scoringStatus: scoring.scoringStatus,
      leadScore: scoring.leadScore,
      scoreLabel: scoring.scoreLabel,
    });
  } catch (err) {
    console.error('[retry-scoring] unhandled failure', { err });
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
