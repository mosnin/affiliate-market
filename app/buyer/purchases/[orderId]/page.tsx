import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getClientUser } from '@/lib/client-auth';
import { getOrderById, getLicenseForOrder } from '@/lib/marketplace/orders';
import { getRefundRequestForOrder } from '@/lib/marketplace/refunds';
import { centsToDisplay } from '@/components/marketplace/price-format';
import { CopyButton } from '@/components/marketplace/copy-button';
import { RefundRequestForm } from '@/components/buyer/refund-request-form';
import { TITLE_FONT } from '@/lib/typography';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  paid: 'Paid',
  refunded: 'Refunded',
  canceled: 'Canceled',
};

const STATUS_TONE: Record<string, string> = {
  pending: 'text-muted-foreground bg-muted dark:text-muted-foreground dark:bg-muted0/15',
  paid: 'text-positive bg-positive-subtle dark:text-positive dark:bg-positive-subtle0/15',
  refunded: 'text-muted-foreground bg-muted',
  canceled: 'text-muted-foreground bg-muted',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
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

export default async function OrderReceiptPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const user = await getClientUser();
  if (!user) redirect('/buyer/login');
  if (!user.emailVerifiedAt) redirect('/buyer/verify');

  const { orderId } = await params;
  const [order, license, refundRequest] = await Promise.all([
    getOrderById(orderId),
    getLicenseForOrder(orderId),
    getRefundRequestForOrder(orderId),
  ]);

  if (!order) notFound();

  // Security check — only the buyer whose email is on the order can view it
  if (order.buyerEmail.toLowerCase() !== user.email.toLowerCase()) notFound();

  const amount = centsToDisplay(order.amountCents, order.currency);
  const statusLabel = STATUS_LABEL[order.status] ?? order.status;
  const statusTone = STATUS_TONE[order.status] ?? 'text-muted-foreground bg-muted';

  return (
    <main className="mx-auto max-w-lg px-4 py-10 pb-16 sm:px-6">
      <Link
        href="/buyer/dashboard"
        className="mb-8 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={13} aria-hidden="true" />
        Back to your portal
      </Link>

      <header className="mb-6 space-y-1.5">
        <p className="text-sm text-muted-foreground">Receipt.</p>
        <h1 className="text-3xl tracking-tight text-foreground" style={TITLE_FONT}>
          {order.productName}
        </h1>
      </header>

      {/* Order card */}
      <div className="space-y-1 rounded-xl border border-border/70 bg-card p-5">
        <h2 className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Order details
        </h2>
        <div className="divide-y divide-border/60">
          <Row label="Seller" value={order.sellerName} />
          <Row label="Date" value={formatDate(order.createdAt)} />
          {order.paidAt && <Row label="Paid" value={formatDate(order.paidAt)} />}
          <Row label="Amount" value={amount} />
          <Row label="Status">
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusTone}`}>
              {statusLabel}
            </span>
          </Row>
          <Row label="Email" value={order.buyerEmail} />
          {order.referralCode && <Row label="Referral code" value={order.referralCode} />}
        </div>
      </div>

      {/* License key */}
      {license && (
        <div className="mt-4 rounded-xl border border-border/70 bg-card p-5">
          <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            License key
          </h2>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <code className="flex-1 overflow-x-auto text-sm font-mono text-foreground">
              {license.licenseKey}
            </code>
            <CopyButton text={license.licenseKey} />
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
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
            {license.deliveredAt && (
              <span>Delivered: {formatDate(license.deliveredAt)}</span>
            )}
            {license.expiresAt && (
              <span>Expires: {formatDate(license.expiresAt)}</span>
            )}
          </div>
        </div>
      )}

      {/* Refund — offered on a paid order, or showing the status of a prior ask. */}
      {(order.status === 'paid' || refundRequest) && (
        <div className="mt-4 rounded-xl border border-border/70 bg-card p-5">
          <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Refund
          </h2>
          <RefundRequestForm orderId={order.id} existingStatus={refundRequest?.status ?? null} />
        </div>
      )}
    </main>
  );
}
