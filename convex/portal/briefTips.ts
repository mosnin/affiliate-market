import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * BriefTipHistory data access — the Convex replacement for the two
 * `.from('BriefTipHistory')` ops in lib/briefing/tips/cool-down.ts. The cool-down
 * WINDOW math (coolDownDaysFor) stays in lib; only the DB hops move here.
 *
 * subjectId is tri-state: a tip pinned to a specific subject (a contact/deal id)
 * and a trend tip with no subject are DISTINCT cool-down keys. PG distinguished
 * `subjectId IS NULL` from `subjectId = ?` explicitly, so this layer matches on
 * absent vs equal exactly.
 */

const outcomeValidator = v.union(
  v.literal('shown'),
  v.literal('acted'),
  v.literal('dismissed'),
);

/**
 * The most recent fire for (spaceId, tipCategory, subjectId) — {firedAt, outcome}
 * or null. Mirrors `.eq('spaceId').eq('tipCategory').{is|eq}('subjectId').
 * order('firedAt', desc).limit(1).maybeSingle()`. canFireTip applies the
 * cool-down window to the returned row; null (never fired) means it can fire.
 *
 * subjectId === null selects the rows with NO subject (PG `is null`); a value
 * selects that exact subject. We read off the (spaceId, tipCategory) index
 * prefix and pick the newest matching the subject predicate.
 */
export const latestFire = query({
  args: { spaceId: v.string(), tipCategory: v.string(), subjectId: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('BriefTipHistory')
      .withIndex('by_space_cat_subject', (q) =>
        q.eq('spaceId', args.spaceId).eq('tipCategory', args.tipCategory),
      )
      .collect();
    const matching = rows.filter((r) =>
      args.subjectId === null ? r.subjectId == null : r.subjectId === args.subjectId,
    );
    if (matching.length === 0) return null;
    // Newest firedAt (PG ordered firedAt desc, limit 1).
    matching.sort((a, b) => (a.firedAt < b.firedAt ? 1 : a.firedAt > b.firedAt ? -1 : 0));
    const top = matching[0];
    return { firedAt: top.firedAt, outcome: top.outcome };
  },
});

/**
 * Record a tip fired (recordTipFired). Replaces `.insert({ spaceId, tipCategory,
 * subjectId, outcome:'shown' })`. outcome defaults to 'shown'; firedAt defaults
 * to now (PG default). subjectId null = the no-subject (trend) cool-down key.
 */
export const record = mutation({
  args: {
    spaceId: v.string(),
    tipCategory: v.string(),
    subjectId: v.union(v.string(), v.null()),
    outcome: v.optional(outcomeValidator),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('BriefTipHistory', {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      tipCategory: args.tipCategory,
      ...(args.subjectId !== null ? { subjectId: args.subjectId } : {}),
      firedAt: new Date().toISOString(),
      outcome: args.outcome ?? 'shown',
    });
  },
});
