import { getTranslations } from 'next-intl/server';
import { cn } from '@/lib/format/cn';

/**
 * Result badges (§35). Status is carried by text plus shape, never by colour
 * alone — the colour is reinforcement, not the message.
 */
const TONE: Record<string, string> = {
  WON: 'border-emerald-primary/50 bg-emerald-primary/15 text-emerald-bright',
  HALF_WON: 'border-emerald-primary/40 bg-emerald-primary/10 text-emerald-bright',
  PARTIAL_WIN: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  LOST: 'border-rose-500/50 bg-rose-500/10 text-rose-300',
  HALF_LOST: 'border-rose-500/40 bg-rose-500/5 text-rose-300',
  PENDING: 'border-white/15 bg-white/5 text-muted',
  VOID: 'border-white/15 bg-white/5 text-muted',
  PUSHED: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  CANCELED: 'border-white/15 bg-white/5 text-muted',
};

const GLYPH: Record<string, string> = {
  WON: '✓',
  HALF_WON: '✓',
  PARTIAL_WIN: '◐',
  LOST: '✕',
  HALF_LOST: '✕',
  PENDING: '•',
  VOID: '—',
  PUSHED: '=',
  CANCELED: '—',
};

export async function ResultBadge({ status, className }: { status: string; className?: string }) {
  const t = await getTranslations('status');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        TONE[status] ?? TONE.PENDING,
        className,
      )}
    >
      <span aria-hidden>{GLYPH[status] ?? '•'}</span>
      {t(status)}
    </span>
  );
}
