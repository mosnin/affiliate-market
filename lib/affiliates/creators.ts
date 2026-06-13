import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

/**
 * Creator profiles — the supply side of the directory. One per creator
 * (keyed by email), shared across every seller program they join.
 */

export const CREATOR_CHANNELS = [
  { value: 'youtube', label: 'YouTube' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'x', label: 'X / Twitter' },
  { value: 'newsletter', label: 'Newsletter' },
  { value: 'blog', label: 'Blog' },
  { value: 'podcast', label: 'Podcast' },
  { value: 'community', label: 'Community / Discord' },
] as const;

export interface CreatorProfileRow {
  id: string;
  emailLower: string;
  name: string;
  clerkUserId: string | null;
  bio: string | null;
  niche: string | null;
  audienceSize: number;
  channels: string[];
  websiteUrl: string | null;
  avatarUrl: string | null;
  listed: boolean;
  createdAt: string;
  updatedAt: string;
}

function parseChannels(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((c): c is string => typeof c === 'string');
  return [];
}

function decorate(row: Record<string, unknown> | null): CreatorProfileRow | null {
  if (!row) return null;
  return { ...(row as unknown as CreatorProfileRow), channels: parseChannels(row.channels) };
}

export async function getCreatorProfileByEmail(email: string): Promise<CreatorProfileRow | null> {
  const { data } = await supabase
    .from('CreatorProfile')
    .select('*')
    .eq('emailLower', email.trim().toLowerCase())
    .maybeSingle();
  return decorate(data);
}

export interface CreatorProfileInput {
  email: string;
  name: string;
  clerkUserId?: string | null;
  bio?: string | null;
  niche?: string | null;
  audienceSize?: number;
  channels?: string[];
  websiteUrl?: string | null;
  listed?: boolean;
}

/** Create or update a creator's profile (keyed by email). */
export async function upsertCreatorProfile(
  input: CreatorProfileInput,
): Promise<CreatorProfileRow | null> {
  const emailLower = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!emailLower || !name) return null;

  const validChannels = new Set(CREATOR_CHANNELS.map((c) => c.value));
  const update: Record<string, unknown> = { name, updatedAt: new Date().toISOString() };
  if (input.clerkUserId !== undefined) update.clerkUserId = input.clerkUserId;
  if (input.bio !== undefined) update.bio = input.bio?.slice(0, 600) ?? null;
  if (input.niche !== undefined) update.niche = input.niche?.slice(0, 120) ?? null;
  if (input.audienceSize !== undefined) {
    update.audienceSize = Math.max(0, Math.min(1_000_000_000, Math.round(input.audienceSize)));
  }
  if (input.channels !== undefined) {
    update.channels = input.channels.filter((c) => validChannels.has(c as never)).slice(0, 8);
  }
  if (input.websiteUrl !== undefined) update.websiteUrl = input.websiteUrl?.slice(0, 2048) ?? null;
  if (input.listed !== undefined) update.listed = input.listed;

  const { data, error } = await supabase
    .from('CreatorProfile')
    .upsert({ emailLower, ...update }, { onConflict: 'emailLower' })
    .select('*')
    .single();

  if (error) {
    logger.warn('[affiliates] upsertCreatorProfile failed', { error: error.message });
    return null;
  }
  return decorate(data);
}

export interface CreatorDirectoryEntry {
  id: string;
  name: string;
  email: string;
  bio: string | null;
  niche: string | null;
  audienceSize: number;
  channels: string[];
  websiteUrl: string | null;
  avatarUrl: string | null;
  /** Already a partner of the viewing seller? */
  joined: boolean;
}

/**
 * The seller-facing directory: listed creators, optionally filtered by
 * channel or free-text, annotated with whether they've already joined the
 * seller's program.
 */
export async function listCreatorsForSeller(
  spaceId: string,
  filter?: { channel?: string; q?: string },
): Promise<CreatorDirectoryEntry[]> {
  let query = supabase
    .from('CreatorProfile')
    .select('*')
    .eq('listed', true)
    .order('audienceSize', { ascending: false })
    .limit(60);

  // channels is jsonb — containment needs the JSON form ["x"], not the
  // Postgres-array literal {x} that a JS array would serialize to.
  if (filter?.channel) query = query.contains('channels', JSON.stringify([filter.channel]));
  if (filter?.q) {
    const q = filter.q.replace(/[%_]/g, '').trim();
    if (q) query = query.or(`name.ilike.%${q}%,niche.ilike.%${q}%,bio.ilike.%${q}%`);
  }

  const { data: creators } = await query;
  if (!creators || creators.length === 0) return [];

  // Which of these already partner with this seller?
  const emails = creators.map((c) => c.emailLower);
  const { data: partners } = await supabase
    .from('AffiliatePartner')
    .select('email')
    .eq('spaceId', spaceId)
    .in('email', emails);
  const joined = new Set((partners ?? []).map((p) => p.email.toLowerCase()));

  return creators.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.emailLower,
    bio: c.bio,
    niche: c.niche,
    audienceSize: c.audienceSize,
    channels: parseChannels(c.channels),
    websiteUrl: c.websiteUrl,
    avatarUrl: c.avatarUrl,
    joined: joined.has(c.emailLower),
  }));
}

export function channelLabel(value: string): string {
  return CREATOR_CHANNELS.find((c) => c.value === value)?.label ?? value;
}

/** Compact audience number: 12500 → "12.5K", 2_000_000 → "2M". */
export function formatAudience(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}
