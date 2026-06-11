import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ShoppingBag, Key, ChevronRight, Store } from 'lucide-react';
import { getClientUser } from '@/lib/client-auth';
import { getOrdersForBuyerEmail, getLicensesForBuyerEmail } from '@/lib/marketplace/orders';
import { centsToDisplay } from '@/components/marketplace/price-format';
import { CopyButton } from '@/components/marketplace/copy-button';
import { TITLE_FONT } from '@/lib/typography';
import { LogoutButton } from '../auth-ui';

export const dynamic = 'force-dynamic';

const ORDER_STATUS_TONE: Record<string, string> = {
  pending: 'text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-500/15',
  paid: 'text-emerald-700 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-500/15',
  refunded: 'text-muted-foreground bg-muted',
  canceled: 'text-muted-foreground bg-muted',
};

const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  paid: 'Paid',
  refunded: 'Refunded',
  canceled: 'Canceled',
};

const LICENSE_STATUS_TONE: Record<string, string> = {
  active: 'text-emerald-700 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-500/15',
  revoked: 'text-rose-700 bg-rose-50 dark:text-rose-400 dark:bg-rose-500/15',
  expired: 'text-muted-foreground bg-muted',
};

function StatusPill({ status, toneMap, labelMap }: {
  status: string;
  toneMap: Record<string, string>;
  labelMap: Record<string, string>;
}) {
  const tone = toneMap[status] ?? 'text-muted-foreground bg-muted';
  const label = labelMap[status] ?? status;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function BuyerDashboardPage() {
  const user = await getClientUser();
  if (!user) redirect('/buyer/login');
  if (!user.emailVerifiedAt) redirect('/buyer/verify');

  const [orders, licenses] = await Promise.all([
    getOrdersForBuyerEmail(user.email),
    getLicensesForBuyerEmail(user.email),
  ]);

  const firstName = (user.name ?? '').trim().split(/\s+/)[0] || null;
  const hasActivity = orders.length > 0 || licenses.length > 0;

  return (
    <main className="mx-auto max-w-3xl space-y-12 px-4 py-10 pb-16 sm:px-6">
      {/* Header */}
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <p className="text-sm text-muted-foreground">Buyer portal.</p>
          <h1 className="text-3xl tracking-tight text-foreground" style={TITLE_FONT}>
            {firstName ? `Welcome back, ${firstName}.` : 'Welcome back.'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {hasActivity
              ? `${orders.length} purchase${orders.length === 1 ? '' : 's'} · ${licenses.length} license${licenses.length === 1 ? '' : 's'}.`
              : "No purchases yet — they'll show up here the moment you buy."}
          </p>
        </div>
        <LogoutButton />
      </header>

      {/* Empty state */}
      {!hasActivity && (
        <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-5 py-10 text-center">
          <p className="text-sm text-foreground">Nothing here yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Browse the marketplace and your purchases will appear here instantly.
          </p>
          <Link
            href="/marketplace"
            className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-2 text-xs font-medium text-background transition-all hover:bg-foreground/90"
          >
            <Store size={13} aria-hidden="true" />
            Browse marketplace
          </Link>
        </div>
      )}

      {/* Purchases */}
      {orders.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Purchases
          </h2>
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card">
            {orders.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/buyer/purchases/${order.id}`}
                  className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-foreground/[0.04]"
                >
                  <ShoppingBag size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {order.productName}
                    </p>
                    <p className="text-[11px] tabular-nums text-muted-foreground">
                      {order.sellerName} · {formatDate(order.createdAt)} ·{' '}
                      {centsToDisplay(order.amountCents, order.currency)}
                    </p>
                  </div>
                  <StatusPill
                    status={order.status}
                    toneMap={ORDER_STATUS_TONE}
                    labelMap={ORDER_STATUS_LABEL}
                  />
                  <ChevronRight size={15} className="shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Licenses */}
      {licenses.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Licenses
          </h2>
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card">
            {licenses.map((lic) => (
              <li key={lic.id} className="px-4 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <Key size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {lic.productName}
                      </p>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <code className="max-w-[180px] truncate text-[11px] font-mono text-muted-foreground sm:max-w-none">
                          {lic.licenseKey}
                        </code>
                        <CopyButton text={lic.licenseKey} />
                      </div>
                      {lic.expiresAt && (
                        <p className="text-[11px] tabular-nums text-muted-foreground">
                          Expires {formatDate(lic.expiresAt)}
                        </p>
                      )}
                    </div>
                  </div>
                  <StatusPill
                    status={lic.status}
                    toneMap={LICENSE_STATUS_TONE}
                    labelMap={{ active: 'Active', revoked: 'Revoked', expired: 'Expired' }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Browse CTA at the bottom for active users */}
      {hasActivity && (
        <div>
          <Link
            href="/marketplace"
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <Store size={14} aria-hidden="true" />
            Browse marketplace
          </Link>
        </div>
      )}
    </main>
  );
}
