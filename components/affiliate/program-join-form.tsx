'use client';

import { useState } from 'react';
import { DollarSign } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BODY_MUTED, PRIMARY_PILL } from '@/lib/typography';
import { Input } from '@/components/ui/input';

/**
 * Join form bound to one seller's program (the public /partners/[slug] page).
 * Posts to the same /api/affiliates/join endpoint the generic portal uses.
 */
export function ProgramJoinForm({ spaceSlug, sellerName }: { spaceSlug: string; sellerName: string }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    setState('loading');
    setError('');
    try {
      const res = await fetch('/api/affiliates/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), spaceSlug }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? 'Something went wrong. Try again.');
        setState('error');
        return;
      }
      setState('success');
    } catch {
      setError('Network error. Try again.');
      setState('error');
    }
  }

  if (state === 'success') {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-center space-y-3">
        <div className="w-12 h-12 rounded-xl bg-brand-subtle text-primary flex items-center justify-center mx-auto">
          <DollarSign size={20} strokeWidth={1.75} />
        </div>
        <p className="text-[17px] font-semibold text-foreground">Application sent.</p>
        <p className={cn(BODY_MUTED)}>
          {sellerName} will review it and email you. Once approved, your referral link is ready in your{' '}
          <a href="/affiliate/dashboard" className="text-primary font-medium hover:underline">dashboard</a>.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="pj-name" className="text-sm font-medium text-foreground">Full name</label>
        <Input id="pj-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" required autoComplete="name" className="rounded-xl" />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="pj-email" className="text-sm font-medium text-foreground">Email</label>
        <Input id="pj-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email" className="rounded-xl" />
      </div>
      {state === 'error' && <p className="text-sm text-negative">{error}</p>}
      <button type="submit" disabled={state === 'loading'} className={cn(PRIMARY_PILL, 'disabled:opacity-60')}>
        {state === 'loading' ? 'Applying…' : `Apply to promote ${sellerName}`}
      </button>
    </form>
  );
}
