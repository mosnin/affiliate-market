import type Stripe from 'stripe';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { encrypt, decrypt } from '@/lib/crypto';
import { recordPaymentCommission } from '@/lib/affiliates/recurring';
import { reverseCommissionsForInvoice } from '@/lib/affiliates/reversals';

/**
 * The seller Stripe bridge — how a software company's OWN billing reaches
 * Cola. The seller points a webhook from their Stripe dashboard at
 * /api/webhooks/stripe-bridge/[bridgeId] and pastes the signing secret
 * back into Cola. From then on every verified payment in THEIR app
 * (first charge and every renewal) earns the referring creator a
 * commission, subject to the program's recurring window.
 *
 * Attribution, in order: `cola_ref` in the event's metadata (sellers pass
 * the visitor's cola_ref cookie value into their Checkout metadata), then
 * billing-email match against the space's existing referrals.
 */

export interface StripeBridgeRow {
  id: string;
  spaceId: string;
  webhookSecretEnc: string | null;
  lastEventAt: string | null;
  createdAt: string;
}

export interface BridgeStatus {
  id: string;
  url: string;
  hasSecret: boolean;
  lastEventAt: string | null;
}

export async function getBridgeForSpace(spaceId: string): Promise<StripeBridgeRow | null> {
  const { data } = await supabase
    .from('StripeBridge')
    .select('*')
    .eq('spaceId', spaceId)
    .maybeSingle();
  return (data as StripeBridgeRow) ?? null;
}

export async function getBridgeById(bridgeId: string): Promise<StripeBridgeRow | null> {
  const { data } = await supabase
    .from('StripeBridge')
    .select('*')
    .eq('id', bridgeId)
    .maybeSingle();
  return (data as StripeBridgeRow) ?? null;
}

export async function getOrCreateBridge(spaceId: string): Promise<StripeBridgeRow | null> {
  const existing = await getBridgeForSpace(spaceId);
  if (existing) return existing;
  const { data, error } = await supabase
    .from('StripeBridge')
    .insert({ spaceId })
    .select('*')
    .single();
  if (error) {
    const retry = await getBridgeForSpace(spaceId);
    if (retry) return retry;
    logger.warn('[affiliates] bridge create failed', { spaceId, error: error.message });
    return null;
  }
  return data as StripeBridgeRow;
}

export async function setBridgeSecret(bridgeId: string, secret: string): Promise<boolean> {
  let enc: string;
  try {
    enc = encrypt(secret.trim());
  } catch (err) {
    logger.warn('[affiliates] bridge secret encryption failed (ENCRYPTION_KEY missing?)', {
      err: String(err),
    });
    return false;
  }
  const { error } = await supabase
    .from('StripeBridge')
    .update({ webhookSecretEnc: enc })
    .eq('id', bridgeId);
  return !error;
}

export function bridgeWebhookUrl(bridgeId: string, base: string): string {
  return `${(base || '').replace(/\/$/, '')}/api/webhooks/stripe-bridge/${bridgeId}`;
}

export function decryptBridgeSecret(bridge: StripeBridgeRow): string | null {
  if (!bridge.webhookSecretEnc) return null;
  try {
    return decrypt(bridge.webhookSecretEnc);
  } catch {
    return null;
  }
}

// ── Event payload extraction ─────────────────────────────────────────────────
// The Stripe SDK's types track one API version, but bridge events arrive at
// whatever version the SELLER's account pins — so subscription/metadata can
// live at either the legacy top-level fields or under invoice.parent.
// Read both shapes defensively; never trust one.

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

function extractInvoiceMetadataCode(invoice: Stripe.Invoice): string | null {
  const inv = asRecord(invoice);
  const lines = asRecord(inv.lines).data;
  const firstLine = Array.isArray(lines) ? asRecord(lines[0]) : {};
  const candidates: unknown[] = [
    asRecord(inv.metadata).cola_ref,
    asRecord(asRecord(asRecord(inv.parent).subscription_details).metadata).cola_ref,
    asRecord(asRecord(inv.subscription_details).metadata).cola_ref,
    asRecord(firstLine.metadata).cola_ref,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function extractSessionMetadataCode(session: Stripe.Checkout.Session): string | null {
  const code = session.metadata?.cola_ref ?? session.metadata?.via;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

/**
 * Process one signature-verified event from a seller's Stripe account.
 * Returns true when the event produced (or idempotently matched) work.
 */
export async function processBridgeEvent(
  bridge: StripeBridgeRow,
  event: Stripe.Event,
): Promise<boolean> {
  void supabase
    .from('StripeBridge')
    .update({ lastEventAt: new Date().toISOString() })
    .eq('id', bridge.id)
    .then(() => undefined);

  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object as Stripe.Invoice;
    const amount = invoice.amount_paid ?? 0;
    if (amount <= 0) return false;

    const result = await recordPaymentCommission({
      spaceId: bridge.spaceId,
      stripeInvoiceId: invoice.id ?? `evt_${event.id}`,
      amountCents: amount,
      currency: invoice.currency ?? 'usd',
      buyerEmail: invoice.customer_email ?? null,
      referralCode: extractInvoiceMetadataCode(invoice),
      source: 'stripe_bridge',
    });
    return result != null;
  }

  // Money that came back in the seller's app claws its commission back.
  if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
    const charge = asRecord(event.data.object);
    const reason =
      event.type === 'charge.refunded'
        ? 'Charge refunded in seller app'
        : 'Charge disputed in seller app';
    const invoiceId =
      typeof charge.invoice === 'string'
        ? charge.invoice
        : ((asRecord(charge.invoice).id as string | undefined) ?? null);
    if (invoiceId) {
      const result = await reverseCommissionsForInvoice(invoiceId, reason);
      return result.reversed > 0;
    }
    return false;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    // Subscription checkouts emit invoice.paid for the same money — let the
    // invoice path own those so the idempotency key is consistent.
    if (session.mode !== 'payment') return false;
    if (session.payment_status !== 'paid') return false;
    const amount = session.amount_total ?? 0;
    if (amount <= 0) return false;

    const result = await recordPaymentCommission({
      spaceId: bridge.spaceId,
      stripeInvoiceId: session.id,
      amountCents: amount,
      currency: session.currency ?? 'usd',
      buyerEmail:
        session.customer_details?.email ??
        ((asRecord(session).customer_email as string | undefined) || null),
      referralCode: extractSessionMetadataCode(session),
      source: 'stripe_bridge',
    });
    return result != null;
  }

  return false;
}
