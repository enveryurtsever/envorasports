import { cn } from '@/lib/format/cn';

/**
 * The two surfaces every page is built from (§25). Styling lives here rather
 * than being re-invented per page, so "premium" stays consistent.
 */

export function PremiumCard({
  className,
  children,
  accent = 'none',
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { accent?: 'none' | 'emerald' | 'gold' }) {
  return (
    <div
      className={cn(
        'rounded-[--radius-card] border bg-navy-dark/70 p-5 shadow-lg shadow-black/20 backdrop-blur-sm',
        accent === 'none' && 'border-white/10',
        accent === 'emerald' && 'border-emerald-primary/40',
        // Gold marks Elite/premium states only.
        accent === 'gold' && 'border-gold/40',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  tone = 'default',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'default' | 'emerald' | 'gold' | 'muted';
  className?: string;
}) {
  return (
    <PremiumCard className={cn('flex flex-col gap-1.5 p-4', className)}>
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
      <p
        className={cn(
          'tabular text-2xl leading-none font-semibold',
          tone === 'emerald' && 'text-emerald-bright',
          tone === 'gold' && 'text-gold-light',
          tone === 'muted' && 'text-muted',
        )}
      >
        {value}
      </p>
      {hint ? <p className="text-xs text-muted-dark">{hint}</p> : null}
    </PremiumCard>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <PremiumCard className="border-dashed py-10 text-center">
      <p className="text-sm font-medium text-paper">{title}</p>
      {hint ? <p className="mx-auto mt-2 max-w-md text-sm text-muted">{hint}</p> : null}
    </PremiumCard>
  );
}
