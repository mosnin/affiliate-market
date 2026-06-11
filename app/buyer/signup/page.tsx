import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getClientUser } from '@/lib/client-auth';
import { AuthShell, SignupForm } from '../auth-ui';

export const dynamic = 'force-dynamic';

export default async function BuyerSignupPage() {
  const user = await getClientUser();
  if (user) redirect(user.emailVerifiedAt ? '/buyer/dashboard' : '/buyer/verify');

  return (
    <AuthShell
      title="Create your account"
      subtitle="One login for all your Cola purchases."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/buyer/login" className="text-foreground hover:underline">
            Sign in
          </Link>
          .
        </>
      }
    >
      <SignupForm />
    </AuthShell>
  );
}
