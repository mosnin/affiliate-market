'use client';

/**
 * /affiliate — Public affiliate portal landing page.
 *
 * Pitch + how it works + join form posting to /api/affiliates/join.
 * On success, shows a pending-approval confirmation state.
 */

import { useState } from 'react';
import { Users, Share2, DollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  H1,
  TITLE_FONT,
  BODY_MUTED,
  BODY,
  SECTION_LABEL,
  SECTION_RHYTHM,
} from '@/lib/typography';
import { cn } from '@/lib/utils';

interface FormState {
  name: string;
  email: string;
  code: string;
}

type PageState = 'idle' | 'loading' | 'success' | 'error';

const HOW_IT_WORKS = [
  {
    icon: Users,
    title: 'Join the program',
    description: 'Fill out a quick form. We review applications and approve most within one business day.',
  },
  {
    icon: Share2,
    title: 'Share your link',
    description: 'Get a unique referral link to share with your audience, network, or content.',
  },
  {
    icon: DollarSign,
    title: 'Earn commissions',
    description: 'Earn a commission for every customer who signs up through your link. Paid out regularly.',
  },
];

export default function AffiliateLandingPage() {
  const [form, setForm] = useState<FormState>({ name: '', email: '', code: '' });
  const [pageState, setPageState] = useState<PageState>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim()) return;

    setPageState('loading');
    setErrorMsg('');

    try {
      const body: Record<string, string> = {
        name: form.name.trim(),
        email: form.email.trim(),
      };
      if (form.code.trim()) {
        // code field accepts either a space slug or a referral code
        const trimmed = form.code.trim();
        // Heuristic: slugs are short lowercase words, codes tend to be alphanumeric tokens
        body.spaceSlug = trimmed;
        body.code = trimmed;
      }

      const res = await fetch('/api/affiliates/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMsg(data?.error ?? 'Something went wrong. Please try again.');
        setPageState('error');
        return;
      }

      setPageState('success');
    } catch {
      setErrorMsg('Network error. Please try again.');
      setPageState('error');
    }
  };

  if (pageState === 'success') {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 text-center space-y-4">
        <div className="w-12 h-12 rounded-full bg-foreground/[0.06] flex items-center justify-center mx-auto">
          <DollarSign size={20} strokeWidth={1.75} className="text-foreground" />
        </div>
        <h1 className={cn(H1)} style={TITLE_FONT}>
          Application received.
        </h1>
        <p className={cn(BODY_MUTED)}>
          We&apos;ll review your application and follow up via email. Most applications
          are reviewed within one business day. Once approved you&apos;ll receive your
          unique referral link.
        </p>
        <a
          href="/affiliate/dashboard"
          className="inline-flex items-center gap-1.5 mt-4 text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
        >
          Check your dashboard
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 pb-16 space-y-14">
      {/* Hero */}
      <header className="space-y-3">
        <p className={cn(BODY_MUTED)}>Partners.</p>
        <h1 className={cn(H1)} style={TITLE_FONT}>
          Earn commissions promoting the best software.
        </h1>
        <p className={cn(BODY_MUTED, 'max-w-xl')}>
          Join the Cola affiliate program. Share your link with your audience and
          earn a commission for every customer who signs up through you.
        </p>
      </header>

      {/* How it works */}
      <section className={cn(SECTION_RHYTHM)}>
        <p className={cn(SECTION_LABEL)}>How it works</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
          {HOW_IT_WORKS.map(({ icon: Icon, title, description }, i) => (
            <Card key={i} className="py-5 gap-3">
              <CardHeader className="pb-0">
                <div className="w-8 h-8 rounded-md bg-foreground/[0.04] flex items-center justify-center mb-1">
                  <Icon size={15} strokeWidth={1.75} className="text-muted-foreground" />
                </div>
                <CardTitle className="text-sm font-semibold">{title}</CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription>{description}</CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Join form */}
      <section className={cn(SECTION_RHYTHM)}>
        <p className={cn(SECTION_LABEL)}>Apply to join</p>
        <div className="mt-4 max-w-md">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="aff-name" className="text-sm font-medium text-foreground">
                Full name
              </label>
              <Input
                id="aff-name"
                type="text"
                placeholder="Your name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                required
                autoComplete="name"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="aff-email" className="text-sm font-medium text-foreground">
                Email address
              </label>
              <Input
                id="aff-email"
                type="email"
                placeholder="you@example.com"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                required
                autoComplete="email"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="aff-code" className="text-sm font-medium text-foreground">
                Referral or space code{' '}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                id="aff-code"
                type="text"
                placeholder="e.g. acme or ref-abc123"
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                If someone invited you or you have a company slug, enter it here.
              </p>
            </div>

            {pageState === 'error' && (
              <p className="text-sm text-destructive">{errorMsg}</p>
            )}

            <Button
              type="submit"
              disabled={pageState === 'loading' || !form.name.trim() || !form.email.trim()}
              className="w-full sm:w-auto"
            >
              {pageState === 'loading' ? 'Submitting…' : 'Apply now'}
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}
