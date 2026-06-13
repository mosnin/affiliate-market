import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { MessageSquare, ShieldCheck, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  H1,
  H2,
  BODY_MUTED,
  SECTION_LABEL,
  STAT_NUMBER_COMPACT,
  PAGE_RHYTHM,
  SECTION_RHYTHM,
  CARD,
  STAT_CARD,
  ICON_SQUARE,
  META,
} from '@/lib/typography';
import { isPlatformAdmin } from '@/lib/permissions';
import { supabase } from '@/lib/supabase';
import { getReviewsForModeration } from '@/lib/marketplace/reviews';
import { ReviewModerationButton, VerifyProductButton } from './moderation-actions';

export const dynamic = 'force-dynamic';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface UnverifiedProduct {
  id: string;
  name: string;
  marketplaceSlug: string | null;
  sellerName: string;
}

/** Published listings still awaiting a verification decision. */
async function getUnverifiedPublishedProducts(): Promise<UnverifiedProduct[]> {
  const { data } = await supabase
    .from('Product')
    .select('id, name, address, marketplaceSlug, spaceId')
    .eq('published', true)
    .eq('verified', false)
    .not('marketplaceSlug', 'is', null)
    .order('updatedAt', { ascending: false })
    .limit(100);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const spaceIds = [...new Set(rows.map((r) => r.spaceId as string))];
  const { data: spaces } = await supabase.from('Space').select('id, name').in('id', spaceIds);
  const nameById = new Map((spaces ?? []).map((s) => [s.id as string, s.name as string]));

  return rows.map((r) => ({
    id: r.id as string,
    name: (r.name as string | null) ?? (r.address as string | null) ?? 'Untitled product',
    marketplaceSlug: (r.marketplaceSlug as string | null) ?? null,
    sellerName: nameById.get(r.spaceId as string) ?? 'Unknown seller',
  }));
}

/**
 * Trust & safety console: moderate buyer reviews and vet listings. Reviews can
 * be hidden (reversibly) without deleting the buyer's words; listings get a
 * platform "verified" vouch that sellers can't grant themselves.
 */
export default async function ModerationPage() {
  const { userId } = await auth();
  if (!userId || !(await isPlatformAdmin())) redirect('/');

  const [reviews, unverified] = await Promise.all([
    getReviewsForModeration(),
    getUnverifiedPublishedProducts(),
  ]);

  const hiddenCount = reviews.filter((r) => r.status === 'hidden').length;

  const stats = [
    { label: 'Reviews', value: reviews.length, icon: MessageSquare },
    { label: 'Hidden', value: hiddenCount, icon: Star },
    { label: 'Awaiting verification', value: unverified.length, icon: ShieldCheck },
  ];

  return (
    <div className={cn('max-w-5xl mx-auto px-4 sm:px-6 py-10', PAGE_RHYTHM)}>
      <header className="space-y-1">
        <p className={cn(SECTION_LABEL)}>Admin</p>
        <h1 className={cn(H1)}>Moderation</h1>
        <p className={cn(BODY_MUTED)}>
          Hide reviews that break the rules and verify listings you&apos;ve vetted. Hiding is
          reversible; verification is a platform vouch sellers can&apos;t self-grant.
        </p>
      </header>

      <section className="grid grid-cols-3 gap-4">
        {stats.map(({ label, value, icon: Icon }) => (
          <div key={label} className={cn(STAT_CARD)}>
            <div className={cn(ICON_SQUARE)}>
              <Icon size={16} aria-hidden />
            </div>
            <p className={cn(SECTION_LABEL)}>{label}</p>
            <p className={cn(STAT_NUMBER_COMPACT)}>{value}</p>
          </div>
        ))}
      </section>

      {/* Listing verification */}
      <section className={cn(SECTION_RHYTHM)}>
        <h2 className={cn(H2)}>Listing verification</h2>
        {unverified.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-5 py-10 text-center">
            <p className={cn(BODY_MUTED)}>Every published listing has been reviewed. Nothing pending.</p>
          </div>
        ) : (
          <div className={cn(CARD, 'overflow-hidden')}>
            <ul className="divide-y divide-border/60">
              {unverified.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    {p.marketplaceSlug ? (
                      <Link
                        href={`/marketplace/p/${p.marketplaceSlug}`}
                        className="text-sm font-medium text-foreground hover:underline"
                      >
                        {p.name}
                      </Link>
                    ) : (
                      <span className="text-sm font-medium text-foreground">{p.name}</span>
                    )}
                    <span className={cn(META, 'ml-2')}>{p.sellerName}</span>
                  </div>
                  <VerifyProductButton productId={p.id} verified={false} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Review moderation */}
      <section className={cn(SECTION_RHYTHM)}>
        <h2 className={cn(H2)}>Recent reviews</h2>
        {reviews.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-5 py-10 text-center">
            <p className={cn(BODY_MUTED)}>No reviews yet.</p>
          </div>
        ) : (
          <div className={cn(CARD, 'overflow-hidden')}>
            <ul className="divide-y divide-border/60">
              {reviews.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-4 px-4 py-3.5">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{r.productName}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {r.rating}/5
                      </span>
                      {r.status === 'hidden' && (
                        <span className="inline-flex items-center rounded-lg bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          Hidden
                        </span>
                      )}
                    </div>
                    {r.title && <p className="text-sm text-foreground">{r.title}</p>}
                    {r.body && (
                      <p className="line-clamp-3 text-sm text-muted-foreground">{r.body}</p>
                    )}
                    <p className={cn(META)}>
                      {r.buyerEmail} · {formatDate(r.createdAt)}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <ReviewModerationButton reviewId={r.id} status={r.status} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
