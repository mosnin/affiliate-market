/**
 * Drafts signal source — surfaces pending AgentDraft rows the autonomous
 * agent has produced (from Gmail triggers, routine runs, calendar event
 * handlers, etc.).
 *
 * Why this is in Phase B and not Phase A: AgentDraft is the OUTPUT of
 * the agent's autonomous work. Surfacing drafts in the brief gives the
 * seller "what Cola did overnight, ready for your approve" — the
 * single highest-value card type for a working seller whose agent
 * actually ran.
 *
 * Why this is its own source (not folded into pipeline/leads): drafts
 * are concrete + actionable — the work is already done, just needs a
 * yes/no — while pipeline/leads signals are abstract ("this deal sat
 * too long"). Different confidence ceilings, different verb.
 *
 * Confidence calibration:
 *   - High-priority draft for hot lead:        0.95
 *   - High-priority draft for any lead tier:   0.90
 *   - Standard draft for hot lead:             0.88
 *   - Standard draft, any tier:                0.83
 *
 * The brief shows the top drafts as REPLY cards; the rest stay in the
 * FocusCard queue on /cola/today. The two surfaces complement: the
 * brief is the morning curated view, the focus card is the working queue.
 */

import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { HOT_LEAD_THRESHOLD } from '@/lib/constants';
import type { Signal, SignalGatherer, SignalKind } from '../types';

type DraftRow = {
  id: string;
  contactId: string | null;
  channel: 'sms' | 'email' | 'note';
  subject: string | null;
  priority: number;
  Contact: { id: string; name: string; leadScore: number | null } | null;
};

const HIGH_PRIORITY_THRESHOLD = 5;

function kindForChannel(channel: DraftRow['channel']): SignalKind {
  switch (channel) {
    case 'sms':
      return 'reply';
    case 'email':
      return 'reply';
    case 'note':
      return 'review';
  }
}

function evidenceFor(channel: DraftRow['channel']): string {
  switch (channel) {
    case 'sms':
      return 'Cola drafted a text. Approve or edit.';
    case 'email':
      return 'Cola drafted an email. Approve or edit.';
    case 'note':
      return 'Cola flagged a note for your review.';
  }
}

export const draftsSource: SignalGatherer = {
  // 'drafts' tag is origin-agnostic — these rows are produced by the
  // autonomous agent regardless of what triggered the run (Gmail webhook,
  // routine cron, calendar handler, manual quick-draft). The brief surface
  // shows the seller "Cola did this overnight, ready for your approve."
  // Provenance per draft lives on AgentDraft.triggerSource for the rare
  // case the surface wants to attribute (Phase C breadcrumbs).
  source: 'drafts',
  async gather(spaceId: string): Promise<Signal[]> {
    // Pending drafts live in Convex; the Contact join (id/name/leadScore) is
    // still a Supabase table, so this source is hybrid: read the drafts from
    // Convex, then stitch the contact rows in to reproduce the old shape.
    let rawDrafts: Array<{
      id: string;
      contactId: string | null;
      channel: 'sms' | 'email' | 'note';
      subject: string | null;
      priority: number;
    }>;
    try {
      rawDrafts = (await convex().query(api.agent.drafts.listBySpaceStatus, {
        spaceId,
        status: 'pending',
        limit: 10,
      })) as typeof rawDrafts;
    } catch {
      return [];
    }

    const contactIds = Array.from(
      new Set(rawDrafts.map((d) => d.contactId).filter((id): id is string => Boolean(id))),
    );
    const contactById = new Map<string, { id: string; name: string; leadScore: number | null }>();
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from('Contact')
        .select('id, name, leadScore')
        .in('id', contactIds);
      for (const c of (contacts ?? []) as Array<{ id: string; name: string; leadScore: number | null }>) {
        contactById.set(c.id, c);
      }
    }

    const data: DraftRow[] = rawDrafts.map((d) => ({
      id: d.id,
      contactId: d.contactId,
      channel: d.channel,
      subject: d.subject,
      priority: d.priority,
      Contact: d.contactId ? contactById.get(d.contactId) ?? null : null,
    }));

    const signals: Signal[] = [];

    for (const draft of data) {
      // Drafts without a contact link don't surface on the brief — they're
      // working state for the agent, not actionable for the seller's
      // morning. They still appear in the FocusCard queue if relevant.
      if (!draft.Contact) continue;

      const isHigh = draft.priority >= HIGH_PRIORITY_THRESHOLD;
      const isHot = (draft.Contact.leadScore ?? 0) >= HOT_LEAD_THRESHOLD;

      const confidence = isHigh
        ? isHot
          ? 0.95
          : 0.9
        : isHot
          ? 0.88
          : 0.83;

      signals.push({
        source: 'drafts',
        kind: kindForChannel(draft.channel),
        urgency: isHigh || isHot ? 1 : 2,
        confidence,
        subject: {
          id: draft.Contact.id,
          name: draft.Contact.name,
          href: `/contacts/${draft.Contact.id}`,
        },
        evidence: evidenceFor(draft.channel),
        // Open the contact page where the draft surfaces in context. The
        // brief intentionally doesn't carry the draft body inline — that's
        // the FocusCard's job, where the seller has the editing UI ready.
        draftedAction: {
          kind: 'open',
          href: `/contacts/${draft.Contact.id}?draftId=${draft.id}`,
        },
      });
    }

    return signals;
  },
};
