import { convex, api } from '@/lib/convex-server';

// 30-second TTL cache to avoid DB hammering on every tool call
const cache = new Map<string, { disabled: boolean; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

export async function isSpaceDisabled(spaceId: string): Promise<boolean> {
  // Check cache first
  const cached = cache.get(spaceId);
  if (cached && Date.now() < cached.expiresAt) return cached.disabled;

  // Active disable for this space? Convex throws on failure (the old code
  // threw on the Supabase error) — let it propagate to the caller.
  const disabled = await convex().query(api.workspace.disabled.isDisabled, { spaceId });

  // Update cache
  cache.set(spaceId, { disabled, expiresAt: Date.now() + CACHE_TTL_MS });

  return disabled;
}

export async function disableSpace(
  spaceId: string,
  reason: string,
  disabledBy = 'system'
): Promise<void> {
  // Insert a new active DisabledSpace row, or refresh the existing active one
  // (the mutation re-implements the PG `onConflict: 'spaceId,isActive'` upsert).
  // Convex throws on failure — preserve the old throw-on-error contract.
  await convex().mutation(api.workspace.disabled.disable, { spaceId, reason, disabledBy });

  // Invalidate cache for this spaceId
  cache.delete(spaceId);
}

export async function reenableSpace(spaceId: string): Promise<void> {
  // Flip every active disable to inactive + stamp reenabledAt. Convex throws
  // on failure — preserve the old throw-on-error contract.
  await convex().mutation(api.workspace.disabled.reenable, { spaceId });

  // Invalidate cache
  cache.delete(spaceId);
}

export async function assertSpaceEnabled(spaceId: string): Promise<void> {
  const disabled = await isSpaceDisabled(spaceId);
  if (disabled) {
    throw new Error(`space_disabled:${spaceId}`);
  }
}
