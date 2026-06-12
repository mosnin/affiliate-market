'use client';

import { SignInButton, UserButton, useUser } from '@clerk/nextjs';

/**
 * Auth corner for the affiliate portal header. Client component because it
 * branches on live session state (Clerk v7 dropped the SignedIn/SignedOut
 * wrappers this layout previously used).
 */
export function AffiliateAuthCorner() {
  const { isLoaded, isSignedIn } = useUser();

  if (!isLoaded) return <div className="h-8 w-8" aria-hidden />;

  if (!isSignedIn) {
    return (
      <SignInButton mode="modal">
        <button className="px-3 h-8 inline-flex items-center rounded-md text-sm font-medium bg-foreground text-background hover:bg-foreground/90 transition-colors">
          Sign in
        </button>
      </SignInButton>
    );
  }

  return <UserButton />;
}
