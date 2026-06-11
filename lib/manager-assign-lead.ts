import { supabase } from '@/lib/supabase';
import { getSpaceByOwnerId } from '@/lib/space';
import { notifyNewLead } from '@/lib/notify';

export type AssignLeadResult =
  | { ok: true; newContactId: string; assignedToSpaceId: string }
  | { ok: false; error: string; status: number };

/**
 * Assign a company lead (Contact) from the manager's space into a seller's
 * space: clone the contact, mark the original as assigned, notify the seller.
 *
 * Shared by POST /api/manager/assign-lead and the /assign team-chat command so
 * the two can never drift. Callers MUST verify the caller is a manager who can
 * manage leads before calling this — it performs no auth of its own.
 */
export async function assignLeadToSeller(params: {
  company: { id: string; ownerId: string; name: string };
  assignedByUserId: string;
  contactId: string;
  sellerUserId: string;
}): Promise<AssignLeadResult> {
  const { company, assignedByUserId, contactId, sellerUserId } = params;

  // ── Find the manager's space ────────────────────────────────────────────
  const managerSpace = await getSpaceByOwnerId(company.ownerId);
  if (!managerSpace) {
    return { ok: false, error: 'Manager space not found', status: 500 };
  }

  // ── Verify the contact belongs to this company ───────────────────────
  // Accept contacts in the manager owner's space (legacy path) OR contacts
  // where companyId is explicitly set (modern intake path).
  const { data: contactInSpace, error: contactError } = await supabase
    .from('Contact')
    .select('*')
    .eq('id', contactId)
    .eq('spaceId', managerSpace.id)
    .maybeSingle();
  if (contactError) throw contactError;

  let contact = contactInSpace;
  if (!contact) {
    const { data: contactByCompanyId, error: companyContactError } = await supabase
      .from('Contact')
      .select('*')
      .eq('id', contactId)
      .eq('companyId', company.id)
      .maybeSingle();
    if (companyContactError) throw companyContactError;
    contact = contactByCompanyId;
  }

  if (!contact) {
    return { ok: false, error: 'Contact not found in your company space', status: 404 };
  }

  // ── Verify the seller is a member of this company ───────────────────
  const { data: sellerMembership, error: memberError } = await supabase
    .from('CompanyMembership')
    .select('id, role, userId')
    .eq('companyId', company.id)
    .eq('userId', sellerUserId)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!sellerMembership) {
    return { ok: false, error: 'User is not a member of this company', status: 403 };
  }

  // ── Find the seller's space ───────────────────────────────────────────
  const sellerSpace = await getSpaceByOwnerId(sellerUserId);
  if (!sellerSpace) {
    return { ok: false, error: 'Member does not have a workspace yet', status: 404 };
  }

  // ── Fetch the seller's name ───────────────────────────────────────────
  const { data: sellerUser } = await supabase
    .from('User')
    .select('name, email')
    .eq('id', sellerUserId)
    .maybeSingle();
  const sellerName = sellerUser?.name ?? sellerUser?.email ?? sellerUserId;

  // ── Prevent double-assignment ──────────────────────────────────────────
  const existingTags: string[] = contact.tags ?? [];
  if (existingTags.includes('assigned')) {
    return { ok: false, error: 'This lead has already been assigned', status: 409 };
  }

  // ── Clone the contact into the seller's space ─────────────────────────
  const newContactId = crypto.randomUUID();
  const now = new Date().toISOString();

  const { error: cloneError } = await supabase.from('Contact').insert({
    id: newContactId,
    spaceId: sellerSpace.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    budget: contact.budget,
    preferences: contact.preferences,
    address: contact.address,
    notes: contact.notes,
    type: contact.type,
    products: contact.products ?? [],
    tags: ['assigned-by-manager', 'new-lead'],
    scoringStatus: contact.scoringStatus,
    leadScore: contact.leadScore,
    scoreLabel: contact.scoreLabel,
    scoreSummary: contact.scoreSummary,
    scoreDetails: contact.scoreDetails,
    sourceLabel: `company: ${company.name}`,
    applicationData: contact.applicationData,
    applicationRef: contact.applicationRef,
    applicationStatus: contact.applicationStatus,
  });
  if (cloneError) throw cloneError;

  // ── Mark the original contact as assigned ──────────────────────────────
  const assignmentNote = [
    contact.notes,
    `\nAssigned to: ${sellerName}`,
    `--- Assigned to seller (${sellerUserId}) on ${now} by ${assignedByUserId} ---`,
  ]
    .filter(Boolean)
    .join('\n');

  const assignmentMeta = JSON.stringify({
    assignedTo: sellerUserId,
    assignedToName: sellerName,
    assignedContactId: newContactId,
    assignedSpaceId: sellerSpace.id,
    assignedAt: now,
  });

  const { error: updateError } = await supabase
    .from('Contact')
    .update({
      tags: [...existingTags.filter((t: string) => t !== 'new-lead'), 'assigned'],
      notes: assignmentNote,
      applicationStatus: 'assigned',
      applicationStatusNote: assignmentMeta,
      updatedAt: now,
    })
    .eq('id', contactId);
  if (updateError) throw updateError;

  console.info('[assign-lead] lead assigned', {
    contactId,
    newContactId,
    companyId: company.id,
    sellerUserId,
    assignedBy: assignedByUserId,
  });

  // ── Notify the seller (best-effort — never fail the assignment) ───────
  try {
    await notifyNewLead({
      spaceId: sellerSpace.id,
      contactId: newContactId,
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      leadScore: contact.leadScore,
      scoreLabel: contact.scoreLabel,
      scoreSummary: contact.scoreSummary,
      applicationData: contact.applicationData,
    });
  } catch (e) {
    console.error('[assign-lead] notification failed:', { newContactId, e });
  }

  return { ok: true, newContactId, assignedToSpaceId: sellerSpace.id };
}
