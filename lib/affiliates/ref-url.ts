/**
 * Pure, client-safe URL helper — no server imports, usable in both the
 * browser (outbound links on cached pages) and server code.
 *
 * Carry attribution across domains: append ?via=CODE to an outbound URL
 * (a seller's website, their signup page) so their landing page — and from
 * there their Stripe checkout metadata — can keep crediting the creator.
 */
export function appendRefToUrl(url: string, code: string | null | undefined): string {
  if (!code) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('via')) u.searchParams.set('via', code);
    return u.toString();
  } catch {
    return url;
  }
}
