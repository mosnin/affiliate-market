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
import { supabase } from '@/lib/supabase';
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

/** Escape LIKE/ILIKE metacharacters so a full email is matched literally (still
 *  case-insensitively) rather than as a pattern. `%` and `_` are legal in email
 *  local parts and were a wildcard-injection hole in the cross-client guard. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Pull the client's applications + demos by email. `email` MUST be the verified
 * session email — it is the only authorization check, so never pass an
 * unverified or caller-supplied address here.
 */
export async function getClientPortalData(email: string): Promise<ClientPortalData> {
  const lower = email.trim().toLowerCase();

  const [{ data: contacts }, demoRows] = await Promise.all([
    supabase
      .from('Contact')
      .select(
        'id, name, email, applicationStatus, applicationStatusNote, applicationRef, spaceId, createdAt, Space(name, slug)',
      )
      .ilike('email', escapeLike(lower))
      .order('createdAt', { ascending: false }),
    // Demos for this verified email, newest-first. The Space(name, slug) join
    // can't ride a Convex query, so resolve seller names from Space separately
    // (Space stays on Supabase) and stitch them in below.
    convex().query(api.demos.demos.listByGuestEmail, { guestEmail: lower, order: 'desc' }),
  ]);

  // Batch-resolve the seller name/slug for every space the demos belong to.
  const demoSpaceIds = Array.from(
    new Set((demoRows as { spaceId: string }[]).map((t) => t.spaceId)),
  );
  const demoSpaceMap = new Map<string, { name: string | null; slug: string | null }>();
  if (demoSpaceIds.length > 0) {
    const { data: spaceRows } = await supabase
      .from('Space')
      .select('id, name, slug')
      .in('id', demoSpaceIds);
    for (const s of (spaceRows ?? []) as { id: string; name: string | null; slug: string | null }[]) {
      demoSpaceMap.set(s.id, { name: s.name ?? null, slug: s.slug ?? null });
    }
  }
  const demos = (demoRows as Array<Record<string, unknown>>).map((t) => ({
    ...t,
    Space: demoSpaceMap.get(t.spaceId as string) ?? null,
  })) as Array<Record<string, unknown> & { Space: { name: string | null; slug: string | null } | null }>;

  const applications: PortalApplication[] = (contacts ?? []).map((c) => {
    const space = c.Space as SpaceRel;
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
  const { data } = await supabase
    .from('Contact')
    .select('id')
    .eq('id', contactId)
    .ilike('email', escapeLike(lower))
    .maybeSingle();
  return Boolean(data);
}
