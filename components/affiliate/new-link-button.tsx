'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { GHOST_PILL } from '@/lib/typography';

export function NewLinkButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch('/api/affiliates/me/links', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error ?? 'Failed to create link.');
        return;
      }
      toast.success('New referral link created.');
      router.refresh();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={cn(GHOST_PILL, 'h-8 px-3 text-xs disabled:opacity-50')}
    >
      <Plus size={13} strokeWidth={1.75} />
      {loading ? 'creating…' : 'new link'}
    </button>
  );
}
