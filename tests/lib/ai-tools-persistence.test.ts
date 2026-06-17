import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageBlock } from '@/lib/ai-tools/blocks';

// ── Mock Convex ──────────────────────────────────────────────────────────────
// persistence.ts moved off Supabase: saveUserMessage / saveAssistantMessage now
// call convex().mutation(api.conversations.messages.{saveUserMessage,
// saveAssistantMessage}, args). `role` is set INSIDE the Convex mutation, not
// forwarded by the lib — so we branch on the fn path (which mutation ran) for
// the role, and assert the rest on the args object (2nd mutation arg).
//
// We record { path, args } per call; the mock returns a fixed messageId (or
// rejects when a test wants the failure path). The param signature
// (_ref, _args) keeps `.mock.calls[i][1]` typed.

let writes: Array<{ path: string; args: Record<string, unknown> }> = [];
let nextError: Error | null = null;

const { mutationMock } = vi.hoisted(() => ({
  mutationMock: vi.fn(async (_ref?: unknown, _args?: unknown) => null as unknown),
}));

vi.mock('@/lib/convex-server', () => {
  const makePath = (p: string): unknown =>
    new Proxy(() => p, { get: (_t, k) => (typeof k === 'string' ? makePath(`${p}.${k}`) : p) });
  return {
    api: new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? makePath(k) : undefined) }),
    convex: () => ({ mutation: mutationMock, query: vi.fn() }),
  };
});

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { saveAssistantMessage, saveUserMessage } from '@/lib/ai-tools/persistence';

/** The args object (2nd arg) of the first recorded mutation. */
function row(): Record<string, unknown> {
  return writes[0].args;
}
/** The fn path of the first recorded mutation (e.g. ".../saveUserMessage"). */
function path(): string {
  return writes[0].path;
}

beforeEach(() => {
  writes = [];
  nextError = null;
  mutationMock.mockReset();
  mutationMock.mockImplementation(async (ref: unknown, args: unknown) => {
    const p = typeof ref === 'function' ? (ref as () => string)() : '';
    writes.push({ path: p, args: (args ?? {}) as Record<string, unknown> });
    if (nextError) throw nextError;
    return { messageId: '00000000-0000-4000-8000-000000000000' };
  });
});

describe('saveUserMessage', () => {
  it('writes a user message via the saveUserMessage mutation with no blocks', async () => {
    await saveUserMessage({ spaceId: 'space_1', conversationId: 'conv_1', content: 'Hi' });
    expect(writes).toHaveLength(1);
    // role:'user' is set inside the Convex mutation — the lib targets the
    // saveUserMessage fn (the observable equivalent of inserting role=user).
    expect(path()).toMatch(/conversations\.messages\.saveUserMessage$/);
    expect(row()).toMatchObject({
      spaceId: 'space_1',
      conversationId: 'conv_1',
      content: 'Hi',
    });
    // User messages carry no blocks.
    expect(row().blocks).toBeUndefined();
  });

  it('throws with a helpful error when the mutation fails', async () => {
    nextError = new Error('network down');
    await expect(
      saveUserMessage({ spaceId: 's', conversationId: null, content: 'Hi' }),
    ).rejects.toThrow(/network down/);
  });
});

describe('saveAssistantMessage', () => {
  it('coalesces adjacent text blocks before persistence', async () => {
    const blocks: MessageBlock[] = [
      { type: 'text', content: 'Found ' },
      { type: 'text', content: '3 contacts.' },
    ];
    await saveAssistantMessage({ spaceId: 's', conversationId: 'c', blocks });
    expect(path()).toMatch(/conversations\.messages\.saveAssistantMessage$/);
    expect((row().blocks as MessageBlock[])).toHaveLength(1);
    expect((row().blocks as MessageBlock[])[0]).toMatchObject({
      type: 'text',
      content: 'Found 3 contacts.',
    });
  });

  it('derives content as the concatenation of text-block contents', async () => {
    const blocks: MessageBlock[] = [
      { type: 'text', content: 'Searching...' },
      {
        type: 'tool_call',
        callId: 'c1',
        name: 'search_contacts',
        args: {},
        status: 'complete',
      },
      { type: 'text', content: 'Found 3.' },
    ];
    await saveAssistantMessage({ spaceId: 's', conversationId: null, blocks });
    // Concatenated text, tool_call block skipped for content derivation.
    expect(row().content).toMatch(/Searching/);
    expect(row().content).toMatch(/Found 3/);
    // Blocks array persists the tool_call as well.
    expect((row().blocks as MessageBlock[]).some((b) => b.type === 'tool_call')).toBe(true);
  });

  it('falls back to a placeholder content when the turn is tool-only', async () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool_call',
        callId: 'c1',
        name: 'search_contacts',
        args: {},
        status: 'complete',
      },
    ];
    await saveAssistantMessage({ spaceId: 's', conversationId: null, blocks });
    expect(row().content).toBe('(tool-only turn)');
  });

  it('returns the new message id', async () => {
    const { messageId } = await saveAssistantMessage({
      spaceId: 's',
      conversationId: null,
      blocks: [{ type: 'text', content: 'hi' }],
    });
    expect(typeof messageId).toBe('string');
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('throws on a Convex mutation error', async () => {
    nextError = new Error('db offline');
    await expect(
      saveAssistantMessage({ spaceId: 's', conversationId: null, blocks: [{ type: 'text', content: 'hi' }] }),
    ).rejects.toThrow(/db offline/);
  });
});
