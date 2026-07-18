/**
 * GET   /api/profile-page — the seller's public-page config (defaults if unset).
 * PATCH /api/profile-page — update enabled / headline / section toggles / links / videos.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';
import { convex, api } from '@/lib/convex-server';
import { getSignedDownloadUrl } from '@/lib/storage';
import { logger } from '@/lib/logger';
import { parseYouTubeId } from '@/lib/profile-page';
import { SOCIAL_PLATFORMS, type SocialPlatform } from '@/components/profile-page/public-profile';

export const runtime = 'nodejs';

// Brand identity bits (verified badge, social handles) live on SpaceSetting
// rather than ProfilePage because they're inherited across every public
// surface the seller owns — the public page, the application, the booking
// page all read these. The PATCH below threads them through.

// The picker only needs to render — full product pages live elsewhere.
// We cap the list at 50 so the editor stays snappy; if a seller truly has
// more, the picker isn't the right tool for the long tail.
const AVAILABLE_PRODUCTS_CAP = 50;

// Cap the seller's curated set at 12 — enough for a carousel without
// drowning the page. Matches the editor's own UI cap.
const FEATURED_CAP = 12;

const DEFAULTS = {
  enabled: true,
  headline: null as string | null,
  showIntake: true,
  showDemos: true,
  showProducts: true,
  customLinks: [] as Array<{ id: string; label: string; url: string; thumbnail: string }>,
  videos: [] as Array<{ id: string; url: string; title: string }>,
  coverPhotoUrl: null as string | null,
  profilePhotoUrl: null as string | null,
  featuredProductIds: [] as string[],
  isVerified: false,
  socialLinks: {} as Partial<Record<SocialPlatform, string>>,
};

interface AvailableProduct {
  id: string;
  address: string;
  city: string | null;
  stateRegion: string | null;
  listPrice: number | null;
  photo: string | null;
}

/** Sign a stored photo KEY for the editor preview (24h TTL — way longer than
 *  the editor's actual session). Legacy `http(s)://` values pass through
 *  verbatim. Returns null on signing failure so the UI shows the empty state
 *  instead of a broken image.
 */
async function signStoredPhoto(value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  try {
    return await getSignedDownloadUrl(value, 60 * 60 * 24);
  } catch {
    return null;
  }
}

export async function GET() {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  const space = await getSpaceForUser(authResult.userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const [data, settingsRow, productRowsRaw] = await Promise.all([
    convex().query(api.marketplace.profiles.getBySpace, { spaceId: space.id }),
    convex().query(api.workspace.settings.getBySpace, { spaceId: space.id }),
    // The picker shows every active listing in the space. Capped at 50 —
    // beyond that the seller isn't picking from a list any more, they're
    // hunting, and that belongs in the listings management surface, not
    // here. listForSpace unions owned + assigned-pool rows; the old query
    // was spaceId-only, so filter back to owned rows before capping.
    convex().query(api.marketplace.products.listForSpace, {
      spaceId: space.id,
      listingStatusIn: ['active'],
      order: 'updated',
    }),
  ]);
  const productRows = productRowsRaw
    .filter((r) => r.spaceId === space.id)
    .slice(0, AVAILABLE_PRODUCTS_CAP);

  // Sanitize socialLinks read from the DB. Older rows may carry arbitrary
  // platform keys (the original shape was Record<string,string>); the
  // editor only edits the closed set, so we drop anything outside it on
  // the way out so the UI's view of the data matches what it can write
  // back.
  const rawSocial = (settingsRow?.socialLinks ?? {}) as Record<string, unknown>;
  const cleanSocial: Partial<Record<SocialPlatform, string>> = {};
  for (const platform of SOCIAL_PLATFORMS) {
    const v = rawSocial[platform];
    if (typeof v === 'string' && v.trim()) cleanSocial[platform] = v.trim();
  }

  // coverPhotoUrl is stored as a storage KEY (the bucket isn't anonymously
  // readable, so signing on read is the live contract). Legacy values that
  // start with `http(s)://` are URLs and get passed through. Editor UI
  // displays this value directly, so signing here is the only place that
  // matters for the preview.
  const merged: Record<string, unknown> = {
    ...DEFAULTS,
    ...(data ?? {}),
    isVerified: settingsRow?.isVerified === true,
    socialLinks: cleanSocial,
  };
  // Both photos use the same private-store + sign-on-read contract. Sign
  // both in parallel so the editor preview never sees a raw storage key.
  const [signedCover, signedProfile] = await Promise.all([
    signStoredPhoto(merged.coverPhotoUrl),
    signStoredPhoto(merged.profilePhotoUrl),
  ]);
  merged.coverPhotoUrl = signedCover;
  merged.profilePhotoUrl = signedProfile;

  // Product photos are stored as a JSONB array of URLs (see the Product
  // migration comment). For the picker we only need the first one — the
  // public page's carousel uses the same shape.
  const availableProducts: AvailableProduct[] = ((productRows ?? []) as unknown as Array<{
    id: string;
    address: string;
    city: string | null;
    stateRegion: string | null;
    listPrice: number | null;
    photos: unknown;
  }>).map((row) => ({
    id: row.id,
    address: row.address,
    city: row.city ?? null,
    stateRegion: row.stateRegion ?? null,
    listPrice: row.listPrice ?? null,
    photo: Array.isArray(row.photos) && typeof row.photos[0] === 'string' ? row.photos[0] : null,
  }));
  merged.availableProducts = availableProducts;

  return NextResponse.json(merged);
}

export async function PATCH(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  const space = await getSpaceForUser(authResult.userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };

  for (const key of ['enabled', 'showIntake', 'showDemos', 'showProducts'] as const) {
    if (typeof body[key] === 'boolean') patch[key] = body[key];
  }
  if (body.headline === null || typeof body.headline === 'string') {
    patch.headline =
      typeof body.headline === 'string' ? body.headline.trim().slice(0, 200) || null : null;
  }
  if (Array.isArray(body.customLinks)) {
    // Sanitize to [{ id, label, url, thumbnail }] — cap 20, http(s) URLs only.
    // thumbnail is optional and only kept when it's itself an http(s) URL.
    patch.customLinks = (body.customLinks as unknown[])
      .filter((l): l is Record<string, unknown> => Boolean(l) && typeof l === 'object')
      .slice(0, 20)
      .map((l) => ({
        id: typeof l.id === 'string' && l.id ? l.id : crypto.randomUUID(),
        label: typeof l.label === 'string' ? l.label.trim().slice(0, 80) : '',
        url: typeof l.url === 'string' ? l.url.trim().slice(0, 500) : '',
        thumbnail:
          typeof l.thumbnail === 'string' && /^https?:\/\//i.test(l.thumbnail.trim())
            ? l.thumbnail.trim().slice(0, 500)
            : '',
      }))
      .filter((l) => l.label && /^https?:\/\//i.test(l.url));
  }
  if (Array.isArray(body.videos)) {
    // Sanitize to [{ id, url, title }] — cap 12, only real YouTube URLs survive.
    patch.videos = (body.videos as unknown[])
      .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
      .slice(0, 12)
      .map((v) => ({
        id: typeof v.id === 'string' && v.id ? v.id : crypto.randomUUID(),
        url: typeof v.url === 'string' ? v.url.trim().slice(0, 500) : '',
        title: typeof v.title === 'string' ? v.title.trim().slice(0, 120) : '',
      }))
      .filter((v) => parseYouTubeId(v.url));
  }

  // featuredProductIds: validate each id belongs to the space and is an
  // active listing. Unknown / stale ids are dropped silently rather than
  // 400-ing the whole save — the editor's set can drift when a product
  // gets deleted or marked sold, and the user shouldn't be punished for
  // that. Cap at FEATURED_CAP. Order is preserved (array order = render
  // order on the public page).
  if (Array.isArray(body.featuredProductIds)) {
    const raw = (body.featuredProductIds as unknown[])
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, FEATURED_CAP);

    if (raw.length === 0) {
      patch.featuredProductIds = [];
    } else {
      const validRows = await convex().query(api.marketplace.products.byIds, { ids: raw });
      const valid = new Set(
        validRows
          .filter((r) => r.spaceId === space.id && r.listingStatus === 'active')
          .map((r) => r.id),
      );
      // Preserve the seller's submitted order — the validation set is
      // unordered, so filter `raw` to keep render order.
      patch.featuredProductIds = raw.filter((id) => valid.has(id));
    }
  }

  // The mutation bumps updatedAt itself and keys the upsert on spaceId, so
  // strip both from the writable bag.
  const { updatedAt: _updatedAt, ...fields } = patch;
  void _updatedAt;
  let data: Record<string, unknown>;
  try {
    data = await convex().mutation(api.marketplace.profiles.upsert, {
      spaceId: space.id,
      fields,
    });
  } catch (error) {
    logger.error('[profile-page] update failed', { spaceId: space.id }, error as Error);
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }

  // socialLinks + isVerified live on SpaceSetting (they're brand-level —
  // every public surface the seller owns reads from there). Build a
  // separate settings patch and apply it if anything came through.
  const settingsPatch: Record<string, unknown> = {};

  if (typeof body.isVerified === 'boolean') {
    settingsPatch.isVerified = body.isVerified;
  }

  if (body.socialLinks && typeof body.socialLinks === 'object' && !Array.isArray(body.socialLinks)) {
    // Closed platform set — anything outside SOCIAL_PLATFORMS is dropped.
    // Each value must be a string http(s) URL; non-URL strings are
    // silently dropped so we never persist an unclickable link. Empty
    // strings remove the platform.
    const incoming = body.socialLinks as Record<string, unknown>;
    const cleaned: Partial<Record<SocialPlatform, string>> = {};
    for (const platform of SOCIAL_PLATFORMS) {
      const raw = incoming[platform];
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim().slice(0, 500);
      if (!trimmed) continue; // empty = unset, leave it out
      if (!/^https?:\/\//i.test(trimmed)) continue;
      cleaned[platform] = trimmed;
    }
    settingsPatch.socialLinks = cleaned;
  }

  let settingsRow: { isVerified: boolean; socialLinks: Record<string, string> } | null = null;
  if (Object.keys(settingsPatch).length > 0) {
    // Upsert keyed on spaceId — the mutation reads-then-inserts-or-patches the
    // single row, preserving UNIQUE(spaceId) and minting the PK on first insert.
    try {
      const upserted = await convex().mutation(api.workspace.settings.upsertBySpace, {
        spaceId: space.id,
        fields: settingsPatch,
      });
      settingsRow = upserted as unknown as typeof settingsRow;
    } catch (settingsError) {
      logger.error('[profile-page] settings update failed', { spaceId: space.id }, settingsError as Error);
      return NextResponse.json({ error: 'Update failed' }, { status: 500 });
    }
  } else {
    const existing = await convex().query(api.workspace.settings.getBySpace, { spaceId: space.id });
    settingsRow = existing as unknown as typeof settingsRow;
  }

  // Mirror the GET shape so the editor's applyConfig() can re-hydrate
  // straight from the PATCH response.
  const settingsRowAny = settingsRow as { isVerified?: boolean; socialLinks?: unknown } | null;
  const rawSocial = (settingsRowAny?.socialLinks ?? {}) as Record<string, unknown>;
  const cleanSocial: Partial<Record<SocialPlatform, string>> = {};
  for (const platform of SOCIAL_PLATFORMS) {
    const v = rawSocial[platform];
    if (typeof v === 'string' && v.trim()) cleanSocial[platform] = v.trim();
  }

  return NextResponse.json({
    ...data,
    isVerified: settingsRowAny?.isVerified === true,
    socialLinks: cleanSocial,
  });
}
