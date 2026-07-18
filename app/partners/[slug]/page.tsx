import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Megaphone, Link2, Banknote } from 'lucide-react';
import { cn } from '@/lib/utils';
import { convex, api } from '@/lib/convex-server';
import { getOrCreateDefaultProgram } from '@/lib/affiliates/programs';
import { PLATFORM_FEE_PERCENT } from '@/lib/affiliates/fees';
import { ProgramJoinForm } from '@/components/affiliate/program-join-form';

export const revalidate = 300;

async function getSeller(slug: string) {
  return await convex().query(api.workspace.spaces.getBySlug, {
    slug: slug.toLowerCase(),
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const seller = await getSeller(slug);
  if (!seller) return { title: 'Program not found — Cola' };
  return {
    title: `Promote ${seller.name} — Cola partners`,
    description: `Earn commission promoting ${seller.name}. Join their affiliate program on Cola.`,
  };
}

function commissionLine(program: { commissionType: string; commissionValue: number; recurring: boolean }): string {
  const base =
    program.commissionType === 'flat'
      ? `${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: program.commissionValue % 100 === 0 ? 0 : 2 }).format(program.commissionValue / 100)} per sale`
      : `${program.commissionValue}% per sale`;
  return program.recurring ? `${base}, recurring` : base;
}

export default async function PublicProgramPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const seller = await getSeller(slug);
  if (!seller) notFound();

  const program = await getOrCreateDefaultProgram(seller.id);

  const steps = [
    { icon: Megaphone, title: 'Join the program', desc: 'Apply in seconds. Most sellers approve fast.' },
    { icon: Link2, title: 'Share your link', desc: `Get a referral link for ${seller.name} and share it with your audience.` },
    { icon: Banknote, title: 'Earn on every sale', desc: 'Net commission paid to your Stripe — already after Cola’s fee.' },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 pb-16 space-y-12">
        {/* Hero */}
        <div className="rounded-[20px] bg-hero text-hero-foreground px-6 py-8 sm:px-8 space-y-3">
          <p className="text-white/70 text-[11px] font-medium uppercase tracking-wider">Partner program</p>
          <h1 className="text-3xl font-semibold tracking-tight text-white">
            Earn {commissionLine(program)} promoting {seller.name}.
          </h1>
          <p className="text-white/80 text-sm max-w-xl">
            You already know how to reach an audience. Point them at software worth using
            and get paid for every customer you bring.
          </p>
        </div>

        {/* How it works */}
        <section className="space-y-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">How it works</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {steps.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="rounded-2xl border border-border bg-card p-5 space-y-3">
                <div className="w-9 h-9 rounded-xl bg-brand-subtle text-primary flex items-center justify-center">
                  <Icon size={16} strokeWidth={1.75} />
                </div>
                <p className="text-[17px] font-semibold text-foreground leading-snug">{title}</p>
                <p className="text-sm text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Join form — pre-bound to this seller */}
        <section className="space-y-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Apply to join</p>
          <div className="max-w-md">
            <ProgramJoinForm spaceSlug={seller.slug} sellerName={seller.name} />
          </div>
          <p className="text-xs text-muted-foreground">
            Commissions are paid net of Cola&apos;s {PLATFORM_FEE_PERCENT}% platform fee.
          </p>
        </section>
      </div>
    </div>
  );
}
