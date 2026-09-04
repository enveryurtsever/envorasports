'use client';

import { useState } from 'react';
import { cn } from '@/lib/format/cn';

/**
 * League table tabs.
 *
 * Every table is rendered on the server and kept in the DOM; the tabs only
 * toggle visibility. That keeps switching instant and means the tables are
 * present for a reader without JavaScript.
 */
export function StandingsTabs({
  labels,
  panels,
}: {
  labels: string[];
  panels: React.ReactNode[];
}) {
  const [active, setActive] = useState(0);

  return (
    <div>
      <div role="tablist" aria-label="League tables" className="mb-3 flex flex-wrap gap-1.5">
        {labels.map((label, index) => (
          <button
            key={label}
            role="tab"
            type="button"
            aria-selected={index === active}
            onClick={() => setActive(index)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              index === active
                ? 'border-emerald-primary/60 bg-emerald-primary/15 text-emerald-bright'
                : 'border-white/10 bg-white/5 text-muted hover:text-paper',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {panels.map((panel, index) => (
        <div key={index} role="tabpanel" hidden={index !== active}>
          {panel}
        </div>
      ))}
    </div>
  );
}
