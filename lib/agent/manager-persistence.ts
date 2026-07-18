/**
 * Message persistence for the manager Cola surface.
 *
 * The manager analogue of `lib/ai-tools/persistence.ts`. Manager conversations
 * and messages live in their OWN tables — "ManagerConversation" / "ManagerMessage"
 * — keyed by `companyId`, NOT by `spaceId`. That keeps company-private chat
 * structurally isolated from the seller "Conversation"/"Message" tables: a
 * seller surface cannot read a manager row because the rows are not even in the
 * same table, never mind the same space.
 *
 * Same content-coalescing + content-derivation rules as the seller helpers so
 * a manager message row reads identically (blocks for the renderer, content as
 * the joined text for legacy readers).
 */

import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { coalesceTextBlocks, type MessageBlock } from '@/lib/ai-tools/blocks';

/** Bump the parent conversation's updatedAt so the sidebar orders by recency. */
async function touchConversation(conversationId: string): Promise<void> {
  try {
    await convex().mutation(api.conversations.managerConversations.touch, { id: conversationId });
  } catch (error) {
    // Non-fatal — the message already saved; ordering is cosmetic.
    logger.warn('[manager-persistence] touch conversation failed', { conversationId }, error);
  }
}

export interface SaveManagerUserMessageInput {
  companyId: string;
  conversationId: string;
  content: string;
}

export async function saveManagerUserMessage(
  input: SaveManagerUserMessageInput,
): Promise<{ messageId: string }> {
  let messageId: string;
  try {
    ({ messageId } = await convex().mutation(api.conversations.managerMessages.saveUserMessage, {
      companyId: input.companyId,
      conversationId: input.conversationId,
      content: input.content,
      // User messages are always plain text — no blocks.
    }));
  } catch (error) {
    logger.error('[manager-persistence] saveManagerUserMessage failed', { companyId: input.companyId }, error);
    throw new Error(
      `Failed to save manager user message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await touchConversation(input.conversationId);
  return { messageId };
}

export interface SaveManagerAssistantMessageInput {
  companyId: string;
  conversationId: string;
  blocks: MessageBlock[];
}

export async function saveManagerAssistantMessage(
  input: SaveManagerAssistantMessageInput,
): Promise<{ messageId: string }> {
  const merged = coalesceTextBlocks(input.blocks);
  const content = merged
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.content)
    .join('\n')
    .trim();

  let messageId: string;
  try {
    ({ messageId } = await convex().mutation(api.conversations.managerMessages.saveAssistantMessage, {
      companyId: input.companyId,
      conversationId: input.conversationId,
      // A pure tool-only turn has no text — store a short placeholder so legacy
      // readers don't render a blank row.
      content: content || '(tool-only turn)',
      blocks: merged as unknown as Record<string, unknown>[],
    }));
  } catch (error) {
    logger.error('[manager-persistence] saveManagerAssistantMessage failed', { companyId: input.companyId }, error);
    throw new Error(
      `Failed to save manager assistant message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await touchConversation(input.conversationId);
  return { messageId };
}
