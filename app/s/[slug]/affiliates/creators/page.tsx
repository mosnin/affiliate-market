import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { Search, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  H1,
  BODY_MUTED,
  SECTION_LABEL,
  META,
  PAGE_RHYTHM,
  CARD,
  CHIP_NEUTRAL,
} from '@/lib/typography';
import { getSpaceFromSlug, getSpaceForUser } from '@/lib/space';
import { listCreatorsForSeller, CREATOR_CHANNELS, channelLabel, formatAudience } from '@/lib/affiliates/creators';
import { InviteCreatorButton } from '@/components/affiliate/invite-creator-button';

const AFFILIATE_TABS = [
  { label: 'Overview', href: '' },
  { label: 'Program', href: '/program' },
  { label: 'Creators', href: '/creators' },
  { label: 'Commissions', href: '/commissions' },
  { label: 'Payouts', href: '/payouts' },
];

export default async function CreatorDirectoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ channel?: string; q?: string }>;
}) {
  const { slug } = await params;
  const { channel, q } = await searchParams;

  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  const userSpace = await getSpaceForUser(userId);
  if (!userSpace || userSpace.id !== space.id) notFound();

  const creators = await listCreatorsForSeller(space.id, { channel, q });

  return (
    <div className={cn(PAGE_RHYTHM)}>
      <header className="space-y-1">
        <p className={cn(SECTION_LABEL)}>Affiliates</p>
        <h1 className={cn(H1)}>Find creators</h1>
        <p className={cn(BODY_MUTED)}>
          Browse creators who promote software and invite them into your program.
        </p>
      </header>

      {/* Tab strip */}
      <nav className="flex items-center gap-0.5 border-b border-border/60 -mb-6">
        {AFFILIATE_TABS.map(({ label, href }) => {
          const isActive = href === '/creators';
          return (
            <Link
              key={label}
              href={`/s/${slug}/affiliates${href}`}
              className={cn(
                'px-3.5 h-9 inline-flex items-center text-sm transition-colors border-b-2 -mb-px',
                isActive
                  ? 'border-primary text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Search + channel filters */}
      <section className="space-y-4">
        <form action={`/s/${slug}/affiliates/creators`} method="GET" className="max-w-md">
          {channel && <input type="hidden" name="channel" value={channel} />}
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 h-9 focus-within:ring-2 focus-within:ring-ring/30">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              type="search"
              name="q"
              defaultValue={q ?? ''}
              placeholder="Search by name, niche…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            />
          </div>
        </form>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Link
            href={`/s/${slug}/affiliates/creators`}
            className={cn(
              'px-3 h-8 inline-flex items-center rounded-xl text-xs border transition-colors',
              !channel ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground hover:text-foreground',
            )}
          >
            All channels
          </Link>
          {CREATOR_CHANNELS.map((c) => (
            <Link
              key={c.value}
              href={`/s/${slug}/affiliates/creators?channel=${c.value}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
              className={cn(
                'px-3 h-8 inline-flex items-center rounded-xl text-xs border transition-colors',
                channel === c.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {c.label}
            </Link>
          ))}
        </div>
      </section>

      {/* Directory grid */}
      {creators.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-5 py-14 text-center">
          <p className={cn(BODY_MUTED)}>
            {q || channel
              ? 'No creators match that filter yet.'
              : 'No creators have listed themselves yet. As they join Cola and opt into the directory, they’ll appear here.'}
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {creators.map((c) => (
            <div key={c.id} className={cn(CARD, 'p-5 flex flex-col gap-3')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-foreground truncate">{c.name}</p>
                    {c.niche && <span className={cn(CHIP_NEUTRAL, 'shrink-0')}>{c.niche}</span>}
                  </div>
                  <p className={cn(META, 'mt-0.5 text-muted-foreground')}>
                    {formatAudience(c.audienceSize)} reach
                    {c.channels.length > 0 && <> · {c.channels.map(channelLabel).join(', ')}</>}
                  </p>
                </div>
                <InviteCreatorButton email={c.email} name={c.name} joined={c.joined} />
              </div>
              {c.bio && <p className={cn(BODY_MUTED, 'line-clamp-3')}>{c.bio}</p>}
              {c.websiteUrl && (
                <a
                  href={c.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Globe size={12} aria-hidden /> {c.websiteUrl.replace(/^https?:\/\//, '')}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
