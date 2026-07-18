import type { MarketplaceProduct } from '@/lib/marketplace/products';

/**
 * Media-kit promo copy — ready-to-post blurbs a creator can grab and tweak.
 * Generated from the product's own fields so every listing has a kit without
 * the seller writing one. The creator appends their referral link.
 */
export interface PromoCopy {
  short: string;
  tweet: string;
  long: string;
}

export function buildPromoCopy(product: MarketplaceProduct): PromoCopy {
  const name = product.name;
  const tagline = product.tagline?.trim();
  const desc = product.longDescription?.trim();
  const feature = product.features[0]?.trim();

  const short = tagline
    ? `${name} — ${tagline}. Check it out:`
    : `${name} is worth a look. Check it out:`;

  const tweet = [
    tagline ? `${name}: ${tagline}` : `I've been using ${name}`,
    feature ? `What sold me: ${feature}.` : '',
    'Grab it here →',
  ]
    .filter(Boolean)
    .join(' ');

  const long = [
    tagline ? `${name} — ${tagline}.` : `${name}.`,
    desc || (feature ? `Highlights: ${product.features.slice(0, 3).join(', ')}.` : ''),
    'If you’ve been looking for something like this, give it a try with my link below:',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { short, tweet, long };
}

/** Image assets a creator can grab (logo + screenshots). */
export function mediaKitImages(product: MarketplaceProduct & { photos?: string[] }): string[] {
  const imgs: string[] = [];
  if (product.logoUrl) imgs.push(product.logoUrl);
  if (Array.isArray(product.photos)) imgs.push(...product.photos.filter((p) => typeof p === 'string'));
  return [...new Set(imgs)];
}
