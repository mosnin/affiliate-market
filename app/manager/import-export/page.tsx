import { getManagerContext } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { redirect } from 'next/navigation';
import ImportExportClient from './import-export-client';

export const metadata = { title: 'Import / Export — Teams' };

export default async function ImportExportPage() {
  const ctx = await getManagerContext();
  if (!ctx) redirect('/');

  const { company } = ctx;

  // Get total lead count across all member spaces
  const memberships = (await convex().query(api.org.memberships.listByCompany, {
    companyId: company.id,
  })) as Array<{ userId: string }>;

  const memberUserIds = memberships.map((m) => m.userId);

  let totalLeads = 0;
  if (memberUserIds.length > 0) {
    const spaces = (await convex().query(api.workspace.spaces.listByOwnerIds, {
      ownerIds: memberUserIds,
    })) as Array<{ id: string }>;

    const spaceIds = spaces.map((s) => s.id);
    if (spaceIds.length > 0) {
      totalLeads = await convex().query(api.contacts.contacts.countForSpaces, {
        spaceIds,
      });
    }
  }

  return <ImportExportClient totalLeads={totalLeads} />;
}
