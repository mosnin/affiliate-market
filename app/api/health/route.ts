import { auth } from '@clerk/nextjs/server';
import { convex, api } from '@/lib/convex-server';
import { NextResponse } from 'next/server';

/**
 * Internal health check — admin-only.
 * Returns opaque status values; never exposes env var names, table schemas,
 * raw DB rows, or error messages to unauthenticated callers.
 */
export async function GET() {
  // Require authentication
  const { userId, sessionClaims } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Require admin role (set via Clerk publicMetadata: { role: 'admin' })
  const isAdmin = (sessionClaims?.publicMetadata as Record<string, unknown>)?.role === 'admin';
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let dbStatus: 'ok' | 'error' = 'error';
  try {
    // Liveness probe: a successful query (it returns; Convex throws on failure)
    // means the data layer is reachable. Mirrors the old `select('id').limit(1)`.
    await convex().query(api.org.users.listRecent, { limit: 1 });
    dbStatus = 'ok';
  } catch {
    // intentionally swallowed — status already 'error'
  }

  return NextResponse.json({ status: 'ok', db: dbStatus });
}
