'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A native <dialog> behind a trigger button.
 *
 * Native dialog gives focus trapping, Escape-to-close and inert backdrop for
 * free — reimplementing those in JavaScript is how modals end up unusable with
 * a keyboard. The content is rendered on the server and passed in as children,
 * so opening the modal costs no request.
 */
export function Modal({
  triggerLabel,
  closeLabel,
  title,
  children,
  triggerClassName,
}: {
  triggerLabel: string;
  closeLabel: string;
  title: string;
  children: React.ReactNode;
  triggerClassName?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          triggerClassName ??
          'rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium transition-colors hover:border-emerald-bright hover:text-emerald-bright'
        }
      >
        {triggerLabel}
      </button>

      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          // Clicking the backdrop closes; clicking the panel does not.
          if (event.target === ref.current) setOpen(false);
        }}
        className="w-[min(44rem,92vw)] rounded-[--radius-card] border border-white/15 bg-navy-dark p-0 text-paper backdrop:bg-black/70 backdrop:backdrop-blur-sm"
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md border border-white/15 px-2 py-1 text-xs text-muted transition-colors hover:text-paper"
          >
            {closeLabel}
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
      </dialog>
    </>
  );
}
