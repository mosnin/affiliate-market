import { redirect } from 'next/navigation';
import { auth, currentUser } from '@clerk/nextjs/server';
import { SignInButton } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import { H1, BODY_MUTED, SECTION_LABEL, PRIMARY_PILL, PAGE_RHYTHM } from '@/lib/typography';
import { getCreatorProfileByEmail } from '@/lib/affiliates/creators';
import { CreatorProfileForm } from '@/components/affiliate/creator-profile-form';

export const dynamic = 'force-dynamic';

export default async function CreatorProfilePage() {
  const { userId } = await auth();
  if (!userId) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-20 text-center space-y-4">
        <h1 className={cn(H1)}>Your creator profile.</h1>
        <p className={cn(BODY_MUTED)}>Sign in to edit your profile.</p>
        <SignInButton mode="modal">
          <button className={cn(PRIMARY_PILL, 'mt-2')}>Sign in</button>
        </SignInButton>
      </div>
    );
  }

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress ?? null;
  if (!email) redirect('/affiliate');

  const profile = await getCreatorProfileByEmail(email);
  const fallbackName =
    [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || email.split('@')[0];

  return (
    <div className={cn('max-w-3xl mx-auto px-4 sm:px-6 py-10', PAGE_RHYTHM)}>
      <header className="space-y-1">
        <p className={cn(SECTION_LABEL)}>Creator profile</p>
        <h1 className={cn(H1)}>How sellers find you</h1>
        <p className={cn(BODY_MUTED)}>
          Sellers shopping for distribution browse this. The more you share, the more
          relevant the invites.
        </p>
      </header>

      <CreatorProfileForm
        initial={{
          name: profile?.name ?? fallbackName,
          bio: profile?.bio ?? '',
          niche: profile?.niche ?? '',
          audienceSize: profile?.audienceSize ?? 0,
          channels: profile?.channels ?? [],
          websiteUrl: profile?.websiteUrl ?? '',
          listed: profile?.listed ?? false,
        }}
      />
    </div>
  );
}
