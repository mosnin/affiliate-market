/**
 * Client-portal data — two layers:
 *
 * 1. LEGACY (kept for API routes that own their own paths):
 *    `getClientPortalData` and `clientOwnsContact` still read Contact/Demo rows
 *    so the existing /api/clients/** routes continue to work unchanged.
 *
 * 2. BUYER PORTAL (new):
 *    The buyer dashboard uses `getOrdersForBuyerEmail` and
 *    `getLicensesForBuyerEmail` from lib/marketplace/orders directly —
 *    those are imported there, not here. This file is only the aggregation
 *    layer for the old client portal surfaces.
 *
 * Authorization boundary: `email` MUST always be the verified session email.
 */
import 'server-only';
import { convex, api } from '@/lib/convex-server';

export interface PortalApplication {
  contactId: string;
  name: string | null;
  status: string;
  statusNote: string | null;
  applicationRef: string | null;
  spaceId: string;
  sellerName: string | null;
  sellerSlug: string | null;
  createdAt: string;
}

export interface PortalDemo {
  id: string;
  productAddress: string | null;
  startsAt: string | null;
  status: string | null;
  spaceId: string;
  contactId: string | null;
  sellerName: string | null;
  sellerSlug: string | null;
}

export interface ClientPortalData {
  applications: PortalApplication[];
  demos: PortalDemo[];
  /** Contact ids this client owns (by verified email) — the scope for
   *  messaging, documents, and info-requests. */
  contactIds: string[];
}

type SpaceRel = { name?: string | null; slug?: string | null } | null;

/**
 * Pull the client's applications + demos by email. `email` MUST be the verified
 * session email — it is the only authorization check, so never pass an
 * unverified or caller-supplied address here.
 */
export async function getClientPortalData(email: string): Promise<ClientPortalData> {
  const lower = email.trim().toLowerCase();

  const [contacts, demoRows] = await Promise.all([
    // Every contact across all spaces for this verified email, newest-first
    // (the fn lower-cases + matches case-insensitively, mirroring ilike).
    convex().query(api.contacts.contacts.listByEmailAllSpaces, { email: lower }),
    // Demos for this verified email, newest-first. The Space(name, slug) join
    // can't ride a Convex query, so resolve seller names from Space separately
    // and stitch them in below.
    convex().query(api.demos.demos.listByGuestEmail, { guestEmail: lower, order: 'desc' }),
  ]);

  // Batch-resolve the seller name/slug for every space the contacts AND demos
  // belong to (the Contact/Space and Demo/Space embeds, done in one lookup).
  const spaceIds = Array.from(
    new Set([
      ...(contacts as { spaceId: string }[]).map((c) => c.spaceId),
      ...(demoRows as { spaceId: string }[]).map((t) => t.spaceId),
    ]),
  );
  const spaceMap = new Map<string, { name: string | null; slug: string | null }>();
  if (spaceIds.length > 0) {
    const spaceRows = await convex().query(api.workspace.spaces.listByIds, { ids: spaceIds });
    for (const s of (spaceRows ?? []) as { id: string; name: string | null; slug: string | null }[]) {
      spaceMap.set(s.id, { name: s.name ?? null, slug: s.slug ?? null });
    }
  }
  const demos = (demoRows as Array<Record<string, unknown>>).map((t) => ({
    ...t,
    Space: spaceMap.get(t.spaceId as string) ?? null,
  })) as Array<Record<string, unknown> & { Space: { name: string | null; slug: string | null } | null }>;

  const applications: PortalApplication[] = (contacts ?? []).map((c) => {
    const space = spaceMap.get(c.spaceId as string) ?? null;
    return {
      contactId: c.id as string,
      name: (c.name as string | null) ?? null,
      status: (c.applicationStatus as string | null) ?? 'received',
      statusNote: (c.applicationStatusNote as string | null) ?? null,
      applicationRef: (c.applicationRef as string | null) ?? null,
      spaceId: c.spaceId as string,
      sellerName: space?.name ?? null,
      sellerSlug: space?.slug ?? null,
      createdAt: c.createdAt as string,
    };
  });

  const portalDemos: PortalDemo[] = (demos ?? []).map((t) => {
    const space = t.Space as SpaceRel;
    return {
      id: t.id as string,
      productAddress: (t.productAddress as string | null) ?? null,
      startsAt: (t.startsAt as string | null) ?? null,
      status: (t.status as string | null) ?? null,
      spaceId: t.spaceId as string,
      contactId: (t.contactId as string | null) ?? null,
      sellerName: space?.name ?? null,
      sellerSlug: space?.slug ?? null,
    };
  });

  const contactIds = Array.from(
    new Set([
      ...applications.map((a) => a.contactId),
      ...portalDemos.map((t) => t.contactId).filter((id): id is string => Boolean(id)),
    ]),
  );

  return { applications, demos: portalDemos, contactIds };
}

/** Guard: does this verified email own this contact? Used by messaging / docs
 *  / info-request endpoints before any read or write on a contact. */
export async function clientOwnsContact(email: string, contactId: string): Promise<boolean> {
  const lower = email.trim().toLowerCase();
  // Exact case-insensitive (id, email) gate — the fn lower-cases both sides, so the
  // old escapeLike wildcard-neutralization is no longer needed (no LIKE pattern).
  const row = await convex().query(api.contacts.contacts.getByIdAndEmail, {
    id: contactId,
    email: lower,
  });
  return Boolean(row);
}
