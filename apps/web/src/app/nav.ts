import { LayoutDashboard, type LucideIcon } from 'lucide-react';

export interface NavItem {
  path: string;
  /** i18n key of the label */
  labelKey: string;
  icon: LucideIcon;
}

/** Main navigation. Add an entry here when a page is added to the router. */
export const NAV_ITEMS: NavItem[] = [{ path: '/', labelKey: 'nav.dashboard', icon: LayoutDashboard }];
