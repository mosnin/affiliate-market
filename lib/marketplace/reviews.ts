/**
 * Marketplace reviews — the trust signal.
 *
 * A review can only be written by someone who actually bought the product:
 * `createReview` looks for a PAID MarketplaceOrder for (productId, buyerEmail)
 * before it will insert. No purchase, no review — that's the whole anti-scam
 * point. One review per buyer per product is enforced both here (friendly
 * error) and by the unique index (race-safe backstop).
 *
 * Money never appears here, so none of the net/gross rules apply. These are
 * just star ratings and words.
 */
import { supabase } from '@/lib/supabase';
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
  // buyer is enough. ilike keeps it case-insensitive to match how orders store
  // the email. Also gives us the spaceId to denormalise onto the review.
  const { data: order } = await supabase
    .from('MarketplaceOrder')
    .select('id, spaceId')
    .eq('productId', input.productId)
    .eq('status', 'paid')
    .ilike('buyerEmail', buyerEmail)
    .limit(1)
    .maybeSingle();

  if (!order) {
    return { ok: false, error: 'Only buyers who purchased this product can review it.', status: 403 };
  }

  const title = (input.title ?? '').trim().slice(0, MAX_TITLE) || null;
  const body = (input.body ?? '').trim().slice(0, MAX_BODY) || null;

  const { error } = await supabase.from('Review').insert({
    spaceId: (order as { spaceId: string }).spaceId,
    productId: input.productId,
    buyerEmail,
    rating,
    title,
    body,
    status: 'published',
  });

  if (error) {
    // 23505 = unique_violation → already reviewed this product.
    if ((error as { code?: string }).code === '23505') {
      return { ok: false, error: 'You already reviewed this product.', status: 409 };
    }
    logger.error('[reviews] createReview insert failed', { productId: input.productId }, error);
    return { ok: false, error: 'Could not save your review. Try again.', status: 500 };
  }

  return { ok: true };
}

/** Published reviews for a product, newest first. */
export async function getReviewsForProduct(productId: string): Promise<PublicReview[]> {
  const { data } = await supabase
    .from('Review')
    .select('id, rating, title, body, createdAt, buyerEmail')
    .eq('productId', productId)
    .eq('status', 'published')
    .order('createdAt', { ascending: false })
    .limit(100);

  return (data ?? []).map((r) => ({
    id: r.id as string,
    rating: r.rating as number,
    title: (r.title as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    createdAt: r.createdAt as string,
    author: maskEmail(r.buyerEmail as string),
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

  const { data } = await supabase
    .from('Review')
    .select('productId, rating')
    .in('productId', ids)
    .eq('status', 'published');

  const sums = new Map<string, { sum: number; count: number }>();
  for (const r of data ?? []) {
    const pid = r.productId as string;
    const acc = sums.get(pid) ?? { sum: 0, count: 0 };
    acc.sum += (r.rating as number) ?? 0;
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
  const { error } = await supabase.from('Review').update({ status: 'hidden' }).eq('id', id);
  if (error) {
    logger.warn('[reviews] hideReview failed', { id, err: error.message });
    return false;
  }
  return true;
}

/** Admin: restore a hidden review to published. */
export async function unhideReview(id: string): Promise<boolean> {
  const { error } = await supabase.from('Review').update({ status: 'published' }).eq('id', id);
  if (error) {
    logger.warn('[reviews] unhideReview failed', { id, err: error.message });
    return false;
  }
  return true;
}

/** Admin moderation queue: recent reviews across all sellers, newest first. */
export async function getReviewsForModeration(limit = 100): Promise<ModerationReview[]> {
  const { data } = await supabase
    .from('Review')
    .select('id, productId, spaceId, buyerEmail, rating, title, body, status, createdAt')
    .order('createdAt', { ascending: false })
    .limit(limit);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const productIds = [...new Set(rows.map((r) => r.productId as string))];
  const { data: products } = await supabase
    .from('Product')
    .select('id, name, address')
    .in('id', productIds);
  const nameById = new Map(
    (products ?? []).map((p) => [
      p.id as string,
      (p.name as string | null) ?? (p.address as string | null) ?? 'Untitled product',
    ]),
  );

  return rows.map((r) => ({
    id: r.id as string,
    productId: r.productId as string,
    productName: nameById.get(r.productId as string) ?? 'Untitled product',
    spaceId: r.spaceId as string,
    buyerEmail: r.buyerEmail as string,
    rating: r.rating as number,
    title: (r.title as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    status: (r.status as ReviewStatus) ?? 'published',
    createdAt: r.createdAt as string,
  }));
}
