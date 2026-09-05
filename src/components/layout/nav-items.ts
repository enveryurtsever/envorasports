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
  // Every coupon lives here, systems included — a separate systems page just
  // split the same week's slate across two menus.
  { href: '/predictions', labelKey: 'predictions' },
  { href: '/winners', labelKey: 'winners' },
  { href: '/matches', labelKey: 'matches' },
  { href: '/pricing', labelKey: 'pricing' },
];

export const MOBILE_NAV: NavItem[] = [
  { href: '/', labelKey: 'mobile.home' },
  { href: '/predictions', labelKey: 'mobile.predictions' },
  { href: '/winners', labelKey: 'mobile.winners' },
  { href: '/matches', labelKey: 'mobile.matches' },
  { href: '/account', labelKey: 'mobile.account' },
];

export const ADMIN_NAV: NavItem[] = [
  { href: '/admin', labelKey: 'overview' },
  { href: '/admin/coupons', labelKey: 'couponEditor' },
  { href: '/admin/matches', labelKey: 'matchControl' },
  { href: '/admin/settings/coupons', labelKey: 'couponSettings' },
  { href: '/admin/settings/schedule', labelKey: 'scheduleSettings' },
  { href: '/admin/results', labelKey: 'results' },
];
