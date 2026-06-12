import { supabase } from '@/lib/supabase';
import {
  getPublishedProducts,
  type MarketplaceProduct,
} from '@/lib/marketplace/products';
import { calculateCommissionCents } from '@/lib/affiliates/commissions';
import { splitCommissionCents } from '@/lib/affiliates/fees';

/**
 * The creator-facing catalog: every published product, decorated with the
 * seller's program terms and what a creator would actually pocket per sale
 * (net of the platform fee). This is the supply side of the marketplace —
 * software looking for distribution.
 */

export interface ExploreProduct extends MarketplaceProduct {
  commissionType: 'percent' | 'flat';
  commissionValue: number;
  recurring: boolean;
  /** Creator's NET earnings per sale at the listed price (null when unpriced). */
  estimatedNetPerSaleCents: number | null;
  /** Human commission line, e.g. "20% per sale" or "$25 per sale". */
  commissionLabel: string;
}

interface ProgramTerms {
  spaceId: string;
  commissionType: 'percent' | 'flat';
  commissionValue: number;
  recurring: boolean;
}

const DEFAULT_TERMS = {
  commissionType: 'percent' as const,
  commissionValue: 20,
  recurring: false,
};

function commissionLabel(terms: { commissionType: 'percent' | 'flat'; commissionValue: number }): string {
  if (terms.commissionType === 'flat') {
    const dollars = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: terms.commissionValue % 100 === 0 ? 0 : 2,
    }).format(terms.commissionValue / 100);
    return `${dollars} per sale`;
  }
  return `${terms.commissionValue}% per sale`;
}

export async function getExploreProducts(filter?: {
  category?: string;
  q?: string;
}): Promise<ExploreProduct[]> {
  const products = await getPublishedProducts(filter);
  if (products.length === 0) return [];

  const spaceIds = [...new Set(products.map((p) => p.spaceId))];
  const { data: programs } = await supabase
    .from('AffiliateProgram')
    .select('spaceId, commissionType, commissionValue, recurring, createdAt')
    .in('spaceId', spaceIds)
    .order('createdAt', { ascending: true });

  // First (default) program per space; sellers without one yet are shown at
  // the platform default — getOrCreateDefaultProgram materialises it the
  // moment a creator actually grabs a link.
  const termsBySpace = new Map<string, ProgramTerms>();
  for (const p of programs ?? []) {
    if (!termsBySpace.has(p.spaceId)) {
      termsBySpace.set(p.spaceId, {
        spaceId: p.spaceId,
        commissionType: p.commissionType === 'flat' ? 'flat' : 'percent',
        commissionValue: Number(p.commissionValue) || 0,
        recurring: Boolean(p.recurring),
      });
    }
  }

  return products.map((product) => {
    const terms = termsBySpace.get(product.spaceId) ?? { spaceId: product.spaceId, ...DEFAULT_TERMS };
    const grossPerSale =
      product.priceCents != null
        ? calculateCommissionCents(terms, product.priceCents)
        : terms.commissionType === 'flat'
          ? Math.max(0, Math.round(terms.commissionValue))
          : null;
    const estimatedNetPerSaleCents =
      grossPerSale != null ? splitCommissionCents(grossPerSale).netCents : null;

    return {
      ...product,
      commissionType: terms.commissionType,
      commissionValue: terms.commissionValue,
      recurring: terms.recurring,
      estimatedNetPerSaleCents,
      commissionLabel: commissionLabel(terms),
    };
  });
}
