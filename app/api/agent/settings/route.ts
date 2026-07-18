import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';
import { audit } from '@/lib/audit';
import { isValidChatModel } from '@/lib/chat-models';

export async function GET(_req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const data = await convex().query(api.agent.settings.getBySpace, { spaceId: space.id });

  // Default if no row yet (shouldn't happen since we auto-seed, but defensive:
  // never make the UI block on a missing row).
  if (!data) {
    return NextResponse.json({
      spaceId: space.id,
      enabled: false,
      dailyTokenBudget: 50_000,
      chatModel: null,
    });
  }

  return NextResponse.json({
    spaceId: data.spaceId,
    enabled: data.enabled,
    dailyTokenBudget: data.dailyTokenBudget,
    chatModel: data.chatModel,
  });
}

export async function PATCH(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json();
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };

  if (body.enabled !== undefined) {
    patch.enabled = Boolean(body.enabled);
  }
  if (body.dailyTokenBudget !== undefined) {
    const budget = parseInt(String(body.dailyTokenBudget), 10);
    if (Number.isNaN(budget) || budget < 1000 || budget > 500_000) {
      return NextResponse.json(
        { error: 'dailyTokenBudget must be between 1,000 and 500,000' },
        { status: 400 },
      );
    }
    patch.dailyTokenBudget = budget;
  }
  if (body.chatModel !== undefined) {
    // null clears the override — the workspace falls back to the app default.
    if (body.chatModel !== null && !isValidChatModel(body.chatModel)) {
      return NextResponse.json(
        { error: 'chatModel must be a supported model.' },
        { status: 400 },
      );
    }
    patch.chatModel = body.chatModel;
  }

  // Upsert (Convex) — one-row-per-space, read-then-patch-or-insert. Only the
  // provided fields change; chatModel is tri-state (absent=leave, null=clear,
  // string=set), matching the validation above.
  const updated = await convex().mutation(api.agent.settings.upsert, {
    spaceId: space.id,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled as boolean } : {}),
    ...(patch.dailyTokenBudget !== undefined ? { dailyTokenBudget: patch.dailyTokenBudget as number } : {}),
    ...(body.chatModel !== undefined ? { chatModel: body.chatModel as string | null } : {}),
  });

  const data = {
    spaceId: updated.spaceId,
    enabled: updated.enabled,
    dailyTokenBudget: updated.dailyTokenBudget,
    chatModel: updated.chatModel,
  };

  void audit({
    actorClerkId: userId,
    action: 'UPDATE',
    resource: 'AgentSettings',
    resourceId: space.id,
    spaceId: space.id,
    metadata: patch,
  });

  return NextResponse.json(data);
}
