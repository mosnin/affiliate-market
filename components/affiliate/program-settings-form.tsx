'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  BODY,
  BODY_MUTED,
  SECTION_LABEL,
  PRIMARY_PILL,
  FIELD_RHYTHM,
} from '@/lib/typography';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

interface ProgramSettingsFormProps {
  slug: string;
  initial: {
    name: string;
    commissionType: 'percent' | 'flat';
    commissionValue: number;
    cookieWindowDays: number;
    autoApproveAffiliates: boolean;
    autoApproveCommissions: boolean;
    recurring: boolean;
    recurringMonths: number | null;
  };
}

export function ProgramSettingsForm({ slug, initial }: ProgramSettingsFormProps) {
  const [name, setName] = useState(initial.name);
  const [commissionType, setCommissionType] = useState<'percent' | 'flat'>(initial.commissionType);
  // flat commissionValue stored in cents in DB; show as dollars for flat type
  const [commissionValue, setCommissionValue] = useState(
    initial.commissionType === 'flat'
      ? String(initial.commissionValue / 100)
      : String(initial.commissionValue),
  );
  const [cookieWindowDays, setCookieWindowDays] = useState(String(initial.cookieWindowDays));
  const [autoApproveAffiliates, setAutoApproveAffiliates] = useState(initial.autoApproveAffiliates);
  const [autoApproveCommissions, setAutoApproveCommissions] = useState(initial.autoApproveCommissions);
  const [recurring, setRecurring] = useState(initial.recurring);
  const [recurringMonths, setRecurringMonths] = useState(
    initial.recurringMonths ? String(initial.recurringMonths) : '',
  );
  const [saving, setSaving] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    const numValue = parseFloat(commissionValue);
    const numCookie = parseInt(cookieWindowDays, 10);

    if (isNaN(numValue) || numValue < 0) {
      toast.error('Commission value must be a positive number.');
      setSaving(false);
      return;
    }
    if (isNaN(numCookie) || numCookie < 1 || numCookie > 365) {
      toast.error('Cookie window must be between 1 and 365 days.');
      setSaving(false);
      return;
    }

    // flat: UI shows dollars → send cents; percent: send as-is
    const serverValue = commissionType === 'flat' ? Math.round(numValue * 100) : numValue;

    try {
      const res = await fetch('/api/affiliates/program', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          commissionType,
          commissionValue: serverValue,
          cookieWindowDays: numCookie,
          autoApproveAffiliates,
          autoApproveCommissions,
          recurring,
          recurringMonths: recurring && recurringMonths.trim()
            ? parseInt(recurringMonths, 10)
            : null,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error ?? 'Failed to save settings.');
        return;
      }

      toast.success('Program settings saved.');
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className={cn(FIELD_RHYTHM)}>
      {/* Program name */}
      <div className="space-y-1.5">
        <Label htmlFor="prog-name" className={cn(BODY, 'font-medium')}>
          Program name
        </Label>
        <Input
          id="prog-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Acme Affiliate Program"
          className="max-w-sm"
        />
      </div>

      {/* Commission type */}
      <div className="space-y-1.5">
        <Label className={cn(BODY, 'font-medium')}>Commission type</Label>
        <div className="flex gap-2">
          {(['percent', 'flat'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setCommissionType(t)}
              className={cn(
                'px-3.5 h-9 rounded-lg text-sm font-medium border transition-colors',
                commissionType === t
                  ? 'bg-foreground text-background border-foreground'
                  : 'bg-background text-muted-foreground border-border/60 hover:text-foreground',
              )}
            >
              {t === 'percent' ? 'Percentage (%)' : 'Flat amount ($)'}
            </button>
          ))}
        </div>
      </div>

      {/* Commission value */}
      <div className="space-y-1.5">
        <Label htmlFor="prog-value" className={cn(BODY, 'font-medium')}>
          {commissionType === 'percent' ? 'Commission percentage' : 'Commission amount (dollars)'}
        </Label>
        <div className="flex items-center gap-2 max-w-[200px]">
          <Input
            id="prog-value"
            type="number"
            min="0"
            step={commissionType === 'percent' ? '0.1' : '0.01'}
            max={commissionType === 'percent' ? '100' : undefined}
            value={commissionValue}
            onChange={(e) => setCommissionValue(e.target.value)}
          />
          <span className={cn(BODY_MUTED, 'shrink-0')}>
            {commissionType === 'percent' ? '%' : 'USD'}
          </span>
        </div>
        {commissionType === 'percent' && (
          <p className={cn('text-xs text-muted-foreground')}>
            Percentage of each order value. e.g. 20 = 20%.
          </p>
        )}
        {commissionType === 'flat' && (
          <p className={cn('text-xs text-muted-foreground')}>
            Fixed dollar amount per conversion, regardless of order size.
          </p>
        )}
      </div>

      {/* Cookie window */}
      <div className="space-y-1.5">
        <Label htmlFor="prog-cookie" className={cn(BODY, 'font-medium')}>
          Attribution window (days)
        </Label>
        <div className="flex items-center gap-2 max-w-[200px]">
          <Input
            id="prog-cookie"
            type="number"
            min="1"
            max="365"
            step="1"
            value={cookieWindowDays}
            onChange={(e) => setCookieWindowDays(e.target.value)}
          />
          <span className={cn(BODY_MUTED, 'shrink-0')}>days</span>
        </div>
        <p className="text-xs text-muted-foreground">
          How long after a click a conversion is attributed to the affiliate.
        </p>
      </div>

      {/* Recurring commissions */}
      <div className="space-y-3 pt-1">
        <div className="flex items-center justify-between max-w-sm">
          <div className="space-y-0.5">
            <p className={cn(BODY, 'font-medium')}>Recurring commissions</p>
            <p className="text-xs text-muted-foreground">
              Pay the creator every billing period the customer stays subscribed.
            </p>
          </div>
          <Switch checked={recurring} onCheckedChange={setRecurring} />
        </div>
        {recurring && (
          <div className="space-y-1.5">
            <Label htmlFor="prog-recurring-months" className={cn(BODY, 'font-medium')}>
              For how many months
            </Label>
            <div className="flex items-center gap-2 max-w-[200px]">
              <Input
                id="prog-recurring-months"
                type="number"
                min="1"
                max="120"
                step="1"
                value={recurringMonths}
                onChange={(e) => setRecurringMonths(e.target.value)}
                placeholder="forever"
              />
              <span className={cn(BODY_MUTED, 'shrink-0')}>months</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Leave blank to pay for as long as the subscription lasts.
            </p>
          </div>
        )}
      </div>

      {/* Auto-approve switches */}
      <div className="space-y-3 pt-1">
        <div className="flex items-center justify-between max-w-sm">
          <div className="space-y-0.5">
            <p className={cn(BODY, 'font-medium')}>Auto-approve affiliates</p>
            <p className="text-xs text-muted-foreground">
              Approve affiliate applications automatically on join.
            </p>
          </div>
          <Switch
            checked={autoApproveAffiliates}
            onCheckedChange={setAutoApproveAffiliates}
          />
        </div>
        <div className="flex items-center justify-between max-w-sm">
          <div className="space-y-0.5">
            <p className={cn(BODY, 'font-medium')}>Auto-approve commissions</p>
            <p className="text-xs text-muted-foreground">
              Approve commissions automatically when an order is placed.
            </p>
          </div>
          <Switch
            checked={autoApproveCommissions}
            onCheckedChange={setAutoApproveCommissions}
          />
        </div>
      </div>

      <div className="pt-2">
        <button
          type="submit"
          disabled={saving}
          className={cn(PRIMARY_PILL, 'disabled:opacity-50')}
        >
          {saving ? 'saving…' : 'save settings'}
        </button>
      </div>
    </form>
  );
}
