'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BODY, BODY_MUTED, SECTION_LABEL, PRIMARY_PILL, META } from '@/lib/typography';
import { Input } from '@/components/ui/input';

interface BridgeState {
  id: string;
  url: string;
  hasSecret: boolean;
  lastEventAt: string | null;
}

/**
 * "Bridge your app's Stripe" — the seller connects their own billing to
 * Cola in two steps: create the endpoint, add it to their Stripe webhooks,
 * paste the signing secret back. After that, every payment in their app
 * (first charge and renewals) earns the referring creator a commission.
 */
export function StripeBridgeCard({ initial }: { initial: BridgeState | null }) {
  const [bridge, setBridge] = useState<BridgeState | null>(initial);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function createEndpoint() {
    setBusy(true);
    try {
      const res = await fetch('/api/affiliates/bridge', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.bridge) {
        toast.error(data.error || "Couldn't create the endpoint. Try again.");
        return;
      }
      setBridge(data.bridge);
    } finally {
      setBusy(false);
    }
  }

  async function saveSecret(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/affiliates/bridge', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookSecret: secret }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Couldn't save the secret.");
        return;
      }
      toast.success('Bridge connected. Payments in your app now pay your creators.');
      setBridge((b) => (b ? { ...b, hasSecret: true } : b));
      setSecret('');
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    if (!bridge) return;
    await navigator.clipboard.writeText(bridge.url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="rounded-2xl border border-border bg-card px-5 py-5 space-y-4 max-w-2xl">
      <div className="space-y-1">
        <p className={cn(SECTION_LABEL)}>
          {bridge?.hasSecret ? 'stripe bridge — connected' : 'bridge your app’s stripe'}
        </p>
        <p className={cn(BODY_MUTED)}>
          Sell through your own app or site? Point a webhook from your Stripe account at Cola
          and creators earn on every payment there too — first charge and every renewal,
          within your recurring window.
        </p>
      </div>

      {!bridge ? (
        <button onClick={createEndpoint} disabled={busy} className={cn(PRIMARY_PILL, 'disabled:opacity-60')}>
          {busy ? 'Creating…' : 'Create bridge endpoint'}
        </button>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className={cn(BODY, 'font-medium')}>1. Add this webhook in your Stripe dashboard</p>
            <div className="flex items-center gap-2">
              <p className="flex-1 min-w-0 text-xs font-mono bg-muted px-3 py-2 rounded-lg truncate">
                {bridge.url}
              </p>
              <button
                onClick={copyUrl}
                className="h-8 w-8 inline-flex items-center justify-center rounded-xl border border-border text-muted-foreground hover:text-foreground transition-colors shrink-0"
                aria-label="Copy webhook URL"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
            <p className={cn(META, 'text-muted-foreground')}>
              Developers → Webhooks → Add endpoint. Select events: <span className="font-mono">invoice.paid</span>,{' '}
              <span className="font-mono">checkout.session.completed</span>,{' '}
              <span className="font-mono">charge.refunded</span>,{' '}
              <span className="font-mono">charge.dispute.created</span>.
            </p>
          </div>

          <form onSubmit={saveSecret} className="space-y-1.5">
            <p className={cn(BODY, 'font-medium')}>
              2. Paste the signing secret {bridge.hasSecret && <span className={cn(META, 'text-muted-foreground')}>(saved — paste again to rotate)</span>}
            </p>
            <div className="flex items-center gap-2 max-w-md">
              <Input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="whsec_…"
                autoComplete="off"
                className="rounded-xl"
              />
              <button
                type="submit"
                disabled={busy || !secret.trim()}
                className={cn(PRIMARY_PILL, 'shrink-0 disabled:opacity-50')}
              >
                Save
              </button>
            </div>
          </form>

          <p className={cn(META, 'text-muted-foreground')}>
            {bridge.lastEventAt
              ? `Last event received ${new Date(bridge.lastEventAt).toLocaleString()}.`
              : 'No events received yet.'}{' '}
            For exact attribution, pass the visitor&apos;s <span className="font-mono">cola_ref</span> cookie
            as <span className="font-mono">metadata.cola_ref</span> in your checkout; otherwise Cola
            matches payments to creators by the customer&apos;s billing email.
          </p>
        </div>
      )}
    </div>
  );
}
