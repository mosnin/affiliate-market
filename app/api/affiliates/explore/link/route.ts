import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { convex, api } from '@/lib/convex-server';
import { getOrCreateDefaultProgram } from '@/lib/affiliates/programs';
import { createPartner, getPartnersByUser } from '@/lib/affiliates/partners';
import {
  createLink,
  getLinkForProduct,
  buildReferralLinkUrl,
} from '@/lib/affiliates/links';

/**
 * "Get my link" from the explore page. Resolves the product's seller
 * program, joins the creator to it if needed (auto-approve per program
 * settings), and returns their product referral link.
 *
 * Responses:
 *  - { url, code }                  — link ready to share
 *  - { pending: true }              — application created/awaiting approval
 *  - { error }                      — anything else
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Sign in to get your link.' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const productId = typeof body.productId === 'string' ? body.productId : '';
  if (!productId) return NextResponse.json({ error: 'Missing product' }, { status: 400 });

  const product = await convex().query(api.marketplace.products.getById, { id: productId });
  if (!product || !product.published || !product.marketplaceSlug) {
    return NextResponse.json({ error: 'Product not available.' }, { status: 404 });
  }

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress ?? null;
  if (!email) return NextResponse.json({ error: 'Your account has no email.' }, { status: 400 });
  const name =
    [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
    email.split('@')[0];

  // Already a partner of this seller?
  const partners = await getPartnersByUser({ clerkUserId: userId, email });
  let partner = partners.find((p) => p.spaceId === product.spaceId) ?? null;

  if (!partner) {
    // Materialise the program (sellers get the 20% default lazily) and join.
    await getOrCreateDefaultProgram(product.spaceId);
    const result = await createPartner({
      spaceId: product.spaceId,
      name,
      email,
      clerkUserId: userId,
    });
    if (!result) return NextResponse.json({ error: 'Could not join the program.' }, { status: 500 });
    partner = result.partner;
  }

  if (partner.status === 'suspended') {
    return NextResponse.json({ error: 'Your account with this seller is suspended.' }, { status: 403 });
  }
  if (partner.status === 'pending') {
    return NextResponse.json({ pending: true });
  }

  const destination = `/marketplace/p/${product.marketplaceSlug}`;
  let link = await getLinkForProduct(partner.id, product.id);
  if (!link) link = await createLink(partner.id, destination, product.id);
  if (!link) return NextResponse.json({ error: 'Could not create your link.' }, { status: 500 });

  const base = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
  return NextResponse.json({
    url: buildReferralLinkUrl(link, base),
    code: link.code,
  });
}
