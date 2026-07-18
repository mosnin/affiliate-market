import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * Artifact + ArtifactVersion data access (AGENT ARTIFACTS) — the Convex
 * replacement for the `.from('Artifact')` / `.from('ArtifactVersion')` reads &
 * writes in app/api/agent/artifacts/route.ts, .../[artifactId]/route.ts, and
 * .../[artifactId]/download/route.ts. Auth/ownership + the kill-switch check stay
 * in the routes; this module owns the table hops.
 *
 * MULTI-STEP WRITES COLLAPSE TO ONE MUTATION. Both tables are this domain's, so
 * the old non-atomic three-statement flows become single serializable mutations:
 *   - create: insert Artifact -> insert ArtifactVersion v1 -> patch
 *     Artifact.currentVersionId. (Old POST did three round-trips with two failure
 *     windows that could leave an artifact with no version, or a version with no
 *     link. One mutation removes both.)
 *   - addVersion: read max versionNumber -> insert next ArtifactVersion -> patch
 *     Artifact.currentVersionId + updatedAt. (Old PATCH did the same three steps;
 *     reading the max and inserting in one mutation also closes the race where two
 *     concurrent edits mint the same versionNumber.)
 *
 * NOT-NULL FILL. ArtifactVersion.contentHash and ArtifactVersion.spaceId are
 * NOT NULL in PG, but the old routes never passed either (the column was a latent
 * gap on this write path). The mutations make every inserted row valid:
 *   - contentHash = sha-256 hex of `content` (the column's literal meaning; the
 *     codebase hashes content with sha-256 hex elsewhere — lib/morning-story-agent,
 *     lib/chat/vector-context).
 *   - spaceId is inherited from the parent Artifact (RLS filtered versions by it).
 * createdByAgent + metadata also take their PG defaults ('cola', {}).
 *
 * No call site DELETEs an Artifact (the cron retention RPC ages old ones — that's
 * the data-retention domain, not this one), so no delete/cascade mutation here.
 */

const artifactTypeValidator = v.union(
  v.literal('draft_email'),
  v.literal('draft_sms'),
  v.literal('deal_update'),
  v.literal('contact_update'),
  v.literal('demo_booking'),
  v.literal('goal_plan'),
  v.literal('report'),
  v.literal('raw_output'),
);

/** sha-256 hex of a string, via Web Crypto (no node:crypto in Convex). Async,
 *  which a mutation handler can await. Matches the sha-256-hex convention the
 *  codebase uses for content hashes. */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Full Artifact row (the routes `select('*')` and spread it). _id/_creationTime
 *  are dropped; absent optionals -> null to preserve the old Row shape. */
function toArtifactRow(a: Doc<'Artifact'>) {
  return {
    id: a.id,
    spaceId: a.spaceId,
    taskId: a.taskId ?? null,
    stepId: a.stepId ?? null,
    artifactType: a.artifactType,
    title: a.title,
    contentType: a.contentType,
    status: a.status,
    currentVersionId: a.currentVersionId ?? null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** Full ArtifactVersion row (the GET `select('*')` spread + download fields). */
function toVersionRow(v_: Doc<'ArtifactVersion'>) {
  return {
    id: v_.id,
    artifactId: v_.artifactId,
    spaceId: v_.spaceId,
    versionNumber: v_.versionNumber,
    content: v_.content,
    contentHash: v_.contentHash,
    metadata: v_.metadata ?? null,
    createdByAgent: v_.createdByAgent,
    createdAt: v_.createdAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Artifacts for a space, newest-first (cap 50), with optional taskId / type
 * filters. Mirrors the GET list `.from('Artifact').eq('spaceId')
 * .order('createdAt', desc).limit(50)` plus the conditional `.eq('taskId')` /
 * `.eq('artifactType', type)`. The optional filters are applied in memory.
 */
export const listForSpace = query({
  args: {
    spaceId: v.string(),
    taskId: v.optional(v.string()),
    artifactType: v.optional(artifactTypeValidator),
  },
  handler: async (ctx, args) => {
    let rows = await ctx.db
      .query('Artifact')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .take(50);
    if (args.taskId !== undefined) rows = rows.filter((a) => a.taskId === args.taskId);
    if (args.artifactType !== undefined) {
      rows = rows.filter((a) => a.artifactType === args.artifactType);
    }
    return rows.map(toArtifactRow);
  },
});

/** One artifact by id, or null. Mirrors `.from('Artifact').eq('id').maybeSingle()`
 *  (the GET / PATCH / download routes load it to derive spaceId for auth). */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const a = await ctx.db
      .query('Artifact')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return a ? toArtifactRow(a) : null;
  },
});

/**
 * An artifact plus all its versions (oldest-first). Mirrors the GET
 * `.../[artifactId]` route: load the artifact, then
 * `.from('ArtifactVersion').eq('artifactId').order('versionNumber', asc)`.
 * Returns { artifact, versions } | null so the route can shape its response.
 */
export const getWithVersions = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const a = await ctx.db
      .query('Artifact')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!a) return null;
    const versions = await ctx.db
      .query('ArtifactVersion')
      .withIndex('by_artifact_version', (q) => q.eq('artifactId', a.id))
      .order('asc')
      .collect();
    return { artifact: toArtifactRow(a), versions: versions.map(toVersionRow) };
  },
});

/**
 * Resolve one version of an artifact for download. Mirrors the download route's
 * version selection over `.from('ArtifactVersion').eq('artifactId')`:
 *   - versionNumber given  -> that exact version,
 *   - else currentVersionId -> the version with that id,
 *   - else                  -> the highest versionNumber.
 * Returns { id, versionNumber, content } | null (the columns the route emits).
 * The route resolves the artifact (title/type/ownership) separately via getById.
 */
export const versionForDownload = query({
  args: {
    artifactId: v.string(),
    versionNumber: v.optional(v.number()),
    currentVersionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const versions = await ctx.db
      .query('ArtifactVersion')
      .withIndex('by_artifact_version', (q) => q.eq('artifactId', args.artifactId))
      .collect();
    if (versions.length === 0) return null;

    let chosen: Doc<'ArtifactVersion'> | undefined;
    if (args.versionNumber !== undefined) {
      chosen = versions.find((x) => x.versionNumber === args.versionNumber);
    } else if (args.currentVersionId !== undefined) {
      chosen = versions.find((x) => x.id === args.currentVersionId);
    } else {
      chosen = versions.reduce((max, x) => (x.versionNumber > max.versionNumber ? x : max));
    }
    if (!chosen) return null;
    return { id: chosen.id, versionNumber: chosen.versionNumber, content: chosen.content };
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create an artifact with its first version, atomically. Replaces the POST
 * route's three statements (insert Artifact -> insert ArtifactVersion v1 ->
 * patch currentVersionId). contentType defaults to 'text/plain', status to
 * 'draft' (PG defaults); contentHash is derived; the version's spaceId inherits
 * the artifact's. Returns { artifact, currentVersion } in the shape the route
 * returns (`{ ...updatedArtifact, currentVersion: version }`).
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    taskId: v.optional(v.string()),
    artifactType: artifactTypeValidator,
    title: v.string(),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const artifactId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const contentHash = await sha256Hex(args.content);

    await ctx.db.insert('Artifact', {
      id: artifactId,
      spaceId: args.spaceId,
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
      artifactType: args.artifactType,
      title: args.title,
      contentType: 'text/plain',
      status: 'draft',
      currentVersionId: versionId,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert('ArtifactVersion', {
      id: versionId,
      artifactId,
      spaceId: args.spaceId, // inherited from the parent Artifact
      versionNumber: 1,
      content: args.content,
      contentHash,
      metadata: {},
      createdByAgent: 'cola',
      createdAt: now,
    });

    const artifact = (await ctx.db
      .query('Artifact')
      .withIndex('by_app_id', (q) => q.eq('id', artifactId))
      .unique())!;
    const version = (await ctx.db
      .query('ArtifactVersion')
      .withIndex('by_artifact_version', (q) => q.eq('artifactId', artifactId).eq('versionNumber', 1))
      .unique())!;
    return { artifact: toArtifactRow(artifact), currentVersion: toVersionRow(version) };
  },
});

export type AddVersionResult =
  | { ok: true; artifact: ReturnType<typeof toArtifactRow>; newVersion: ReturnType<typeof toVersionRow> }
  | { ok: false; error: 'not_found' };

/**
 * Append a new version to an artifact + relink currentVersionId, atomically.
 * Replaces the PATCH route's flow (max versionNumber -> insert next version ->
 * patch currentVersionId + updatedAt). versionNumber = max + 1 (1 if none).
 * contentHash derived; spaceId inherited. Returns { ok:false, 'not_found' } when
 * the artifact is gone (the route 404s; it pre-checked ownership). On success
 * returns { artifact, newVersion } matching the route's response shape.
 */
export const addVersion = mutation({
  args: { artifactId: v.string(), content: v.string() },
  handler: async (ctx, args): Promise<AddVersionResult> => {
    const artifact = await ctx.db
      .query('Artifact')
      .withIndex('by_app_id', (q) => q.eq('id', args.artifactId))
      .unique();
    if (!artifact) return { ok: false, error: 'not_found' };

    // Highest existing versionNumber for this artifact (the by_artifact_version
    // index is ordered, so the last row in desc order is the max).
    const top = await ctx.db
      .query('ArtifactVersion')
      .withIndex('by_artifact_version', (q) => q.eq('artifactId', args.artifactId))
      .order('desc')
      .first();
    const nextVersionNumber = (top?.versionNumber ?? 0) + 1;

    const now = new Date().toISOString();
    const versionId = crypto.randomUUID();
    const contentHash = await sha256Hex(args.content);

    await ctx.db.insert('ArtifactVersion', {
      id: versionId,
      artifactId: args.artifactId,
      spaceId: artifact.spaceId, // inherited from the parent Artifact
      versionNumber: nextVersionNumber,
      content: args.content,
      contentHash,
      metadata: {},
      createdByAgent: 'cola',
      createdAt: now,
    });

    await ctx.db.patch(artifact._id, { currentVersionId: versionId, updatedAt: now });

    const updated = (await ctx.db.get(artifact._id))!;
    const newVersion = (await ctx.db
      .query('ArtifactVersion')
      .withIndex('by_artifact_version', (q) =>
        q.eq('artifactId', args.artifactId).eq('versionNumber', nextVersionNumber),
      )
      .unique())!;
    return { ok: true, artifact: toArtifactRow(updated), newVersion: toVersionRow(newVersion) };
  },
});
