import Link from 'next/link';
import { SignInButton, SignedIn, SignedOut, UserButton } from '@clerk/nextjs';

export default function AffiliateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Top nav */}
      <header className="border-b border-border/60 bg-background/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          {/* Wordmark */}
          <Link
            href="/"
            className="text-lg font-semibold tracking-tight text-foreground hover:opacity-80 transition-opacity"
            style={{ fontFamily: 'var(--font-title)' }}
          >
            Cola
          </Link>

          {/* Nav links */}
          <nav className="flex items-center gap-1">
            <Link
              href="/affiliate/dashboard"
              className="px-3 h-8 inline-flex items-center rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-colors"
            >
              Dashboard
            </Link>
            <Link
              href="/affiliate/payouts"
              className="px-3 h-8 inline-flex items-center rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-colors"
            >
              Payouts
            </Link>
          </nav>

          {/* Auth */}
          <div className="flex items-center gap-2">
            <SignedOut>
              <SignInButton mode="modal">
                <button className="px-3 h-8 inline-flex items-center rounded-md text-sm font-medium bg-foreground text-background hover:bg-foreground/90 transition-colors">
                  Sign in
                </button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <UserButton />
            </SignedIn>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
