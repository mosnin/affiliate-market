'use client';

import { useState } from 'react';
import { Check, Copy, Megaphone } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MediaKitProps {
  copy: { short: string; tweet: string; long: string };
  images: string[];
}

/**
 * Per-product media kit for creators: copyable promo blurbs (short / tweet /
 * long) and grabbable image URLs. Public — a creator opens the product page,
 * grabs copy + assets, appends their referral link, and posts.
 */
export function MediaKit({ copy, images }: MediaKitProps) {
  const [copied, setCopied] = useState<string | null>(null);

  async function grab(text: string, key: string) {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  const blocks: { key: string; label: string; text: string }[] = [
    { key: 'short', label: 'Short', text: copy.short },
    { key: 'tweet', label: 'Tweet', text: copy.tweet },
    { key: 'long', label: 'Long', text: copy.long },
  ];

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Megaphone size={15} className="text-muted-foreground" aria-hidden />
        <h2 className="text-[17px] font-semibold text-foreground">Media kit</h2>
        <span className="text-[11px] text-muted-foreground">for creators</span>
      </div>

      <div className="space-y-3">
        {blocks.map((b) => (
          <div key={b.key} className="rounded-2xl border border-border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {b.label}
              </span>
              <button
                onClick={() => grab(b.text, b.key)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {copied === b.key ? <Check size={12} /> : <Copy size={12} />}
                {copied === b.key ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-sm text-foreground whitespace-pre-wrap">{b.text}</p>
          </div>
        ))}
      </div>

      {images.length > 0 && (
        <div className="space-y-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Assets</span>
          <div className="flex flex-wrap gap-3">
            {images.map((src, i) => (
              <div key={i} className="space-y-1">
                <div className="w-20 h-20 rounded-xl border border-border bg-muted overflow-hidden flex items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={`asset ${i + 1}`} className="w-full h-full object-contain" loading="lazy" />
                </div>
                <button
                  onClick={() => grab(src, `img-${i}`)}
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {copied === `img-${i}` ? <Check size={11} /> : <Copy size={11} />}
                  {copied === `img-${i}` ? 'Copied' : 'Copy URL'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
