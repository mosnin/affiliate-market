export function ImportanceDot({ importance }: { importance: number }) {
  if (importance >= 0.7)
    return <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0 mt-1.5" />;
  if (importance >= 0.4)
    return <span className="w-1.5 h-1.5 rounded-full bg-lead-warm shrink-0 mt-1.5" />;
  return <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 shrink-0 mt-1.5" />;
}
