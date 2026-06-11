/**
 * Composio entity-id namespacing for company-level connections.
 *
 * Composio scopes connections per "entity". The seller flow uses the bare
 * Clerk userId as the entity, which means a seller's personal Gmail and the
 * SAME person's company-level Gmail would collide on one Composio entity if
 * we reused the userId. Namespacing the company entity keeps the two
 * connections distinct, so a manager can connect one inbox personally and a
 * different one at the company level.
 *
 * The shape is `company:<companyId>:<userId>` — deterministic, so the
 * connect route and the callback resolve to the same entity.
 */

const PREFIX = 'company';

export function companyEntityId(args: { companyId: string; userId: string }): string {
  return `${PREFIX}:${args.companyId}:${args.userId}`;
}
