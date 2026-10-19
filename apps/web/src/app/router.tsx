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
        path: 'settings/company',
        lazy: async () => ({ Component: (await import('@/pages/company-settings-page')).CompanySettingsPage }),
      },
      {
        path: 'settings/users',
        lazy: async () => ({ Component: (await import('@/pages/users-page')).UsersPage }),
      },
      {
        path: 'platform/companies',
        lazy: async () => ({
          Component: (await import('@/pages/platform-companies-page')).PlatformCompaniesPage,
        }),
      },
      {
        path: '*',
        lazy: async () => ({ Component: (await import('@/pages/not-found-page')).NotFoundPage }),
      },
    ],
  },
]);
