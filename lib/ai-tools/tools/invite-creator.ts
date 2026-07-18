/**
 * `invite_creator` — recruit a creator into the seller's affiliate program.
 *
 * A mutation that creates an approved partner (mints their link) and emails
 * them an invite. Requires approval: it reaches out to a real person on the
 * seller's behalf. Pairs with `find_creators`.
 */

import { z } from 'zod';
import { defineTool } from '../types';
import { createPartner } from '@/lib/affiliates/partners';

const parameters = z
  .object({
    email: z.string().email().describe("The creator's email (from find_creators)."),
    name: z.string().min(1).optional().describe("The creator's name; defaults to their profile name."),
  })
  .describe('Invite a creator into the affiliate program by email.');

interface InviteCreatorResult {
  partnerId: string;
  status: string;
}

export const inviteCreatorTool = defineTool<typeof parameters, InviteCreatorResult>({
  name: 'invite_creator',
  riskLevel: 'high',
  description:
    'Invite a creator into your affiliate program. Creates an approved partner, mints their referral link, and emails them. Use after find_creators.',
  parameters,
  requiresApproval: true,
  rateLimit: { max: 30, windowSeconds: 3600 },

  summariseCall(args) {
    return `Invite ${args?.email ?? 'a creator'} to the affiliate program`;
  },

  async handler(args, ctx) {
    const email = args.email.trim().toLowerCase();
    const name = args.name?.trim() || email.split('@')[0];

    const result = await createPartner({
      spaceId: ctx.space.id,
      name,
      email,
      invitedBySeller: true,
    });

    if (!result) {
      return { summary: `Could not invite ${email}.`, display: 'error' };
    }
    if (!result.created) {
      return {
        summary: `${email} is already in your program (status: ${result.partner.status}).`,
        data: { partnerId: result.partner.id, status: result.partner.status },
        display: 'warning',
      };
    }

    return {
      summary: `Invited ${name} (${email}). Their referral link is live and an invite email is on the way.`,
      data: { partnerId: result.partner.id, status: result.partner.status },
      display: 'success',
    };
  },
});
