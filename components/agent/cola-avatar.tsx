import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ColaAvatarProps {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  pulse?: boolean;
}

const sizes = {
  xs: { container: 'w-4 h-4', icon: 8, rounded: 'rounded-md' },
  sm: { container: 'w-6 h-6', icon: 12, rounded: 'rounded-lg' },
  md: { container: 'w-8 h-8', icon: 15, rounded: 'rounded-xl' },
  lg: { container: 'w-10 h-10', icon: 18, rounded: 'rounded-xl' },
};

export function ColaAvatar({ size = 'sm', className, pulse = false }: ColaAvatarProps) {
  const s = sizes[size];
  return (
    <div className={cn(
      'relative flex items-center justify-center flex-shrink-0 bg-brand',
      s.container, s.rounded, className,
    )}>
      <Bot size={s.icon} className="text-white" />
      {pulse && (
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-brand border-2 border-background" />
      )}
    </div>
  );
}

interface ColaBadgeProps {
  label?: string;
  className?: string;
}

export function ColaBadge({ label = 'Cola', className }: ColaBadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-[10px] font-semibold text-primary dark:text-primary bg-brand-subtle dark:bg-brand-subtle border border-primary/20 dark:border-primary/40 rounded-full px-1.5 py-0.5',
      className,
    )}>
      <Bot size={8} />
      {label}
    </span>
  );
}
