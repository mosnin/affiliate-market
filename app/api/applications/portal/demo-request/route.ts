import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

/**
 * POST /api/applications/portal/demo-request
 *
 * Public endpoint — applicant requests a demo from the status portal.
 * Auth: applicationRef + statusPortalToken (same pattern as portal/message).
 *
 * Side effects:
 *   1. Creates an ApplicationMessage with a structured demo-request body
 *      so the existing message thread reflects the ask.
 *   2. Creates an AgentQuestion scoped to the seller's space + this
 *      contact, which surfaces in /cola's focus card / questions panel
 *      so the seller sees it as the next thing that needs them.
 *   3. (TODO follow-up) emails the seller via the existing notify path.
 *
 * Why a structured request and not "just a chat message" — the seller's
 * focus card needs a typed entry to render the right action affordance
 * ("Schedule" + "Reply"). Free-text chat shows up in the existing message
 * thread but doesn't surface in focus mode.
 */
export async function POST(req: NextRequest) {
  let body: {
    applicationRef?: string;
    token?: string;
    preferredTimes?: string;
    productAddress?: string;
    notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { applicationRef, token, preferredTimes, productAddress, notes } = body;

  if (!applicationRef || !token) {
    return NextResponse.json(
      { error: 'applicationRef and token are required' },
      { status: 400 },
    );
  }
  if (!preferredTimes || typeof preferredTimes !== 'string' || !preferredTimes.trim()) {
    return NextResponse.json(
      { error: 'preferredTimes is required' },
      { status: 400 },
    );
  }

  // Format guard — same shape as portal/message
  if (
    typeof applicationRef !== 'string' || applicationRef.length < 10 || applicationRef.length > 64 ||
    typeof token !== 'string' || token.length < 32 || token.length > 128
  ) {
    return NextResponse.json({ error: 'Application not found' }, { status: 404 });
  }

  const trimmedTimes = preferredTimes.trim().slice(0, 500);
  const trimmedAddress = productAddress?.trim().slice(0, 300) ?? '';
  const trimmedNotes = notes?.trim().slice(0, 1000) ?? '';

  // Rate limit. Demo requests are heavier than chat — tighter cap.
  const ip = getClientIp(req);
  const { allowed: ipAllowed } = await checkRateLimit(`portal:demo:ip:${ip}`, 10, 3600);
  if (!ipAllowed) {
    return NextResponse.json(
      { error: 'Too many requests. Try again in a bit.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }
  const tokenKey = token.slice(0, 64);
  const { allowed } = await checkRateLimit(`portal:demo:${tokenKey}`, 5, 3600);
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Try again in a bit.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  // Verify token + application
  const { data: contact, error: contactError } = await supabase
    .from('Contact')
    .select('id, spaceId, name, email')
    .eq('applicationRef', applicationRef)
    .eq('statusPortalToken', token)
    .maybeSingle();

  if (contactError) {
    console.error('[portal/demo-request] Contact lookup error:', contactError);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
  if (!contact) {
    return NextResponse.json({ error: 'Application not found' }, { status: 404 });
  }

  // Sanitize free-text fields. Allowlist same as portal/message — letters,
  // numbers, basic punctuation, whitespace.
  const sanitize = (s: string) =>
    s
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/[^\w\s.,!?;:'"@#$%&*()\-/+=\[\]{}~`^\n\r\t]/g, '');

  const safeTimes = sanitize(trimmedTimes);
  const safeAddress = sanitize(trimmedAddress);
  const safeNotes = sanitize(trimmedNotes);

  // Compose the demo-request body for the message thread.
  const messageBody = [
    '🏠 Demo requested',
    safeAddress ? `Product: ${safeAddress}` : null,
    `Available: ${safeTimes}`,
    safeNotes ? `Notes: ${safeNotes}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const messageInsert = convex().mutation(api.portal.applicationMessages.create, {
    contactId: contact.id,
    spaceId: contact.spaceId,
    senderType: 'applicant',
    content: messageBody,
  });

  // Compose the AgentQuestion that surfaces in the seller's Cola focus
  // card. The question itself is action-oriented; the context carries the
  // structured fields. agentType=applicant_portal flags the source so the
  // UI can render the right action set in a future pass. status is hardcoded
  // 'pending' inside the mutation.
  const questionInsert = convex().mutation(api.agent.questions.create, {
    spaceId: contact.spaceId,
    runId: 'applicant-portal',
    agentType: 'applicant_portal',
    question: `${contact.name} requested a demo${safeAddress ? ` of ${safeAddress}` : ''}.`,
    context: [
      `Available: ${safeTimes}`,
      safeNotes ? `Notes from ${contact.name}: ${safeNotes}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    priority: 50, // mid-high — applicant action; seller should see it today
    contactId: contact.id,
  });

  // Message and AgentQuestion (both Convex, throw on failure) run concurrently;
  // allSettled lets each fail on its own terms.
  const [messageRes, questionRes] = await Promise.allSettled([messageInsert, questionInsert]);

  if (messageRes.status === 'rejected') {
    console.error('[portal/demo-request] Message insert error:', messageRes.reason);
    return NextResponse.json({ error: 'Failed to send demo request' }, { status: 500 });
  }
  if (questionRes.status === 'rejected') {
    // Soft-fail the AgentQuestion — the message landed, the seller sees it.
    // Log for observability but don't 500 the user.
    console.error('[portal/demo-request] Question insert error:', questionRes.reason);
  }

  // Notify seller (fire and forget — same pattern as message endpoint).
  void notifySellerOfDemoRequest(
    contact.spaceId,
    contact.name,
    safeTimes,
    safeAddress,
    safeNotes,
  ).catch((err) =>
    console.error('[portal/demo-request] Seller notification failed:', err),
  );

  return NextResponse.json({ message: messageRes.value }, { status: 201 });
}

/**
 * Email the seller about a new demo request. Same template family as
 * portal/message's notification, with a clearer "demo requested" subject
 * and a structured body.
 */
async function notifySellerOfDemoRequest(
  spaceId: string,
  applicantName: string,
  preferredTimes: string,
  productAddress: string,
  notes: string,
): Promise<void> {
  if (!process.env.RESEND_API_KEY) return;

  const [{ data: space }, { data: settings }] = await Promise.all([
    supabase.from('Space').select('ownerId, name, slug').eq('id', spaceId).maybeSingle(),
    supabase
      .from('SpaceSetting')
      .select('notifications, businessName')
      .eq('spaceId', spaceId)
      .maybeSingle(),
  ]);
  if (!space) return;
  if (settings && !settings.notifications) return;

  const { data: owner } = await supabase
    .from('User')
    .select('email')
    .eq('id', space.ownerId)
    .maybeSingle();
  if (!owner?.email) return;

  const { Resend } = await import('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const FROM = process.env.RESEND_FROM_EMAIL?.includes('@')
    ? process.env.RESEND_FROM_EMAIL
    : `notifications@${process.env.RESEND_FROM_EMAIL ?? 'alerts.usecola.com'}`;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://my.usecola.com';
  const escape = (s: string) =>
    s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n\t]/g, ' ').slice(0, 500);
  const safeName = escape(applicantName).slice(0, 100);

  await resend.emails.send({
    from: FROM,
    to: owner.email,
    subject: `Demo requested by ${safeName}`,
    html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 16px">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">
        <tr><td style="background:#0f172a;padding:20px 28px">
          <p style="margin:0;color:#94a3b8;font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.05em">${space.name}</p>
          <p style="margin:4px 0 0;color:#ffffff;font-size:20px;font-weight:700">Demo requested</p>
        </td></tr>
        <tr><td style="padding:24px 28px">
          <p style="margin:0 0 12px;font-size:14px;color:#111827"><strong>${safeName}</strong> just requested a demo through their applicant portal.</p>
          <div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:12px 0">
            ${productAddress ? `<p style="margin:0 0 6px;font-size:13px;color:#374151"><strong>Product:</strong> ${escape(productAddress)}</p>` : ''}
            <p style="margin:0 0 6px;font-size:13px;color:#374151"><strong>Available:</strong> ${escape(preferredTimes)}</p>
            ${notes ? `<p style="margin:8px 0 0;font-size:13px;color:#374151"><strong>Notes:</strong> ${escape(notes)}</p>` : ''}
          </div>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px">
            <tr><td>
              <a href="${appUrl}/s/${space.slug}/cola" style="display:inline-block;background:#0f172a;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 22px;border-radius:8px">Open in Cola &rarr;</a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #f1f5f9">
          <p style="margin:0;font-size:11px;color:#9ca3af">This appears in your Cola focus card so you can schedule it inline.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}
