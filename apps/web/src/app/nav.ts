import { Building, Building2, LayoutDashboard, Users, type LucideIcon } from 'lucide-react';
import { canManageCompany, type Me } from '@/lib/auth';

export interface NavItem {
  path: string;
  /** i18n key of the label */
  labelKey: string;
  icon: LucideIcon;
  /** Shown only when this returns true (the API enforces access independently). */
  visible?: (me: Me) => boolean;
}

export interface NavSection {
  /** i18n key of the section heading; none for the first section */
  titleKey?: string;
  items: NavItem[];
}

/** Main navigation. Add an entry here when a page is added to the router. */
export const NAV_SECTIONS: NavSection[] = [
  {
    items: [{ path: '/', labelKey: 'nav.dashboard', icon: LayoutDashboard }],
  },
  {
    titleKey: 'nav.settings',
    items: [
      { path: '/settings/company', labelKey: 'nav.company', icon: Building, visible: canManageCompany },
      { path: '/settings/users', labelKey: 'nav.users', icon: Users, visible: canManageCompany },
    ],
  },
  {
    titleKey: 'nav.platform',
    items: [
      { path: '/platform/companies', labelKey: 'nav.companies', icon: Building2, visible: (me) => me.user.isPlatformAdmin },
    ],
  },
];
