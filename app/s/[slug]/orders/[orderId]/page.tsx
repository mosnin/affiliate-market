import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { ChevronRight, Tag, User, Package, Calendar, CreditCard, Hash } from 'lucide-react';
import { getSpaceFromSlug, getSpaceForUser } from '@/lib/space';
import { getOrderById, getLicenseForOrder } from '@/lib/marketplace/orders';
import { H1, TITLE_FONT, BODY_MUTED } from '@/lib/typography';
import { cn } from '@/lib/utils';

const STATUS_CONFIG: Record<string, { label: string; color: string; description: string }> = {
  pending:  { label: 'Pending',  color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300', description: 'Payment is being processed.' },
  paid:     { label: 'Paid',     color: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300', description: 'Payment confirmed.' },
  refunded: { label: 'Refunded', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300', description: 'Amount has been refunded to the buyer.' },
  canceled: { label: 'Canceled', color: 'bg-muted text-muted-foreground', description: 'Order was canceled.' },
};

function formatAmount(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ slug: string; orderId: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const { slug, orderId } = await params;
  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  const userSpace = await getSpaceForUser(userId);
  if (!userSpace || userSpace.id !== space.id) redirect('/');

  let order: Awaited<ReturnType<typeof getOrderById>> = null;
  let license: Awaited<ReturnType<typeof getLicenseForOrder>> = null;

  try {
    order = await getOrderById(orderId);
    if (!order) notFound();
    license = await getLicenseForOrder(orderId);
  } catch (err) {
    console.error('[orders/[orderId]] fetch failed', { orderId, error: err });
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center space-y-4 p-8">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className={cn(BODY_MUTED)}>We couldn&apos;t load this order. This is usually temporary.</p>
          <a
            href={`/s/${slug}/orders`}
            className="inline-block px-4 py-2 text-sm font-medium rounded-md bg-foreground text-background hover:bg-foreground/90"
          >
            Back to orders
          </a>
        </div>
      </div>
    );
  }

  if (!order) notFound();

  const statusConf = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.pending;

  // Status timeline events
  const timeline = [
    { label: 'Order created', date: order.createdAt, active: true },
    { label: 'Payment received', date: order.paidAt ?? null, active: order.status === 'paid' || order.status === 'refunded' },
    { label: 'License issued', date: license ? order.paidAt : null, active: !!license },
    { label: 'Refunded', date: null, active: order.status === 'refunded' },
  ].filter((e) => e.active || e.label === 'Payment received');

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href={`/s/${slug}/orders`} className="hover:text-foreground transition-colors">
          Orders
        </Link>
        <ChevronRight size={11} aria-hidden className="text-muted-foreground/60" />
        <span className="text-foreground font-mono">{orderId.slice(0, 8)}</span>
      </nav>

      {/* Header */}
      <header className="space-y-1.5">
        <p className={cn(BODY_MUTED)}>Order.</p>
        <div className="flex items-center gap-3">
          <h1 className={cn(H1)} style={TITLE_FONT}>
            {order.productName}
          </h1>
          <span className={cn('text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap', statusConf.color)}>
            {statusConf.label}
          </span>
        </div>
        <p className={cn(BODY_MUTED)}>{statusConf.description}</p>
      </header>

      {/* Details grid */}
      <div className="rounded-xl border border-border/70 bg-card overflow-hidden">
        <div className="divide-y divide-border/60">
          <DetailRow icon={User} label="Buyer" value={order.buyerEmail} />
          <DetailRow icon={Package} label="Product" value={order.productName} />
          <DetailRow
            icon={CreditCard}
            label="Amount"
            value={formatAmount(order.amountCents, order.currency)}
          />
          <DetailRow
            icon={Calendar}
            label="Order date"
            value={formatDate(order.createdAt)}
          />
          {order.paidAt && (
            <DetailRow
              icon={Calendar}
              label="Paid at"
              value={formatDate(order.paidAt)}
            />
          )}
          {order.referralCode && (
            <DetailRow
              icon={Tag}
              label="Referral code"
              value={
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-xs">
                  {order.referralCode}
                </span>
              }
            />
          )}
          {order.sellerName && (
            <DetailRow icon={User} label="Seller" value={order.sellerName} />
          )}
          <DetailRow
            icon={Hash}
            label="Order ID"
            value={<span className="font-mono text-xs text-muted-foreground">{order.id}</span>}
          />
        </div>
      </div>

      {/* Status timeline */}
      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Status timeline
        </p>
        <ol className="space-y-3">
          {timeline.map((event, i) => (
            <li key={i} className="flex items-start gap-3">
              <div className={cn(
                'mt-0.5 w-2 h-2 rounded-full flex-shrink-0',
                event.active ? 'bg-foreground' : 'bg-border',
              )} />
              <div>
                <p className={cn('text-sm', event.active ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                  {event.label}
                </p>
                {event.date && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDate(event.date)}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* License info */}
      {license && (
        <section className="rounded-xl border border-border/70 bg-card px-5 py-4 space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            License agreement
          </p>
          <p className="text-sm text-foreground">
            License issued for this order.
          </p>
          {license.licenseKey && (
            <p className="font-mono text-xs bg-muted px-2 py-1 rounded text-muted-foreground">
              {license.licenseKey}
            </p>
          )}
        </section>
      )}

      {/* Referral attribution */}
      {order.referralCode && (
        <section className="rounded-xl border border-border/70 bg-muted/20 px-5 py-4 space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Referral attribution
          </p>
          <p className="text-sm text-foreground">
            This order was referred via code{' '}
            <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-xs">
              {order.referralCode}
            </span>
            .
          </p>
          <Link
            href={`/s/${slug}/affiliates`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            View affiliate program
            <ChevronRight size={11} />
          </Link>
        </section>
      )}
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-5 py-3">
      <Icon size={14} className="text-muted-foreground flex-shrink-0" />
      <span className="text-xs text-muted-foreground w-28 flex-shrink-0">{label}</span>
      <span className="text-sm text-foreground flex-1 min-w-0">{value}</span>
    </div>
  );
}
