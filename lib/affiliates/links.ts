import { randomBytes } from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

export interface ReferralLinkRow {
  id: string;
  partnerId: string;
  programId: string;
  code: string;
  destinationUrl: string | null;
  productId: string | null;
  discountPercent: number;
  isVanity: boolean;
  createdAt: string;
}

/** Vanity codes are typed by humans: letters/digits, 3–24 chars, case-folded. */
export function normalizeVanityCode(raw: string): string | null {
  const code = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z0-9][a-z0-9_-]{2,23}$/.test(code)) return null;
  return code;
}

export interface ReferralLinkWithClicks {
  id: string;
  code: string;
  destinationUrl: string | null;
  productId: string | null;
  productName: string | null;
  discountPercent: number;
  isVanity: boolean;
  clicks: number;
}

/**
 * Short referral codes: 8 chars from an unambiguous alphabet (no 0/O/1/l/I).
 * ~40 bits of entropy — plenty for per-partner link codes.
 */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generateReferralCode(length = 8): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/** Full shareable URL for a code. Default destination is the marketplace. */
export function buildReferralUrl(code: string, base: string): string {
  const origin = (base || '').replace(/\/$/, '');
  return `${origin}/marketplace?via=${encodeURIComponent(code)}`;
}

/**
 * Shareable URL honouring the link's destination (e.g. a product page from
 * the explore flow). Falls back to the marketplace home.
 */
export function buildReferralLinkUrl(
  link: { code: string; destinationUrl: string | null },
  base: string,
): string {
  const origin = (base || '').replace(/\/$/, '');
  const dest =
    link.destinationUrl && link.destinationUrl.startsWith('/')
      ? link.destinationUrl
      : '/marketplace';
  const sep = dest.includes('?') ? '&' : '?';
  return `${origin}${dest}${sep}via=${encodeURIComponent(link.code)}`;
}

export async function getLinkByCode(code: string): Promise<ReferralLinkRow | null> {
  if (!code) return null;
  const { data } = await supabase
    .from('ReferralLink')
    .select('*')
    .eq('code', code)
    .maybeSingle();
  return (data as ReferralLinkRow) ?? null;
}

export async function createLink(
  partnerId: string,
  destinationUrl?: string | null,
  productId?: string | null,
): Promise<ReferralLinkRow | null> {
  const { data: partner } = await supabase
    .from('AffiliatePartner')
    .select('id, programId')
    .eq('id', partnerId)
    .maybeSingle();
  if (!partner) return null;

  // Codes are globally unique; retry a couple of times on the off chance of a
  // collision rather than pre-checking (insert is the race-free check).
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateReferralCode();
    const { data, error } = await supabase
      .from('ReferralLink')
      .insert({
        partnerId: partner.id,
        programId: partner.programId,
        code,
        destinationUrl: destinationUrl ?? null,
        productId: productId ?? null,
      })
      .select('*')
      .single();

    if (!error) return data as ReferralLinkRow;
    if (!`${error.message}`.toLowerCase().includes('duplicate')) {
      logger.warn('[affiliates] createLink failed', { error: error.message });
      return null;
    }
  }
  return null;
}

/**
 * Create a vanity code: a human-chosen code with an optional discount.
 * Returns { error } when the code is malformed or already taken so the
 * caller can tell the creator why.
 */
export async function createVanityLink(
  partnerId: string,
  rawCode: string,
  opts?: { discountPercent?: number; productId?: string | null; destinationUrl?: string | null },
): Promise<{ link: ReferralLinkRow } | { error: string }> {
  const code = normalizeVanityCode(rawCode);
  if (!code) return { error: 'Codes are 3–24 letters, numbers, - or _.' };

  const discountPercent = Math.max(0, Math.min(90, Math.round(opts?.discountPercent ?? 0)));

  const { data: partner } = await supabase
    .from('AffiliatePartner')
    .select('id, programId')
    .eq('id', partnerId)
    .maybeSingle();
  if (!partner) return { error: 'Partner not found.' };

  const { data, error } = await supabase
    .from('ReferralLink')
    .insert({
      partnerId: partner.id,
      programId: partner.programId,
      code,
      discountPercent,
      isVanity: true,
      productId: opts?.productId ?? null,
      destinationUrl: opts?.destinationUrl ?? null,
    })
    .select('*')
    .single();

  if (error) {
    if (`${error.message}`.toLowerCase().includes('duplicate')) {
      return { error: 'That code is taken. Try another.' };
    }
    logger.warn('[affiliates] createVanityLink failed', { error: error.message });
    return { error: 'Could not create that code.' };
  }
  return { link: data as ReferralLinkRow };
}

/** Existing product link for a partner, if they already generated one. */
export async function getLinkForProduct(
  partnerId: string,
  productId: string,
): Promise<ReferralLinkRow | null> {
  const { data } = await supabase
    .from('ReferralLink')
    .select('*')
    .eq('partnerId', partnerId)
    .eq('productId', productId)
    .order('createdAt', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as ReferralLinkRow) ?? null;
}

export async function listLinksForPartner(partnerId: string): Promise<ReferralLinkWithClicks[]> {
  return listLinksForPartners([partnerId]);
}

/** Links across all of a creator's partner rows (one per seller program). */
export async function listLinksForPartners(
  partnerIds: string[],
): Promise<ReferralLinkWithClicks[]> {
  if (partnerIds.length === 0) return [];
  const { data: links } = await supabase
    .from('ReferralLink')
    .select('id, code, destinationUrl, productId, discountPercent, isVanity')
    .in('partnerId', partnerIds)
    .order('createdAt', { ascending: true });
  if (!links || links.length === 0) return [];

  const ids = links.map((l) => l.id);
  const productIds = [...new Set(links.map((l) => l.productId).filter(Boolean))] as string[];

  const [clicksRes, productsRes] = await Promise.all([
    supabase.from('ReferralClick').select('linkId').in('linkId', ids),
    productIds.length > 0
      ? supabase.from('Product').select('id, name, address').in('id', productIds)
      : Promise.resolve({ data: [] as { id: string; name: string | null; address: string | null }[] }),
  ]);

  const counts = new Map<string, number>();
  for (const c of clicksRes.data ?? []) {
    counts.set(c.linkId, (counts.get(c.linkId) ?? 0) + 1);
  }
  const productNames = new Map(
    (productsRes.data ?? []).map((p) => [p.id, p.name ?? p.address ?? null]),
  );

  return links.map((l) => ({
    id: l.id,
    code: l.code,
    destinationUrl: l.destinationUrl ?? null,
    productId: l.productId ?? null,
    productName: l.productId ? (productNames.get(l.productId) ?? null) : null,
    discountPercent: l.discountPercent ?? 0,
    isVanity: Boolean(l.isVanity),
    clicks: counts.get(l.id) ?? 0,
  }));
}
