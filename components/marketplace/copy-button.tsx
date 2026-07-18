'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available — silently ignore
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label="Copy to clipboard"
      className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
    >
      {copied ? (
        <Check size={14} className="text-positive" aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
    </button>
  );
}
