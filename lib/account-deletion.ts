/**
 * Account deletion — the destructive sweep, in one reviewed place.
 *
 * GDPR right to erasure / CCPA right to delete (Privacy Policy §11.1). This is
 * the only place in the codebase that hard-deletes a user's full footprint, so
 * it lives behind a single function with the table-by-table plan documented in
 * docs/DATA-DELETION.md. Read that doc before touching this.
 *
 * How the cascade USED to work (Postgres, pre-Convex): deleting the single User
 * row cascaded via the FK graph — `Space.ownerId REFERENCES "User"(id) ON DELETE
 * CASCADE`, and almost every Space-scoped table `REFERENCES "Space"(id) ON DELETE
 * CASCADE`. Postgres enforced the deletion order; we hand-rolled nothing.
 *
 * CONVEX HAS NO FOREIGN KEYS AND NO CASCADE. The FK graph that did all the work
 * above is gone. A faithful replacement must explicitly delete every one of the
 * ~83 Space-scoped tables (20 of which are nested children keyed by deal/contact
 * id, not spaceId), in batches that respect Convex's per-mutation write limits.
 * That is a dedicated, test-covered build — `convex/workspace/purgeSpaceData`
 * (TODO) — NOT something to wedge in untested. Per this file's own long-standing
 * rule ("we do not ship an untested cascade as always-on"), until that mutation
 * exists the hard-delete path THROWS rather than delete the User row alone and
 * leave 80+ tables of orphaned PII behind.
 *
 * What is intentionally retained when the cascade ships (docs/DATA-DELETION.md
 * §retention): Stripe customer/invoice records (held by Stripe); CommissionLedger
 * (company-owned financial record, not space-owned); SET-NULL pool rows.
 *
 * The feature flag (ACCOUNT_DELETION_HARD_DELETE) gates the irreversible DB
 * sweep. With it off, the route deletes the Clerk user and records the request,
 * leaving workspace rows for the documented reviewed run — unchanged by the
 * Convex migration. The flag MUST stay off until purgeSpaceData lands.
 */

import { convex, api } from '@/lib/convex-server';

export function hardDeleteEnabled(): boolean {
  return process.env.ACCOUNT_DELETION_HARD_DELETE === 'true';
}

/**
 * Returns a reason string if the space's owner cannot be hard-deleted yet, or
 * null if deletion is safe to proceed.
 *
 * The one structural blocker: `Company.ownerId REFERENCES "User"(id) ON
 * DELETE RESTRICT`. A manager who owns a company cannot have their User row
 * deleted until the company is transferred or removed — Postgres will reject
 * the delete. We surface that as a clear message rather than letting the DB
 * throw an opaque FK error at the user.
 */
export async function checkDeletionBlockers(ownerId: string): Promise<string | null> {
  // Company has a one-per-owner invariant, so getByOwner returns the single
  // owned company (or null). Owning one blocks the User delete (PG modeled this
  // as ownerId ON DELETE RESTRICT).
  const ownedCompany = await convex().query(api.org.companies.getByOwner, { ownerId });
  if (ownedCompany) {
    return 'you own a company. transfer or close it before deleting your account, or contact help@usecola.com.';
  }
  return null;
}

/**
 * The destructive sweep. Under Postgres this deleted a couple of non-cascading
 * tables, then the User row — and the FK graph erased everything else. Under
 * Convex there is no FK graph, so this needs an explicit ~83-table purge that
 * does not exist yet (see the file header). Until it does, this throws.
 *
 * Gated by hardDeleteEnabled() AND by the missing-cascade guard below. The flag
 * is off in production; this is the second guard against an accidental purge.
 */
export async function hardDeleteSpaceAndUser(_params: {
  userDbId: string;
  spaceId: string;
}): Promise<void> {
  if (!hardDeleteEnabled()) {
    throw new Error('hardDeleteSpaceAndUser called with ACCOUNT_DELETION_HARD_DELETE off');
  }

  // The Convex cascade replacement (purgeSpaceData) is not built yet. Deleting
  // the User row alone — the old Postgres entry point — would orphan 80+ tables
  // of PII instead of erasing them, which is the opposite of what a GDPR/CCPA
  // erasure must do. Fail loud: the flag must stay off until the purge lands.
  throw new Error(
    'hardDeleteSpaceAndUser: Convex space-data purge (purgeSpaceData) not yet ' +
      'implemented — refusing to delete the User row alone and orphan workspace PII. ' +
      'Keep ACCOUNT_DELETION_HARD_DELETE off until the cascade ships.',
  );
}
