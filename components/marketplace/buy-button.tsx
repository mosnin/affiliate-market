'use client';

import { useState } from 'react';
import { Loader2, ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';

interface BuyButtonProps {
  productId: string;
  productName: string;
}

export function BuyButton({ productId, productName }: BuyButtonProps) {
  const [stage, setStage] = useState<'idle' | 'email' | 'pending'>('idle');
  const [email, setEmail] = useState('');
  const [coupon, setCoupon] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleBuy(e: React.FormEvent) {
    e.preventDefault();
    if (stage === 'pending') return;
    setStage('pending');
    setError(null);

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, email, couponCode: coupon.trim() || undefined }),
      });
      const data = (await res.json()) as { url?: string; error?: string };

      if (data.error || !data.url) {
        const msg = data.error ?? 'Checkout failed. Please try again.';
        setError(msg);
        toast.error(msg);
        setStage('email');
        return;
      }

      // Redirect to Stripe Checkout or success URL
      window.location.href = data.url;
    } catch {
      const msg = 'Network error. Please try again.';
      setError(msg);
      toast.error(msg);
      setStage('email');
    }
  }

  if (stage === 'idle') {
    return (
      <button
        type="button"
        onClick={() => setStage('email')}
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-foreground px-5 py-3 text-sm font-medium text-background transition-all duration-150 hover:bg-foreground/90 active:scale-[0.98]"
      >
        <ShoppingCart size={15} aria-hidden="true" />
        Buy {productName}
      </button>
    );
  }

  return (
    <form onSubmit={handleBuy} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="buy-email" className="text-xs font-medium text-foreground">
          Your email — we&apos;ll send your license here
        </label>
        <input
          id="buy-email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={stage === 'pending'}
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm placeholder:text-muted-foreground/70 outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="buy-coupon" className="text-xs font-medium text-foreground">
          Discount or creator code <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <input
          id="buy-coupon"
          type="text"
          autoComplete="off"
          placeholder="e.g. CASEY20"
          value={coupon}
          onChange={(e) => setCoupon(e.target.value)}
          disabled={stage === 'pending'}
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm placeholder:text-muted-foreground/70 outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={stage === 'pending'}
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-foreground px-5 py-3 text-sm font-medium text-background transition-all duration-150 hover:bg-foreground/90 active:scale-[0.98] disabled:opacity-50"
      >
        {stage === 'pending' && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
        {stage === 'pending' ? 'Redirecting…' : 'Continue to checkout'}
      </button>
      <button
        type="button"
        onClick={() => { setStage('idle'); setError(null); }}
        disabled={stage === 'pending'}
        className="w-full text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        Cancel
      </button>
    </form>
  );
}
