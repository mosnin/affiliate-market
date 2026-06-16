import { ConvexHttpClient } from 'convex/browser';
import { api } from '@/convex/_generated/api';

/**
 * Server-side Convex client. The Next.js server is a trusted caller (the same
 * posture as the old Supabase service-role key), so it talks to Convex over the
 * HTTP client and calls the data functions directly.
 *
 * Lazy + cached, mirroring lib/supabase.ts: constructed on first use so the
 * build succeeds without env. Throws a clear error if NEXT_PUBLIC_CONVEX_URL is
 * missing at call time rather than at import.
 *
 * NOTE (auth): functions are currently public query/mutation, matching the
 * "all access is trusted server-side" model we had with the service role. The
 * Clerk -> Convex identity hardening (internal vs public functions, ctx.auth)
 * is a dedicated migration pass, tracked separately — do not bolt per-call auth
 * into individual domain functions ad hoc.
 */
let _client: ConvexHttpClient | undefined;

export function convex(): ConvexHttpClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error(
      'Missing NEXT_PUBLIC_CONVEX_URL. Set it from your Convex deployment ' +
        '(scripts/convex-local.sh writes it to .env.local for local dev).',
    );
  }
  _client = new ConvexHttpClient(url);
  return _client;
}

export { api };
