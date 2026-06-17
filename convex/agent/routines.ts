import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * Routine data access — the Convex replacement for the `.from('Routine')` reads &
 * writes: the routines API (list/create/patch/delete/run-now), the per-space
 * count cap, and the hourly cron (find-due + stamp-run).
 *
 * nextRunAt: Postgres computed this in a BEFORE INSERT/UPDATE trigger
 * (routine_set_next_run -> routine_next_run_at). Convex has no triggers, so this
 * module PORTS routine_next_run_at (faithfully, in UTC) and the create/update/
 * stampRun mutations set nextRunAt + updatedAt themselves. This is the single
 * source of truth for the schedule math now.
 */

const cadenceValidator = v.union(
  v.literal('hourly'),
  v.literal('daily'),
  v.literal('weekdays'),
  v.literal('monthly'),
  v.literal('custom'),
);
const lastRunStatusValidator = v.union(v.literal('ok'), v.literal('error'));

// JS-style dow: Sun=0..Sat=6 (matches Postgres extract(dow), which the SQL used).
const DOW_MAP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * Port of public.routine_next_run_at(p_cadence, p_hour, p_from, p_day_of_month,
 * p_days_of_week). All arithmetic is UTC (the SQL used timestamptz truncated to
 * UTC day + make_interval(hours)). `from` is the reference instant (now).
 */
export function routineNextRunAt(
  cadence: string,
  hour: number,
  from: Date,
  dayOfMonth: number | null,
  daysOfWeek: string[] | null,
): string {
  // hourly: next top of the hour after `from`.
  if (cadence === 'hourly') {
    const c = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours()),
    );
    c.setUTCHours(c.getUTCHours() + 1);
    return c.toISOString();
  }

  // daily / weekdays / monthly / custom: the next hour:00 UTC strictly after from,
  // then roll forward to a valid day.
  let candidate = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour, 0, 0, 0),
  );
  if (candidate.getTime() <= from.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }

  if (cadence === 'weekdays') {
    // roll off Sat(6)/Sun(0).
    while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate.toISOString();
  }

  if (cadence === 'monthly') {
    // walk forward until the day-of-month matches (≤62 iterations, crosses months).
    for (let i = 0; i < 62; i++) {
      if (candidate.getUTCDate() === dayOfMonth) break;
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate.toISOString();
  }

  if (cadence === 'custom') {
    const targets = new Set((daysOfWeek ?? []).map((d) => DOW_MAP[d]).filter((n) => n !== undefined));
    for (let i = 0; i < 7; i++) {
      if (targets.has(candidate.getUTCDay())) break;
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate.toISOString();
  }

  // daily (default)
  return candidate.toISOString();
}

function toRoutineRow(r: Doc<'Routine'>) {
  return {
    id: r.id,
    spaceId: r.spaceId,
    instruction: r.instruction,
    cadence: r.cadence,
    hour: r.hour,
    dayOfMonth: r.dayOfMonth ?? null,
    daysOfWeek: r.daysOfWeek ?? null,
    enabled: r.enabled,
    lastRunAt: r.lastRunAt ?? null,
    lastRunStatus: r.lastRunStatus ?? null,
    nextRunAt: r.nextRunAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A space's routines, oldest-first (createdAt asc). Mirrors `.eq('spaceId')
 *  .order('createdAt', asc)` with the routines list projection. */
export const listBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Routine')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return rows.map(toRoutineRow);
  },
});

/** One routine by (id, spaceId), or null — the run-now instruction read + the
 *  PATCH/DELETE ownership pre-read. */
export const getByIdForSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('Routine')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.spaceId !== args.spaceId) return null;
    return toRoutineRow(r);
  },
});

/** Per-space routine count (the create cap check, MAX_ROUTINES). Mirrors
 *  `.select('id', { count:'exact', head:true }).eq('spaceId')`. */
export const countBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Routine')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.length;
  },
});

/** Due routines for the hourly cron: enabled=true AND nextRunAt <= now, oldest-
 *  due first, capped (250). Across ALL spaces. Mirrors `.eq('enabled', true)
 *  .lte('nextRunAt', now).order('nextRunAt', asc).limit(250)` selecting (id,
 *  spaceId, instruction). enabled filtered in-handler after the nextRunAt range. */
export const due = query({
  args: { now: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Routine')
      .withIndex('by_next_run', (q) => q.lte('nextRunAt', args.now))
      .order('asc')
      .collect();
    return rows
      .filter((r) => r.enabled)
      .slice(0, args.limit ?? 250)
      .map((r) => ({ id: r.id, spaceId: r.spaceId, instruction: r.instruction }));
  },
});

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Create a routine. The caller (route) has already normalised cadence + the
 * cadence-specific field (dayOfMonth only for monthly, daysOfWeek only for
 * custom; the other is null). We compute nextRunAt from now (replacing the PG
 * trigger) and set updatedAt. PG defaults: hour=13, enabled=true. Returns the
 * new row (the route selected the full projection).
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    instruction: v.string(),
    cadence: cadenceValidator,
    hour: v.optional(v.number()),
    dayOfMonth: v.union(v.number(), v.null()),
    daysOfWeek: v.union(v.array(v.string()), v.null()),
  },
  handler: async (ctx, args) => {
    const now = new Date();
    const nowIso = now.toISOString();
    const hour = args.hour ?? 13;
    const nextRunAt = routineNextRunAt(
      args.cadence,
      hour,
      now,
      args.dayOfMonth,
      args.daysOfWeek,
    );
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      instruction: args.instruction,
      cadence: args.cadence,
      hour,
      enabled: true,
      ...(args.dayOfMonth !== null ? { dayOfMonth: args.dayOfMonth } : {}),
      ...(args.daysOfWeek !== null ? { daysOfWeek: args.daysOfWeek } : {}),
      nextRunAt,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await ctx.db.insert('Routine', doc);
    return toRoutineRow(doc as Doc<'Routine'>);
  },
});

/**
 * Patch a routine (PATCH) and recompute nextRunAt — the PG trigger recomputed it
 * on EVERY update. The route blanks out the non-matching cadence field when
 * cadence changes; we accept the resolved {cadence, hour, dayOfMonth, daysOfWeek}
 * and recompute from now using the row's effective values. Scoped to (id,
 * spaceId). Returns the updated row, or null if not in space.
 */
export const update = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    instruction: v.optional(v.string()),
    cadence: v.optional(cadenceValidator),
    hour: v.optional(v.number()),
    // tri-state for the cadence-specific fields: undefined = leave, null = clear.
    dayOfMonth: v.optional(v.union(v.number(), v.null())),
    daysOfWeek: v.optional(v.union(v.array(v.string()), v.null())),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('Routine')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.spaceId !== args.spaceId) return null;

    const patch: Record<string, unknown> = {};
    if (args.instruction !== undefined) patch.instruction = args.instruction;
    if (args.cadence !== undefined) patch.cadence = args.cadence;
    if (args.hour !== undefined) patch.hour = args.hour;
    if (args.dayOfMonth !== undefined) patch.dayOfMonth = args.dayOfMonth ?? undefined;
    if (args.daysOfWeek !== undefined) patch.daysOfWeek = args.daysOfWeek ?? undefined;
    if (args.enabled !== undefined) patch.enabled = args.enabled;

    // Effective scheduling values after the patch (recompute nextRunAt like the
    // trigger did on every UPDATE).
    const effCadence = (args.cadence ?? r.cadence) as string;
    const effHour = args.hour ?? r.hour;
    const effDom = args.dayOfMonth !== undefined ? args.dayOfMonth : (r.dayOfMonth ?? null);
    const effDow = args.daysOfWeek !== undefined ? args.daysOfWeek : (r.daysOfWeek ?? null);
    const now = new Date();
    patch.nextRunAt = routineNextRunAt(effCadence, effHour, now, effDom, effDow);
    patch.updatedAt = now.toISOString();

    await ctx.db.patch(r._id, patch);
    const updated = (await ctx.db.get(r._id))!;
    return toRoutineRow(updated);
  },
});

/**
 * Stamp a run: set lastRunAt=now (+ optional lastRunStatus) and recompute
 * nextRunAt — the PG trigger recomputed nextRunAt because lastRunAt is an UPDATE.
 * Covers both the manual run-now stamp and the cron per-dispatch stamp. Scoped to
 * (id, spaceId) for the route path; the cron passes the routine's own spaceId.
 */
export const stampRun = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    lastRunStatus: v.optional(lastRunStatusValidator),
  },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const r = await ctx.db
      .query('Routine')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.spaceId !== args.spaceId) return { ok: false };
    const now = new Date();
    await ctx.db.patch(r._id, {
      lastRunAt: now.toISOString(),
      ...(args.lastRunStatus !== undefined ? { lastRunStatus: args.lastRunStatus } : {}),
      nextRunAt: routineNextRunAt(r.cadence, r.hour, now, r.dayOfMonth ?? null, r.daysOfWeek ?? null),
      updatedAt: now.toISOString(),
    });
    return { ok: true };
  },
});

/** Set just lastRunStatus (the manual run-now async error correction):
 *  `.update({ lastRunStatus:'error' }).eq('id').eq('spaceId')`. Does NOT touch
 *  nextRunAt (the route's correction only flips the status flag). Scoped. */
export const setLastRunStatus = mutation({
  args: { id: v.string(), spaceId: v.string(), lastRunStatus: lastRunStatusValidator },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const r = await ctx.db
      .query('Routine')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.spaceId !== args.spaceId) return { ok: false };
    await ctx.db.patch(r._id, { lastRunStatus: args.lastRunStatus });
    return { ok: true };
  },
});

/** Hard-delete a routine (DELETE route). Scoped to (id, spaceId). Returns whether
 *  it existed in the space. */
export const remove = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const r = await ctx.db
      .query('Routine')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.spaceId !== args.spaceId) return { ok: false };
    await ctx.db.delete(r._id);
    return { ok: true };
  },
});
