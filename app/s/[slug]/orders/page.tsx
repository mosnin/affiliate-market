import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { ShoppingCart, ChevronRight } from 'lucide-react';
import { getSpaceFromSlug, getSpaceForUser } from '@/lib/space';
import { getOrdersForSpace } from '@/lib/marketplace/orders';
import { H1, TITLE_FONT, BODY_MUTED, PAGE_MAX, CARD, SECTION_LABEL } from '@/lib/typography';
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

  const totalRevenue = orders
    .filter((o) => o.status === 'paid')
    .reduce((sum, o) => sum + o.amountCents, 0);

  return (
    <div className={cn('space-y-6 mx-auto pb-12', PAGE_MAX)}>
      <header className="space-y-1.5">
        <p className={cn(BODY_MUTED)}>Orders.</p>
        <h1 className={cn(H1)} style={TITLE_FONT}>
          All orders
        </h1>
        <p className={cn(BODY_MUTED)}>
          {orders.length === 0
            ? 'No orders yet.'
            : `${orders.length} ${orders.length === 1 ? 'order' : 'orders'}${
                totalRevenue > 0
                  ? ` · ${formatAmount(totalRevenue, orders.find(o => o.status === 'paid')?.currency ?? 'usd')} paid`
                  : ''
              }`}
        </p>
      </header>

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
                  <th className="w-8 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {orders.map((order) => {
                  const statusConf = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.pending;
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
