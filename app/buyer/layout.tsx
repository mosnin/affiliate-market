import type { Metadata } from 'next';
import Link from 'next/link';
import { BrandLogo } from '@/components/brand-logo';

export const metadata: Metadata = {
  title: 'Buyer portal · Cola',
  description: 'Track your purchases and licenses from Cola Marketplace.',
};

/**
 * Buyer portal layout — a fully separate end-user surface. No ClerkProvider,
 * no seller nav. Middleware already carves /buyer (via /clients rules) out of
 * Clerk; each page enforces its own session via getClientUser().
 *
 * Same quiet chrome as /clients: wordmark + single link.
 */
export default function BuyerPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4 sm:px-6">
          <Link href="/buyer" className="flex items-center gap-2" aria-label="Cola buyer portal">
            <BrandLogo className="h-5" />
          </Link>
          <a
            href="/marketplace"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Marketplace
          </a>
        </div>
      </header>
      {children}
    </div>
  );
}
