'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PRIMARY_PILL, GHOST_PILL } from '@/lib/typography';

/** Invite a directory creator into the seller's program. */
export function InviteCreatorButton({
  email,
  name,
  joined,
}: {
  email: string;
  name: string;
  joined: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'loading' | 'invited'>(joined ? 'invited' : 'idle');

  async function invite() {
    setState('loading');
    try {
      const res = await fetch('/api/affiliates/partners/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? 'Could not send the invite.');
        setState('idle');
        return;
      }
      toast.success(`Invited ${name} to your program.`);
      setState('invited');
      router.refresh();
    } catch {
      toast.error('Something went wrong. Try again.');
      setState('idle');
    }
  }

  if (state === 'invited') {
    return (
      <span className={cn(GHOST_PILL, 'pointer-events-none text-xs')}>
        <Check size={13} aria-hidden /> In program
      </span>
    );
  }

  return (
    <button onClick={invite} disabled={state === 'loading'} className={cn(PRIMARY_PILL, 'text-xs gap-1.5 disabled:opacity-60')}>
      <UserPlus size={13} aria-hidden />
      {state === 'loading' ? 'Inviting…' : 'Invite'}
    </button>
  );
}
