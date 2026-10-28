import {
  Building,
  Building2,
  CalendarCheck,
  CalendarDays,
  ClipboardList,
  ClipboardPen,
  Clock,
  Coins,
  CreditCard,
  HardHat,
  LayoutDashboard,
  MapPin,
  Scale,
  Network,
  SunMoon,
  Tags,
  UserCog,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import {
  canEnterMonthlyHours,
  canManageCompany,
  canManageTimesheet,
  canViewPayRules,
  hasTimesheet,
  inCompany,
  isPlatformAdmin,
  seesPay,
  type Me,
} from '@/lib/auth';

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
    titleKey: 'nav.organisation',
    items: [
      { path: '/sites', labelKey: 'nav.sites', icon: MapPin, visible: inCompany },
      { path: '/workers', labelKey: 'nav.workers', icon: HardHat, visible: inCompany },
      { path: '/timesheet', labelKey: 'nav.timesheet', icon: ClipboardList, visible: hasTimesheet },
    ],
  },
  {
    titleKey: 'nav.payroll',
    items: [
      { path: '/monthly-hours', labelKey: 'nav.monthlyHours', icon: Clock, visible: canEnterMonthlyHours },
      { path: '/adjustments', labelKey: 'nav.adjustments', icon: Coins, visible: seesPay },
      { path: '/payroll', labelKey: 'nav.payrollRun', icon: Wallet, visible: seesPay },
    ],
  },
  {
    titleKey: 'nav.settings',
    items: [
      { path: '/settings/company', labelKey: 'nav.company', icon: Building, visible: canManageCompany },
      { path: '/settings/users', labelKey: 'nav.users', icon: Users, visible: canManageCompany },
      { path: '/settings/pay-rules', labelKey: 'nav.payRules', icon: Scale, visible: canViewPayRules },
      { path: '/settings/holidays', labelKey: 'nav.holidays', icon: CalendarDays, visible: canViewPayRules },
      { path: '/settings/working-days', labelKey: 'nav.workingDays', icon: CalendarCheck, visible: canViewPayRules },
      { path: '/settings/timesheet', labelKey: 'nav.timesheetSettings', icon: ClipboardPen, visible: canManageTimesheet },
      { path: '/settings/codes', labelKey: 'nav.codes', icon: Tags, visible: canManageCompany },
      { path: '/settings/shifts', labelKey: 'nav.shifts', icon: SunMoon, visible: canManageCompany },
      { path: '/settings/departments', labelKey: 'nav.departments', icon: Network, visible: canManageCompany },
    ],
  },
  {
    titleKey: 'nav.platform',
    items: [
      { path: '/platform/companies', labelKey: 'nav.companies', icon: Building2, visible: isPlatformAdmin },
      { path: '/platform/users', labelKey: 'nav.platformUsers', icon: UserCog, visible: isPlatformAdmin },
      { path: '/platform/plans', labelKey: 'nav.plans', icon: CreditCard, visible: isPlatformAdmin },
    ],
  },
];
