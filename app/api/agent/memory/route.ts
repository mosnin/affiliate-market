/**
 * GET /api/agent/memory
 *
 * Lists Cola's long-term memory rows for the caller's space, with entity
 * names resolved for display. The agent writes here via the Python memory
 * store; this endpoint is the read side for the user-facing memory surface.
 *
 * Query params:
 *   - entityType: 'contact' | 'deal' | 'space'  (filter)
 *   - memoryType: 'fact' | 'preference' | 'observation' | 'reminder'  (filter)
 *   - search:     free-text content match (ILIKE)
 *   - limit:      max rows, default 100, cap 200
 *
 * Memories with the special PRIORITY_LIST: prefix are excluded — they're
 * coordinator scratch state, not knowledge the seller cares about.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

type EntityTypeFilter = 'contact' | 'deal' | 'space';
type MemoryTypeFilter = 'fact' | 'preference' | 'observation' | 'reminder';

export interface MemoryRow {
  id: string;
  memoryType: 'fact' | 'preference' | 'observation' | 'reminder';
  content: string;
  importance: number;
  entityType: 'contact' | 'deal' | 'space' | null;
  entityId: string | null;
  entityName: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function GET(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const entityType = sp.get('entityType');
  const memoryType = sp.get('memoryType');
  const search = (sp.get('search') ?? '').trim();
  const limit = Math.min(parseInt(sp.get('limit') ?? '100'), 200);

  // listForSpace handles the PRIORITY_LIST exclusion, the optional
  // entityType/memoryType filters, the free-text content match, the
  // importance-desc / createdAt-desc sort, and the limit — exactly the query
  // the PostgREST chain built. The validation gate stays here so we only pass
  // recognised filter values into the typed Convex args.
  const entityTypeFilter: EntityTypeFilter | undefined =
    entityType && ['contact', 'deal', 'space'].includes(entityType)
      ? (entityType as EntityTypeFilter)
      : undefined;
  const memoryTypeFilter: MemoryTypeFilter | undefined =
    memoryType && ['fact', 'preference', 'observation', 'reminder'].includes(memoryType)
      ? (memoryType as MemoryTypeFilter)
      : undefined;

  let data;
  try {
    data = await convex().query(api.swarmvector.agentMemory.listForSpace, {
      spaceId: space.id,
      limit,
      ...(entityTypeFilter ? { entityType: entityTypeFilter } : {}),
      ...(memoryTypeFilter ? { memoryType: memoryTypeFilter } : {}),
      ...(search ? { search } : {}),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  if (!data || data.length === 0) return NextResponse.json([]);

  // Resolve entity names in two batched queries
  const contactIds = [...new Set(data.filter((m) => m.entityType === 'contact' && m.entityId).map((m) => m.entityId as string))];
  const dealIds = [...new Set(data.filter((m) => m.entityType === 'deal' && m.entityId).map((m) => m.entityId as string))];

  const [contactsRes, dealsRes] = await Promise.all([
    contactIds.length
      ? supabase.from('Contact').select('id, name').in('id', contactIds).eq('spaceId', space.id)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    dealIds.length
      ? supabase.from('Deal').select('id, title').in('id', dealIds).eq('spaceId', space.id)
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
  ]);

  const contactNames = new Map((contactsRes.data ?? []).map((c) => [c.id, c.name]));
  const dealNames = new Map((dealsRes.data ?? []).map((d) => [d.id, d.title]));

  const rows: MemoryRow[] = data.map((m) => ({
    id: m.id as string,
    memoryType: m.memoryType as MemoryRow['memoryType'],
    content: m.content as string,
    importance: m.importance as number,
    entityType: (m.entityType as MemoryRow['entityType']) ?? null,
    entityId: (m.entityId as string | null) ?? null,
    entityName:
      m.entityType === 'contact' ? (contactNames.get(m.entityId as string) ?? null) :
      m.entityType === 'deal' ? (dealNames.get(m.entityId as string) ?? null) :
      null,
    expiresAt: (m.expiresAt as string | null) ?? null,
    createdAt: m.createdAt as string,
    updatedAt: m.updatedAt as string,
  }));

  return NextResponse.json(rows);
}
