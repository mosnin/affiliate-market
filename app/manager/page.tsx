import { redirect } from 'next/navigation';
import { convex, api } from '@/lib/convex-server';
import { getManagerMemberContext } from '@/lib/permissions';
import { ColaWorkspace } from '@/components/cola/cola-workspace';
import { MemberDashboard } from './member-dashboard';
import type { Conversation } from '@/lib/types';
import type { MessageBlock } from '@/lib/ai-tools/blocks';

/**
 * /manager — the company home.
 *
 * Mirrors the seller home (`/s/[slug]/cola`): the home IS the Cola chat.
 * Owners and admins land on the company chief-of-staff chat
 * (`ColaWorkspace variant="manager"`, backed by /api/ai/manager-task), scoped
 * to the whole company. The team-overview dashboard moved to `/manager/brief`.
 *
 * `seller_member`s are unchanged — they get their own work surface
 * (`MemberDashboard`), never the company chat.
 */

export const dynamic = 'force-dynamic';

export default async function ManagerHomePage({
  searchParams,
}: {
  searchParams: Promise<{ conversationId?: string; prompt?: string; prefill?: string }>;
}) {
  const ctx = await getManagerMemberContext();
  if (!ctx) redirect('/');

  // seller_member sees their own work surface, not the company chat.
  if (ctx.membership.role === 'seller_member') {
    return <MemberDashboard ctx={ctx} />;
  }

  const { conversationId: urlConversationId, prompt: urlPrompt, prefill: urlPrefill } = await searchParams;
  const initialPrefill =
    typeof urlPrompt === 'string' && urlPrompt.trim().length > 0
      ? urlPrompt
      : typeof urlPrefill === 'string' && urlPrefill.trim().length > 0
        ? urlPrefill
        : undefined;

  // Manager conversations + messages live in their OWN tables, keyed by
  // companyId — structurally separate from the seller "Conversation"/
  // "Message" tables. No Space lookup, no title-prefix query.
  const convData = await convex().query(api.conversations.managerConversations.listByCompany, {
    companyId: ctx.company.id,
  });
  // Timestamps arrive as ISO strings (as they did from Supabase); the workspace
  // consumes them as-is, so the cast mirrors the prior `as Conversation[]`.
  const conversations = convData as unknown as Conversation[];

  let initialMessages: { role: 'user' | 'assistant'; content: string; blocks?: MessageBlock[] | null }[] = [];
  let initialConversationId: string | null = null;

  if (urlConversationId) {
    // Verify the requested conversation belongs to THIS company BEFORE
    // loading messages. Without this guard an arbitrary conversationId in the
    // URL (another company's) would render its private history. A seller
    // conversation id simply won't exist in "ManagerConversation".
    const convRow = await convex().query(api.conversations.managerConversations.getById, {
      id: urlConversationId,
    });
    const isThisCompanyConversation = convRow != null && convRow.companyId === ctx.company.id;

    if (isThisCompanyConversation) {
      initialConversationId = urlConversationId;
      const msgData = await convex().query(api.conversations.managerMessages.listForConversation, {
        conversationId: urlConversationId,
        limit: 50,
      });
      initialMessages = msgData.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        blocks: m.blocks as MessageBlock[] | null,
      }));
    }
    // Foreign / seller / unknown conversation id → new-chat state.
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <ColaWorkspace
        slug=""
        variant="manager"
        initialMessages={initialMessages}
        initialConversations={conversations}
        initialConversationId={initialConversationId}
        initialPrefill={initialPrefill}
      />
    </div>
  );
}
