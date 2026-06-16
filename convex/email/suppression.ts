import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * EmailSuppression data access — the Convex replacement for the Supabase reads
 * in lib/email/suppression.ts. The signed-token sign/verify logic stays in
 * lib/ (pure crypto, no DB); only the two DB ops move here.
 */

const listTypeValidator = v.union(v.literal('creator_digest'), v.literal('seller_digest'));

export const isSuppressed = query({
  args: { email: v.string(), listType: listTypeValidator },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query('EmailSuppression')
      .withIndex('by_email_list', (q) => q.eq('email', args.email).eq('listType', args.listType))
      .unique();
    return row !== null;
  },
});

export const suppress = mutation({
  args: { email: v.string(), listType: listTypeValidator },
  handler: async (ctx, args): Promise<void> => {
    // Read-then-insert inside one mutation is serializable in Convex, so this is
    // race-safe without the old unique-index upsert dance.
    const existing = await ctx.db
      .query('EmailSuppression')
      .withIndex('by_email_list', (q) => q.eq('email', args.email).eq('listType', args.listType))
      .unique();
    if (existing) return;
    await ctx.db.insert('EmailSuppression', {
      id: crypto.randomUUID(),
      email: args.email,
      listType: args.listType,
      createdAt: new Date().toISOString(),
    });
  },
});
