import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Affiliates domain — the MONEY CORE of Cola. Sellers run programs, creators
 * earn commissions on the software they distribute, the platform takes a flat
 * 20% cut, and payouts move the creator's NET to their Stripe.
 *
 * See convex/CONVENTIONS.md for the Postgres -> Convex translation rules every
 * table follows (string `id`; ISO-8601 timestamps as v.string(); CHECK enums ->
 * v.union of v.literal; nullable -> v.optional; jsonb -> v.any; integer
 * cents/counts -> v.number NEVER float; bool -> v.boolean; text[]/jsonb-array ->
 * v.array(v.string())).
 *
 * MONEY RULES (CLAUDE.md):
 *   - integer cents ONLY, never float — every *Cents field is v.number().
 *   - AffiliateCommission stores GROSS (amountCents = what the seller owes),
 *     platformFeeCents (Cola's 20%), and netCents (what the creator keeps). The
 *     20% split lives in lib/affiliates/fees.ts#splitCommissionCents and STAYS
 *     in lib; these inserts only store the gross/fee/net the lib computed.
 *   - Creator-facing money is NET; seller-facing money is GROSS. The tables hold
 *     both; the lib mappers decide which a given surface sees.
 *
 * Invariants preserved (no native Convex equivalent) as read-then-insert inside
 * the mutations (serializable in one mutation), noted per table:
 *   - AffiliatePartner: idx_affiliate_partner_space_email UNIQUE(spaceId,
 *     lower(email)) — one partner per (space, email); createPartner reads
 *     by_space_email before insert.
 *   - AffiliateProgram: one default program per space (the lib selects the
 *     earliest by createdAt); getOrCreateDefaultProgram reads by_space first.
 *   - AffiliateCommission: idx_affiliate_commission_stripe_invoice UNIQUE(
 *     stripeInvoiceId) WHERE NOT NULL — one commission per Stripe invoice
 *     (recurring idempotency); recordPaymentCommission reads by_stripe_invoice.
 *   - Referral: idx_referral_link_buyer UNIQUE(linkId, lower(buyerEmail)) — one
 *     referral per link+buyer; the conversion upsert reads by_link_buyer.
 *   - ReferralLink: code is globally unique (no pre-check — insert is the race;
 *     by_code backs the lookup and a collision retry).
 *   - CreatorProfile: CreatorProfile_emailLower_key UNIQUE(emailLower) — one
 *     profile per creator; upsertCreatorProfile reads by_email_lower then
 *     inserts-or-patches.
 *   - CommissionLedger: idx_commission_ledger_deal UNIQUE(dealId) — one ledger
 *     row per deal (PG ON CONFLICT (dealId) DO NOTHING from the Deal->won
 *     trigger); the insert mutation reads by_deal first.
 *
 * Hold/settlement gating preserved verbatim (lib does the filtering; these
 * fields carry the state the lib reads):
 *   - matureAt: refund-hold window. A commission is only payable once
 *     matureAt <= now (lib filters .lte('matureAt', now)).
 *   - settledAt: bridge gating. A stripe_bridge commission is payable ONLY once
 *     settledAt is set (seller has paid the settlement invoice). marketplace
 *     commissions never wait on it.
 *   - recurring: periodNumber + stripeInvoiceId carry the renewal chain.
 *   - tier-2: AffiliatePartner.parentPartnerId + AffiliateCommission.level=2.
 *   - clawbacks/reversals: status='reversed' + AffiliatePartner
 *     .balanceAdjustmentCents goes negative (next payout absorbs the debt).
 */
export const affiliatesTables = {
  // Was: "AffiliatePartner" (TEXT id, spaceId, programId, name, email,
  // clerkUserId nullable, status CHECK pending/approved/suspended default
  // pending, payoutMethod nullable, payoutDetails jsonb nullable, createdAt,
  // stripeAccountId nullable, balanceAdjustmentCents int default 0,
  // invitedBySeller bool default false, parentPartnerId nullable).
  AffiliatePartner: defineTable({
    id: v.string(),
    spaceId: v.string(),
    programId: v.string(),
    name: v.string(),
    email: v.string(), // stored lower-cased by the writer (matches PG lower(email))
    clerkUserId: v.optional(v.string()),
    status: v.union(v.literal('pending'), v.literal('approved'), v.literal('suspended')),
    payoutMethod: v.optional(v.string()),
    payoutDetails: v.optional(v.any()), // jsonb
    createdAt: v.string(), // ISO-8601
    stripeAccountId: v.optional(v.string()), // Stripe Connect (Express) account
    balanceAdjustmentCents: v.number(), // integer cents; goes NEGATIVE on refund clawback (debt)
    invitedBySeller: v.boolean(),
    parentPartnerId: v.optional(v.string()), // recruiter (sub-affiliate tier-2)
  })
    // getPartnerById / approve / suspend / tier2 / reversal / payout all key by id.
    .index('by_app_id', ['id'])
    // UNIQUE(spaceId, lower(email)) — one partner per (space, email). createPartner
    // reads this (lowercased email) before insert; listCreatorsForSeller filters
    // (spaceId, email). idx_affiliate_partner_space_email.
    .index('by_space_email', ['spaceId', 'email'])
    // listPartners / getProgramStats / digests list a space's partners.
    // idx is space-scoped; (spaceId, status) also serves the pending/approved scans.
    .index('by_space_status', ['spaceId', 'status'])
    // getPartnerByUser/getPartnersByUser by clerkUserId (idx_affiliate_partner_clerk).
    .index('by_clerk', ['clerkUserId'])
    // getPartnerByUser/getPartnersByUser/listCreatorsForSeller by lower(email)
    // across spaces (idx_affiliate_partner_email = lower(email)).
    .index('by_email', ['email']),

  // Was: "AffiliateProgram" (TEXT id, spaceId, name default 'Default program',
  // commissionType CHECK percent/flat default 'percent', commissionValue numeric
  // default 20, recurring bool default false, recurringMonths int nullable,
  // cookieWindowDays int default 30, autoApproveAffiliates bool default false,
  // autoApproveCommissions bool default false, createdAt, updatedAt, tier2Enabled
  // bool default false, tier2Percent numeric default 10, holdDays int default 14,
  // minPayoutCents int default 2000). commissionValue/tier2Percent are numeric
  // percentages -> v.number (NOT cents; minPayoutCents IS integer cents).
  AffiliateProgram: defineTable({
    id: v.string(),
    spaceId: v.string(),
    name: v.string(),
    commissionType: v.union(v.literal('percent'), v.literal('flat')),
    commissionValue: v.number(), // numeric: percent (0-100) OR flat cents (lib decides by type)
    recurring: v.boolean(),
    recurringMonths: v.optional(v.number()), // null/absent = lifetime
    cookieWindowDays: v.number(),
    autoApproveAffiliates: v.boolean(),
    autoApproveCommissions: v.boolean(),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    tier2Enabled: v.boolean(),
    tier2Percent: v.number(), // numeric percent 0-50
    holdDays: v.number(), // refund-hold window in days (matureAt = createdAt + holdDays)
    minPayoutCents: v.number(), // integer cents — payout floor
  })
    // conversion/recurring/tier2/payout load a program by id (link.programId,
    // partner.programId). updateProgram patches by id.
    .index('by_app_id', ['id'])
    // getOrCreateDefaultProgram + explore terms select the earliest program for a
    // space (idx_affiliate_program_space). Backs the one-program-per-space upsert.
    .index('by_space', ['spaceId']),

  // Was: "AffiliateCommission" (TEXT id, spaceId, partnerId, referralId nullable,
  // orderId nullable, amountCents int default 0 [GROSS], currency default 'usd',
  // status CHECK pending/approved/paid/rejected/reversed default 'pending', level
  // int default 1, payoutId nullable, note nullable, createdAt, approvedAt
  // nullable, platformFeeCents int default 0, netCents int nullable, source
  // default 'marketplace', periodNumber int default 1, stripeInvoiceId nullable,
  // settledAt nullable, settlementInvoiceId nullable, reversedAt nullable,
  // reversalReason nullable, matureAt nullable).
  //
  // MONEY: amountCents = GROSS (seller owes). platformFeeCents = Cola's 20%.
  // netCents = creator keeps. The 20% split is computed in lib/affiliates/fees.ts
  // and passed in — NEVER recomputed here.
  AffiliateCommission: defineTable({
    id: v.string(),
    spaceId: v.string(),
    partnerId: v.string(),
    referralId: v.optional(v.string()),
    orderId: v.optional(v.string()),
    amountCents: v.number(), // integer cents — GROSS (what the seller owes)
    currency: v.string(),
    status: v.union(
      v.literal('pending'),
      v.literal('approved'),
      v.literal('paid'),
      v.literal('rejected'),
      v.literal('reversed'),
    ),
    level: v.number(), // 1 = direct, 2 = sub-affiliate override
    payoutId: v.optional(v.string()), // set when a payout consumes this commission
    note: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    approvedAt: v.optional(v.string()),
    platformFeeCents: v.number(), // integer cents — Cola's flat 20% cut
    netCents: v.optional(v.number()), // integer cents — creator's NET (gross - fee)
    source: v.union(v.literal('marketplace'), v.literal('stripe_bridge')),
    periodNumber: v.number(), // 1 = sale; >1 = subscription renewal period
    stripeInvoiceId: v.optional(v.string()), // recurring idempotency key (UNIQUE where not null)
    settledAt: v.optional(v.string()), // bridge gating: payable only once set
    settlementInvoiceId: v.optional(v.string()),
    reversedAt: v.optional(v.string()),
    reversalReason: v.optional(v.string()),
    matureAt: v.optional(v.string()), // refund-hold: payable only once matureAt <= now
  })
    // approve/reject/payout-consume key a commission by id; the route ownership
    // checks read (id, spaceId).
    .index('by_app_id', ['id'])
    // listCommissions / getProgramStats / finance / settlement / bridge-owed all
    // filter by spaceId (+ status / source / createdAt in mem).
    // idx_affiliate_commission_space_status = (spaceId, status, createdAt DESC).
    .index('by_space_status', ['spaceId', 'status', 'createdAt'])
    // createPayout / getPayableBalance / stats / period-count filter by partnerId
    // (+ status, matureAt). idx_affiliate_commission_partner_status +
    // idx_affiliate_commission_payable = (partnerId, status, matureAt).
    .index('by_partner_status', ['partnerId', 'status', 'matureAt'])
    // reverseCommissionsForOrder filters by orderId; link-analytics/period count
    // by referralId. idx_affiliate_commission_referral = referralId.
    .index('by_order', ['orderId'])
    .index('by_referral', ['referralId'])
    // recordPaymentCommission idempotency + reverseCommissionsForInvoice key by
    // stripeInvoiceId. idx_affiliate_commission_stripe_invoice UNIQUE where not null.
    .index('by_stripe_invoice', ['stripeInvoiceId']),

  // Was: "AffiliatePayout" (TEXT id, spaceId, partnerId, amountCents int default
  // 0 [creator NET], method nullable, status CHECK pending/processing/completed/
  // failed default 'pending', periodStart nullable, periodEnd nullable, paidAt
  // nullable, createdAt, platformFeeCents int default 0, stripeTransferId nullable).
  // amountCents = creator NET (what actually transfers). platformFeeCents accrued.
  AffiliatePayout: defineTable({
    id: v.string(),
    spaceId: v.string(),
    partnerId: v.string(),
    amountCents: v.number(), // integer cents — creator NET (transferred amount)
    method: v.optional(v.string()),
    status: v.union(
      v.literal('pending'),
      v.literal('processing'),
      v.literal('completed'),
      v.literal('failed'),
    ),
    periodStart: v.optional(v.string()),
    periodEnd: v.optional(v.string()),
    paidAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    platformFeeCents: v.number(), // integer cents — Cola's accrued cut over this payout
    stripeTransferId: v.optional(v.string()),
  })
    // markPayoutCompleted/markPayoutFailed/transfer-complete patch by id.
    .index('by_app_id', ['id'])
    // listPayouts by space, newest-first (idx_affiliate_payout_space).
    .index('by_space_created', ['spaceId', 'createdAt'])
    // listPayoutsForPartners + tax-export by partner, newest-first
    // (idx_affiliate_payout_partner). Also serves the (status, paidAt) tax scan.
    .index('by_partner_created', ['partnerId', 'createdAt'])
    // tax-export filters completed payouts by paidAt window across all partners.
    .index('by_status_paid', ['status', 'paidAt']),

  // Was: "Referral" (TEXT id, linkId, partnerId, buyerEmail, orderId nullable,
  // status CHECK lead/customer default 'lead', firstClickAt nullable, convertedAt
  // nullable, createdAt). Attribution: one row per link+buyer.
  Referral: defineTable({
    id: v.string(),
    linkId: v.string(),
    partnerId: v.string(),
    buyerEmail: v.string(), // stored lower-cased (matches PG lower(buyerEmail))
    orderId: v.optional(v.string()),
    status: v.union(v.literal('lead'), v.literal('customer')),
    firstClickAt: v.optional(v.string()),
    convertedAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // UNIQUE(linkId, lower(buyerEmail)) — one referral per link+buyer. The
    // conversion/recurring upsert reads by_link_buyer before insert.
    // idx_referral_link_buyer. Also serves resolveReferral's "latest by link".
    .index('by_link_buyer', ['linkId', 'buyerEmail'])
    // resolveReferral (recurring) + link-analytics scan referrals by linkId.
    .index('by_link', ['linkId'])
    // stats/partners/digests/resolveReferral filter by partnerId (+ status,
    // convertedAt in mem). idx_referral_partner = partnerId.
    .index('by_partner', ['partnerId']),

  // Was: "ReferralLink" (TEXT id, partnerId, programId, code, destinationUrl
  // nullable, createdAt, productId nullable, discountPercent int default 0,
  // isVanity bool default false). code is globally unique.
  ReferralLink: defineTable({
    id: v.string(),
    partnerId: v.string(),
    programId: v.string(),
    code: v.string(),
    destinationUrl: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    productId: v.optional(v.string()),
    discountPercent: v.number(), // 0-90
    isVanity: v.boolean(),
  })
    // getLinkByCode (attribution hot path) + the code-uniqueness collision retry.
    // code is globally UNIQUE.
    .index('by_code', ['code'])
    // createLink/createVanityLink read the link's owning partner for programId;
    // listLinksForPartners / link-analytics / stats list a partner's links.
    // idx_referral_link_partner = partnerId.
    .index('by_partner', ['partnerId'])
    // getLinkForProduct filters (partnerId, productId) earliest-first.
    // idx_referral_link_product = productId (where not null).
    .index('by_partner_product', ['partnerId', 'productId']),

  // Was: "ReferralClick" (TEXT id, linkId, visitorId nullable, ipHash nullable,
  // userAgent nullable, landingUrl nullable, referrer nullable, createdAt).
  // Append-only click telemetry (best-effort; cookie is the source of truth).
  ReferralClick: defineTable({
    id: v.string(),
    linkId: v.string(),
    visitorId: v.optional(v.string()),
    ipHash: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    landingUrl: v.optional(v.string()),
    referrer: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // recordConversion reads the latest/earliest click per link for the
    // attribution window; stats/digests/analytics count clicks per link.
    // idx_referral_click_link_created = (linkId, createdAt DESC).
    .index('by_link_created', ['linkId', 'createdAt']),

  // Was: "CommissionSplit" (TEXT id, dealId, spaceId, party, label, basis CHECK
  // percent/flat, percentOfGci numeric(6,3) nullable, flatAmount numeric(14,2)
  // nullable, paidAt nullable, notes nullable, createdAt, updatedAt). Real-estate
  // GCI split — money is numeric DOLLARS here (percentOfGci / flatAmount), NOT
  // cents. The CHECK that ties basis to which field is set is enforced by the
  // route building the patch (clears the other field when switching basis).
  CommissionSplit: defineTable({
    id: v.string(),
    dealId: v.string(),
    spaceId: v.string(),
    party: v.string(),
    label: v.string(),
    basis: v.union(v.literal('percent'), v.literal('flat')),
    percentOfGci: v.optional(v.number()), // numeric percent (set when basis='percent')
    flatAmount: v.optional(v.number()), // numeric dollars (set when basis='flat')
    paidAt: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // PATCH/DELETE resolve a split by (id, dealId, spaceId).
    .index('by_app_id', ['id'])
    // GET lists a deal's splits (dealId, spaceId) earliest-first; the commissions
    // page loads all of a space's splits. idx_commission_split_deal = dealId,
    // idx_commission_split_space_paid = (spaceId, paidAt).
    .index('by_deal', ['dealId'])
    .index('by_space', ['spaceId']),

  // Was: "CommissionLedger" (TEXT id, companyId, agentUserId nullable, dealId
  // nullable, closedAt, dealValue numeric(12,2), agentRate numeric(5,2),
  // managerRate numeric(5,2), referralRate numeric(5,2) default 0, referralUserId
  // nullable, agentAmount numeric(12,2), managerAmount numeric(12,2),
  // referralAmount numeric(12,2) default 0, status CHECK pending/paid/void default
  // 'pending', payoutAt nullable, notes nullable, createdAt, updatedAt). Real-
  // estate GCI ledger — money is numeric DOLLARS, NOT cents. Rows are minted by
  // the Deal->'won' Postgres trigger (UNIQUE(dealId) ON CONFLICT DO NOTHING); the
  // app only reads + PATCHes them. The insert mutation reimplements that trigger
  // for completeness (read-then-insert on by_deal).
  CommissionLedger: defineTable({
    id: v.string(),
    companyId: v.string(),
    agentUserId: v.optional(v.string()),
    dealId: v.optional(v.string()),
    closedAt: v.string(), // ISO-8601
    dealValue: v.number(), // numeric dollars
    agentRate: v.number(), // numeric percent 0-100
    managerRate: v.number(), // numeric percent 0-100
    referralRate: v.number(), // numeric percent 0-100
    referralUserId: v.optional(v.string()),
    agentAmount: v.number(), // numeric dollars (dealValue * agentRate / 100)
    managerAmount: v.number(), // numeric dollars
    referralAmount: v.number(), // numeric dollars
    status: v.union(v.literal('pending'), v.literal('paid'), v.literal('void')),
    payoutAt: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // ledger PATCH loads + scopes a row by (id, companyId).
    .index('by_app_id', ['id'])
    // page + export list a company's ledger by closedAt window
    // (idx_commission_agent/_company are companyId-scoped). Also UNIQUE(dealId)
    // for the trigger-insert dedup is backed by by_deal.
    .index('by_company', ['companyId', 'closedAt'])
    .index('by_deal', ['dealId']),

  // Was: "CreatorProfile" (TEXT id, emailLower, name, clerkUserId nullable, bio
  // nullable, niche nullable, audienceSize int default 0, channels jsonb default
  // [], websiteUrl nullable, avatarUrl nullable, listed bool default false,
  // createdAt, updatedAt). One per creator, keyed by emailLower (UNIQUE).
  CreatorProfile: defineTable({
    id: v.string(),
    emailLower: v.string(),
    name: v.string(),
    clerkUserId: v.optional(v.string()),
    bio: v.optional(v.string()),
    niche: v.optional(v.string()),
    audienceSize: v.number(), // integer count
    channels: v.array(v.string()), // jsonb array of channel slugs
    websiteUrl: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    listed: v.boolean(),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // UNIQUE(emailLower) — one profile per creator. getCreatorProfileByEmail +
    // upsertCreatorProfile read this then insert-or-patch the single row.
    .index('by_email_lower', ['emailLower'])
    // listCreatorsForSeller lists listed creators by audienceSize DESC
    // (idx_creator_profile_listed = audienceSize DESC where listed).
    .index('by_listed_audience', ['listed', 'audienceSize']),

  // Was: "AffiliateAccount" (TEXT id, userId, spaceId, fpPromoterId, refLink,
  // refToken, createdAt, updatedAt). Legacy FirstPromoter linkage. ZERO call
  // sites in lib/app/components — included for schema completeness only (so
  // Supabase can be fully removed); no functions are generated for it.
  AffiliateAccount: defineTable({
    id: v.string(),
    userId: v.string(),
    spaceId: v.string(),
    fpPromoterId: v.string(),
    refLink: v.string(),
    refToken: v.string(),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // AffiliateAccount_userId_idx — the only PG index on this dead table.
    .index('by_user', ['userId']),
};
