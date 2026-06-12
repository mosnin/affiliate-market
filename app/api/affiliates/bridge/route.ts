import { NextRequest, NextResponse } from 'next/server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import {
  getBridgeForSpace,
  getOrCreateBridge,
  setBridgeSecret,
  bridgeWebhookUrl,
} from '@/lib/affiliates/stripe-bridge';

function baseUrl(req: NextRequest): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
}

/** Bridge status for the seller's program page. */
export async function GET(req: NextRequest) {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const bridge = await getBridgeForSpace(result.space.id);
  if (!bridge) return NextResponse.json({ bridge: null });
  return NextResponse.json({
    bridge: {
      id: bridge.id,
      url: bridgeWebhookUrl(bridge.id, baseUrl(req)),
      hasSecret: Boolean(bridge.webhookSecretEnc),
      lastEventAt: bridge.lastEventAt,
    },
  });
}

/** Create the bridge endpoint (idempotent). */
export async function POST(req: NextRequest) {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const bridge = await getOrCreateBridge(result.space.id);
  if (!bridge) return NextResponse.json({ error: 'Could not create endpoint' }, { status: 500 });
  return NextResponse.json({
    bridge: {
      id: bridge.id,
      url: bridgeWebhookUrl(bridge.id, baseUrl(req)),
      hasSecret: Boolean(bridge.webhookSecretEnc),
      lastEventAt: bridge.lastEventAt,
    },
  });
}

/** Save the Stripe signing secret the seller pasted back. */
export async function PATCH(req: NextRequest) {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const secret = typeof body.webhookSecret === 'string' ? body.webhookSecret.trim() : '';
  if (!secret.startsWith('whsec_') || secret.length < 20) {
    return NextResponse.json(
      { error: 'That does not look like a Stripe signing secret (whsec_…).' },
      { status: 400 },
    );
  }

  const bridge = await getOrCreateBridge(result.space.id);
  if (!bridge) return NextResponse.json({ error: 'Could not create endpoint' }, { status: 500 });

  const ok = await setBridgeSecret(bridge.id, secret);
  if (!ok) {
    return NextResponse.json(
      { error: 'Could not store the secret. Is ENCRYPTION_KEY configured?' },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
