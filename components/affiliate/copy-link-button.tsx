'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CopyLinkButtonProps {
  url: string;
}

export function CopyLinkButton({ url }: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // fallback: select + execCommand for older browsers
      const el = document.createElement('textarea');
      el.value = url;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'inline-flex items-center gap-1 px-2 h-7 rounded-lg text-xs font-medium transition-colors',
        copied
          ? 'text-foreground bg-muted'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
      )}
      title="Copy link"
    >
      {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.75} />}
      {copied ? 'copied' : 'copy'}
    </button>
  );
}
