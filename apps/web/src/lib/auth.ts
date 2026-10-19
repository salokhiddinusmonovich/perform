import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@puantaj/schemas';
import { api } from './api';

export interface Me {
  user: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    locale: string;
    isPlatformAdmin: boolean;
    mustChangePassword: boolean;
  };
  activeCompany: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
    role: Role;
    siteId: string | null;
  } | null;
  companies: { id: string; name: string; role: Role }[];
}

export const ME_KEY = ['auth', 'me'] as const;

/** The logged-in user, or null when not logged in (the API answers null, not 401). */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => api.get<Me | null>('/auth/me'),
    staleTime: 5 * 60_000,
  });
}

/** After login, logout or switching company: forget all cached data and reload "me". */
export function useResetSession() {
  const queryClient = useQueryClient();
  return async () => {
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
  };
}

/** Can manage the active company's settings and users. */
export function canManageCompany(me: Me | null | undefined): boolean {
  return me?.activeCompany?.role === 'OWNER' || me?.activeCompany?.role === 'ADMIN';
}
