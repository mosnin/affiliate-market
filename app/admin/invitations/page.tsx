import { convex, api } from '@/lib/convex-server';
import { Card, CardContent } from '@/components/ui/card';
import { isPlatformAdmin } from '@/lib/permissions';
import { redirect } from 'next/navigation';

const statusStyle = (status: string) => {
  switch (status) {
    case 'pending':  return 'text-muted-foreground bg-muted dark:text-muted-foreground dark:bg-muted0/15';
    case 'accepted': return 'text-positive bg-positive-subtle dark:text-positive dark:bg-positive-subtle0/15';
    default:         return 'text-muted-foreground bg-muted';
  }
};

export default async function AdminInvitationsPage() {
  const isAdmin = await isPlatformAdmin();
  if (!isAdmin) redirect('/');

  let invs: Array<{
    id: string;
    email: string;
    roleToAssign: string;
    status: string;
    expiresAt: string;
    createdAt: string;
    companyId: string | null;
    Company: { name: string } | null;
  }>;
  try {
    // Invitations newest-first (cap 200), then resolve the embedded Company(name)
    // lib-side — the Convex fn returns Invitation rows only.
    const invitations = (await convex().query(api.org.invitations.listAll, {
      limit: 200,
    })) as Array<{
      id: string;
      email: string;
      roleToAssign: string;
      status: string;
      expiresAt: string;
      createdAt: string;
      companyId: string;
    }>;

    const companyIds = Array.from(new Set(invitations.map((i) => i.companyId).filter(Boolean)));
    const companies =
      companyIds.length > 0
        ? ((await convex().query(api.org.companies.listByIds, {
            ids: companyIds,
          })) as Array<{ id: string; name: string }>)
        : [];
    const nameById = new Map(companies.map((c) => [c.id, c.name]));

    invs = invitations.map((i) => ({
      id: i.id,
      email: i.email,
      roleToAssign: i.roleToAssign,
      status: i.status,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
      companyId: i.companyId,
      Company: nameById.has(i.companyId) ? { name: nameById.get(i.companyId)! } : null,
    }));
  } catch {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="text-sm text-muted-foreground">Couldn&apos;t load invitations.</p>
      </div>
    );
  }

  const roleLabel = (r: string) => r === 'manager_admin' ? 'Admin' : 'Seller';

  return (
    <div className="space-y-8 pb-12 max-w-5xl mx-auto">
      <header className="space-y-1.5">
        <p className="text-sm text-muted-foreground">Management.</p>
        <h1
          className="text-3xl tracking-tight text-foreground"
          style={{ fontFamily: 'var(--font-title)' }}
        >
          Invitations
        </h1>
        <p className="text-sm text-muted-foreground">
          {invs.length} invitation{invs.length !== 1 ? 's' : ''} across all companies.
        </p>
      </header>

      {invs.length === 0 ? (
        <Card>
          <CardContent className="px-5 py-8 text-center">
            <p className="text-sm text-muted-foreground">No invitations yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {invs.map((inv) => {
            const sentAt = new Date(inv.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const expiresAt = new Date(inv.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return (
              <div key={inv.id} className="rounded-xl border border-border bg-card px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{inv.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {inv.Company?.name ?? '—'} · {roleLabel(inv.roleToAssign)} · Sent {sentAt}
                      {inv.status === 'pending' && ` · Expires ${expiresAt}`}
                    </p>
                  </div>
                  <span className={`inline-flex text-[10px] font-semibold rounded-full px-2 py-0.5 capitalize flex-shrink-0 ${statusStyle(inv.status)}`}>
                    {inv.status}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
