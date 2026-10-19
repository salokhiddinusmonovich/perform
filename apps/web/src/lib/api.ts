/**
 * The only HTTP client for our API. Pages call these through TanStack Query
 * (`useQuery` / `useMutation`), never `fetch` directly.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const body: unknown = isJson ? await response.json() : await response.text();
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
};
