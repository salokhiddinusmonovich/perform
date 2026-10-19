import { createBrowserRouter } from 'react-router';
import { LoadingState } from '@/components/loading-state';
import { AppShell } from './app-shell';

// Pages are loaded on demand so each one ships as its own small chunk.
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    HydrateFallback: LoadingState,
    children: [
      {
        index: true,
        lazy: async () => ({ Component: (await import('@/pages/dashboard-page')).DashboardPage }),
      },
      {
        path: '*',
        lazy: async () => ({ Component: (await import('@/pages/not-found-page')).NotFoundPage }),
      },
    ],
  },
]);
