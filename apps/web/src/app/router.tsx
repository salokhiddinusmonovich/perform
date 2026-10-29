import { createBrowserRouter } from 'react-router';
import { LoadingState } from '@/components/loading-state';
import { AppShell } from './app-shell';

// Pages are loaded on demand so each one ships as its own small chunk.
// Add a matching entry to app/nav.ts for pages that belong in the menu.
export const router = createBrowserRouter([
  {
    path: '/login',
    HydrateFallback: LoadingState,
    lazy: async () => ({ Component: (await import('@/pages/login-page')).LoginPage }),
  },
  {
    path: '/change-password',
    HydrateFallback: LoadingState,
    lazy: async () => ({ Component: (await import('@/pages/change-password-page')).ChangePasswordPage }),
  },
  {
    element: <AppShell />,
    HydrateFallback: LoadingState,
    children: [
      {
        index: true,
        lazy: async () => ({ Component: (await import('@/pages/dashboard-page')).DashboardPage }),
      },
      {
        path: 'sites',
        lazy: async () => ({ Component: (await import('@/pages/sites-page')).SitesPage }),
      },
      {
        path: 'sites/:siteId',
        lazy: async () => ({ Component: (await import('@/pages/site-page')).SitePage }),
      },
      {
        path: 'departments',
        lazy: async () => ({ Component: (await import('@/pages/departments-page')).DepartmentsPage }),
      },
      {
        path: 'workers',
        lazy: async () => ({ Component: (await import('@/pages/workers-page')).WorkersPage }),
      },
      {
        path: 'timesheet',
        lazy: async () => ({ Component: (await import('@/pages/timesheet-page')).TimesheetPage }),
      },
      {
        path: 'monthly-hours',
        lazy: async () => ({ Component: (await import('@/pages/monthly-hours-page')).MonthlyHoursPage }),
      },
      {
        path: 'adjustments',
        lazy: async () => ({ Component: (await import('@/pages/adjustments-page')).AdjustmentsPage }),
      },
      {
        path: 'payroll',
        lazy: async () => ({ Component: (await import('@/pages/payroll-page')).PayrollPage }),
      },
      {
        path: 'settings/company',
        lazy: async () => ({ Component: (await import('@/pages/company-settings-page')).CompanySettingsPage }),
      },
      {
        path: 'settings/users',
        lazy: async () => ({ Component: (await import('@/pages/users-page')).UsersPage }),
      },
      {
        path: 'settings/pay-rules',
        lazy: async () => ({ Component: (await import('@/pages/pay-rules-page')).PayRulesPage }),
      },
      {
        path: 'settings/holidays',
        lazy: async () => ({ Component: (await import('@/pages/holidays-page')).HolidaysPage }),
      },
      {
        path: 'settings/working-days',
        lazy: async () => ({ Component: (await import('@/pages/working-days-page')).WorkingDaysPage }),
      },
      {
        path: 'settings/timesheet',
        lazy: async () => ({ Component: (await import('@/pages/timesheet-settings-page')).TimesheetSettingsPage }),
      },
      {
        path: 'settings/codes',
        lazy: async () => ({ Component: (await import('@/pages/timesheet-codes-page')).TimesheetCodesPage }),
      },
      {
        path: 'settings/shifts',
        lazy: async () => ({ Component: (await import('@/pages/shifts-page')).ShiftsPage }),
      },
      {
        path: 'platform/companies',
        lazy: async () => ({
          Component: (await import('@/pages/platform-companies-page')).PlatformCompaniesPage,
        }),
      },
      {
        path: 'platform/users',
        lazy: async () => ({ Component: (await import('@/pages/platform-users-page')).PlatformUsersPage }),
      },
      {
        path: 'platform/plans',
        lazy: async () => ({ Component: (await import('@/pages/platform-plans-page')).PlatformPlansPage }),
      },
      {
        path: '*',
        lazy: async () => ({ Component: (await import('@/pages/not-found-page')).NotFoundPage }),
      },
    ],
  },
]);
