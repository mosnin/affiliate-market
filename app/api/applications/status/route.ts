import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireContactAccess } from '@/lib/api-auth';

/**
 * PATCH — Update application status (agent-facing, authenticated).
 * Used from the contact detail page to change application status.
 * Also creates an ApplicationStatusUpdate audit trail record.
 */
export async function PATCH(req: NextRequest) {
  const { contactId, status, statusNote } = await req.json();

  if (!contactId || !status) {
    return NextResponse.json({ error: 'contactId and status required' }, { status: 400 });
  }

  const validStatuses = ['received', 'under_review', 'demo_scheduled', 'approved', 'needs_info', 'declined', 'waitlisted'];
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const auth = await requireContactAccess(contactId);
  if (auth instanceof NextResponse) return auth;

  // Get current status for audit trail
  const currentContact = await convex().query(api.contacts.contacts.getById, { id: contactId });

  const patch: Record<string, any> = {
    applicationStatus: status,
  };
  if (statusNote !== undefined) {
    patch.applicationStatusNote = statusNote?.trim() || null;
  }

  await convex().mutation(api.contacts.contacts.update, {
    id: contactId,
    patch,
  });

  // Create audit trail record
  if (currentContact) {
    await convex().mutation(api.portal.applicationStatus.create, {
      contactId,
      spaceId: currentContact.spaceId,
      fromStatus: currentContact.applicationStatus ?? null,
      toStatus: status,
      note: statusNote?.trim() || null,
    }).catch((auditErr) => {
      console.warn('[status] Audit insert failed (non-fatal):', auditErr);
    });
  }

  return NextResponse.json({ success: true, status });
}
