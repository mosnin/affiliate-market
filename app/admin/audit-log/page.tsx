import { convex, api } from '@/lib/convex-server';
import { isPlatformAdmin } from '@/lib/permissions';
import { redirect } from 'next/navigation';
import { AuditLogClient } from './audit-log-client';

export default async function AuditLogPage() {
  const isAdmin = await isPlatformAdmin();
  if (!isAdmin) redirect('/');

  // Fetch audit logs and users in parallel. The user list is the full table (the
  // old `.select('clerkId, name, email')` had no limit) so the clerkId map is
  // complete; pass a high cap to listForAdmin to keep that "all users" behavior.
  const [logs, users] = await Promise.all([
    convex().query(api.infra.auditLog.listRecent, { limit: 200 }) as Promise<
      {
        id: string;
        clerkId: string | null;
        ipAddress: string | null;
        action: string;
        resource: string;
        resourceId: string | null;
        spaceId: string | null;
        metadata: Record<string, unknown> | null;
        createdAt: string;
      }[]
    >,
    convex().query(api.org.users.listForAdmin, { limit: 100000 }) as Promise<
      { clerkId: string; name: string | null; email: string }[]
    >,
  ]);

  // Build a clerkId -> { name, email } map
  const userMap: Record<string, { name: string | null; email: string }> = {};
  for (const user of users) {
    userMap[user.clerkId] = { name: user.name, email: user.email };
  }

  return (
    <div className="space-y-8 pb-12">
      <header className="space-y-1.5">
        <p className="text-sm text-muted-foreground">System.</p>
        <h1
          className="text-3xl tracking-tight text-foreground"
          style={{ fontFamily: 'var(--font-title)' }}
        >
          Audit log
        </h1>
        <p className="text-sm text-muted-foreground">Platform-wide activity log for SOC 2 compliance.</p>
      </header>
      <AuditLogClient logs={logs} userMap={userMap} />
    </div>
  );
}
