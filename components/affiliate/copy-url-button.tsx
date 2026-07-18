'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GHOST_PILL } from '@/lib/typography';

interface CopyUrlButtonProps {
  url: string;
  label?: string;
}

export function CopyUrlButton({ url, label = 'copy join link' }: CopyUrlButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const el = document.createElement('textarea');
      el.value = url;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button
      onClick={handleCopy}
      className={cn(GHOST_PILL, 'h-8 px-3 text-xs')}
    >
      {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.75} />}
      {copied ? 'copied' : label}
    </button>
  );
}
