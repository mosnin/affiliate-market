import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

type Params = { params: Promise<{ id: string }> };

// ── GET /api/custom-agents/[id] ───────────────────────────────────────────────
// Fetch a single custom agent. Verifies the agent belongs to the caller's space.

export async function GET(_req: NextRequest, { params }: Params) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;

  let agent;
  try {
    agent = await convex().query(api.agent.customAgents.getById, { id });
  } catch (err) {
    console.error('[custom-agents/[id]/GET] fetch error:', err);
    return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 });
  }
  if (!agent) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (agent.spaceId !== space.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({ agent });
}

// ── PUT /api/custom-agents/[id] ───────────────────────────────────────────────
// Update a custom agent. Accepts partial updates to any of the mutable fields.
// Applies the same validation rules as POST.

export async function PUT(req: NextRequest, { params }: Params) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;

  // Fetch the agent and verify ownership before mutating.
  let existing;
  try {
    existing = await convex().query(api.agent.customAgents.getById, { id });
  } catch (fetchError) {
    console.error('[custom-agents/[id]/PUT] fetch error:', fetchError);
    return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (existing.spaceId !== space.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: {
    name?: unknown;
    description?: unknown;
    systemPrompt?: unknown;
    model?: unknown;
    capabilities?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { name, description, systemPrompt, model, capabilities } = body;

  // Validate fields that are present in the payload.
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
    }
    if (name.trim().length > 100) {
      return NextResponse.json({ error: 'name must be 100 characters or fewer' }, { status: 400 });
    }
  }
  if (description !== undefined && typeof description !== 'string') {
    return NextResponse.json({ error: 'description must be a string' }, { status: 400 });
  }
  if (systemPrompt !== undefined) {
    if (typeof systemPrompt !== 'string' || systemPrompt.trim().length === 0) {
      return NextResponse.json({ error: 'systemPrompt must be a non-empty string' }, { status: 400 });
    }
    if (systemPrompt.trim().length > 10000) {
      return NextResponse.json({ error: 'systemPrompt must be 10,000 characters or fewer' }, { status: 400 });
    }
  }
  if (model !== undefined && typeof model !== 'string') {
    return NextResponse.json({ error: 'model must be a string' }, { status: 400 });
  }
  if (capabilities !== undefined && !Array.isArray(capabilities)) {
    return NextResponse.json({ error: 'capabilities must be an array' }, { status: 400 });
  }

  // Build the update args from validated fields. updatedAt is set inside the
  // mutation. The mutation re-checks (id, spaceId) scope on the write.
  let agent;
  try {
    agent = await convex().mutation(api.agent.customAgents.update, {
      id,
      spaceId: space.id,
      ...(name !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description as string }),
      ...(systemPrompt !== undefined && { systemPrompt: systemPrompt.trim() }),
      ...(model !== undefined && { model: model as string }),
      ...(capabilities !== undefined && { capabilities }),
    });
  } catch (updateError) {
    console.error('[custom-agents/[id]/PUT] update error:', updateError);
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
  }
  if (!agent) {
    // Lost the row between the ownership read and the write.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ agent });
}

// ── DELETE /api/custom-agents/[id] ───────────────────────────────────────────
// Soft-delete a custom agent by setting isActive=false.

export async function DELETE(_req: NextRequest, { params }: Params) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;

  // Fetch the agent and verify ownership before mutating.
  let existing;
  try {
    existing = await convex().query(api.agent.customAgents.getById, { id });
  } catch (fetchError) {
    console.error('[custom-agents/[id]/DELETE] fetch error:', fetchError);
    return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (existing.spaceId !== space.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    await convex().mutation(api.agent.customAgents.deactivate, { id, spaceId: space.id });
  } catch (updateError) {
    console.error('[custom-agents/[id]/DELETE] soft-delete error:', updateError);
    return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
