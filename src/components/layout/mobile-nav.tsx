import { getTranslations } from 'next-intl/server';
import { NavLink } from './nav-link';
import { MOBILE_NAV } from './nav-items';

/** Bottom tab bar; the product is mobile-first (§49). */
export async function MobileNav() {
  const t = await getTranslations('nav');

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-navy-deep/95 backdrop-blur md:hidden"
    >
      <ul className="mx-auto grid max-w-6xl grid-cols-5">
        {MOBILE_NAV.map((item) => (
          <li key={item.href}>
            <NavLink
              href={item.href}
              className="flex flex-col items-center gap-1 px-1 py-3 text-[0.68rem] text-muted transition-colors"
              activeClassName="text-emerald-bright"
            >
              {t(item.labelKey)}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
