import type { TFunction } from 'i18next';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from './api';

/** A translated, user-facing message for any error from a request. */
export function errorMessage(t: TFunction, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'auth.tooManyAttempts' && error.retryAfterSeconds) {
      return t('errors.auth.tooManyAttempts', { minutes: Math.ceil(error.retryAfterSeconds / 60) });
    }
    if (error.code && error.code !== 'validation') {
      const key = `errors.${error.code}`;
      // Details the API sends with the code (e.g. a plan's worker limit) fill the message.
      const text = t(key, error.body as Record<string, unknown>);
      if (text !== key) return text;
    }
  }
  return t('errors.unknown');
}

/**
 * Shows the API's per-field validation errors under the matching form fields.
 * Returns false when the error wasn't a field validation error (show a toast instead).
 */
export function applyFieldErrors<T extends FieldValues>(error: unknown, setError: UseFormSetError<T>): boolean {
  if (!(error instanceof ApiError) || error.code !== 'validation' || error.issues.length === 0) return false;
  const seen = new Set<string>();
  for (const issue of error.issues) {
    const path = issue.path || 'root';
    if (seen.has(path)) continue; // the first problem per field is the most basic one
    seen.add(path);
    setError(path as Path<T>, { type: 'server', message: issue.message });
  }
  return true;
}
