import type { MarketplaceProduct } from '@/lib/marketplace/products';

/**
 * Converts integer cents to a display price string.
 * "$49/mo", "$499", or "Contact seller" when priceCents is null.
 */
export function formatPriceCents(product: Pick<MarketplaceProduct, 'priceCents' | 'pricingModel' | 'billingPeriod' | 'currency'>): string {
  if (product.priceCents === null || product.priceCents === undefined) {
    return 'Contact seller';
  }

  const dollars = product.priceCents / 100;
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: product.currency || 'USD',
    maximumFractionDigits: dollars % 1 === 0 ? 0 : 2,
  }).format(dollars);

  if (product.pricingModel === 'subscription') {
    const period = product.billingPeriod === 'yearly' ? '/yr' : '/mo';
    return `${formatted}${period}`;
  }

  return formatted;
}

/**
 * Converts cents to a simple dollar amount string for display (no period suffix).
 */
export function centsToDisplay(cents: number, currency = 'USD'): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: dollars % 1 === 0 ? 0 : 2,
  }).format(dollars);
}
