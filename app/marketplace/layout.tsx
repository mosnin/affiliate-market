import type { Metadata } from 'next';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { BrandLogo } from '@/components/brand-logo';
import { ReferralTracker } from '@/components/affiliate/referral-tracker';

export const metadata: Metadata = {
  title: 'Cola Marketplace — Find software. Buy in minutes.',
  description: 'Browse, compare, and buy software directly from verified sellers.',
};

export default function MarketplaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
          {/* Wordmark */}
          <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="Cola home">
            <BrandLogo className="h-5" />
          </Link>

          {/* Search — links to marketplace with q= populated */}
          <form
            action="/marketplace"
            method="get"
            className="flex flex-1 items-center rounded-full border border-border bg-muted/40 px-3 py-1.5 text-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 focus-within:ring-offset-1 focus-within:ring-offset-background"
          >
            <Search size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              name="q"
              type="search"
              placeholder="Search software…"
              className="ml-2 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60"
            />
          </form>

          {/* Nav links */}
          <nav className="flex shrink-0 items-center gap-1">
            <Link
              href="/affiliate"
              className="hidden h-8 items-center rounded-full px-3 text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground sm:inline-flex"
            >
              Affiliates
            </Link>
            <Link
              href="/buyer"
              className="inline-flex h-8 items-center rounded-full border border-border px-3 text-sm text-foreground transition-colors hover:bg-foreground/[0.04]"
            >
              My purchases
            </Link>
          </nav>
        </div>
      </header>

      {/* ReferralTracker is a client component that reads referral codes from the URL
          and persists them — mount it invisibly in the layout so it fires on every page. */}
      <ReferralTracker />

      {children}

      <footer className="mt-24 border-t border-border/60 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 text-center sm:px-6">
          <BrandLogo className="h-4 opacity-50" />
          <p className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} Cola &middot;{' '}
            <a href="https://usecola.com" className="hover:text-foreground">
              usecola.com
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
