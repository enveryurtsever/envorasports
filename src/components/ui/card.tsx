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

export type MetricTone = 'default' | 'emerald' | 'gold' | 'muted' | 'rose' | 'sky' | 'violet';

/**
 * Tone is a readability device, not decoration: it separates the good news from
 * the bad at a glance. The value always carries its own text, so colour is
 * never the only thing carrying the meaning.
 */
const TONE_TEXT: Record<MetricTone, string> = {
  default: 'text-paper',
  emerald: 'text-emerald-bright',
  gold: 'text-gold-light',
  muted: 'text-muted',
  rose: 'text-rose-300',
  sky: 'text-sky-300',
  violet: 'text-violet-300',
};

const TONE_EDGE: Record<MetricTone, string> = {
  default: 'before:bg-white/20',
  emerald: 'before:bg-emerald-bright',
  gold: 'before:bg-gold',
  muted: 'before:bg-white/15',
  rose: 'before:bg-rose-400',
  sky: 'before:bg-sky-400',
  violet: 'before:bg-violet-400',
};

export function MetricCard({
  label,
  value,
  hint,
  tone = 'default',
  icon,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: MetricTone;
  icon?: string;
  className?: string;
}) {
  return (
    <PremiumCard
      className={cn(
        'relative flex flex-col gap-1.5 overflow-hidden p-4',
        'before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[""]',
        TONE_EDGE[tone],
        className,
      )}
    >
      <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
        {icon ? <span aria-hidden>{icon}</span> : null}
        {label}
      </p>
      <p className={cn('tabular text-2xl leading-none font-semibold', TONE_TEXT[tone])}>{value}</p>
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
