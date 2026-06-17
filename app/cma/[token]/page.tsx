/**
 * /cma/[token] — public competitive pricing analysis report.
 *
 * No Clerk gate. Access is the unguessable shareToken; only a `published`
 * report renders (a draft 404s, so a half-finished analysis never leaks). The
 * report renders the frozen `payload`, so it stays stable even if the seller
 * later edits or deletes the underlying Product rows.
 *
 * This is a competitive pricing analysis (CPA) — replaces the real-estate CMA
 * concept. Shows pricing for comparable software products in the market.
 *
 * NOTE FOR DEPLOY: /cma/(.*) must be in middleware's public routes or
 * Clerk will gate this page.
 */

import { notFound } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { formatCurrency } from '@/lib/formatting';
import type { CmaPayload, CmaComp } from '@/lib/cma';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ token: string }>;
}

interface ReportRow {
  id: string;
  spaceId: string;
  subjectAddress: string;
  title: string | null;
  status: string;
  payload: CmaPayload;
}

function money(n: number | null): string {
  return n == null ? '—' : formatCurrency(n);
}

function ppsf(n: number | null): string {
  return n == null ? '—' : `$${n.toLocaleString('en-US')}`;
}

function facts(c: { beds: number | null; baths: number | null; squareFeet: number | null }): string {
  const parts: string[] = [];
  // beds → seats, baths → plan tier, squareFeet → integrations count
  if (c.beds != null) parts.push(`${c.beds} seats`);
  if (c.baths != null) parts.push(`tier ${c.baths}`);
  if (c.squareFeet != null) parts.push(`${c.squareFeet.toLocaleString('en-US')} integrations`);
  return parts.join(' · ') || '—';
}

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  pending: 'Pending',
  sold: 'Acquired',
  off_market: 'Discontinued',
  owned: 'In catalog',
};

const BASIS_NOTE: Record<CmaPayload['stats']['basis'], string> = {
  sold: 'Based on recent acquisition prices of comparable software products.',
  list: 'Based on current list prices of comparable software products.',
  mixed: 'Based on a mix of acquisition and current list prices.',
  none: 'Not enough priced comparables to compute a range yet.',
};

export default async function CmaPublicPage({ params }: Props) {
  const { token } = await params;

  const row = await convex().query(api.portal.cmaReports.getByShareToken, { shareToken: token });

  if (!row) notFound();
  const report = row as unknown as ReportRow;

  // A draft is private. Only published reports are visible to an outsider.
  if (report.status !== 'published') notFound();

  const { data: spaceRow } = await supabase
    .from('Space')
    .select('name, emoji')
    .eq('id', report.spaceId)
    .maybeSingle();
  const brand = (spaceRow as { name: string; emoji: string | null } | null) ?? null;

  const { subject, comps, stats, generatedAt } = report.payload;

  const subjectLocation = [subject.city, subject.stateRegion].filter(Boolean).join(', ');
  const hasRange = stats.suggestedLow != null && stats.suggestedHigh != null;
  const generated = new Date(generatedAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="min-h-screen bg-background text-foreground print:bg-white">
      <style>{PRINT_CSS}</style>

      <div className="mx-auto max-w-3xl px-5 sm:px-6 py-10 sm:py-14 pb-16 space-y-12">
        {/* ── Brand line ─────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 text-muted-foreground">
          {brand?.emoji && <span aria-hidden className="text-base leading-none">{brand.emoji}</span>}
          <span className="text-[11px] font-medium uppercase tracking-wider">
            {brand?.name ?? 'Comparative market analysis'}
          </span>
        </div>

        {/* ── Header (the one focal block) ───────────────────────────────── */}
        <header className="space-y-1.5">
          <p className="text-sm text-muted-foreground">Competitive pricing analysis.</p>
          <h1
            className="text-3xl tracking-tight text-foreground"
            style={{ fontFamily: 'var(--font-title)' }}
          >
            {report.title?.trim() || subject.address}
          </h1>
          <p className="text-sm text-muted-foreground">
            {report.title?.trim() ? subject.address : subjectLocation || 'Prepared for the seller.'}
          </p>
        </header>

        {/* ── Suggested range — the headline number ──────────────────────── */}
        <section className="rounded-xl border border-border/70 bg-card px-6 py-7 text-center space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Suggested subscription price range
          </p>
          {hasRange ? (
            <p
              className="text-3xl tracking-tight text-foreground tabular-nums"
              style={{ fontFamily: 'var(--font-title)' }}
            >
              {money(stats.suggestedLow)} – {money(stats.suggestedHigh)}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Add priced comparables to compute a range.
            </p>
          )}
          <p className="text-xs text-muted-foreground">{BASIS_NOTE[stats.basis]}</p>
        </section>

        {/* ── The comp-derived stat strip ────────────────────────────────── */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded-xl overflow-hidden border border-border/60 bg-border/60">
          <Stat label="Comparables" value={String(stats.compCount)} />
          <Stat label="Low" value={money(stats.low)} />
          <Stat label="Median" value={money(stats.median)} />
          <Stat label="High" value={money(stats.high)} />
        </section>

        {/* ── Subject product ───────────────────────────────────────────── */}
        <section className="space-y-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Subject software product
          </p>
          <div className="rounded-xl border border-border/70 bg-card px-5 py-4 space-y-1.5">
            <p className="text-[17px] font-semibold text-foreground">{subject.address}</p>
            <p className="text-sm text-muted-foreground">{facts(subject)}</p>
            {subject.listPrice != null && (
              <p className="text-sm text-muted-foreground">
                List price{' '}
                <span className="text-foreground tabular-nums">{money(subject.listPrice)}</span>
              </p>
            )}
          </div>
        </section>

        {/* ── Comparables table ──────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Comparable products
            </p>
            {stats.avgPricePerSqft != null && (
              <p className="text-xs text-muted-foreground">
                Avg{' '}
                <span className="text-foreground tabular-nums">
                  {ppsf(stats.avgPricePerSqft)}
                </span>
                /seat
              </p>
            )}
          </div>

          {comps.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-5 py-10 text-center">
              <p className="text-sm text-foreground">No comparable products on file yet.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Comparable products from market research will appear here.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border/70 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/70 text-left">
                    <Th>Product</Th>
                    <Th className="text-right">Seats / tier</Th>
                    <Th className="text-right">Integrations</Th>
                    <Th className="text-right">Price</Th>
                    <Th className="text-right">$/seat</Th>
                  </tr>
                </thead>
                <tbody>
                  {comps.map((c) => (
                    <CompRow key={c.id} c={c} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer className="border-t border-border/60 pt-6 space-y-2">
          <p className="text-xs text-muted-foreground">
            Prepared {brand?.name ? `by ${brand.name} ` : ''}on {generated}. This analysis is a
            competitive pricing estimate based on comparable software products, not a formal valuation.
          </p>
          <p className="text-[11px] text-muted-foreground print:hidden">
            Tip: use your browser&apos;s print to save this report as a PDF.
          </p>
        </footer>
      </div>
    </div>
  );
}

// ── Leaf components ───────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background px-4 py-4 print:bg-white">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className="text-[25px] leading-tight tracking-tight text-foreground tabular-nums mt-1"
        style={{ fontFamily: 'var(--font-title)' }}
      >
        {value}
      </p>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-3 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground ${className}`}
    >
      {children}
    </th>
  );
}

function CompRow({ c }: { c: CmaComp }) {
  const bedBath =
    c.beds != null || c.baths != null
      ? `${c.beds ?? '—'} / ${c.baths ?? '—'}`
      : '—';
  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="px-3 py-2.5 align-top">
        <span className="text-foreground">{c.address}</span>
        {c.city && <span className="text-muted-foreground"> · {c.city}</span>}
        <span className="ml-2 text-[11px] text-muted-foreground">
          {STATUS_LABEL[c.listingStatus] ?? c.listingStatus}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums align-top">{bedBath}</td>
      <td className="px-3 py-2.5 text-right tabular-nums align-top">
        {c.squareFeet != null ? c.squareFeet.toLocaleString('en-US') : '—'}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums align-top">{money(c.price)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums align-top">{ppsf(c.pricePerSqft)}</td>
    </tr>
  );
}

// Print: drop chrome to white, tighten margins, force colors so the PDF reads
// like printed paper. Scoped to this page via inline <style>.
const PRINT_CSS = `
@media print {
  @page { margin: 16mm; }
  html, body { background: #fff !important; }
  .print\\:hidden { display: none !important; }
}
`;
