import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { ShoppingCart, ChevronRight } from 'lucide-react';
import { getSpaceFromSlug, getSpaceForUser } from '@/lib/space';
import { getOrdersForSpace } from '@/lib/marketplace/orders';
import { H1, TITLE_FONT, BODY_MUTED, PAGE_MAX } from '@/lib/typography';
import { cn } from '@/lib/utils';

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  pending:   { label: 'Pending',   color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' },
  paid:      { label: 'Paid',      color: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' },
  refunded:  { label: 'Refunded',  color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  canceled:  { label: 'Canceled',  color: 'bg-muted text-muted-foreground' },
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
        <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-5 py-12 text-center">
          <ShoppingCart size={28} className="mx-auto mb-3 text-muted-foreground/60" aria-hidden />
          <p className="text-sm text-foreground">No orders yet.</p>
          <p className={cn('text-xs mt-1', BODY_MUTED)}>
            Orders from your marketplace products and affiliate referrals will appear here.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Date
                  </th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Product
                  </th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hidden sm:table-cell">
                    Buyer
                  </th>
                  <th className="text-right px-4 py-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Amount
                  </th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Status
                  </th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hidden md:table-cell">
                    Referral
                  </th>
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
                        <span className={cn('text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap', statusConf.color)}>
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
