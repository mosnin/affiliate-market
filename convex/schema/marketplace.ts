import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Marketplace domain tables — the buy/sell side of Cola (products, orders,
 * licenses, reviews, refund requests, view tracking, profile pages, packets).
 * See convex/CONVENTIONS.md for the Postgres -> Convex translation rules every
 * table here follows (string `id`, ISO timestamps, CHECK/enum -> v.union of
 * v.literal, nullable -> v.optional, jsonb -> v.any, text[] -> v.array, integer
 * counts/cents -> v.number NEVER float, bool -> v.boolean).
 *
 * MONEY: every cents field is an integer -> v.number. Creator-facing money is
 * NET, seller-facing is GROSS (CLAUDE.md); the split/fee math lives in
 * lib/marketplace (fees.ts, sellers.ts) + lib/affiliates and is NOT recomputed
 * here — these tables only store the already-computed cents.
 *
 * Postgres uniqueness invariants that encode real business behavior (no native
 * Convex equivalent) are re-implemented as read-then-insert inside the mutations
 * (serializable within one mutation). They are noted per table below:
 *   - License.licenseKey UNIQUE + idx_license_order UNIQUE(orderId): one license
 *     per order, globally-unique key.
 *   - idx_product_marketplace_slug UNIQUE(marketplaceSlug) WHERE NOT NULL.
 *   - idx_product_space_mls UNIQUE(spaceId, mlsNumber) WHERE NOT NULL.
 *   - idx_refund_request_open_order UNIQUE(orderId) WHERE status='requested':
 *     one OPEN refund request per order.
 *   - idx_review_product_buyer UNIQUE(productId, lower(buyerEmail)): one review
 *     per buyer per product.
 *   - ProfilePage_spaceId_key UNIQUE(spaceId): one profile page per space.
 *   - ProductPacket_token_key UNIQUE(token).
 *
 * Postgres ON DELETE CASCADE that the code relies on (Product/Order deletes) is
 * re-implemented as explicit cascade deletes in the delete mutations. CASCADE to
 * tables OUTSIDE this domain (none) and ON DELETE SET NULL on Deal/Demo.productId
 * (those tables stay on Supabase) cannot be enforced from a Convex mutation —
 * the Product DELETE route handles the cross-backend link clearing itself.
 */
export const marketplaceTables = {
  // Was: "MarketplaceOrder" (TEXT id, spaceId, productId, buyerEmail,
  // clientUserId nullable, amountCents int default 0, currency default 'usd',
  // status default 'pending', referralCode nullable, stripeCheckoutSessionId
  // nullable, createdAt, paidAt nullable, stripeSubscriptionId nullable,
  // sellerPayoutCents int nullable, sellerTransferId nullable, refundedAt
  // nullable, stripePaymentIntentId nullable, discountCents int default 0,
  // stripeCustomerId nullable, platformGmvFeeCents int default 0).
  // status enum is the app's OrderStatus union.
  MarketplaceOrder: defineTable({
    id: v.string(),
    spaceId: v.string(),
    productId: v.string(),
    buyerEmail: v.string(),
    clientUserId: v.optional(v.string()),
    amountCents: v.number(), // integer cents (GROSS sale amount)
    currency: v.string(),
    status: v.union(
      v.literal('pending'),
      v.literal('paid'),
      v.literal('refunded'),
      v.literal('canceled'),
    ),
    referralCode: v.optional(v.string()),
    stripeCheckoutSessionId: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    paidAt: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    sellerPayoutCents: v.optional(v.number()), // integer cents (seller net of commission+gmv fee)
    sellerTransferId: v.optional(v.string()),
    refundedAt: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
    discountCents: v.number(), // integer cents
    stripeCustomerId: v.optional(v.string()),
    platformGmvFeeCents: v.number(), // integer cents (Cola's GMV cut)
  })
    // getOrderById / markOrderPaid / markOrderRefunded / refund-request guard
    // look an order up by its string id.
    .index('by_app_id', ['id'])
    // getOrdersForSpace lists a space's orders newest-first
    // (idx_marketplace_order_space_created = (spaceId, createdAt DESC)).
    .index('by_space_created', ['spaceId', 'createdAt'])
    // getOrdersForBuyerEmail / getStripeCustomerForBuyer / reviews+refunds buyer
    // gate filter by buyerEmail (idx_marketplace_order_buyer = lower(buyerEmail)).
    // We store/lookup the already-lowercased email the lib always passes.
    .index('by_buyer_email', ['buyerEmail'])
    // Webhook reconciliation by Stripe ids — each its own partial PG index.
    .index('by_stripe_session', ['stripeCheckoutSessionId'])
    .index('by_stripe_payment_intent', ['stripePaymentIntentId'])
    .index('by_stripe_subscription', ['stripeSubscriptionId'])
    // reviews/refunds gate also filters productId+status; admin-metrics filters
    // by status+paidAt. Productid lookup for review/refund eligibility.
    .index('by_product', ['productId']),

  // Was: "Product" (TEXT id, spaceId, real-estate-era address/unitNumber/city/
  // stateRegion/postalCode/mlsNumber/beds/baths/squareFeet/lotSizeSqft/yearBuilt/
  // listPrice/listingStatus/listingUrl/photos jsonb/notes [all kept for back-
  // compat], createdAt, updatedAt, companyId nullable, assignedSpaceId nullable,
  // + software-product fields: name/tagline/longDescription/category/pricingModel
  // default 'one_time'/priceCents nullable/currency default 'usd'/billingPeriod/
  // features jsonb/logoUrl/websiteUrl/published default false/marketplaceSlug/
  // commissionType/commissionValue/featured default false/verified default false).
  // numeric beds/baths/listPrice/commissionValue -> v.number (NOT money cents,
  // but kept numeric per PG); priceCents IS integer cents.
  Product: defineTable({
    id: v.string(),
    spaceId: v.string(),
    address: v.optional(v.string()),
    unitNumber: v.optional(v.string()),
    city: v.optional(v.string()),
    stateRegion: v.optional(v.string()),
    postalCode: v.optional(v.string()),
    mlsNumber: v.optional(v.string()),
    productType: v.optional(v.string()),
    beds: v.optional(v.number()),
    baths: v.optional(v.number()),
    squareFeet: v.optional(v.number()),
    lotSizeSqft: v.optional(v.number()),
    yearBuilt: v.optional(v.number()),
    listPrice: v.optional(v.number()),
    listingStatus: v.string(), // default 'draft' (validated by lib/products, not a fixed enum here)
    listingUrl: v.optional(v.string()),
    photos: v.any(), // jsonb array of URLs (default [])
    notes: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    companyId: v.optional(v.string()),
    assignedSpaceId: v.optional(v.string()),
    name: v.optional(v.string()),
    tagline: v.optional(v.string()),
    longDescription: v.optional(v.string()),
    category: v.optional(v.string()),
    pricingModel: v.string(), // default 'one_time'
    priceCents: v.optional(v.number()), // integer cents
    currency: v.string(), // default 'usd'
    billingPeriod: v.optional(v.string()),
    features: v.any(), // jsonb array (default [])
    logoUrl: v.optional(v.string()),
    websiteUrl: v.optional(v.string()),
    published: v.boolean(), // default false
    marketplaceSlug: v.optional(v.string()),
    commissionType: v.optional(v.string()),
    commissionValue: v.optional(v.number()),
    featured: v.boolean(), // default false
    verified: v.boolean(), // default false
  })
    // Every per-row read/update/delete keys by id (products CRUD, checkout,
    // ai-tools, cma, packets resolve, etc.).
    .index('by_app_id', ['id'])
    // Seller listing pages + profile picker + funnel filter by spaceId, newest-
    // updated first (idx_product_space_updated = (spaceId, updatedAt DESC)).
    .index('by_space_updated', ['spaceId', 'updatedAt'])
    // Company-pool products (idx_product_assigned_space = assignedSpaceId).
    .index('by_assigned_space', ['assignedSpaceId'])
    // Company products list (idx_product_company = (companyId, updatedAt DESC)).
    .index('by_company_updated', ['companyId', 'updatedAt'])
    // Marketplace catalog: published products (+ optional category filter)
    // (idx_product_published = (published, category)).
    .index('by_published_category', ['published', 'category'])
    // getProductBySlug — UNIQUE(marketplaceSlug) WHERE NOT NULL. Also backs the
    // uniqueness read-then-insert in the create/update mutations.
    .index('by_marketplace_slug', ['marketplaceSlug']),

  // Was: "ProductPacket" (TEXT id, spaceId, productId, name, token,
  // includeDocumentIds jsonb default [], expiresAt nullable, viewCount int
  // default 0, lastViewedAt nullable, createdAt, revokedAt nullable).
  ProductPacket: defineTable({
    id: v.string(),
    spaceId: v.string(),
    productId: v.string(),
    name: v.string(),
    token: v.string(),
    includeDocumentIds: v.any(), // jsonb array of DealDocument ids
    expiresAt: v.optional(v.string()),
    viewCount: v.number(),
    lastViewedAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    revokedAt: v.optional(v.string()),
  })
    // PATCH/DELETE/resolve look a packet up by id (+ scope checks in the route).
    .index('by_app_id', ['id'])
    // The public packet page + documents endpoint resolve by token
    // (ProductPacket_token_key UNIQUE). Also backs the token-uniqueness read.
    .index('by_token', ['token'])
    // GET lists a product's packets newest-first
    // (idx_product_packet_product = productId; route adds spaceId scope in mem).
    .index('by_product_created', ['productId', 'createdAt']),

  // Was: "License" (TEXT id, orderId, productId, buyerEmail, licenseKey,
  // status default 'active', deliveredAt default now(), expiresAt nullable).
  // status enum is the app's LicenseStatus union.
  License: defineTable({
    id: v.string(),
    orderId: v.string(),
    productId: v.string(),
    buyerEmail: v.string(),
    licenseKey: v.string(),
    status: v.union(v.literal('active'), v.literal('revoked'), v.literal('expired')),
    deliveredAt: v.string(), // ISO-8601 (PG default now())
    expiresAt: v.optional(v.string()),
  })
    // getLicensesForBuyerEmail filters by lower(buyerEmail) (idx_license_buyer).
    // The lib always lowercases before query/insert, matching PG's lower() index.
    .index('by_buyer_email', ['buyerEmail'])
    // getLicenseForOrder + markOrderRefunded revoke key by orderId. PG had
    // idx_license_order UNIQUE(orderId) — one license per order; the markOrderPaid
    // mutation enforces it via read-then-insert before delivering a license.
    .index('by_order', ['orderId'])
    // licenseKey global uniqueness backstop — the delivery mutation reads this
    // before insert so a regenerated key can't collide (License_licenseKey_key).
    .index('by_license_key', ['licenseKey']),

  // Was: "Review" (TEXT id, spaceId, productId, buyerEmail, rating int,
  // title nullable, body nullable, status default 'published', createdAt).
  // status enum is the app's ReviewStatus union.
  Review: defineTable({
    id: v.string(),
    spaceId: v.string(),
    productId: v.string(),
    buyerEmail: v.string(),
    rating: v.number(), // integer 1..5 (validated in lib)
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    status: v.union(v.literal('published'), v.literal('hidden')),
    createdAt: v.string(), // ISO-8601
  })
    // hideReview / unhideReview patch by id; moderation read by id.
    .index('by_app_id', ['id'])
    // Product page + rating aggregate filter (productId, status), newest-first
    // (idx_review_product_status = (productId, status, createdAt DESC)). Also
    // serves getRatingForProducts (per-product scan filtered to published).
    .index('by_product_status', ['productId', 'status', 'createdAt'])
    // UNIQUE(productId, lower(buyerEmail)) — one review per buyer per product.
    // createReview reads this (lowercased email) before insert as the race-safe
    // backstop the unique index used to provide.
    .index('by_product_buyer', ['productId', 'buyerEmail']),

  // Was: "RefundRequest" (TEXT id, orderId, spaceId, buyerEmail, reason
  // nullable, status default 'requested', createdAt, resolvedAt nullable).
  // status enum is the app's RefundRequestStatus union.
  RefundRequest: defineTable({
    id: v.string(),
    orderId: v.string(),
    spaceId: v.string(),
    buyerEmail: v.string(),
    reason: v.optional(v.string()),
    status: v.union(v.literal('requested'), v.literal('approved'), v.literal('declined')),
    createdAt: v.string(), // ISO-8601
    resolvedAt: v.optional(v.string()),
  })
    // approve/decline resolve a request by id.
    .index('by_app_id', ['id'])
    // getRefundRequestForOrder + the "one open per order" pre-check filter by
    // orderId (and status). UNIQUE(orderId) WHERE status='requested' is enforced
    // by reading this index for an open request before insert.
    .index('by_order', ['orderId'])
    // getRefundRequestsForSpace filters (spaceId, status) newest-first
    // (idx_refund_request_space_status = (spaceId, status, createdAt DESC)).
    .index('by_space_status', ['spaceId', 'status', 'createdAt']),

  // Was: "ProductView" (TEXT id, spaceId nullable, productId, visitorId
  // nullable, ipHash nullable, createdAt). Thin append-only beacon row.
  ProductView: defineTable({
    id: v.string(),
    spaceId: v.optional(v.string()),
    productId: v.string(),
    visitorId: v.optional(v.string()),
    ipHash: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // getViewCountsForProducts + funnel tally per product
    // (idx_productview_product_created = (productId, createdAt DESC)).
    .index('by_product_created', ['productId', 'createdAt']),

  // Was: "ProfilePage" (TEXT id, spaceId, enabled default true, headline
  // nullable, showIntake/showDemos/showProducts default true, customLinks jsonb
  // default [], createdAt, updatedAt, videos jsonb default [], coverPhotoUrl
  // nullable, profilePhotoUrl nullable, featuredProductIds text[] default {}).
  // UNIQUE(spaceId): one profile page per space — every read/write is an upsert
  // keyed on spaceId, re-implemented as read-by-space-then-insert-or-patch.
  ProfilePage: defineTable({
    id: v.string(),
    spaceId: v.string(),
    enabled: v.boolean(),
    headline: v.optional(v.string()),
    showIntake: v.boolean(),
    showDemos: v.boolean(),
    showProducts: v.boolean(),
    customLinks: v.any(), // jsonb array of { id, label, url, thumbnail }
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    videos: v.any(), // jsonb array of { id, url, title }
    coverPhotoUrl: v.optional(v.string()),
    profilePhotoUrl: v.optional(v.string()),
    featuredProductIds: v.array(v.string()), // text[] (default {})
  })
    // Every access is by spaceId (UNIQUE) — the upsert reads this then
    // inserts-or-patches the single row.
    .index('by_space', ['spaceId']),
};
