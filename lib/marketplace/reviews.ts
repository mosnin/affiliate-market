/**
 * Marketplace reviews — the trust signal.
 *
 * A review can only be written by someone who actually bought the product:
 * `createReview` looks for a PAID MarketplaceOrder for (productId, buyerEmail)
 * before it will insert. No purchase, no review — that's the whole anti-scam
 * point. One review per buyer per product is enforced both here (friendly
 * error) and by the unique index, now re-implemented as a read-then-insert
 * inside the Convex create mutation (race-safe backstop).
 *
 * Money never appears here, so none of the net/gross rules apply. These are
 * just star ratings and words. All DB hops (MarketplaceOrder gate, Review,
 * Product names) are Convex calls — every table touched here is marketplace-owned.
 */
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';

export type ReviewStatus = 'published' | 'hidden';

const MAX_TITLE = 120;
const MAX_BODY = 4000;

/** A published review as shown on the product page. */
export interface PublicReview {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  createdAt: string;
  /** Masked author handle ("a***@gmail.com") — never the raw email. */
  author: string;
}

/** A review row for the admin moderation queue (carries status + product). */
export interface ModerationReview {
  id: string;
  productId: string;
  productName: string;
  spaceId: string;
  buyerEmail: string;
  rating: number;
  title: string | null;
  body: string | null;
  status: ReviewStatus;
  createdAt: string;
}

export interface CreateReviewResult {
  ok: boolean;
  /** Set when ok === false — a short, buyer-safe reason. */
  error?: string;
  /** HTTP-ish status hint for the calling route. */
  status?: number;
}

/** "alice@gmail.com" → "a***@gmail.com". Keeps reviews from leaking emails. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return 'a buyer';
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

/**
 * Create a review — only if the buyer purchased and paid for the product.
 * Verifies a paid MarketplaceOrder directly (cheap targeted query, avoids
 * pulling the buyer's whole order history through orders.ts just to count one).
 */
export async function createReview(input: {
  productId: string;
  buyerEmail: string;
  rating: number;
  title?: string | null;
  body?: string | null;
}): Promise<CreateReviewResult> {
  const buyerEmail = input.buyerEmail.trim().toLowerCase();
  const rating = Math.round(Number(input.rating));

  if (!input.productId) return { ok: false, error: 'Missing product.', status: 400 };
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: 'Rating must be 1 to 5 stars.', status: 400 };
  }

  // Purchased-before-review gate. A single paid order for this product by this
  // buyer is enough. Case-insensitive match (the query lowercases). Also gives
  // us the spaceId to denormalise onto the review.
  const order = (await convex().query(api.marketplace.orders.paidOrderForProductBuyer, {
    productId: input.productId,
    buyerEmail,
  })) as { id: string; spaceId: string } | null;

  if (!order) {
    return { ok: false, error: 'Only buyers who purchased this product can review it.', status: 403 };
  }

  const title = (input.title ?? '').trim().slice(0, MAX_TITLE) || null;
  const body = (input.body ?? '').trim().slice(0, MAX_BODY) || null;

  const result = (await convex().mutation(api.marketplace.reviews.create, {
    spaceId: order.spaceId,
    productId: input.productId,
    buyerEmail,
    rating,
    title,
    body,
  })) as { ok: boolean; error?: 'duplicate' };

  if (!result.ok) {
    // duplicate → already reviewed this product (the unique-index backstop).
    if (result.error === 'duplicate') {
      return { ok: false, error: 'You already reviewed this product.', status: 409 };
    }
    logger.error('[reviews] createReview insert failed', { productId: input.productId });
    return { ok: false, error: 'Could not save your review. Try again.', status: 500 };
  }

  return { ok: true };
}

/** Published reviews for a product, newest first. */
export async function getReviewsForProduct(productId: string): Promise<PublicReview[]> {
  const data = (await convex().query(api.marketplace.reviews.publishedForProduct, {
    productId,
  })) as Array<{
    id: string;
    rating: number;
    title: string | null;
    body: string | null;
    createdAt: string;
    buyerEmail: string;
  }>;

  return (data ?? []).map((r) => ({
    id: r.id,
    rating: r.rating,
    title: r.title ?? null,
    body: r.body ?? null,
    createdAt: r.createdAt,
    author: maskEmail(r.buyerEmail),
  }));
}

/**
 * Batched rating aggregate for many products at once — one query, grouped in
 * memory. Used by the product list/detail queries so each card can show a
 * star average without an N+1. Only published reviews count.
 */
export async function getRatingForProducts(
  productIds: string[],
): Promise<Map<string, { avg: number; count: number }>> {
  const result = new Map<string, { avg: number; count: number }>();
  const ids = [...new Set(productIds)].filter(Boolean);
  if (ids.length === 0) return result;

  const data = (await convex().query(api.marketplace.reviews.publishedRatingsForProducts, {
    productIds: ids,
  })) as Array<{ productId: string; rating: number }>;

  const sums = new Map<string, { sum: number; count: number }>();
  for (const r of data ?? []) {
    const pid = r.productId;
    const acc = sums.get(pid) ?? { sum: 0, count: 0 };
    acc.sum += r.rating ?? 0;
    acc.count += 1;
    sums.set(pid, acc);
  }
  for (const [pid, { sum, count }] of sums) {
    // One decimal — "4.7". Enough precision for a star line, no float noise.
    result.set(pid, { avg: Math.round((sum / count) * 10) / 10, count });
  }
  return result;
}

/** Admin: hide a review (moderation) without deleting the buyer's words. */
export async function hideReview(id: string): Promise<boolean> {
  const res = (await convex().mutation(api.marketplace.reviews.setStatus, {
    id,
    status: 'hidden',
  })) as { ok: boolean };
  if (!res.ok) logger.warn('[reviews] hideReview failed', { id });
  return res.ok;
}

/** Admin: restore a hidden review to published. */
export async function unhideReview(id: string): Promise<boolean> {
  const res = (await convex().mutation(api.marketplace.reviews.setStatus, {
    id,
    status: 'published',
  })) as { ok: boolean };
  if (!res.ok) logger.warn('[reviews] unhideReview failed', { id });
  return res.ok;
}

/** Admin moderation queue: recent reviews across all sellers, newest first. */
export async function getReviewsForModeration(limit = 100): Promise<ModerationReview[]> {
  const rows = (await convex().query(api.marketplace.reviews.forModeration, { limit })) as Array<{
    id: string;
    productId: string;
    spaceId: string;
    buyerEmail: string;
    rating: number;
    title: string | null;
    body: string | null;
    status: ReviewStatus;
    createdAt: string;
  }>;

  if (rows.length === 0) return [];

  const productIds = [...new Set(rows.map((r) => r.productId))];
  const products = (await convex().query(api.marketplace.products.byIds, {
    ids: productIds,
  })) as Array<{ id: string; name: string | null; address: string | null }>;
  const nameById = new Map(
    products.map((p) => [p.id, p.name ?? p.address ?? 'Untitled product']),
  );

  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    productName: nameById.get(r.productId) ?? 'Untitled product',
    spaceId: r.spaceId,
    buyerEmail: r.buyerEmail,
    rating: r.rating,
    title: r.title ?? null,
    body: r.body ?? null,
    status: r.status ?? 'published',
    createdAt: r.createdAt,
  }));
}
