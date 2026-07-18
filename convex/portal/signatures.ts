import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * SignatureRequest data access — the Convex replacement for the
 * `.from('SignatureRequest')` ops in lib/esign.ts (insert after sending an
 * envelope; read + status updates on refresh), app/api/esign/[id]/route.ts (the
 * status route's scoped reads), and app/s/[slug]/deals/[id]/page.tsx (a deal's
 * signature list).
 *
 * All Composio/DocuSign orchestration, document fetch/upload, and the cross-
 * domain DealDocument write stay in lib/esign.ts — only the SignatureRequest
 * table hops move here. status is the 'created'|'sent'|'delivered'|'completed'|
 * 'declined'|'voided' CHECK enum.
 */

const statusValidator = v.union(
  v.literal('created'),
  v.literal('sent'),
  v.literal('delivered'),
  v.literal('completed'),
  v.literal('declined'),
  v.literal('voided'),
);

type SignatureFields = {
  id: string;
  spaceId: string;
  dealId?: string;
  documentId?: string;
  envelopeId?: string;
  subject: string;
  signerEmail: string;
  signerName?: string;
  status: 'created' | 'sent' | 'delivered' | 'completed' | 'declined' | 'voided';
  signedDocumentUrl?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  contactId?: string;
};

/** The full SignatureRequestRow shape (lib REQUEST_COLUMNS). Surfaces id, coerces
 *  absent optionals to SQL NULL. */
function toRow(s: SignatureFields) {
  return {
    id: s.id,
    spaceId: s.spaceId,
    dealId: s.dealId ?? null,
    contactId: s.contactId ?? null,
    documentId: s.documentId ?? null,
    envelopeId: s.envelopeId ?? null,
    subject: s.subject,
    signerEmail: s.signerEmail,
    signerName: s.signerName ?? null,
    status: s.status,
    signedDocumentUrl: s.signedDocumentUrl ?? null,
    completedAt: s.completedAt ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One request by id (full row), or null — the refresh-status read in
 *  lib/esign.ts (`.eq('id').maybeSingle()` selecting REQUEST_COLUMNS). */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('SignatureRequest')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return s ? toRow(s) : null;
  },
});

/** One request scoped to (id, spaceId) — the esign status route. Returns the
 *  full row or null (the spaceId guard denies cross-space access). Covers both
 *  the `.select('id, spaceId')` ownership probe and the full-row read; the route
 *  can read what it needs off the returned row. */
export const getByIdForSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('SignatureRequest')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!s || s.spaceId !== args.spaceId) return null;
    return toRow(s);
  },
});

/**
 * A deal's signature requests scoped to (dealId, spaceId), newest-first — the
 * deal page list. Mirrors `.select('id, documentId, status, signerEmail,
 * signerName, subject, createdAt').eq('dealId').eq('spaceId').order('createdAt', desc)`.
 * SignatureRequest_dealId_idx = (dealId); the spaceId filter is applied in memory.
 * Returns the lite columns the page (SignatureRequestLite[]) reads.
 */
export const listForDeal = query({
  args: { dealId: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('SignatureRequest')
      .withIndex('by_deal_created', (q) => q.eq('dealId', args.dealId))
      .order('desc')
      .collect();
    return rows
      .filter((s) => s.spaceId === args.spaceId)
      .map((s) => ({
        id: s.id,
        documentId: s.documentId ?? null,
        status: s.status,
        signerEmail: s.signerEmail,
        signerName: s.signerName ?? null,
        subject: s.subject,
        createdAt: s.createdAt,
      }));
  },
});

/**
 * A contact's signature requests scoped to (contactId, spaceId), newest-first —
 * the seller contact page list (app/s/[slug]/contacts/[id]/page.tsx). Mirrors
 * `.select('id, documentId, status, signerEmail, signerName, subject, createdAt')
 * .eq('contactId').eq('spaceId').order('createdAt', desc)`.
 * SignatureRequest_contactId_createdAt_idx = (contactId, createdAt DESC); the
 * spaceId filter is applied in memory. Same lite columns as listForDeal.
 */
export const listForContact = query({
  args: { contactId: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('SignatureRequest')
      .withIndex('by_contact_created', (q) => q.eq('contactId', args.contactId))
      .order('desc')
      .collect();
    return rows
      .filter((s) => s.spaceId === args.spaceId)
      .map((s) => ({
        id: s.id,
        documentId: s.documentId ?? null,
        status: s.status,
        signerEmail: s.signerEmail,
        signerName: s.signerName ?? null,
        subject: s.subject,
        createdAt: s.createdAt,
      }));
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Insert a SignatureRequest after a successful CREATE_ENVELOPE (sendForSignature).
 * Replaces the `.insert({...}).select(REQUEST_COLUMNS).single()`. The lib computed
 * the normalized signerEmail/subject/dealId fallback and passes them in. Nullable
 * fields (dealId, contactId, envelopeId, signerName) arrive as null = unset.
 * status is whatever the lib sets ('sent' on the send path). Returns the full row.
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    dealId: v.union(v.string(), v.null()),
    contactId: v.union(v.string(), v.null()),
    documentId: v.union(v.string(), v.null()),
    envelopeId: v.union(v.string(), v.null()),
    subject: v.string(),
    signerEmail: v.string(),
    signerName: v.union(v.string(), v.null()),
    status: statusValidator,
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      ...(args.dealId !== null ? { dealId: args.dealId } : {}),
      ...(args.contactId !== null ? { contactId: args.contactId } : {}),
      ...(args.documentId !== null ? { documentId: args.documentId } : {}),
      ...(args.envelopeId !== null ? { envelopeId: args.envelopeId } : {}),
      subject: args.subject,
      signerEmail: args.signerEmail,
      ...(args.signerName !== null ? { signerName: args.signerName } : {}),
      status: args.status,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('SignatureRequest', doc);
    return toRow(doc);
  },
});

/** Bump only updatedAt on a request by id — the refresh "no status change" path
 *  (`.update({ updatedAt }).eq('id')`). No-op if the row vanished. */
export const touch = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const s = await ctx.db
      .query('SignatureRequest')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!s) return;
    await ctx.db.patch(s._id, { updatedAt: new Date().toISOString() });
  },
});

/**
 * Apply a refreshed envelope status to a request by id — the refresh "status
 * changed" write (`.update({ status, signedDocumentUrl, completedAt, updatedAt })
 * .eq('id').select(REQUEST_COLUMNS).single()`). signedDocumentUrl/completedAt are
 * tri-state (null clears). Always bumps updatedAt. Returns the full row, or null
 * if the row vanished mid-refresh (the lib falls back to its in-memory copy).
 */
export const applyStatus = mutation({
  args: {
    id: v.string(),
    status: statusValidator,
    signedDocumentUrl: v.union(v.string(), v.null()),
    completedAt: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('SignatureRequest')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!s) return null;
    await ctx.db.patch(s._id, {
      status: args.status,
      signedDocumentUrl: args.signedDocumentUrl === null ? undefined : args.signedDocumentUrl,
      completedAt: args.completedAt === null ? undefined : args.completedAt,
      updatedAt: new Date().toISOString(),
    });
    return toRow((await ctx.db.get(s._id))!);
  },
});
