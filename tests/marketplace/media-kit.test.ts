import { describe, expect, it } from 'vitest';
import { buildPromoCopy, mediaKitImages } from '@/lib/marketplace/media-kit';
import type { MarketplaceProduct } from '@/lib/marketplace/products';

const base: MarketplaceProduct = {
  id: 'p1', spaceId: 's1', sellerSlug: 'acme', sellerName: 'Acme',
  name: 'Acme Analytics', tagline: 'Dashboards your team reads', longDescription: 'Beautiful analytics.',
  category: 'saas', pricingModel: 'subscription', priceCents: 4900, currency: 'usd', billingPeriod: 'monthly',
  features: ['SSO', 'Slack alerts'], logoUrl: 'https://cdn/logo.png', websiteUrl: 'https://acme.dev',
  marketplaceSlug: 'acme-analytics', featured: false,
  verified: false, avgRating: null, reviewCount: 0,
};

describe('buildPromoCopy', () => {
  it('weaves name, tagline, and a feature into the blurbs', () => {
    const c = buildPromoCopy(base);
    expect(c.short).toContain('Acme Analytics');
    expect(c.short).toContain('Dashboards your team reads');
    expect(c.tweet).toContain('Acme Analytics');
    expect(c.tweet).toContain('SSO');
    expect(c.long).toContain('Beautiful analytics.');
  });

  it('degrades gracefully with no tagline/description/features', () => {
    const c = buildPromoCopy({ ...base, tagline: null, longDescription: null, features: [] });
    expect(c.short).toContain('Acme Analytics');
    expect(c.tweet.length).toBeGreaterThan(0);
    expect(c.long.length).toBeGreaterThan(0);
  });
});

describe('mediaKitImages', () => {
  it('includes logo + photos, deduped', () => {
    const imgs = mediaKitImages({ ...base, photos: ['https://cdn/shot1.png', 'https://cdn/logo.png'] });
    expect(imgs).toContain('https://cdn/logo.png');
    expect(imgs).toContain('https://cdn/shot1.png');
    expect(imgs.length).toBe(2); // logo not double-counted
  });
});
