import { NextResponse, type NextRequest } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireContactAccess } from '@/lib/api-auth';
import { getSignedDownloadUrl } from '@/lib/storage';

export const runtime = 'nodejs';

/**
 * GET /api/contacts/[id]/client-documents — seller lists the documents a
 * client uploaded through their portal. With &id=… returns a short-lived
 * signed download URL. Seller auth via requireContactAccess.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: contactId } = await params;
  const auth = await requireContactAccess(contactId);
  if (auth instanceof NextResponse) return auth;

  const docId = req.nextUrl.searchParams.get('id');
  if (docId) {
    const fileKey = await convex().query(api.portal.clientDocuments.fileKeyForDownload, {
      id: docId,
      contactId,
    });
    if (!fileKey) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const url = await getSignedDownloadUrl(fileKey);
    return NextResponse.json({ url });
  }

  const documents = await convex().query(api.portal.clientDocuments.listForContact, {
    contactId,
  });

  return NextResponse.json({ documents });
}
