import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getClientUser } from '@/lib/client-auth';
import { TITLE_FONT } from '@/lib/typography';

export const dynamic = 'force-dynamic';

/**
 * Buyer portal landing. A signed-in buyer goes straight to the dashboard;
 * everyone else sees the one-idea pitch and a single way in.
 */
export default async function BuyerPortalLanding() {
  const user = await getClientUser();
  if (user) {
    redirect(user.emailVerifiedAt ? '/buyer/dashboard' : '/buyer/verify');
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-3xl flex-col justify-center px-4 py-16 sm:px-6">
      <div className="max-w-xl space-y-6">
        <h1 className="text-3xl tracking-tight text-foreground sm:text-4xl" style={TITLE_FONT}>
          Buyer portal — track your purchases.
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          One place for every license you&apos;ve bought. Sign in with the email you used at
          checkout and it&apos;s all here.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Link
            href="/buyer/signup"
            className="inline-flex h-9 items-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-all duration-150 hover:bg-foreground/90 active:scale-[0.98]"
          >
            Create your account
          </Link>
          <Link
            href="/buyer/login"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Sign in
          </Link>
        </div>
        <Link
          href="/marketplace"
          className="inline-block text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Browse the marketplace
        </Link>
      </div>
    </main>
  );
}
