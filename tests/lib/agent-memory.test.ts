/**
 * Tests for the TS-side AgentMemory module (now Convex-backed).
 *
 * Covers:
 *   - embed() calls OpenAI with text-embedding-3-small
 *   - empty-string input throws (embed, storeMemory, recallMemory)
 *   - storeMemory embeds + inserts via api.swarmvector.agentMemory.insert with
 *     translated entity and a raw number[] embedding
 *   - recallMemory embeds the query + calls the matchAgentMemory ACTION with the
 *     renamed args (spaceId, matchCount, filter fields, minSimilarity) + number[] vec
 *   - results are mapped from the action's row shape to the public MemoryEntry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── OpenAI mock ───────────────────────────────────────────────────────────
const { embeddingsCreateMock } = vi.hoisted(() => ({
  embeddingsCreateMock: vi.fn(),
}));

vi.mock('@/lib/ai-tools/openai-client', () => ({
  AGENT_MODEL: 'gpt-4.1-mini',
  MissingOpenAIKeyError: class extends Error {},
  getOpenAIClient: () => ({
    client: {
      embeddings: { create: embeddingsCreateMock },
    },
  }),
}));

// ── Convex mock ───────────────────────────────────────────────────────────
// storeMemory -> convex().mutation(api.swarmvector.agentMemory.insert, …)
// recallMemory -> convex().action(api.swarmvector.agentMemory.matchAgentMemory, …)
const { mutationMock, actionMock } = vi.hoisted(() => ({
  mutationMock: vi.fn(async (_ref?: unknown, _args?: unknown) => ({ id: 'mem_1' })),
  actionMock: vi.fn(async (_ref?: unknown, _args?: unknown) => [] as unknown),
}));
vi.mock('@/lib/convex-server', () => {
  const makePath = (p: string): unknown =>
    new Proxy(() => p, { get: (_t, k) => (typeof k === 'string' ? makePath(`${p}.${k}`) : p) });
  return {
    api: new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? makePath(k) : undefined) }),
    convex: () => ({ mutation: mutationMock, action: actionMock, query: vi.fn() }),
  };
});

import { embed } from '@/lib/agent-memory/embed';
import { storeMemory, recallMemory } from '@/lib/agent-memory/store';

/** Args object (2nd arg) of the most recent insert mutation / match action. */
function insertArgs(): Record<string, unknown> {
  return mutationMock.mock.calls.at(-1)![1] as Record<string, unknown>;
}
function recallArgs(): Record<string, unknown> {
  return actionMock.mock.calls.at(-1)![1] as Record<string, unknown>;
}

beforeEach(() => {
  embeddingsCreateMock.mockReset();
  mutationMock.mockReset();
  actionMock.mockReset();
  mutationMock.mockResolvedValue({ id: 'mem_1' });
  actionMock.mockResolvedValue([]);
});

function makeVec(): number[] {
  // 1536-dim vector; fill with deterministic values so we can spot-check.
  return Array.from({ length: 1536 }, (_, i) => (i % 7) / 7);
}

function mockEmbedOnce(vec: number[] = makeVec()) {
  embeddingsCreateMock.mockResolvedValueOnce({ data: [{ embedding: vec }] });
}

// ── embed ─────────────────────────────────────────────────────────────────
describe('embed', () => {
  it('calls OpenAI with text-embedding-3-small', async () => {
    mockEmbedOnce();
    await embed('hello world');
    expect(embeddingsCreateMock).toHaveBeenCalledTimes(1);
    const [body] = embeddingsCreateMock.mock.calls[0];
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.input).toBe('hello world');
  });

  it('throws on empty input without calling OpenAI', async () => {
    await expect(embed('')).rejects.toThrow(/empty/);
    await expect(embed('   ')).rejects.toThrow(/empty/);
    expect(embeddingsCreateMock).not.toHaveBeenCalled();
  });

  it('throws when the embedding has the wrong dimension', async () => {
    embeddingsCreateMock.mockResolvedValueOnce({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    await expect(embed('hi')).rejects.toThrow(/dimension/);
  });

  it('truncates input over 8000 chars before sending', async () => {
    mockEmbedOnce();
    const long = 'x'.repeat(9_000);
    await embed(long);
    const [body] = embeddingsCreateMock.mock.calls[0];
    expect((body.input as string).length).toBe(8_000);
  });
});

// ── storeMemory ───────────────────────────────────────────────────────────
describe('storeMemory', () => {
  it('embeds and inserts in a single round trip, mapping contactId → entityType=contact', async () => {
    mockEmbedOnce();
    const result = await storeMemory({
      spaceId: 'space_1',
      contactId: 'c_sam',
      kind: 'fact',
      content: 'Sam wants Berkeley schools',
      importance: 0.8,
    });

    expect(result.id).toBe('mem_1');
    expect(embeddingsCreateMock).toHaveBeenCalledTimes(1);
    expect(mutationMock).toHaveBeenCalledTimes(1);
    const payload = insertArgs();
    expect(payload.spaceId).toBe('space_1');
    expect(payload.entityType).toBe('contact');
    expect(payload.entityId).toBe('c_sam');
    expect(payload.memoryType).toBe('fact');
    expect(payload.content).toBe('Sam wants Berkeley schools');
    expect(payload.importance).toBe(0.8);
    // Embedding is now a raw number[] (v.array(v.float64())), not a pgvector string.
    expect(Array.isArray(payload.embedding)).toBe(true);
    expect((payload.embedding as number[]).length).toBe(1536);
  });

  it('falls back to entityType=space when no contact/deal is provided', async () => {
    mockEmbedOnce();
    await storeMemory({
      spaceId: 'space_1',
      kind: 'observation',
      content: 'workspace prefers SMS over email',
    });
    const payload = insertArgs();
    expect(payload.entityType).toBe('space');
    expect(payload.entityId).toBe('space_1');
  });

  it('prefers contactId over dealId when both are passed', async () => {
    mockEmbedOnce();
    await storeMemory({
      spaceId: 'space_1',
      contactId: 'c_1',
      dealId: 'd_1',
      kind: 'fact',
      content: 'contact-focused fact',
    });
    const payload = insertArgs();
    expect(payload.entityType).toBe('contact');
    expect(payload.entityId).toBe('c_1');
  });

  it('clamps importance into [0, 1]', async () => {
    mockEmbedOnce();
    await storeMemory({ spaceId: 'space_1', kind: 'fact', content: 'x', importance: 9.9 });
    expect(insertArgs().importance).toBe(1);
  });

  it('throws on empty content without embedding', async () => {
    await expect(
      storeMemory({ spaceId: 'space_1', kind: 'fact', content: '   ' }),
    ).rejects.toThrow(/empty/);
    expect(embeddingsCreateMock).not.toHaveBeenCalled();
  });
});

// ── recallMemory ──────────────────────────────────────────────────────────
describe('recallMemory', () => {
  it('embeds the query and calls the matchAgentMemory action', async () => {
    mockEmbedOnce();
    actionMock.mockResolvedValueOnce([
      {
        id: 'm_a',
        content: 'high-similarity match',
        memoryType: 'fact',
        entityType: 'contact',
        entityId: 'c_1',
        importance: 0.7,
        similarity: 0.91,
        createdAt: '2026-04-01T00:00:00.000Z',
      },
      {
        id: 'm_b',
        content: 'lower match',
        memoryType: 'observation',
        entityType: 'contact',
        entityId: 'c_1',
        importance: 0.4,
        similarity: 0.55,
        createdAt: '2026-04-02T00:00:00.000Z',
      },
    ]);

    const out = await recallMemory({ spaceId: 'space_1', query: 'school district' });
    expect(actionMock).toHaveBeenCalledTimes(1);
    const args = recallArgs();
    expect(args.spaceId).toBe('space_1');
    expect(args.matchCount).toBe(6); // default k
    expect(args.filterMemoryType).toBeNull();
    expect(args.filterEntityType).toBeNull();
    expect(args.filterEntityId).toBeNull();
    expect(Array.isArray(args.queryEmbedding)).toBe(true);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 'm_a',
      content: 'high-similarity match',
      kind: 'fact',
      similarity: 0.91,
      importance: 0.7,
      entityType: 'contact',
      entityId: 'c_1',
    });
    expect((out[0].similarity ?? 0)).toBeGreaterThanOrEqual(out[1].similarity ?? 0);
  });

  it('forwards kind / contactId / dealId filters into the action args', async () => {
    mockEmbedOnce();
    actionMock.mockResolvedValueOnce([]);

    await recallMemory({
      spaceId: 'space_1',
      query: 'pre-approval',
      kind: 'fact',
      contactId: 'c_sam',
      k: 3,
      minSimilarity: 0.4,
    });

    const args = recallArgs();
    expect(args.filterMemoryType).toBe('fact');
    expect(args.filterEntityType).toBe('contact');
    expect(args.filterEntityId).toBe('c_sam');
    expect(args.matchCount).toBe(3);
    expect(args.minSimilarity).toBe(0.4);
  });

  it('translates dealId into entityType=deal filter', async () => {
    mockEmbedOnce();
    actionMock.mockResolvedValueOnce([]);

    await recallMemory({ spaceId: 'space_1', query: 'closing', dealId: 'd_42' });
    const args = recallArgs();
    expect(args.filterEntityType).toBe('deal');
    expect(args.filterEntityId).toBe('d_42');
  });

  it('caps k at 50', async () => {
    mockEmbedOnce();
    actionMock.mockResolvedValueOnce([]);
    await recallMemory({ spaceId: 'space_1', query: 'x', k: 999 });
    expect(recallArgs().matchCount).toBe(50);
  });

  it('throws on empty query without embedding or the action', async () => {
    await expect(recallMemory({ spaceId: 'space_1', query: '   ' })).rejects.toThrow(/empty/);
    expect(embeddingsCreateMock).not.toHaveBeenCalled();
    expect(actionMock).not.toHaveBeenCalled();
  });

  it('surfaces action errors as thrown exceptions', async () => {
    mockEmbedOnce();
    actionMock.mockRejectedValueOnce(new Error('function not found'));
    await expect(recallMemory({ spaceId: 'space_1', query: 'x' })).rejects.toThrow(
      /function not found/,
    );
  });
});
