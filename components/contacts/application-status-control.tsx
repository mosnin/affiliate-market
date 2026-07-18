'use client';

import { useState } from 'react';
import { Loader2, CheckCircle2, Inbox, Search, AlertCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRouter } from 'next/navigation';

interface ApplicationStatusControlProps {
  contactId: string;
  currentStatus: string;
  statusNote: string | null;
}

const STATUSES = [
  { key: 'received', label: 'Received', icon: Inbox, color: 'bg-brand-subtle text-primary dark:bg-blue-900/30 dark:text-blue-300' },
  { key: 'under_review', label: 'Under Review', icon: Search, color: 'bg-muted text-muted-foreground dark:bg-muted dark:text-muted-foreground' },
  { key: 'approved', label: 'Approved', icon: CheckCircle2, color: 'bg-positive-subtle text-positive dark:bg-positive-subtle dark:text-positive' },
  { key: 'needs_info', label: 'Needs Info', icon: AlertCircle, color: 'bg-brand-subtle text-primary dark:bg-brand-subtle dark:text-brand-subtle' },
  { key: 'declined', label: 'Declined', icon: XCircle, color: 'bg-negative-subtle text-negative dark:bg-red-900/30 dark:text-red-300' },
];

export function ApplicationStatusControl({ contactId, currentStatus, statusNote }: ApplicationStatusControlProps) {
  const [status, setStatus] = useState(currentStatus);
  const [updating, setUpdating] = useState(false);
  const router = useRouter();

  async function updateStatus(newStatus: string) {
    if (newStatus === status || updating) return;
    setUpdating(true);
    try {
      const res = await fetch('/api/applications/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, status: newStatus }),
      });
      if (res.ok) {
        setStatus(newStatus);
        router.refresh();
      }
    } catch (err) {
      console.error('[status] Update failed:', err);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Application Status</p>
      <div className="flex flex-wrap gap-1.5">
        {STATUSES.map((s) => {
          const Icon = s.icon;
          const isActive = s.key === status;
          return (
            <button
              key={s.key}
              onClick={() => updateStatus(s.key)}
              disabled={updating}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
                isActive
                  ? `${s.color} border-current/20 ring-1 ring-current/20`
                  : 'border-border text-muted-foreground hover:bg-muted',
                updating && 'opacity-50'
              )}
            >
              {updating && isActive ? <Loader2 size={11} className="animate-spin" /> : <Icon size={11} />}
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
