'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { BODY, BODY_MUTED, SECTION_LABEL, PRIMARY_PILL, FIELD_RHYTHM } from '@/lib/typography';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { CREATOR_CHANNELS } from '@/lib/affiliates/creators';

interface Initial {
  name: string;
  bio: string;
  niche: string;
  audienceSize: number;
  channels: string[];
  websiteUrl: string;
  listed: boolean;
}

/** The creator's discovery profile — what sellers see when shopping for distribution. */
export function CreatorProfileForm({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [bio, setBio] = useState(initial.bio);
  const [niche, setNiche] = useState(initial.niche);
  const [audienceSize, setAudienceSize] = useState(initial.audienceSize ? String(initial.audienceSize) : '');
  const [channels, setChannels] = useState<string[]>(initial.channels);
  const [websiteUrl, setWebsiteUrl] = useState(initial.websiteUrl);
  const [listed, setListed] = useState(initial.listed);
  const [saving, setSaving] = useState(false);

  function toggleChannel(value: string) {
    setChannels((cur) => (cur.includes(value) ? cur.filter((c) => c !== value) : [...cur, value]));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/affiliates/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          bio: bio.trim(),
          niche: niche.trim(),
          audienceSize: audienceSize.trim() ? parseInt(audienceSize, 10) : 0,
          channels,
          websiteUrl: websiteUrl.trim(),
          listed,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error ?? 'Could not save your profile.');
        return;
      }
      toast.success('Profile saved.');
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className={cn(FIELD_RHYTHM)}>
      <div className="space-y-1.5">
        <Label htmlFor="cp-name" className={cn(BODY, 'font-medium')}>Name</Label>
        <Input id="cp-name" value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl max-w-sm" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cp-niche" className={cn(BODY, 'font-medium')}>Niche</Label>
        <Input id="cp-niche" value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="e.g. dev tools, design, productivity" className="rounded-xl max-w-sm" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cp-bio" className={cn(BODY, 'font-medium')}>Bio</Label>
        <textarea
          id="cp-bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          rows={3}
          maxLength={600}
          placeholder="What you make and who watches."
          className="w-full max-w-lg rounded-xl border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/40"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cp-audience" className={cn(BODY, 'font-medium')}>Audience size</Label>
        <Input id="cp-audience" type="number" min="0" value={audienceSize} onChange={(e) => setAudienceSize(e.target.value)} placeholder="Total followers / subscribers" className="rounded-xl max-w-[220px]" />
      </div>

      <div className="space-y-2">
        <Label className={cn(BODY, 'font-medium')}>Channels</Label>
        <div className="flex flex-wrap gap-2">
          {CREATOR_CHANNELS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => toggleChannel(c.value)}
              className={cn(
                'px-3 h-8 rounded-xl text-xs font-medium border transition-colors',
                channels.includes(c.value)
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cp-web" className={cn(BODY, 'font-medium')}>Website / main channel URL</Label>
        <Input id="cp-web" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://youtube.com/@you" className="rounded-xl max-w-sm" />
      </div>

      <div className="flex items-center justify-between max-w-sm pt-1">
        <div className="space-y-0.5">
          <p className={cn(BODY, 'font-medium')}>List me in the directory</p>
          <p className="text-xs text-muted-foreground">Let sellers find you and invite you to promote their software.</p>
        </div>
        <Switch checked={listed} onCheckedChange={setListed} />
      </div>

      <div className="pt-2">
        <button type="submit" disabled={saving} className={cn(PRIMARY_PILL, 'disabled:opacity-50')}>
          {saving ? 'Saving…' : 'Save profile'}
        </button>
      </div>
      {!listed && (
        <p className={cn(SECTION_LABEL, 'normal-case tracking-normal text-muted-foreground')}>
          You&apos;re hidden from the directory. Sellers can still approve you when you join their program.
        </p>
      )}
    </form>
  );
}
