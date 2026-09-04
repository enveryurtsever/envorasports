/**
 * Customer-facing navigation (§29).
 *
 * Labels come from the `nav` namespace, so English and Turkish stay in step and
 * neither is hard-coded here. Routes deliberately use "predictions", not
 * "coupons" — §28 keeps customer-facing copy out of gambling vocabulary.
 */

export interface NavItem {
  href: string;
  /** Key inside the `nav` namespace. */
  labelKey: string;
}

export const PRIMARY_NAV: NavItem[] = [
  { href: '/', labelKey: 'dashboard' },
  { href: '/predictions', labelKey: 'predictions' },
  { href: '/systems', labelKey: 'systems' },
  { href: '/matches', labelKey: 'matches' },
  { href: '/backtest', labelKey: 'backtest' },
  { href: '/pricing', labelKey: 'pricing' },
];

export const MOBILE_NAV: NavItem[] = [
  { href: '/', labelKey: 'mobile.home' },
  { href: '/predictions', labelKey: 'mobile.predictions' },
  { href: '/systems', labelKey: 'mobile.systems' },
  { href: '/matches', labelKey: 'mobile.matches' },
  { href: '/account', labelKey: 'mobile.account' },
];

export const ADMIN_NAV: NavItem[] = [
  { href: '/admin', labelKey: 'overview' },
  { href: '/admin/settings/coupons', labelKey: 'couponSettings' },
  { href: '/admin/settings/schedule', labelKey: 'scheduleSettings' },
  { href: '/admin/results', labelKey: 'results' },
];
