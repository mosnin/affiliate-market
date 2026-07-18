'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Upload, Users, Package, FileUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  H3,
  BODY_MUTED,
  CAPTION,
  CARD,
  PRIMARY_PILL,
  GHOST_PILL,
  CHIP_POSITIVE,
  CHIP_NEUTRAL,
  CHIP_NEGATIVE,
} from '@/lib/typography';

type Tab = 'creators' | 'products';

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

const TABS: { value: Tab; label: string; icon: typeof Users }[] = [
  { value: 'creators', label: 'Creators', icon: Users },
  { value: 'products', label: 'Products', icon: Package },
];

const CONFIG: Record<
  Tab,
  {
    endpoint: string;
    columns: string;
    placeholder: string;
    verb: string;
    note: string;
  }
> = {
  creators: {
    endpoint: '/api/affiliates/import',
    columns: 'name,email',
    placeholder: 'name,email\nMaya Chen,maya@example.com\nDev Patel,dev@studio.io',
    verb: 'Import creators',
    note: 'Each creator lands approved, gets a referral link, and receives an invite email. Up to 500 rows. Re-importing the same list is safe — duplicates are skipped.',
  },
  products: {
    endpoint: '/api/products/import',
    columns: 'name,tagline,category,priceCents,pricingModel',
    placeholder:
      'name,tagline,category,priceCents,pricingModel\nLinear,Issue tracking for teams,saas,800,subscription\nRaycast,Launcher for power users,desktop_app,0,one_time',
    verb: 'Import products',
    note: 'Products arrive as drafts so you can review before going live. category is one of saas, devtools, mobile_app, desktop_app, api_service, plugin, other. priceCents is whole cents (800 = $8). pricingModel is one_time or subscription. Up to 200 rows.',
  },
};

export function ImportPanel() {
  const [tab, setTab] = useState<Tab>('creators');
  const [csv, setCsv] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const config = CONFIG[tab];

  function switchTab(next: Tab) {
    if (next === tab) return;
    setTab(next);
    setCsv('');
    setResult(null);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function runImport() {
    if (!csv.trim()) {
      toast.error('Paste a CSV first.');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? 'Import failed.');
        setLoading(false);
        return;
      }
      const r = data as ImportResult;
      setResult(r);
      if (r.imported > 0) {
        toast.success(
          `Imported ${r.imported} ${tab === 'creators' ? 'creator' : 'product'}${r.imported === 1 ? '' : 's'}.`,
        );
      } else {
        toast.error('Nothing imported. Check the rows below.');
      }
    } catch {
      toast.error('Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="space-y-5">
      {/* Segmented tabs */}
      <div className="inline-flex items-center gap-0.5 rounded-xl border border-border bg-card p-1">
        {TABS.map(({ value, label, icon: Icon }) => {
          const active = value === tab;
          return (
            <button
              key={value}
              onClick={() => switchTab(value)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-3 h-8 text-sm transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon size={14} aria-hidden />
              {label}
            </button>
          );
        })}
      </div>

      <div className={cn(CARD, 'p-5 space-y-4')}>
        <div className="space-y-1">
          <h3 className={cn(H3)}>
            {tab === 'creators' ? 'Import your affiliate list' : 'Import your catalog'}
          </h3>
          <p className={cn(BODY_MUTED)}>{config.note}</p>
        </div>

        {/* Column hint */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn(CAPTION)}>Columns</span>
          <code className="rounded-lg bg-muted px-2 py-1 text-xs font-mono text-foreground">
            {config.columns}
          </code>
        </div>

        <textarea
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setResult(null);
          }}
          placeholder={config.placeholder}
          spellCheck={false}
          rows={9}
          className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-mono leading-relaxed outline-none resize-y placeholder:text-muted-foreground/50 focus:ring-2 focus:ring-ring/30"
        />

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <button
              onClick={runImport}
              disabled={loading || !csv.trim()}
              className={cn(PRIMARY_PILL, 'disabled:opacity-50')}
            >
              <Upload size={15} aria-hidden />
              {loading ? 'Importing…' : config.verb}
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={loading}
              className={cn(GHOST_PILL, 'disabled:opacity-50')}
            >
              <FileUp size={15} aria-hidden />
              Upload .csv
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              className="hidden"
            />
          </div>
        </div>

        {/* Result summary */}
        {result && (
          <div className="space-y-3 border-t border-border/60 pt-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={cn(CHIP_POSITIVE)}>{result.imported} imported</span>
              {result.skipped > 0 && (
                <span className={cn(CHIP_NEUTRAL)}>{result.skipped} skipped</span>
              )}
              {result.errors.length > 0 && (
                <span className={cn(CHIP_NEGATIVE)}>{result.errors.length} flagged</span>
              )}
            </div>
            {result.errors.length > 0 && (
              <ul className="space-y-1">
                {result.errors.map((e, i) => (
                  <li key={i} className={cn(CAPTION, 'text-muted-foreground')}>
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
