'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Bot, Phone, Mail, ArrowRight, Inbox, HelpCircle,
  Target, TrendingUp, AlertTriangle, MessageCircle, ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/formatting';
import { HOT_LEAD_THRESHOLD } from '@/lib/constants';

interface PriorityItem {
  contactId: string;
  name: string;
  reason: string;
  leadScore: number;
  leadType: 'rental' | 'buyer' | null;
  hasEmail: boolean;
  hasPhone: boolean;
}

interface BriefingData {
  priorityItems: PriorityItem[];
  generatedAt: string | null;
  pendingDrafts: number;
  pendingQuestions: number;
  activeGoals: number;
  isLoaded: boolean;
}

export function ColaBriefing({ slug }: { slug: string }) {
  const [data, setData] = useState<BriefingData>({
    priorityItems: [],
    generatedAt: null,
    pendingDrafts: 0,
    pendingQuestions: 0,
    activeGoals: 0,
    isLoaded: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const [priorityRes, draftsRes, questionsRes, goalsRes] = await Promise.all([
          fetch('/api/agent/priority', { signal: controller.signal }),
          fetch('/api/agent/drafts?status=pending&limit=50', { signal: controller.signal }),
          fetch('/api/agent/questions?status=pending&limit=50', { signal: controller.signal }),
          fetch('/api/agent/goals?status=active&limit=1', { signal: controller.signal }),
        ]);

        const priority = priorityRes.ok ? await priorityRes.json() : { items: [], generatedAt: null };
        const drafts = draftsRes.ok ? await draftsRes.json() : [];
        const questions = questionsRes.ok ? await questionsRes.json() : [];
        const goals = goalsRes.ok ? await goalsRes.json() : [];

        setData({
          priorityItems: priority.items ?? [],
          generatedAt: priority.generatedAt ?? null,
          pendingDrafts: Array.isArray(drafts) ? drafts.length : 0,
          pendingQuestions: Array.isArray(questions) ? questions.length : 0,
          activeGoals: Array.isArray(goals) ? goals.length : 0,
          isLoaded: true,
        });
      } catch {
        setData(prev => ({ ...prev, isLoaded: true }));
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  const agentHref = `/s/${slug}/cola`;
  const hasAnything = data.pendingDrafts > 0 || data.pendingQuestions > 0 || data.priorityItems.length > 0;

  if (!data.isLoaded) {
    return (
      <div className="rounded-2xl border border-primary/20 dark:border-primary/40 bg-brand-subtle dark:bg-brand-subtle p-4 sm:p-5 animate-pulse">
        <div className="h-5 bg-brand-subtle/60 dark:bg-brand-subtle rounded w-40 mb-3" />
        <div className="space-y-2">
          {[1,2,3].map(i => <div key={i} className="h-10 bg-brand-subtle dark:bg-brand-subtle rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (!hasAnything && data.isLoaded) {
    return (
      <div className="rounded-2xl border border-border bg-muted/20 p-4 sm:p-5 flex items-center gap-3">
        <div className="w-8 h-8 rounded-xl bg-brand-subtle dark:bg-brand-subtle flex items-center justify-center flex-shrink-0">
          <Bot size={15} className="text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium">You&apos;re ahead of it</p>
          <p className="text-xs text-muted-foreground mt-0.5">Nothing urgent on Cola&apos;s desk &mdash; pipeline looks healthy. I&apos;ll surface anything that needs you.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-primary/20 dark:border-primary/40 bg-gradient-to-br from-brand-subtle to-brand-subtle/40 dark:from-accent/40 dark:to-accent/20 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-5 pt-4 sm:pt-5 pb-3 border-b border-primary/20 dark:border-primary/40">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-brand flex items-center justify-center flex-shrink-0">
            <Bot size={14} className="text-white" />
          </div>
          <div>
            <p className="text-sm font-semibold text-primary dark:text-brand-subtle">From Cola&apos;s desk</p>
            {data.generatedAt && (
              <p className="text-[10px] text-primary/70 dark:text-primary/60">
                Updated {timeAgo(data.generatedAt)}
              </p>
            )}
          </div>
        </div>
        <Link
          href={agentHref}
          className="text-[11px] font-medium text-primary dark:text-primary hover:text-primary flex items-center gap-0.5 flex-shrink-0"
        >
          View all <ChevronRight size={11} />
        </Link>
      </div>

      <div className="p-4 sm:p-5 space-y-4">
        {/* Attention pills */}
        {(data.pendingDrafts > 0 || data.pendingQuestions > 0 || data.activeGoals > 0) && (
          <div className="flex flex-wrap gap-2">
            {data.pendingDrafts > 0 && (
              <Link
                href={agentHref}
                className="inline-flex items-center gap-1.5 bg-brand hover:bg-brand text-white text-xs font-medium px-2.5 py-1 rounded-full transition-colors"
              >
                <Inbox size={11} />
                {data.pendingDrafts} draft{data.pendingDrafts !== 1 ? 's' : ''} to review
              </Link>
            )}
            {data.pendingQuestions > 0 && (
              <Link
                href={agentHref}
                className="inline-flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium px-2.5 py-1 rounded-full transition-colors"
              >
                <HelpCircle size={11} />
                {data.pendingQuestions} question{data.pendingQuestions !== 1 ? 's' : ''}
              </Link>
            )}
            {data.activeGoals > 0 && (
              <span className="inline-flex items-center gap-1.5 bg-white dark:bg-brand-subtle border border-primary/20 dark:border-primary/40 text-primary dark:text-brand-subtle text-xs font-medium px-2.5 py-1 rounded-full">
                <Target size={11} />
                {data.activeGoals} active goal{data.activeGoals !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        )}

        {/* Priority contacts */}
        {data.priorityItems.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold text-primary dark:text-primary uppercase tracking-wide">
              Today's focus
            </p>
            <div className="space-y-1">
              {data.priorityItems.slice(0, 5).map((item) => (
                <Link
                  key={item.contactId}
                  href={`/s/${slug}/contacts/${item.contactId}`}
                  className="flex items-center gap-3 p-2.5 rounded-xl bg-white/60 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-primary/20 dark:border-primary/40 transition-colors group"
                >
                  {/* Avatar */}
                  <div className="w-7 h-7 rounded-full bg-brand-subtle dark:bg-brand-subtle flex items-center justify-center flex-shrink-0 text-[11px] font-bold text-primary dark:text-primary">
                    {item.name.charAt(0).toUpperCase()}
                  </div>

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{item.name}</span>
                      {item.leadScore > 0 && (
                        <span className={cn(
                          'text-[10px] font-semibold px-1 py-0.5 rounded flex-shrink-0',
                          item.leadScore >= HOT_LEAD_THRESHOLD
                            ? 'text-primary dark:text-primary'
                            : 'text-muted-foreground',
                        )}>
                          {item.leadScore}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground truncate">{item.reason}</p>
                  </div>

                  {/* Contact icons */}
                  <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {item.hasPhone && <Phone size={11} className="text-muted-foreground" />}
                    {item.hasEmail && <Mail size={11} className="text-muted-foreground" />}
                    <ChevronRight size={11} className="text-muted-foreground" />
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
