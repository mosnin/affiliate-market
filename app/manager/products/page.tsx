import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { resolveManagerContext } from '@/lib/agent/manager-context';
import { ManagerProductsClient } from './products-client';

export const metadata: Metadata = { title: 'Products — Company' };

export default async function ManagerProductsPage() {
  const ctx = await resolveManagerContext();
  if (!ctx) redirect('/');

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      <ManagerProductsClient />
    </div>
  );
}
