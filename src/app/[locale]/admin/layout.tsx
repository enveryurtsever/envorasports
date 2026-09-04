import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { getViewer } from '@/lib/auth/session';
import { Link } from '@/i18n/navigation';
import { ADMIN_NAV } from '@/components/layout/nav-items';

export const dynamic = 'force-dynamic';

/**
 * Admin gate. Anyone who is not an admin gets a 404 rather than a 403 — the
 * existence of the panel is not something a visitor needs confirmed.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  if (!viewer.isAdmin) notFound();

  const t = await getTranslations('admin');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 pb-4">
        <span className="rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 text-xs font-medium text-gold-light">
          {t('title')}
        </span>
        {ADMIN_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-white/5 hover:text-paper"
          >
            {t(item.labelKey)}
          </Link>
        ))}
      </div>
      {children}
    </div>
  );
}
