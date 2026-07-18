'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Tag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PRIMARY_PILL, GHOST_PILL } from '@/lib/typography';
import { Input } from '@/components/ui/input';

/**
 * Mint a vanity code (CASEY20): memorable, optionally discounting. The
 * discount comes off the buyer's price; you still earn commission on what
 * they pay.
 */
export function VanityCodeButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [discount, setDiscount] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/affiliates/me/vanity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim(),
          discountPercent: discount.trim() ? parseInt(discount, 10) : 0,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? 'Could not create that code.');
        return;
      }
      toast.success(`Code ${data.link.code.toUpperCase()} is live.`);
      setOpen(false);
      setCode('');
      setDiscount('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={cn(GHOST_PILL, 'text-xs')}>
        <Tag size={13} aria-hidden /> New code
      </button>
    );
  }

  return (
    <form onSubmit={create} className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Code</label>
        <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="CASEY20" className="rounded-xl h-9 w-36" autoFocus />
      </div>
      <div className="space-y-1">
        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Discount %</label>
        <Input value={discount} onChange={(e) => setDiscount(e.target.value)} type="number" min="0" max="90" placeholder="0" className="rounded-xl h-9 w-24" />
      </div>
      <button type="submit" disabled={busy || !code.trim()} className={cn(PRIMARY_PILL, 'disabled:opacity-50')}>
        {busy ? 'Creating…' : 'Create'}
      </button>
      <button type="button" onClick={() => setOpen(false)} className={cn(GHOST_PILL, 'text-xs')}>Cancel</button>
    </form>
  );
}
