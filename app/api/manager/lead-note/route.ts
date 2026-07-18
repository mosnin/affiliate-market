import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { z } from 'zod';

const addNoteSchema = z.object({
  contactId: z.string().uuid('Invalid contact ID'),
  note: z.string().min(1, 'Note cannot be empty').max(2000, 'Note too long'),
});

/**
 * POST /api/manager/lead-note
 *
 * Appends a manager note to a contact's notes field.
 * The note is prefixed with "[Manager: Name - Date]" so sellers can see who wrote it.
 * Works on contacts in both the manager's space (unassigned) and seller spaces (assigned).
 */
export async function POST(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireManager();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { company, dbUserId } = ctx;

  let requestBody: unknown;
  try {
    requestBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = addNoteSchema.safeParse(requestBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request data', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { contactId, note } = parsed.data;

  try {
    // Get manager user's name
    let managerUser: { name: string | null; email: string | null } | null = null;
    try {
      managerUser = await convex().query(api.org.users.getById, { id: dbUserId });
    } catch {
      managerUser = null;
    }
    const managerName = managerUser?.name ?? managerUser?.email ?? 'Manager';

    // Find the manager's space
    let ownerSpace: { id: string } | null = null;
    try {
      ownerSpace = await convex().query(api.workspace.spaces.getByOwnerId, {
        ownerId: company.ownerId,
      });
    } catch {
      ownerSpace = null;
    }
    const managerSpaceId = ownerSpace?.id ?? null;

    // First check: is this contact in the manager's own space?
    let contact: {
      id: string;
      notes: string | null;
      spaceId: string;
      applicationStatusNote: string | null;
    } | null = null;
    try {
      contact = await convex().query(api.contacts.contacts.getById, { id: contactId });
    } catch {
      contact = null;
    }

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    // Verify the contact belongs to manager space or a seller in this company
    let authorized = false;

    if (contact.spaceId === managerSpaceId) {
      authorized = true;
    } else {
      // Check if the contact's space belongs to a company member
      let spaceOwner: { ownerId: string } | null = null;
      try {
        spaceOwner = await convex().query(api.workspace.spaces.getById, {
          id: contact.spaceId,
        });
      } catch {
        spaceOwner = null;
      }

      if (spaceOwner) {
        let membership: { id: string } | null = null;
        try {
          membership = await convex().query(api.org.memberships.getByCompanyUser, {
            companyId: company.id,
            userId: spaceOwner.ownerId,
          });
        } catch {
          membership = null;
        }
        if (membership) authorized = true;
      }
    }

    if (!authorized) {
      return NextResponse.json({ error: 'Not authorized to add notes to this contact' }, { status: 403 });
    }

    // Build the note prefix
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const prefix = `[Manager: ${managerName} - ${dateStr}]`;
    const newNote = `${prefix} ${note}`;

    // Prepend to existing notes (newest first)
    const existingNotes = contact.notes ?? '';
    const updatedNotes = existingNotes
      ? `${newNote}\n\n${existingNotes}`
      : newNote;

    await convex().mutation(api.contacts.contacts.update, {
      id: contactId,
      patch: { notes: updatedNotes },
      updatedAt: now.toISOString(),
    });

    // If this is an assigned lead, also add the note to the seller's copy
    if (contact.spaceId === managerSpaceId && contact.applicationStatusNote) {
      try {
        const meta = JSON.parse(contact.applicationStatusNote);
        if (meta.assignedContactId) {
          const sellerContact = await convex().query(api.contacts.contacts.getById, {
            id: meta.assignedContactId,
          });

          if (sellerContact) {
            const sellerExisting = sellerContact.notes ?? '';
            const sellerUpdated = sellerExisting
              ? `${newNote}\n\n${sellerExisting}`
              : newNote;

            await convex().mutation(api.contacts.contacts.update, {
              id: meta.assignedContactId,
              patch: { notes: sellerUpdated },
              updatedAt: now.toISOString(),
            });
          }
        }
      } catch {
        // If parsing fails, skip syncing to seller copy
      }
    }

    return NextResponse.json({
      success: true,
      note: newNote,
      updatedNotes,
    });
  } catch (error) {
    console.error('[lead-note] error', { contactId, error });
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

/**
 * GET /api/manager/lead-note?contactId=xxx
 *
 * Returns the notes for a contact (manager must have access).
 */
export async function GET(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireManager();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { company } = ctx;

  const contactId = req.nextUrl.searchParams.get('contactId');
  if (!contactId) {
    return NextResponse.json({ error: 'contactId required' }, { status: 400 });
  }

  try {
    let contact: { id: string; notes: string | null; spaceId: string } | null = null;
    try {
      contact = await convex().query(api.contacts.contacts.getById, { id: contactId });
    } catch {
      contact = null;
    }

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    // Verify the contact belongs to the manager's space or a company member's space
    let ownerSpace: { id: string } | null = null;
    try {
      ownerSpace = await convex().query(api.workspace.spaces.getByOwnerId, {
        ownerId: company.ownerId,
      });
    } catch {
      ownerSpace = null;
    }
    const managerSpaceId = ownerSpace?.id ?? null;

    let authorized = false;

    if (contact.spaceId === managerSpaceId) {
      authorized = true;
    } else {
      // Check if the contact's space belongs to a company member
      let spaceOwner: { ownerId: string } | null = null;
      try {
        spaceOwner = await convex().query(api.workspace.spaces.getById, {
          id: contact.spaceId,
        });
      } catch {
        spaceOwner = null;
      }

      if (spaceOwner) {
        let membership: { id: string } | null = null;
        try {
          membership = await convex().query(api.org.memberships.getByCompanyUser, {
            companyId: company.id,
            userId: spaceOwner.ownerId,
          });
        } catch {
          membership = null;
        }
        if (membership) authorized = true;
      }
    }

    if (!authorized) {
      return NextResponse.json({ error: 'Not authorized to view notes for this contact' }, { status: 403 });
    }

    return NextResponse.json({ notes: contact.notes ?? '' });
  } catch (error) {
    console.error('[lead-note] GET error', { contactId, error });
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
