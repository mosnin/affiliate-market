'use client';

/**
 * ReferralTracker — Cola's first-party click tracker.
 *
 * On mount:
 *  1. Reads ?via= or ?ref= from the URL.
 *  2. If present, sets cola_ref=CODE cookie (path=/, 30 days) and ensures
 *     a cola_vid visitor-ID cookie (randomUUID, 1 year).
 *  3. POSTs /api/track/click once per code per session (sessionStorage guard).
 *
 * Renders null — mount in the marketplace layout so every landing page
 * participates without injecting DOM.
 */

import { useEffect } from 'react';

const REF_COOKIE = 'cola_ref';
const VISITOR_COOKIE = 'cola_vid';
const REF_QUERY_PARAMS = ['via', 'ref'];
const SESSION_KEY_PREFIX = 'cola_click_fired_';

function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; expires=${expires}; SameSite=Lax`;
}

function getCookie(name: string): string | null {
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split('=')[1]) : null;
}

export function ReferralTracker() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    let code: string | null = null;
    for (const param of REF_QUERY_PARAMS) {
      const val = params.get(param);
      if (val) {
        code = val;
        break;
      }
    }
    if (!code) return;

    // Set the referral cookie (30 days).
    setCookie(REF_COOKIE, code, 30);

    // Ensure a stable visitor ID (1 year).
    let visitorId = getCookie(VISITOR_COOKIE);
    if (!visitorId) {
      visitorId = crypto.randomUUID();
      setCookie(VISITOR_COOKIE, visitorId, 365);
    }

    // One POST per code per session.
    const sessionKey = `${SESSION_KEY_PREFIX}${code}`;
    if (sessionStorage.getItem(sessionKey)) return;
    sessionStorage.setItem(sessionKey, '1');

    // Fire-and-forget — tracking failure must never break the page.
    fetch('/api/track/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        landingUrl: window.location.href,
        referrer: document.referrer || null,
        visitorId,
      }),
    }).catch(() => {
      // Non-fatal; remove the session guard so we can retry on next page load.
      sessionStorage.removeItem(sessionKey);
    });
  }, []);

  return null;
}
