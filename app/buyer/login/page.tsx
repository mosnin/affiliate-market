import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getClientUser } from '@/lib/client-auth';
import { AuthShell, LoginForm } from '../auth-ui';

export const dynamic = 'force-dynamic';

export default async function BuyerLoginPage() {
  const user = await getClientUser();
  if (user) redirect(user.emailVerifiedAt ? '/buyer/dashboard' : '/buyer/verify');

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to see your purchases and licenses."
      footer={
        <>
          New here?{' '}
          <Link href="/buyer/signup" className="text-foreground hover:underline">
            Create an account
          </Link>
          .
        </>
      }
    >
      <LoginForm />
    </AuthShell>
  );
}
