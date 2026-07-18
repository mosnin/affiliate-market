'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BODY, BODY_MUTED, SECTION_LABEL, META } from '@/lib/typography';

/**
 * The zero-code tracking snippet. The seller drops one <script> on their own
 * site; it captures ?via= into a first-party cookie, attributes the click,
 * and exposes window.cola.ref() for their Stripe Checkout metadata. Pairs
 * with the bridge so off-platform sales credit the right creator without the
 * seller writing attribution code.
 */
export function TrackingSnippetCard({ appUrl }: { appUrl: string }) {
  const base = (appUrl || '').replace(/\/$/, '');
  const snippet = `<script async src="${base}/api/track/cola.js"></script>`;
  const checkoutHint = `metadata: { cola_ref: window.cola && window.cola.ref() }`;
  const [copied, setCopied] = useState<'snippet' | 'hint' | null>(null);

  async function copy(text: string, which: 'snippet' | 'hint') {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="rounded-2xl border border-border bg-card px-5 py-5 space-y-4 max-w-2xl">
      <div className="space-y-1">
        <p className={cn(SECTION_LABEL)}>tracking snippet (zero-code)</p>
        <p className={cn(BODY_MUTED)}>
          Drop this on your site to capture referral clicks into a first-party cookie —
          no attribution code to write. Pair it with the bridge above so off-platform
          sales credit the right creator.
        </p>
      </div>

      <div className="space-y-1.5">
        <p className={cn(BODY, 'font-medium')}>1. Add before <span className="font-mono">&lt;/head&gt;</span></p>
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 text-xs font-mono bg-muted px-3 py-2 rounded-lg truncate">{snippet}</code>
          <button
            onClick={() => copy(snippet, 'snippet')}
            className="h-8 w-8 inline-flex items-center justify-center rounded-xl border border-border text-muted-foreground hover:text-foreground transition-colors shrink-0"
            aria-label="Copy snippet"
          >
            {copied === 'snippet' ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className={cn(BODY, 'font-medium')}>2. Pass it into your Stripe Checkout</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 text-xs font-mono bg-muted px-3 py-2 rounded-lg truncate">{checkoutHint}</code>
          <button
            onClick={() => copy(checkoutHint, 'hint')}
            className="h-8 w-8 inline-flex items-center justify-center rounded-xl border border-border text-muted-foreground hover:text-foreground transition-colors shrink-0"
            aria-label="Copy checkout hint"
          >
            {copied === 'hint' ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
        <p className={cn(META, 'text-muted-foreground')}>
          The snippet also auto-fills any <span className="font-mono">&lt;input name=&quot;cola_ref&quot;&gt;</span> on
          your checkout form — so server-rendered forms need no JS changes.
        </p>
      </div>
    </div>
  );
}
