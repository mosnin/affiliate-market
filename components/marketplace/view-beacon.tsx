'use client';

/**
 * ViewBeacon — records one marketplace product-page view.
 *
 * On mount:
 *  1. Ensures a cola_vid anonymous visitor-ID cookie (randomUUID, 1 year) —
 *     the same cookie the referral tracker uses, so a viewer is one identity
 *     across the marketplace.
 *  2. POSTs /api/track/product-view ONCE per product per session
 *     (sessionStorage guard keyed by productId), so a refresh or a back-and-
 *     forth between the listing and checkout doesn't double-count a view.
 *
 * Renders null. Mount it on the product detail page; tracking failure is
 * non-fatal and silent.
 */

import { useEffect } from 'react';

const VISITOR_COOKIE = 'cola_vid';
const SESSION_KEY_PREFIX = 'cola_view_fired_';

function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; expires=${expires}; SameSite=Lax`;
}

function getCookie(name: string): string | null {
  const match = document.cookie.split('; ').find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split('=')[1]) : null;
}

export function ViewBeacon({ productId }: { productId: string }) {
  useEffect(() => {
    if (typeof window === 'undefined' || !productId) return;

    // One POST per product per session.
    const sessionKey = `${SESSION_KEY_PREFIX}${productId}`;
    if (sessionStorage.getItem(sessionKey)) return;
    sessionStorage.setItem(sessionKey, '1');

    // Ensure a stable visitor ID (1 year). Reuse the referral cookie so the
    // same person is one cola_vid everywhere.
    let visitorId = getCookie(VISITOR_COOKIE);
    if (!visitorId) {
      visitorId = crypto.randomUUID();
      setCookie(VISITOR_COOKIE, visitorId, 365);
    }

    // Fire-and-forget — a tracking miss must never break the page.
    fetch('/api/track/product-view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, visitorId }),
      keepalive: true,
    }).catch(() => {
      // Non-fatal; drop the guard so the next page load can retry.
      sessionStorage.removeItem(sessionKey);
    });
  }, [productId]);

  return null;
}
