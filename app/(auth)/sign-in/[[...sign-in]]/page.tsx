import { redirect } from 'next/navigation';

/**
 * Redirect /sign-in to /login/seller so all sign-in flows use
 * Clerk's path-based routing consistently. This prevents mobile
 * navigation issues when switching between manager/seller tabs.
 */
export default function SignInPage() {
  redirect('/login/seller');
}
