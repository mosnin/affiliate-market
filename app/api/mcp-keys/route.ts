import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';
import { checkRateLimit } from '@/lib/rate-limit';
import crypto from 'crypto';

// GET /api/mcp-keys?slug=xxx — list all MCP API keys for the user's space
export async function GET(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  let keys;
  try {
    keys = await convex().query(api.infra.mcpApiKeys.listForSpace, { spaceId: space.id });
  } catch {
    return NextResponse.json({ error: 'Failed to load API keys' }, { status: 500 });
  }
  return NextResponse.json({ keys });
}

// POST /api/mcp-keys — generate a new MCP API key (returns the full key ONCE)
export async function POST(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  // Rate limit: max 10 key generations per hour
  const { allowed } = await checkRateLimit(`mcp:keygen:${userId}`, 10, 3600);
  if (!allowed) return NextResponse.json({ error: 'Too many key generations. Try again later.' }, { status: 429 });

  // Limit total keys per space to 20
  const count = await convex().query(api.infra.mcpApiKeys.countForSpace, { spaceId: space.id });
  if (count >= 20) return NextResponse.json({ error: 'Maximum 20 API keys per workspace' }, { status: 400 });

  let name = 'Default';
  try {
    const body = await req.json();
    if (body.name && typeof body.name === 'string') {
      name = body.name.replace(/[<>"]/g, '').slice(0, 100);
    }
  } catch {
    // body may be empty — that's fine, use default name
  }

  // Generate API key (for direct Bearer auth)
  const rawKey = `cola_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 12) + '...';

  // Generate OAuth client credentials (for Claude MCP connector)
  const clientId = `cola_${crypto.randomBytes(16).toString('hex')}`;
  const clientSecret = `cs_${crypto.randomBytes(32).toString('hex')}`;
  const clientSecretHash = crypto.createHash('sha256').update(clientSecret).digest('hex');

  // Default 365-day TTL — keys cool off after a year unless the seller
  // rotates. Long enough that a set-and-forget Claude connector keeps
  // working through a billing cycle; short enough that a stale leak goes
  // cold within a year. Legacy keys (created before this migration)
  // carry NULL expiresAt and live until manually revoked.
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  let data;
  try {
    data = await convex().mutation(api.infra.mcpApiKeys.create, {
      spaceId: space.id,
      name,
      keyHash,
      keyPrefix,
      clientId,
      clientSecretHash,
      expiresAt,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 });
  }

  return NextResponse.json({
    ...data,
    key: rawKey,
    clientId,
    clientSecret,
    tokenUrl: 'https://my.usecola.com/api/mcp/oauth/token',
    mcpUrl: 'https://my.usecola.com/api/mcp',
  }, { status: 201 });
}

// DELETE /api/mcp-keys — revoke an API key by id (called from settings form)
export async function DELETE(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  try {
    const { id } = await req.json();
    if (!id || typeof id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 });

    // Verify key belongs to this space
    const existing = await convex().query(api.infra.mcpApiKeys.existsForSpace, {
      id,
      spaceId: space.id,
    });

    if (!existing) return NextResponse.json({ error: 'API key not found' }, { status: 404 });

    try {
      await convex().mutation(api.infra.mcpApiKeys.deleteById, { id });
    } catch {
      return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
