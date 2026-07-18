import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { getSpaceFromSlug } from '@/lib/space';
import { convex, api } from '@/lib/convex-server';
import { Building2, ShieldCheck, UserCircle } from 'lucide-react';
import {
  H1,
  H2,
  TITLE_FONT,
  BODY,
  BODY_MUTED,
  CAPTION,
  PRIMARY_PILL,
  SECTION_RHYTHM,
  READING_MAX,
} from '@/lib/typography';

export default async function CompanyInvitesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  let userEmail: string | null = null;
  try {
    const user = await convex().query(api.org.users.getByClerkId, { clerkId: userId });
    userEmail = user?.email?.toLowerCase() ?? null;
  } catch (err) {
    console.error('[settings/company] Failed to fetch user', err);
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="text-center space-y-3 p-8">
          <h2 className={H2}>Something went wrong</h2>
          <p className={BODY_MUTED}>
            I couldn&apos;t load your invites. Usually temporary.
          </p>
          <a href={`/s/${slug}/settings/company`} className={PRIMARY_PILL}>
            Try again
          </a>
        </div>
      </div>
    );
  }

  if (!userEmail) {
    return (
      <div className={`${SECTION_RHYTHM} ${READING_MAX} pb-12`}>
        <h1 className={H1} style={TITLE_FONT}>
          Company
        </h1>
        <p className={BODY_MUTED}>No email found for your account.</p>
      </div>
    );
  }

  let invitations: Array<{
    id: string;
    email: string;
    roleToAssign: string;
    token: string;
    status: string;
    expiresAt: string;
    createdAt: string;
    Company: { id: string; name: string } | null;
  }> = [];

  try {
    // Pending invites for this email (case-insensitive, newest-first), then
    // compose each Company name with a second read (cross-domain embed lib-side).
    const rows = await convex().query(api.org.invitations.pendingForEmailList, {
      email: userEmail,
    });
    const companyIds = [...new Set(rows.map((r) => r.companyId))];
    const companies = companyIds.length
      ? await convex().query(api.org.companies.listByIds, { ids: companyIds })
      : [];
    const companyById = new Map(companies.map((c) => [c.id, { id: c.id, name: c.name }]));
    invitations = rows.map((r) => ({
      id: r.id,
      email: r.email,
      roleToAssign: r.roleToAssign,
      token: r.token,
      status: r.status,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      Company: companyById.get(r.companyId) ?? null,
    }));
  } catch (err) {
    console.error('[settings/company] Failed to fetch invitations', err);
  }

  const roleLabel = (role: string) => (role === 'manager_admin' ? 'Admin' : 'Member');

  // Inline narration ladder.
  const narration =
    invitations.length === 0
      ? 'No pending invitations right now.'
      : invitations.length === 1
        ? '1 company invite waiting.'
        : `${invitations.length} company invites waiting.`;

  return (
    <div className={`${SECTION_RHYTHM} ${READING_MAX} pb-12`}>
      <div className="space-y-2">
        <h1 className={H1} style={TITLE_FONT}>
          Company
        </h1>
        <p className={BODY_MUTED}>{narration}</p>
      </div>

      {invitations.length === 0 ? (
        <div className="rounded-md border border-border/70 bg-background px-5 py-12 text-center space-y-1">
          <p className={`${BODY} font-medium`}>Nothing here yet</p>
          <p className={CAPTION}>
            When a company invites you, it shows up here.
          </p>
        </div>
      ) : (
        <div>
          {invitations.map((inv) => {
            const companyName = Array.isArray(inv.Company)
              ? (inv.Company as Array<{ name?: string }>)[0]?.name
              : inv.Company?.name;
            const expiresAt = new Date(inv.expiresAt);
            const isExpired = expiresAt < new Date();
            const sentAt = new Date(inv.createdAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });

            return (
              <div
                key={inv.id}
                className="flex items-center justify-between gap-4 py-4 border-b border-border/60 last:border-b-0"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
                    <Building2 size={16} className="text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className={`${BODY} font-medium truncate`}>{companyName ?? 'Unknown company'}</p>
                    <div className={`flex items-center gap-2 ${CAPTION} mt-0.5`}>
                      <span className="inline-flex items-center gap-1">
                        {inv.roleToAssign === 'manager_admin' ? (
                          <ShieldCheck size={11} />
                        ) : (
                          <UserCircle size={11} />
                        )}
                        Invited as {roleLabel(inv.roleToAssign)}
                      </span>
                      <span>&#183;</span>
                      <span>Sent {sentAt}</span>
                    </div>
                  </div>
                </div>
                <div className="flex-shrink-0">
                  {isExpired ? (
                    <span className={CAPTION}>Expired</span>
                  ) : (
                    <a href={`/invite/${inv.token}`} className={PRIMARY_PILL}>
                      Accept
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
