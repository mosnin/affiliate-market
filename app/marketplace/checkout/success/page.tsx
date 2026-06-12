import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle } from 'lucide-react';
import { getOrderById, getLicenseForOrder } from '@/lib/marketplace/orders';
import { centsToDisplay } from '@/components/marketplace/price-format';
import { TITLE_FONT } from '@/lib/typography';
import { CopyButton } from '@/components/marketplace/copy-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Purchase confirmed — Cola Marketplace',
  description: 'Your order is confirmed and your license is ready.',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  paid: 'Paid',
  refunded: 'Refunded',
  canceled: 'Canceled',
};

export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ orderId?: string }>;
}) {
  const { orderId } = await searchParams;
  if (!orderId) notFound();

  const [order, license] = await Promise.all([
    getOrderById(orderId),
    getLicenseForOrder(orderId),
  ]);

  if (!order) notFound();

  const amount = centsToDisplay(order.amountCents, order.currency);
  const statusLabel = STATUS_LABEL[order.status] ?? order.status;
  const orderDate = new Date(order.createdAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <main className="mx-auto max-w-lg px-4 py-16 pb-20 sm:px-6">
      {/* Confirmation header */}
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <CheckCircle size={40} className="text-positive" aria-hidden="true" />
        <h1 className="text-3xl tracking-tight text-foreground" style={TITLE_FONT}>
          Purchase confirmed.
        </h1>
        <p className="text-sm text-muted-foreground">
          Your license has been delivered to{' '}
          <span className="font-medium text-foreground">{order.buyerEmail}</span>.
        </p>
      </div>

      {/* Order summary card */}
      <div className="space-y-4 rounded-xl border border-border/70 bg-card p-5">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Order summary
        </h2>

        <div className="divide-y divide-border/60">
          <Row label="Product" value={order.productName} />
          <Row label="Seller" value={order.sellerName} />
          <Row label="Date" value={orderDate} />
          <Row label="Amount" value={amount} />
          <Row label="Status">
            <span
              className={[
                'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                order.status === 'paid'
                  ? 'bg-positive-subtle text-positive dark:bg-positive-subtle0/15 dark:text-positive'
                  : 'bg-muted text-muted-foreground',
              ].join(' ')}
            >
              {statusLabel}
            </span>
          </Row>
          {order.referralCode && (
            <Row label="Referral code" value={order.referralCode} />
          )}
        </div>
      </div>

      {/* License key */}
      {license && (
        <div className="mt-4 space-y-2 rounded-xl border border-border/70 bg-card p-5">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            License key
          </h2>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <code className="flex-1 overflow-x-auto text-sm font-mono text-foreground">
              {license.licenseKey}
            </code>
            <CopyButton text={license.licenseKey} />
          </div>
          <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span>
              Status:{' '}
              <span
                className={
                  license.status === 'active' ? 'text-positive dark:text-positive' : ''
                }
              >
                {license.status}
              </span>
            </span>
            {license.expiresAt && (
              <span>
                Expires:{' '}
                {new Date(license.expiresAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
            )}
          </div>
        </div>
      )}

      {/* CTA */}
      <div className="mt-8 flex flex-col items-center gap-3">
        <Link
          href="/buyer"
          className="inline-flex h-10 items-center rounded-full bg-foreground px-6 text-sm font-medium text-background transition-all duration-150 hover:bg-foreground/90 active:scale-[0.98]"
        >
          View all my purchases
        </Link>
        <Link
          href="/marketplace"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Continue browsing
        </Link>
      </div>
    </main>
  );
}

function Row({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children ?? <span className="text-sm font-medium text-foreground">{value}</span>}
    </div>
  );
}
