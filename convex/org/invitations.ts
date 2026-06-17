import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * Invitation data access — company email invitations (~27 call sites). Looked up
 * by `token` (the public invite / accept flow), by `email` (the auth-redirect
 * "pending invite waiting for me" + the seller-settings list), and by `companyId`
 * (manager/admin lists + pending counts for seat enforcement). Created by the
 * invite / bulk-invite paths (with a pending-per-email dedup), status-flipped
 * (accepted / cancelled / expired / admin-set), and cascade-deleted on company
 * teardown.
 *
 * Token generation: the old PG default was `encode(gen_random_bytes(32), 'hex')`.
 * We mint the equivalent 64-hex-char token here (Web Crypto getRandomValues — no
 * node:crypto in Convex) on insert.
 *
 * Embedded `Company(...)` in several reads is composed lib-side (the old
 * PostgREST embed) — these fns return Invitation rows only.
 */

const roleValidator = v.union(v.literal('manager_admin'), v.literal('seller_member'));
const statusValidator = v.union(
  v.literal('pending'),
  v.literal('accepted'),
  v.literal('expired'),
  v.literal('cancelled'),
);

/** The Invitation row shape the call sites consume. */
function toInvitationRow(i: Doc<'Invitation'>) {
  return {
    id: i.id,
    companyId: i.companyId,
    email: i.email,
    roleToAssign: i.roleToAssign,
    token: i.token,
    status: i.status,
    expiresAt: i.expiresAt,
    invitedById: i.invitedById ?? null,
    createdAt: i.createdAt,
  };
}

/** 64-char hex token, matching PG's encode(gen_random_bytes(32), 'hex'). */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One invitation by token, or null (Invitation_token_key UNIQUE). Covers the
 *  public invite page, the accept API (full row), and the sign-up page. The
 *  embedded `Company(...)` those routes pull is composed lib-side. */
export const getByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const i = await ctx.db
      .query('Invitation')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .first();
    return i ? toInvitationRow(i) : null;
  },
});

/** One invitation by id, scoped to a company, or null. The manager invitation
 *  PATCH gate reads `.eq('id', id).eq('companyId', x).maybeSingle()` to enforce
 *  the 409-on-non-pending guard before flipping status. */
export const getByIdScoped = query({
  args: { id: v.string(), companyId: v.string() },
  handler: async (ctx, args) => {
    const i = await ctx.db
      .query('Invitation')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!i || i.companyId !== args.companyId) return null;
    return toInvitationRow(i);
  },
});

/** The most-recent PENDING, non-expired invitation for an email, or null. Mirrors
 *  the auth-redirect `.eq('email', x).eq('status','pending').gt('expiresAt', now)
 *  .order('createdAt', desc).limit(1).maybeSingle()`. The caller lowercases the
 *  email; we match it as given. `now` is passed in so the time source matches the
 *  request (defaults to server now). */
export const pendingForEmail = query({
  args: { email: v.string(), now: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = args.now ?? new Date().toISOString();
    const rows = await ctx.db
      .query('Invitation')
      .withIndex('by_email', (q) => q.eq('email', args.email))
      .collect();
    const candidates = rows.filter((i) => i.status === 'pending' && i.expiresAt > now);
    candidates.sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
    const top = candidates[0];
    return top ? toInvitationRow(top) : null;
  },
});

/** Pending invitations addressed to an email, case-insensitive, newest-first.
 *  Mirrors the seller-settings `.ilike('email', userEmail).eq('status','pending')
 *  .order('createdAt', desc)`. `.ilike` here is an exact case-insensitive match
 *  (the userEmail has no % wildcards), so we lower-case both sides. The embedded
 *  `Company(id, name)` is composed lib-side. */
export const pendingForEmailList = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const target = args.email.toLowerCase();
    const rows: Doc<'Invitation'>[] = await ctx.db.query('Invitation').collect();
    const matched = rows.filter(
      (i) => i.status === 'pending' && i.email.toLowerCase() === target,
    );
    matched.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return matched.map(toInvitationRow);
  },
});

/** A company's invitations, newest-first, optionally filtered to a status.
 *  Covers the manager invitations page + brief (status='pending', small limit),
 *  the admin company detail (all statuses). `status` absent = all; `limit` caps
 *  the result (the brief takes 6). */
export const listByCompany = query({
  args: {
    companyId: v.string(),
    status: v.optional(statusValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Invitation')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .collect();
    const filtered =
      args.status === undefined ? rows : rows.filter((i) => i.status === args.status);
    filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const capped = args.limit === undefined ? filtered : filtered.slice(0, args.limit);
    return capped.map(toInvitationRow);
  },
});

/** All invitations across companies, newest-first (cap 200) — the admin
 *  invitations page/API (`.order('createdAt', desc).limit(200)`). Embedded
 *  `Company(name)` composed lib-side. */
export const listAll = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows: Doc<'Invitation'>[] = await ctx.db.query('Invitation').collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.slice(0, args.limit ?? 200).map(toInvitationRow);
  },
});

/** Count of pending, non-expired invitations for a company — the seat-usage
 *  count + manager stats (`.eq('companyId').eq('status','pending').gt('expiresAt',
 *  now)` with `{ count, head }`). `now` passed in to match the request clock. */
export const countPending = query({
  args: { companyId: v.string(), now: v.optional(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    const now = args.now ?? new Date().toISOString();
    const rows = await ctx.db
      .query('Invitation')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .collect();
    return rows.filter((i) => i.status === 'pending' && i.expiresAt > now).length;
  },
});

/** Count of pending invitations for a company, INCLUDING expired (the admin
 *  company-detail `.eq('companyId').eq('status','pending')` count, no expiry
 *  filter). Kept distinct from countPending so each call site keeps its exact
 *  semantics. */
export const countPendingAll = query({
  args: { companyId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Invitation')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .collect();
    return rows.filter((i) => i.status === 'pending').length;
  },
});

/** The existing PENDING invitation for (companyId, email), or null — the
 *  invite/bulk-invite idempotency pre-check (`.eq('companyId').eq('email').eq(
 *  'status','pending').maybeSingle()`). Backs the pending-per-email uniqueness;
 *  see `create`. Email matched as the route passes it (trimmed). */
export const pendingForCompanyEmail = query({
  args: { companyId: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    const i = await ctx.db
      .query('Invitation')
      .withIndex('by_company_email_status', (q) =>
        q.eq('companyId', args.companyId).eq('email', args.email).eq('status', 'pending'),
      )
      .first();
    return i ? toInvitationRow(i) : null;
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

export interface CreateInvitationResult {
  /** 'created' = new invite minted. 'duplicate' = a pending invite for this
   *  (companyId, email) already existed; we return it so the route can resend the
   *  email + respond 200, exactly as the old idempotency branch did. */
  outcome: 'created' | 'duplicate';
  invitation: ReturnType<typeof toInvitationRow>;
}

/**
 * Create an invitation. Replaces the invite / bulk-invite `.insert({ companyId,
 * email, roleToAssign, invitedById }).select().single()`. Preserves the
 * uq_invitation_pending_email UNIQUE(companyId, lower(email)) WHERE
 * status='pending' invariant via a read-then-return-or-insert on
 * by_company_email_status inside this mutation (the old code did a separate
 * pending pre-check then inserted; folding them removes the race). Defaults mirror
 * PG: token = random 64-hex, status='pending', expiresAt = now + 7 days,
 * createdAt = now.
 *
 * The dedup read lower-cases both sides to honor the PG `lower(email)` index even
 * though the route passes a trimmed (not lowercased) email — so two invites that
 * differ only in email case can't both be pending.
 */
export const create = mutation({
  args: {
    companyId: v.string(),
    email: v.string(),
    roleToAssign: roleValidator,
    invitedById: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<CreateInvitationResult> => {
    // Pending-per-email dedup (case-insensitive, mirroring lower(email)).
    const target = args.email.toLowerCase();
    const companyRows = await ctx.db
      .query('Invitation')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .collect();
    const existingPending = companyRows.find(
      (i) => i.status === 'pending' && i.email.toLowerCase() === target,
    );
    if (existingPending) {
      return { outcome: 'duplicate', invitation: toInvitationRow(existingPending) };
    }

    const now = new Date();
    const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const doc = {
      id: crypto.randomUUID(),
      companyId: args.companyId,
      email: args.email,
      roleToAssign: args.roleToAssign,
      token: generateToken(),
      status: 'pending' as const,
      expiresAt: expires.toISOString(),
      ...(args.invitedById != null ? { invitedById: args.invitedById } : {}),
      createdAt: now.toISOString(),
    };
    const _id = await ctx.db.insert('Invitation', doc);
    const created = (await ctx.db.get(_id))!;
    return { outcome: 'created', invitation: toInvitationRow(created) };
  },
});

/** Flip an invitation's status by id (accept / expire / cancel / admin-set:
 *  `.update({ status }).eq('id', invId)`). No-op if absent. Returns the updated
 *  row (or null) — the admin route reads the row back; the accept/cancel routes
 *  fire-and-forget. */
export const setStatus = mutation({
  args: { id: v.string(), status: statusValidator },
  handler: async (ctx, args) => {
    const i = await ctx.db
      .query('Invitation')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!i) return null;
    await ctx.db.patch(i._id, { status: args.status });
    const updated = (await ctx.db.get(i._id))!;
    return toInvitationRow(updated);
  },
});

/** Flip status by id, scoped to a company — the manager revoke
 *  (`.update({ status }).eq('id', invitationId).eq('companyId', x)`). The
 *  companyId scope stops a manager cancelling another company's invite. Returns
 *  the updated row, or null if absent/cross-company. */
export const setStatusScoped = mutation({
  args: { id: v.string(), companyId: v.string(), status: statusValidator },
  handler: async (ctx, args) => {
    const i = await ctx.db
      .query('Invitation')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!i || i.companyId !== args.companyId) return null;
    await ctx.db.patch(i._id, { status: args.status });
    const updated = (await ctx.db.get(i._id))!;
    return toInvitationRow(updated);
  },
});

/** Delete EVERY invitation for a company — the admin company-teardown cascade
 *  (`.delete().eq('companyId', id)`). Also reachable via org.companies
 *  .deleteWithCascade, which deletes invitations inline; this standalone fn
 *  mirrors the old route's discrete `.from('Invitation').delete().eq('companyId')`
 *  step for callers that delete invitations independently. Returns the count. */
export const deleteAllForCompany = mutation({
  args: { companyId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Invitation')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .collect();
    for (const i of rows) await ctx.db.delete(i._id);
    return rows.length;
  },
});
