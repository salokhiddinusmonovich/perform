/**
 * The only HTTP client for our API. Pages call these through TanStack Query
 * (`useQuery` / `useMutation`), never `fetch` directly.
 */
export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** Stable error code from the API (translated as `errors.<code>`), if any. */
  get code(): string | undefined {
    const code = (this.body as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
  }

  /** Per-field validation problems (`code === 'validation'`). */
  get issues(): ApiIssue[] {
    const issues = (this.body as { issues?: unknown } | null)?.issues;
    return Array.isArray(issues) ? (issues as ApiIssue[]) : [];
  }

  get retryAfterSeconds(): number | undefined {
    const value = (this.body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
    return typeof value === 'number' ? value : undefined;
  }
}

/** A JSON body, or a form with files (the browser sets its multipart Content-Type). */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const form = body instanceof FormData;
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
    },
    body: form ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const isJson = response.headers.get('content-type')?.includes('application/json');
  // An empty successful body means "nothing" (the API returned null, e.g. /auth/me logged out).
  const data: unknown = text === '' ? null : isJson ? JSON.parse(text) : text;
  if (!response.ok) throw new ApiError(response.status, data);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T = void>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  /** Uploads a form with files (multipart). */
  upload: <T = void>(path: string, form: FormData) => request<T>('POST', path, form),
  patch: <T = void>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T = void>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
};
