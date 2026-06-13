/**
 * `find_creators` — read-only search over the creator directory.
 *
 * The seller's agentic edge: instead of the seller browsing, Cola finds
 * creators who promote software in a given niche or on a given channel,
 * ranked by reach, and notes who's already in the program. Pairs with
 * `invite_creator` to actually recruit them.
 */

import { z } from 'zod';
import { defineTool } from '../types';
import { listCreatorsForSeller, channelLabel, formatAudience, CREATOR_CHANNELS } from '@/lib/affiliates/creators';

const CHANNEL_VALUES = CREATOR_CHANNELS.map((c) => c.value) as [string, ...string[]];

const parameters = z
  .object({
    query: z.string().min(1).optional().describe('Free text: niche, name, or keyword (e.g. "dev tools").'),
    channel: z.enum(CHANNEL_VALUES).optional().describe('Limit to creators active on this channel.'),
  })
  .describe('Find listed creators to recruit, by niche/keyword or channel.');

interface CreatorRow {
  name: string;
  email: string;
  niche: string | null;
  audienceSize: number;
  channels: string[];
  joined: boolean;
}

interface FindCreatorsResult {
  creators: CreatorRow[];
}

export const findCreatorsTool = defineTool<typeof parameters, FindCreatorsResult>({
  name: 'find_creators',
  riskLevel: 'safe',
  description:
    'Search the creator directory for affiliates to recruit, filtered by niche/keyword or channel. Returns up to 20 ranked by reach, flagging who already joined your program.',
  parameters,
  requiresApproval: false,

  async handler(args, ctx) {
    const creators = await listCreatorsForSeller(ctx.space.id, {
      q: args.query,
      channel: args.channel,
    });

    if (creators.length === 0) {
      return {
        summary: 'No listed creators matched that. Try a broader niche or another channel.',
        data: { creators: [] },
        display: 'plain',
      };
    }

    const rows: CreatorRow[] = creators.map((c) => ({
      name: c.name,
      email: c.email,
      niche: c.niche,
      audienceSize: c.audienceSize,
      channels: c.channels,
      joined: c.joined,
    }));

    const lines = rows.slice(0, 6).map((c) => {
      const ch = c.channels.length ? ` · ${c.channels.map(channelLabel).join(', ')}` : '';
      const flag = c.joined ? ' (already in program)' : '';
      return `• ${c.name} — ${formatAudience(c.audienceSize)} reach${c.niche ? ` · ${c.niche}` : ''}${ch}${flag}`;
    });
    const more = rows.length > 6 ? `\n…and ${rows.length - 6} more.` : '';

    return {
      summary: `${rows.length} creator${rows.length === 1 ? '' : 's'} found:\n${lines.join('\n')}${more}`,
      data: { creators: rows },
      display: 'plain',
    };
  },
});
