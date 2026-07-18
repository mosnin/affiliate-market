/**
 * AI Enhancement Layer for Cola Lead Scoring
 *
 * Adds qualitative analysis on top of the deterministic engine score.
 * The AI does NOT determine the score — it explains it and recommends actions.
 * If the AI call fails, the deterministic score is still returned in full.
 */

import type OpenAI from 'openai';
import type { ScoringEngineResult } from './engine';
import type { ApplicationData } from '@/lib/types';

export type AIEnhancement = {
  summary: string; // ≤200 chars
  explanationTags: string[];
  recommendedNextAction: string;
  leadState: string;
};

const RENTAL_LEAD_STATES = [
  'high_priority_qualified_renter',  // high-intent software buyer / quote requester
  'qualified_low_urgency',
  'incomplete_application',
  'needs_additional_info',
  'likely_unqualified',
] as const;

const BUYER_LEAD_STATES = [
  'high_priority_qualified_buyer',   // decision-maker, budget confirmed, short timeline
  'qualified_buyer_low_urgency',
  'pre_approved_ready',              // authority confirmed, trial/demo ready
  'incomplete_application',
  'needs_additional_info',
  'likely_unqualified',
] as const;

type LeadType = 'rental' | 'buyer';

async function getScoringLLM(): Promise<{ client: InstanceType<typeof OpenAI>; model: string }> {
  // Lazy-import to keep the heavy OpenAI SDK out of the server bundle
  // for pages that don't use scoring (e.g. /apply/[slug]).
  const { getLLMClient, openaiModel } = await import('@/lib/llm');
  return { client: getLLMClient(), model: openaiModel('gpt-4.1-mini') };
}

export async function enhanceWithAI(
  engineResult: ScoringEngineResult,
  input: { name: string; applicationData: ApplicationData | null; leadType?: LeadType },
): Promise<AIEnhancement | null> {
  try {
    const { client: openai, model } = await getScoringLLM();
    const leadType = input.leadType ?? 'rental';
    const isBuyer = leadType === 'buyer';
    const validStates = isBuyer ? BUYER_LEAD_STATES : RENTAL_LEAD_STATES;

    // Build a compact context from the engine's deterministic analysis
    const categoryBreakdown = engineResult.categories
      .map((c) => `${c.category}: ${Math.round(c.rawScore * 100)}/100 (weight ${Math.round(c.weight * 100)}%) — ${c.signals[0] ?? 'no signal'}`)
      .join('\n');

    // Include lead-type-specific fields in the prompt so the AI can give
    // contextually relevant summaries and action recommendations.
    const leadTypeContext = isBuyer
      ? buildBuyerContext(input.applicationData)
      : buildRentalContext(input.applicationData);

    const prompt = [
      `Lead type: ${leadType.toUpperCase()}`,
      `Deterministic score: ${engineResult.score}/100 (${engineResult.priorityTier})`,
      `Confidence: ${Math.round(engineResult.confidence * 100)}%`,
      '',
      'Category breakdown:',
      categoryBreakdown,
      '',
      engineResult.strengths.length > 0 ? `Strengths: ${engineResult.strengths.join('; ')}` : '',
      engineResult.weaknesses.length > 0 ? `Weaknesses: ${engineResult.weaknesses.join('; ')}` : '',
      engineResult.riskFlags.length > 0 ? `Risk flags: ${engineResult.riskFlags.join('; ')}` : '',
      engineResult.missingInformation.length > 0 ? `Missing: ${engineResult.missingInformation.join('; ')}` : '',
      '',
      `Applicant: ${input.name}`,
      '',
      `Key ${leadType} details:`,
      leadTypeContext,
    ].filter(Boolean).join('\n');

    const systemPrompt = isBuyer
      ? [
          'You summarize pre-computed lead scoring results for a software sales CRM (BUYER / demo-request leads).',
          'You do NOT compute scores. The score is already determined.',
          'Your job: write a concise summary (under 200 chars), 2-4 explanation tags,',
          'a specific recommended next action, and classify the lead state.',
          'Focus on purchase readiness: decision-making authority, budget fit, timeline to start, current tooling.',
          'Be direct and actionable. Tags should be 2-3 words each (e.g., "Decision-maker", "Low budget", "ASAP timeline").',
        ].join(' ')
      : [
          'You summarize pre-computed lead scoring results for a software sales CRM (quote-request / subscription leads).',
          'You do NOT compute scores. The score is already determined.',
          'Your job: write a concise summary (under 200 chars), 2-4 explanation tags,',
          'a specific recommended next action, and classify the lead state.',
          'Focus on subscription readiness: budget-to-cost ratio, role authority, team size, timeline urgency, switching cost.',
          'Be direct and actionable. Tags should be 2-3 words each (e.g., "Strong budget", "Greenfield adoption", "Switching cost risk").',
        ].join(' ');

    const response = await openai.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 300,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'lead_enhancement',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string' },
              explanationTags: { type: 'array', items: { type: 'string' } },
              recommendedNextAction: { type: 'string' },
              leadState: {
                type: 'string',
                enum: [...validStates],
              },
            },
            required: ['summary', 'explanationTags', 'recommendedNextAction', 'leadState'],
          },
        },
      },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    });

    const raw = response.choices?.[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw) as AIEnhancement;

    return {
      summary: (parsed.summary ?? '').slice(0, 200),
      explanationTags: (parsed.explanationTags ?? []).slice(0, 5),
      recommendedNextAction: parsed.recommendedNextAction ?? 'Review application details',
      leadState: (validStates as readonly string[]).includes(parsed.leadState)
        ? parsed.leadState
        : deriveLeadState(engineResult, leadType),
    };
  } catch (error) {
    console.warn('[scoring/enhance] AI enhancement failed, using deterministic fallback', { error });
    return null;
  }
}

/**
 * Build context string with buyer/demo-request-specific fields for the AI prompt.
 */
function buildBuyerContext(app: ApplicationData | null): string {
  if (!app) return 'No application data available.';
  const lines: string[] = [];
  if (app.preApprovalStatus) lines.push(`Decision-making authority: ${app.preApprovalStatus}`);
  if (app.preApprovalLender) lines.push(`Additional stakeholders: ${app.preApprovalLender}`);
  if (app.preApprovalAmount) lines.push(`Confirmed budget: ${app.preApprovalAmount}`);
  if (app.buyerBudget) lines.push(`Monthly budget: ${app.buyerBudget}`);
  if (app.buyerTimeline) lines.push(`Timeline to start: ${app.buyerTimeline}`);
  if (app.housingSituation) lines.push(`Current situation: ${app.housingSituation}`);
  if (app.firstTimeBuyer) lines.push(`First-time buyer of this product type: ${app.firstTimeBuyer}`);
  if (app.productType) lines.push(`Product category interested in: ${app.productType}`);
  if (app.bedrooms) lines.push(`Team size: ${app.bedrooms}`);
  if (app.bathrooms) lines.push(`Current integrations: ${app.bathrooms}`);
  if (app.mustHaves) {
    const items = Array.isArray(app.mustHaves) ? app.mustHaves.join(', ') : app.mustHaves;
    lines.push(`Must-have features: ${items}`);
  }
  if (app.employmentStatus) lines.push(`Role / authority: ${app.employmentStatus}`);
  if (app.monthlyGrossIncome) lines.push(`Annual software budget: ${app.monthlyGrossIncome}`);
  return lines.length > 0 ? lines.join('\n') : 'Minimal application data provided.';
}

/**
 * Build context string with quote-request / subscription-specific fields for the AI prompt.
 */
function buildRentalContext(app: ApplicationData | null): string {
  if (!app) return 'No application data available.';
  const lines: string[] = [];
  if (app.monthlyRent) lines.push(`Monthly budget: ${app.monthlyRent}`);
  if (app.targetMoveInDate) lines.push(`Target start date: ${app.targetMoveInDate}`);
  if (app.employmentStatus) lines.push(`Role / authority: ${app.employmentStatus}`);
  if (app.monthlyGrossIncome) lines.push(`Annual software budget: ${app.monthlyGrossIncome}`);
  if (app.additionalIncome) lines.push(`Additional budget headroom: $${app.additionalIncome}`);
  if (app.creditScore) lines.push(`Engagement score signal: ${app.creditScore}`);
  if (app.currentHousingStatus) lines.push(`Current tooling situation: ${app.currentHousingStatus}`);
  if (app.currentLandlordName) lines.push(`Current vendor / provider: ${app.currentLandlordName}`);
  if (app.latePayments != null) lines.push(`Payment issues on record: ${app.latePayments ? 'yes' : 'no'}`);
  if (app.leaseViolations != null) lines.push(`Contract violations on record: ${app.leaseViolations ? 'yes' : 'no'}`);
  if (app.priorEvictions != null) lines.push(`Replacing existing tooling: ${app.priorEvictions ? 'yes' : 'no'}`);
  if (app.bankruptcy != null) lines.push(`Financial risk flag: ${app.bankruptcy ? 'yes' : 'no'}`);
  if (app.outstandingBalances != null) lines.push(`Outstanding balances: ${app.outstandingBalances ? 'yes' : 'no'}`);
  if (app.hasPets != null) lines.push(`Has existing tooling (switching cost): ${app.hasPets ? `yes${app.petDetails ? ` (${app.petDetails})` : ''}` : 'no'}`);
  if (app.numberOfOccupants) lines.push(`Team size (seats): ${app.numberOfOccupants}`);
  if (app.reasonForMoving) lines.push(`Reason for switching / evaluating: ${app.reasonForMoving}`);
  if (app.lengthOfResidence) lines.push(`Time with current solution: ${app.lengthOfResidence}`);
  return lines.length > 0 ? lines.join('\n') : 'Minimal application data provided.';
}

/**
 * Deterministic fallback for lead state when AI is unavailable
 */
export function deriveLeadState(result: ScoringEngineResult, leadType?: LeadType): string {
  if (result.dataCompleteness < 0.3) return 'incomplete_application';
  if (result.missingInformation.length >= 3) return 'needs_additional_info';

  if (leadType === 'buyer') {
    if (result.priorityTier === 'hot') return 'high_priority_qualified_buyer';
    // Check if pre-approval signal is present in strengths
    const hasPreApproval = result.strengths.some((s) => s.toLowerCase().includes('pre-approved'));
    if (hasPreApproval && result.priorityTier === 'warm') return 'pre_approved_ready';
    if (result.priorityTier === 'warm') return 'qualified_buyer_low_urgency';
    return 'likely_unqualified';
  }

  // Subscription / quote-request (default)
  if (result.priorityTier === 'hot') return 'high_priority_qualified_renter';
  if (result.priorityTier === 'warm') return 'qualified_low_urgency';
  return 'likely_unqualified';
}

/**
 * Deterministic fallback summary when AI is unavailable
 */
export function deriveSummary(result: ScoringEngineResult, name: string): string {
  const tier = result.priorityTier;
  const topStrength = result.strengths[0] ?? '';
  const topWeakness = result.weaknesses[0] ?? '';

  if (tier === 'hot') {
    return `${name} scores ${result.score}/100 — strong lead. ${topStrength}`.slice(0, 200);
  }
  if (tier === 'warm') {
    const qualifier = topWeakness ? ` Note: ${topWeakness}` : '';
    return `${name} scores ${result.score}/100 — moderate lead.${qualifier}`.slice(0, 200);
  }
  if (tier === 'cold') {
    return `${name} scores ${result.score}/100 — low priority. ${topWeakness || 'Needs further review.'}`.slice(0, 200);
  }
  return `${name} scores ${result.score}/100 — likely unqualified. ${topWeakness || 'Multiple risk factors.'}`.slice(0, 200);
}

/**
 * Deterministic fallback for explanation tags
 */
export function deriveExplanationTags(result: ScoringEngineResult): string[] {
  const tags: string[] = [];

  for (const cat of result.categories) {
    if (cat.rawScore >= 0.8) {
      tags.push(`Strong ${formatCategoryName(cat.category)}`);
    } else if (cat.rawScore <= 0.3) {
      tags.push(`Weak ${formatCategoryName(cat.category)}`);
    }
  }

  if (result.riskPenalties.length > 0) tags.push('Risk flags present');
  if (result.dataCompleteness < 0.5) tags.push('Incomplete data');

  return tags.slice(0, 5);
}

function formatCategoryName(category: string): string {
  return category.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
}
