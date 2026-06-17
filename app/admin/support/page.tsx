import { redirect } from 'next/navigation';
import { isPlatformAdmin } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { SupportClient, type SupportTicket } from './support-client';

export const metadata = { title: 'Support — Admin — Cola' };

export default async function AdminSupportPage() {
  const ok = await isPlatformAdmin();
  if (!ok) redirect('/');

  const tickets = (await convex().query(api.support.tickets.listAll, {})) as SupportTicket[];

  // Resolve space slugs/names so the admin sees which workspace a ticket came
  // from without a per-row lookup. One query, mapped client-side.
  const spaceIds = Array.from(
    new Set(tickets.map((t) => t.spaceId).filter((s): s is string => !!s)),
  );
  const spaceMap: Record<string, { name: string; slug: string }> = {};
  if (spaceIds.length > 0) {
    const spaces = (await convex().query(api.workspace.spaces.listByIds, {
      ids: spaceIds,
    })) as { id: string; name: string; slug: string }[];
    for (const row of spaces) {
      spaceMap[row.id] = { name: row.name, slug: row.slug };
    }
  }

  return (
    <div className="space-y-8 pb-12">
      <header className="space-y-1.5">
        <p className="text-sm text-muted-foreground">System.</p>
        <h1
          className="text-3xl tracking-tight text-foreground"
          style={{ fontFamily: 'var(--font-title)' }}
        >
          Support
        </h1>
        <p className="text-sm text-muted-foreground">
          Help requests from sellers. {tickets.length} total.
        </p>
      </header>
      <SupportClient initialTickets={tickets} spaceMap={spaceMap} />
    </div>
  );
}
