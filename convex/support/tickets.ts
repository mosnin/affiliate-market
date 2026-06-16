import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * SupportTicket data access — the Convex replacement for the Supabase reads/
 * writes in app/api/support/route.ts (seller-facing GET/POST),
 * app/api/admin/support/route.ts (admin GET/PATCH), and app/admin/support/page.tsx.
 *
 * Identity resolution (Clerk email/name), validation, and rate-limiting stay in
 * the route handlers; only the DB hops move here. Two read shapes are preserved
 * exactly: the seller list omits `adminNote` (its SELECT did), the admin reads
 * include it.
 */

const categoryValidator = v.union(
  v.literal('bug'),
  v.literal('question'),
  v.literal('billing'),
  v.literal('feature'),
  v.literal('other'),
);
const statusValidator = v.union(
  v.literal('open'),
  v.literal('in_progress'),
  v.literal('resolved'),
  v.literal('closed'),
);
const priorityValidator = v.union(v.literal('low'), v.literal('normal'), v.literal('high'));

/** App columns of a SupportTicket — the structural shape both a stored Doc and a
 *  freshly-built insert payload satisfy, so the mappers need no _id/cast. */
type TicketFields = {
  id: string;
  spaceId?: string;
  userId: string;
  email: string;
  name?: string;
  subject: string;
  message: string;
  category: 'bug' | 'question' | 'billing' | 'feature' | 'other';
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'normal' | 'high';
  adminNote?: string;
  createdAt: string;
  updatedAt: string;
};

/** Seller-list row shape: the columns app/api/support selected (no adminNote).
 *  Coerce absent optionals back to the SQL NULLs the client expects. */
function toSellerRow(t: TicketFields) {
  return {
    id: t.id,
    spaceId: t.spaceId ?? null,
    userId: t.userId,
    email: t.email,
    name: t.name ?? null,
    subject: t.subject,
    message: t.message,
    category: t.category,
    status: t.status,
    priority: t.priority,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** Admin row shape: includes adminNote (admin SELECTs carried it). */
function toAdminRow(t: TicketFields) {
  return { ...toSellerRow(t), adminNote: t.adminNote ?? null };
}

/**
 * A user's own tickets, newest first (cap 100). Replaces
 * `.from('SupportTicket').select(...).eq('userId', userId).order('createdAt', desc).limit(100)`.
 */
export const listByUser = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('SupportTicket')
      .withIndex('by_user_created', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(100);
    return rows.map(toSellerRow);
  },
});

/**
 * All tickets newest-first (cap 500), optionally filtered by status. Replaces
 * the admin GET list and the admin page server read. With no `status` we scan
 * the table newest-first (the admin view is cross-user, so the per-user index
 * doesn't apply). With a `status` the by_status index narrows first, then we
 * sort the (small) result newest-first — that index isn't createdAt-ordered.
 */
export const listAll = query({
  args: { status: v.optional(statusValidator) },
  handler: async (ctx, args) => {
    if (args.status !== undefined) {
      const status = args.status; // narrow once, capture for the closure
      const rows = await ctx.db
        .query('SupportTicket')
        .withIndex('by_status', (q) => q.eq('status', status))
        .collect();
      // Status index isn't ordered by createdAt; sort newest-first then cap.
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      return rows.slice(0, 500).map(toAdminRow);
    }
    const rows = await ctx.db.query('SupportTicket').order('desc').take(500);
    return rows.map(toAdminRow);
  },
});

/**
 * Create a ticket. status/priority default to 'open'/'normal' (PG column
 * defaults). Returns the seller row shape the POST handler hands back.
 */
export const create = mutation({
  args: {
    spaceId: v.union(v.string(), v.null()),
    userId: v.string(),
    email: v.string(),
    name: v.union(v.string(), v.null()),
    subject: v.string(),
    message: v.string(),
    category: categoryValidator,
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      ...(args.spaceId !== null ? { spaceId: args.spaceId } : {}),
      userId: args.userId,
      email: args.email,
      ...(args.name !== null ? { name: args.name } : {}),
      subject: args.subject,
      message: args.message,
      category: args.category,
      status: 'open' as const,
      priority: 'normal' as const,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('SupportTicket', doc);
    // `doc` already mirrors the stored row (absent optionals === SQL NULL after
    // toSellerRow's coercion); no read-back needed (cf. calendar events.create).
    return toSellerRow(doc);
  },
});

/**
 * Admin triage update: any of status / priority / adminNote, always bumping
 * updatedAt. Returns the updated admin row, or null if the id doesn't exist
 * (the route maps null -> 404). Replaces the admin PATCH `.update().eq('id')`.
 *
 * `adminNote: null` clears the note (PG stored NULL) -> we delete the optional
 * field via patch; a string sets it.
 */
export const updateTriage = mutation({
  args: {
    id: v.string(),
    status: v.optional(statusValidator),
    priority: v.optional(priorityValidator),
    // tri-state: undefined = leave as-is, null = clear, string = set
    adminNote: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query('SupportTicket')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!t) return null;

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.adminNote !== undefined) {
      // null/empty -> clear the column (Convex: set undefined to remove it).
      patch.adminNote = args.adminNote ? args.adminNote : undefined;
    }
    await ctx.db.patch(t._id, patch);
    const updated = (await ctx.db.get(t._id))!;
    return toAdminRow(updated);
  },
});
