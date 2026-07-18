import { redirect } from 'next/navigation';
import { getClientUser } from '@/lib/client-auth';
import { AuthShell, VerifyForm } from '../auth-ui';

export const dynamic = 'force-dynamic';

export default async function BuyerVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const user = await getClientUser();
  if (user?.emailVerifiedAt) redirect('/buyer/dashboard');

  const { email } = await searchParams;
  const initialEmail = (email ?? user?.email ?? '').trim().toLowerCase();

  return (
    <AuthShell
      title="Verify your email"
      subtitle="We sent a 6-digit code to your inbox. Enter it to finish."
    >
      <VerifyForm initialEmail={initialEmail} />
    </AuthShell>
  );
}
