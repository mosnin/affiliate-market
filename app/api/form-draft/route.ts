import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { sendDraftResumeEmail } from '@/lib/email';

// ── Schemas ─────────────────────────────────────────────────────────────────

const createDraftSchema = z.object({
  spaceId: z.string().min(1),
  email: z.string().trim().email().max(255),
  answers: z.record(z.string(), z.unknown()),
  currentStep: z.number().int().min(0).default(0),
  formConfigVersion: z.number().int().optional(),
  completed: z.boolean().optional(),
});

// ── POST: Create or update a draft ──────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = createDraftSchema.safeParse(body);
  if (!parsed.success) {
    // Only return minimal error info to prevent schema leakage
    const safeIssues = parsed.error.issues.map((i) => ({
      path: i.path,
      message: i.message,
    }));
    return NextResponse.json(
      { error: 'Invalid draft data', issues: safeIssues },
      { status: 400 },
    );
  }

  const { spaceId, email, answers, currentStep, formConfigVersion, completed } = parsed.data;

  // Guard against oversized payloads: limit answers to 500KB serialized
  const answersSize = JSON.stringify(answers).length;
  if (answersSize > 512_000) {
    return NextResponse.json({ error: 'Draft data too large' }, { status: 413 });
  }
  // Limit number of answer keys to prevent abuse
  if (Object.keys(answers).length > 500) {
    return NextResponse.json({ error: 'Too many answer fields' }, { status: 400 });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Rate limit by IP to prevent abuse from rotating email addresses
  const ip = getClientIp(req);
  const { allowed: ipAllowed } = await checkRateLimit(`draft:save:ip:${ip}`, 60, 3600);
  if (!ipAllowed) {
    return NextResponse.json(
      { error: 'Too many saves. Try again in a bit.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  // Rate limit: 30 saves per email per hour
  const { allowed } = await checkRateLimit(`draft:save:${normalizedEmail}`, 30, 3600);
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many saves. Try again in a bit.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  // Verify the space exists
  const space = await convex().query(api.workspace.spaces.getById, { id: spaceId });

  if (!space) {
    return NextResponse.json({ error: 'Space not found' }, { status: 404 });
  }

  try {
    // Check for existing non-expired draft for this space + email
    const existingDraft = await convex().query(api.portal.formDrafts.findOpenForEmail, {
      spaceId,
      email: normalizedEmail,
      now: new Date().toISOString(),
    });

    if (existingDraft) {
      // Update existing draft
      await convex().mutation(api.portal.formDrafts.update, {
        id: existingDraft.id,
        answers,
        currentStep,
        formConfigVersion: formConfigVersion ?? null,
        completed: completed ?? undefined,
      });

      return NextResponse.json({
        draftId: existingDraft.id,
        updated: true,
      });
    }

    // Create new draft with a cryptographically secure resume token
    const resumeToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    const newDraft = await convex().mutation(api.portal.formDrafts.create, {
      spaceId,
      email: normalizedEmail,
      resumeToken,
      answers,
      currentStep,
      formConfigVersion: formConfigVersion ?? null,
      expiresAt,
    });

    // Fetch the business name for the email
    const settings = await convex().query(api.workspace.settings.getBySpace, { spaceId });

    const businessName = settings?.businessName || space.name;

    // Send the resume email (fire-and-forget — don't block the response)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://my.usecola.com';
    const resumeUrl = `${appUrl}/apply/${space.slug}?resume=${resumeToken}`;

    sendDraftResumeEmail({
      toEmail: normalizedEmail,
      businessName,
      resumeUrl,
    }).catch((err) => {
      console.error('[form-draft] Failed to send resume email:', err);
    });

    return NextResponse.json({
      draftId: newDraft.id,
      updated: false,
    }, { status: 201 });
  } catch (error) {
    console.error('[form-draft] Failed to save draft:', error);
    return NextResponse.json({ error: "Server hiccup — usually temporary." }, { status: 500 });
  }
}

// ── GET: Load a draft by resume token ───────────────────────────────────────

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');

  if (!token || token.length !== 64) {
    return NextResponse.json({ error: 'Invalid or missing token' }, { status: 400 });
  }

  // Validate token format: must be hex only
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return NextResponse.json({ error: 'Invalid or missing token' }, { status: 400 });
  }

  // Rate limit by IP to prevent resume token brute-force
  const ip = getClientIp(req);
  const { allowed } = await checkRateLimit(`draft:get:${ip}`, 20, 3600);
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Try again in a bit.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  try {
    const draft = await convex().query(api.portal.formDrafts.getByResumeToken, {
      resumeToken: token,
    });

    if (!draft) {
      return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
    }

    // Check expiration (lazy deletion)
    if (new Date(draft.expiresAt) < new Date()) {
      return NextResponse.json({ error: 'This link has expired' }, { status: 410 });
    }

    // Check if already completed
    if (draft.completedAt) {
      return NextResponse.json({ error: 'This application has already been submitted' }, { status: 410 });
    }

    // Look up the space slug (don't return email or other PII)
    const space = await convex().query(api.workspace.spaces.getById, { id: draft.spaceId });

    return NextResponse.json({
      answers: draft.answers,
      currentStep: draft.currentStep,
      formConfigVersion: draft.formConfigVersion,
      spaceSlug: space?.slug ?? null,
    });
  } catch (error) {
    console.error('[form-draft] Failed to load draft:', error);
    return NextResponse.json({ error: "Server hiccup — usually temporary." }, { status: 500 });
  }
}
