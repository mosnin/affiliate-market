import { redirect } from 'next/navigation';
import { auth, currentUser } from '@clerk/nextjs/server';
import Link from 'next/link';
import { SignInButton } from '@clerk/nextjs';
import { MousePointerClick, Users, Clock, Banknote } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  H1,
  H2,
  BODY_MUTED,
  SECTION_LABEL,
  STAT_NUMBER_COMPACT,
  PRIMARY_PILL,
  PAGE_RHYTHM,
  SECTION_RHYTHM,
  META,
  CAPTION,
  HERO_PANEL,
  CARD,
  STAT_CARD,
  ICON_SQUARE,
  HERO_GHOST_PILL,
  CHIP_POSITIVE,
  CHIP_NEUTRAL,
  CHIP_NEGATIVE,
} from '@/lib/typography';
import { formatCurrency } from '@/lib/formatting';
import { getPartnersByUser } from '@/lib/affiliates/partners';
import { listLinksForPartners, buildReferralLinkUrl } from '@/lib/affiliates/links';
import { getAffiliateStatsForPartners } from '@/lib/affiliates/stats';
import { getLinkAnalyticsForPartners, formatConversionRate } from '@/lib/affiliates/link-analytics';
import { listCommissionsForPartner } from '@/lib/affiliates/commissions';
import { getPayableBalanceCentsForPartners } from '@/lib/affiliates/payouts';
import { PLATFORM_FEE_PERCENT } from '@/lib/affiliates/fees';
import { CopyLinkButton } from '@/components/affiliate/copy-link-button';
import { NewLinkButton } from '@/components/affiliate/new-link-button';
import { VanityCodeButton } from '@/components/affiliate/vanity-code-button';

export default async function AffiliateDashboardPage() {
  const { userId } = await auth();

  if (!userId) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-20 text-center space-y-4">
        <h1 className={cn(H1)}>
          Affiliate dashboard.
        </h1>
        <p className={cn(BODY_MUTED)}>Sign in to view your affiliate dashboard.</p>
        <SignInButton mode="modal">
          <button className={cn(PRIMARY_PILL, 'mt-2')}>Sign in</button>
        </SignInButton>
      </div>
    );
  }

  const clerkUser = await currentUser();
  const email = clerkUser?.emailAddresses?.[0]?.emailAddress ?? null;

  const allPartners = await getPartnersByUser({ clerkUserId: userId, email });
  const partner =
    allPartners.find((p) => p.status === 'approved') ?? allPartners[0] ?? null;

  if (!partner) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-20 text-center space-y-4">
        <h1 className={cn(H1)}>
          Start earning.
        </h1>
        <p className={cn(BODY_MUTED)}>
          Pick a product you actually like, grab your link, share it with your audience.
        </p>
        <Link href="/affiliate/explore" className={cn(PRIMARY_PILL, 'mt-2 inline-flex')}>
          Explore software to promote
        </Link>
      </div>
    );
  }

  if (partner.status === 'pending') {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-20 text-center space-y-4">
        <div className="w-12 h-12 rounded-xl bg-brand-subtle text-primary flex items-center justify-center mx-auto">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="text-primary">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </div>
        <h1 className={cn(H1)}>
          Application under review.
        </h1>
        <p className={cn(BODY_MUTED)}>
          Your application is being reviewed. We&apos;ll email you at{' '}
          <span className="text-foreground">{partner.email}</span> once approved.
          Most applications are reviewed within one business day.
        </p>
      </div>
    );
  }

  if (partner.status === 'suspended') {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-20 text-center space-y-4">
        <h1 className={cn(H1)}>
          Account suspended.
        </h1>
        <p className={cn(BODY_MUTED)}>
          Your affiliate account has been suspended. Contact support for more information.
        </p>
      </div>
    );
  }

  // approved — aggregate across every program this creator has joined
  const approvedIds = allPartners.filter((p) => p.status === 'approved').map((p) => p.id);
  const [stats, links, commissions, payableCents, analytics] = await Promise.all([
    getAffiliateStatsForPartners(approvedIds),
    listLinksForPartners(approvedIds),
    listCommissionsForPartner(partner.id, 10),
    getPayableBalanceCentsForPartners(approvedIds),
    getLinkAnalyticsForPartners(approvedIds),
  ]);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';

  return (
    <div className={cn('max-w-4xl mx-auto px-4 sm:px-6 py-10', PAGE_RHYTHM)}>
      {/* Hero panel */}
      <div className={cn(HERO_PANEL)}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-white/70 text-[11px] font-medium uppercase tracking-wider">Payable balance</p>
            <p className="text-[30px] font-semibold text-white tabular-nums">{formatCurrency(payableCents / 100)}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link href="/affiliate/explore" className={cn(PRIMARY_PILL)}>
              Explore software
            </Link>
            <Link href="/affiliate/payouts" className={cn(HERO_GHOST_PILL)}>
              View payouts
            </Link>
          </div>
        </div>
      </div>

      {/* Stat grid */}
      <section>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className={cn(STAT_CARD)}>
            <div className={cn(ICON_SQUARE)}>
              <MousePointerClick size={16} />
            </div>
            <p className={cn(SECTION_LABEL)}>Clicks</p>
            <p className={cn(STAT_NUMBER_COMPACT)}>{stats.clicks.toLocaleString()}</p>
          </div>
          <div className={cn(STAT_CARD)}>
            <div className={cn(ICON_SQUARE)}>
              <Users size={16} />
            </div>
            <p className={cn(SECTION_LABEL)}>Customers</p>
            <p className={cn(STAT_NUMBER_COMPACT)}>{stats.customers.toLocaleString()}</p>
          </div>
          <div className={cn(STAT_CARD)}>
            <div className={cn(ICON_SQUARE)}>
              <Clock size={16} />
            </div>
            <p className={cn(SECTION_LABEL)}>Pending</p>
            <p className={cn(STAT_NUMBER_COMPACT)}>{formatCurrency(stats.pendingCents / 100)}</p>
          </div>
          <div className={cn(STAT_CARD)}>
            <div className={cn(ICON_SQUARE)}>
              <Banknote size={16} />
            </div>
            <p className={cn(SECTION_LABEL)}>Paid</p>
            <p className={cn(STAT_NUMBER_COMPACT)}>{formatCurrency(stats.paidCents / 100)}</p>
          </div>
        </div>
      </section>

      {/* Links section */}
      <section className={cn(SECTION_RHYTHM)}>
        <div className="flex items-center justify-between gap-4">
          <h2 className={cn(H2)}>Referral links & codes</h2>
          <div className="flex items-center gap-2">
            <VanityCodeButton />
            <NewLinkButton />
          </div>
        </div>

        {links.length === 0 ? (
          <div className={cn(CARD, 'px-5 py-10 text-center')}>
            <p className={cn(BODY_MUTED)}>No referral links yet. Create one to get started.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {links.map((link) => {
              const url = buildReferralLinkUrl(link, appUrl);
              return (
                <div
                  key={link.id}
                  className={cn(CARD, 'px-4 py-3 flex items-center gap-3')}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-foreground truncate font-mono">
                        {link.isVanity ? link.code.toUpperCase() : url}
                      </p>
                      {link.discountPercent > 0 && (
                        <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-lg text-[11px] font-medium bg-brand-subtle text-primary">
                          {link.discountPercent}% off
                        </span>
                      )}
                    </div>
                    <p className={cn(META, 'mt-0.5')}>
                      {link.productName ? `${link.productName} · ` : ''}
                      {link.isVanity ? 'code · ' : ''}
                      {link.clicks} {link.clicks === 1 ? 'click' : 'clicks'}
                      {(() => {
                        const a = analytics.get(link.id);
                        if (!a || a.clicks === 0) return null;
                        return (
                          <>
                            {' · '}
                            {formatConversionRate(a.conversionRate)} conv
                            {' · '}
                            {formatCurrency(a.epcCents / 100)} EPC
                          </>
                        );
                      })()}
                    </p>
                  </div>
                  <CopyLinkButton url={url} />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Recruit other creators (sub-affiliate) */}
      {links.length > 0 && (
        <section className={cn(SECTION_RHYTHM)}>
          <div className="space-y-1">
            <h2 className={cn(H2)}>Recruit creators</h2>
            <p className={cn(BODY_MUTED)}>
              Share this link. When creators you recruit make sales, you earn an override —
              if the seller has sub-affiliates enabled.
            </p>
          </div>
          {(() => {
            const recruitUrl = `${appUrl.replace(/\/$/, '')}/affiliate?recruiter=${encodeURIComponent(links[0].code)}`;
            return (
              <div className={cn(CARD, 'px-4 py-3 flex items-center gap-3')}>
                <p className="flex-1 min-w-0 text-sm text-foreground truncate font-mono">{recruitUrl}</p>
                <CopyLinkButton url={recruitUrl} />
              </div>
            );
          })()}
        </section>
      )}

      {/* Recent commissions */}
      <section className={cn(SECTION_RHYTHM)}>
        <h2 className={cn(H2)}>Recent commissions</h2>

        {commissions.length === 0 ? (
          <div className={cn(CARD, 'px-5 py-10 text-center')}>
            <p className={cn(BODY_MUTED)}>No commissions yet. Share your referral link to start earning.</p>
          </div>
        ) : (
          <div className={cn(CARD, 'overflow-hidden')}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/40">
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Date</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Order</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium')}>Amount</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Status</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium hidden sm:table-cell')}>Type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {commissions.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                    <td className={cn(META, 'px-4 py-3 align-middle')}>
                      {new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className={cn(CAPTION, 'px-4 py-3 align-middle font-mono')}>
                      {c.orderId ? c.orderId.slice(0, 8) + '…' : '—'}
                    </td>
                    <td className={cn('px-4 py-3 align-middle text-right text-sm font-medium tabular-nums text-foreground')}>
                      {formatCurrency(c.netCents / 100)}
                    </td>
                    <td className="px-4 py-3 align-middle">
                      {(c.status === 'approved' || c.status === 'paid') && (
                        <span className={cn(CHIP_POSITIVE)}>{c.status}</span>
                      )}
                      {c.status === 'pending' && (
                        <span className={cn(CHIP_NEUTRAL)}>{c.status}</span>
                      )}
                      {c.status === 'rejected' && (
                        <span className={cn(CHIP_NEGATIVE)}>{c.status}</span>
                      )}
                      {c.status !== 'approved' && c.status !== 'paid' && c.status !== 'pending' && c.status !== 'rejected' && (
                        <span className={cn(CHIP_NEUTRAL)}>{c.status}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-middle hidden sm:table-cell">
                      {c.level === 2 ? (
                        <span className={cn(CHIP_NEUTRAL)}>Recruiter</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Direct</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
