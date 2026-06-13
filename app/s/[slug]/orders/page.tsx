import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { ShoppingCart, ChevronRight, ArrowUpRight } from 'lucide-react';
import { getSpaceFromSlug, getSpaceForUser } from '@/lib/space';
import { getSellerConnectAccountId } from '@/lib/marketplace/sellers';
import { ConnectPayoutsButton } from '@/components/marketplace/connect-payouts-button';
import { getOrdersForSpace } from '@/lib/marketplace/orders';
import { getRefundRequestsForSpace } from '@/lib/marketplace/refunds';
import { RefundRequestActions } from '@/components/seller/refund-request-actions';
import { H1, TITLE_FONT, BODY_MUTED, PAGE_MAX, CARD, SECTION_LABEL, HERO_PANEL, PRIMARY_PILL, HERO_GHOST_PILL, CHIP_NEUTRAL } from '@/lib/typography';
import { cn } from '@/lib/utils';

const STATUS_CONFIG: Record<string, { label: string; chip: string }> = {
  pending:   { label: 'Pending',   chip: 'inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-medium bg-muted text-muted-foreground' },
  paid:      { label: 'Paid',      chip: 'inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-medium bg-positive-subtle text-positive' },
  refunded:  { label: 'Refunded',  chip: 'inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-medium bg-negative-subtle text-negative' },
  canceled:  { label: 'Canceled',  chip: 'inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-medium bg-negative-subtle text-negative' },
};

function formatAmount(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export default async function OrdersPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const { slug } = await params;
  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  const userSpace = await getSpaceForUser(userId);
  if (!userSpace || userSpace.id !== space.id) redirect('/');

  let orders: Awaited<ReturnType<typeof getOrdersForSpace>> = [];
  let fetchError = false;
  try {
    orders = await getOrdersForSpace(space.id);
  } catch (err) {
    console.error('[orders/page] fetch failed', { spaceId: space.id, error: err });
    fetchError = true;
  }

  if (fetchError) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center space-y-4 p-8">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className={cn(BODY_MUTED)}>
            We couldn&apos;t load your orders. This is usually temporary.
          </p>
          <a
            href={`/s/${slug}/orders`}
            className="inline-block px-4 py-2 text-sm font-medium rounded-md bg-foreground text-background hover:bg-foreground/90"
          >
            Try again
          </a>
        </div>
      </div>
    );
  }

  // Open refund requests for this space → map orderId to the request id so each
  // order row can badge itself and offer Approve/Decline. One query, no N+1.
  const openRefundRequests = await getRefundRequestsForSpace(space.id);
  const openRefundByOrderId = new Map(openRefundRequests.map((r) => [r.orderId, r.id]));

  const totalRevenue = orders
    .filter((o) => o.status === 'paid')
    .reduce((sum, o) => sum + o.amountCents, 0);

  const paidCurrency = orders.find(o => o.status === 'paid')?.currency ?? 'usd';
  const payoutsConnected = Boolean(await getSellerConnectAccountId(space.id));

  return (
    <div className={cn('space-y-8 mx-auto pb-12', PAGE_MAX)}>
      {/* Hero panel — revenue is the focal number for this page */}
      <div className={cn(HERO_PANEL, 'flex flex-col sm:flex-row sm:items-center gap-6')}>
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-white/70 text-sm">Total revenue</p>
          <p className="text-[30px] leading-tight font-semibold text-white tabular-nums">
            {totalRevenue > 0 ? formatAmount(totalRevenue, paidCurrency) : '$0'}
          </p>
          {orders.length > 0 && (
            <p className="text-white/60 text-xs tabular-nums">
              {orders.length} {orders.length === 1 ? 'order' : 'orders'} · {orders.filter(o => o.status === 'paid').length} paid
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link href={`/s/${slug}/affiliates`} className={cn(PRIMARY_PILL)}>
            Affiliates
            <ArrowUpRight size={14} />
          </Link>
          <Link href={`/s/${slug}/products`} className={cn(HERO_GHOST_PILL)}>
            Products
          </Link>
        </div>
      </div>

      {/* Marketplace proceeds → seller's own Stripe */}
      {!payoutsConnected && (
        <div className={cn(CARD, 'px-5 py-4 flex flex-wrap items-center justify-between gap-4')}>
          <div className="space-y-0.5 min-w-0">
            <p className={cn(SECTION_LABEL)}>get paid for marketplace sales</p>
            <p className="text-sm text-foreground">
              Connect your Stripe and each sale&apos;s proceeds — minus creator commissions —
              transfer to you automatically the moment it&apos;s paid.
            </p>
          </div>
          <ConnectPayoutsButton />
        </div>
      )}

      {orders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-5 py-12 text-center">
          <ShoppingCart size={28} className="mx-auto mb-3 text-muted-foreground/60" aria-hidden />
          <p className="text-sm text-foreground">No orders yet.</p>
          <p className={cn('text-xs mt-1', BODY_MUTED)}>
            Orders from your marketplace products and affiliate referrals will appear here.
          </p>
        </div>
      ) : (
        <div className={cn(CARD, 'overflow-hidden')}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className={cn(SECTION_LABEL, 'text-left px-4 py-3')}>Date</th>
                  <th className={cn(SECTION_LABEL, 'text-left px-4 py-3')}>Product</th>
                  <th className={cn(SECTION_LABEL, 'text-left px-4 py-3 hidden sm:table-cell')}>Buyer</th>
                  <th className={cn(SECTION_LABEL, 'text-right px-4 py-3')}>Amount</th>
                  <th className={cn(SECTION_LABEL, 'text-left px-4 py-3')}>Status</th>
                  <th className={cn(SECTION_LABEL, 'text-left px-4 py-3 hidden md:table-cell')}>Referral</th>
                  <th className={cn(SECTION_LABEL, 'text-left px-4 py-3')}>Refund</th>
                  <th className="w-8 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {orders.map((order) => {
                  const statusConf = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.pending;
                  const refundRequestId = openRefundByOrderId.get(order.id) ?? null;
                  const date = new Date(order.createdAt).toLocaleDateString([], {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  });

                  return (
                    <tr
                      key={order.id}
                      className="hover:bg-muted/30 transition-colors group/row"
                    >
                      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        {date}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground truncate max-w-[160px]">
                          {order.productName}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground hidden sm:table-cell">
                        {order.buyerEmail}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium text-foreground whitespace-nowrap">
                        {formatAmount(order.amountCents, order.currency)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn(statusConf.chip, 'whitespace-nowrap')}>
                          {statusConf.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {order.referralCode ? (
                          <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                            {order.referralCode}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {refundRequestId ? (
                          <div className="flex flex-col gap-2">
                            <span className={cn(CHIP_NEUTRAL, 'w-fit whitespace-nowrap')}>
                              Refund requested
                            </span>
                            <RefundRequestActions requestId={refundRequestId} />
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/s/${slug}/orders/${order.id}`}
                          className="text-muted-foreground/0 group-hover/row:text-muted-foreground/60 transition-colors"
                          aria-label="View order"
                        >
                          <ChevronRight size={14} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
