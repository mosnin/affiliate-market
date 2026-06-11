/**
 * Unit tests for the seller / manager conversation isolation predicates.
 *
 * These are pure functions with no I/O, so the surface to cover is the
 * boundary itself: which conversations a seller surface may serve and which
 * it must refuse. If someone weakens `isSellerConversation` (drops the
 * spaceId check, drops a prefix), these assertions fail.
 */

import { describe, it, expect } from 'vitest';
import {
  MANAGER_TITLE_PREFIX,
  TEAM_TITLE_PREFIX,
  RESERVED_TITLE_PREFIXES,
  RESERVED_TITLE_LIKE_PATTERNS,
  isReservedConversationTitle,
  isSellerConversation,
} from '@/lib/chat/conversation-access';

const SPACE = 'space_seller_1';
const OTHER_SPACE = 'space_seller_2';

describe('reserved title constants', () => {
  it('pins the exact manager and team prefixes the manager side writes', () => {
    expect(MANAGER_TITLE_PREFIX).toBe('[MANAGER_COLA]');
    expect(TEAM_TITLE_PREFIX).toBe('[COMPANY_CHAT]');
    expect(RESERVED_TITLE_PREFIXES).toEqual(['[MANAGER_COLA]', '[COMPANY_CHAT]']);
  });

  it('derives SQL LIKE patterns from the prefixes', () => {
    expect(RESERVED_TITLE_LIKE_PATTERNS).toEqual(['[MANAGER_COLA]%', '[COMPANY_CHAT]%']);
  });
});

describe('isReservedConversationTitle', () => {
  it('flags manager-prefixed titles', () => {
    expect(isReservedConversationTitle('[MANAGER_COLA] my notes')).toBe(true);
    expect(isReservedConversationTitle('[MANAGER_COLA]')).toBe(true);
  });

  it('flags team-prefixed titles', () => {
    expect(isReservedConversationTitle('[COMPANY_CHAT] standup')).toBe(true);
    expect(isReservedConversationTitle('[COMPANY_CHAT]')).toBe(true);
  });

  it('passes plain seller titles', () => {
    expect(isReservedConversationTitle('Follow up with the Garcias')).toBe(false);
    expect(isReservedConversationTitle('New conversation')).toBe(false);
  });

  it('only matches at the START of the title, never mid-string', () => {
    // A seller could legitimately type the literal text later in a title.
    // Only a leading prefix is reserved.
    expect(isReservedConversationTitle('re: [MANAGER_COLA] question')).toBe(false);
    expect(isReservedConversationTitle('about [COMPANY_CHAT]')).toBe(false);
  });

  it('treats null / undefined / empty as not reserved', () => {
    expect(isReservedConversationTitle(null)).toBe(false);
    expect(isReservedConversationTitle(undefined)).toBe(false);
    expect(isReservedConversationTitle('')).toBe(false);
  });
});

describe('isSellerConversation', () => {
  it('passes a seller-owned conversation in the right space', () => {
    expect(
      isSellerConversation({ spaceId: SPACE, title: 'Follow up with the Garcias' }, SPACE),
    ).toBe(true);
  });

  it('fails when the conversation belongs to a DIFFERENT space', () => {
    // Wrong space is a cross-tenant attempt even with an innocent title.
    expect(
      isSellerConversation({ spaceId: OTHER_SPACE, title: 'Follow up' }, SPACE),
    ).toBe(false);
  });

  it('fails a manager-prefixed conversation even when the space matches', () => {
    // The manager_owner owns this seller space too, so spaceId matches.
    // The prefix is the only thing standing between the seller and the
    // manager's private Cola history.
    expect(
      isSellerConversation({ spaceId: SPACE, title: '[MANAGER_COLA] private' }, SPACE),
    ).toBe(false);
  });

  it('fails a team-prefixed conversation even when the space matches', () => {
    expect(
      isSellerConversation({ spaceId: SPACE, title: '[COMPANY_CHAT] team room' }, SPACE),
    ).toBe(false);
  });

  it('fails a manager-prefixed conversation in a foreign space (both gates trip)', () => {
    expect(
      isSellerConversation({ spaceId: OTHER_SPACE, title: '[MANAGER_COLA] x' }, SPACE),
    ).toBe(false);
  });

  it('fails null / undefined (no conversation row)', () => {
    expect(isSellerConversation(null, SPACE)).toBe(false);
    expect(isSellerConversation(undefined, SPACE)).toBe(false);
  });
});
