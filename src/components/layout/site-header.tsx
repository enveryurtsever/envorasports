import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { LocaleSwitcher } from './locale-switcher';
import { NavLink } from './nav-link';
import { PRIMARY_NAV } from './nav-items';

export async function SiteHeader() {
  const t = await getTranslations('nav');
  const brand = await getTranslations('brand');

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-navy-deep/85 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="h-7 w-7 rounded-lg bg-linear-to-br from-emerald-bright to-emerald-dim shadow-lg shadow-emerald-primary/25"
          />
          <span className="text-[0.95rem] font-semibold tracking-tight">{brand('name')}</span>
        </Link>

        <nav aria-label="Primary" className="hidden flex-1 items-center gap-1 md:flex">
          {PRIMARY_NAV.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:text-paper"
              activeClassName="bg-white/5 text-paper"
            >
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3 md:ml-0">
          <LocaleSwitcher />
          <Link
            href="/account"
            className="hidden rounded-lg border border-white/15 px-3 py-1.5 text-sm text-paper transition-colors hover:border-emerald-bright sm:block"
          >
            {t('account')}
          </Link>
        </div>
      </div>
    </header>
  );
}
