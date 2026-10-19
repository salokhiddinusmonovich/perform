import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiError } from '@/lib/api';
import { ME_KEY } from '@/lib/auth';

function createQueryClient() {
  // Any request that finds the session gone (expired, signed out elsewhere) or a
  // temporary password pending refreshes "me"; the shell then redirects as needed.
  const onError = (error: unknown) => {
    if (!(error instanceof ApiError)) return;
    if (error.status === 401) client.setQueryData(ME_KEY, null);
    else if (error.code === 'auth.passwordChangeRequired' || error.code === 'company.required') {
      void client.invalidateQueries({ queryKey: ME_KEY });
    }
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Don't retry "you can't do that" answers; retry once for network hiccups.
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
      },
    },
  });
  return client;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {children}
          <Toaster position="top-center" richColors closeButton />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
