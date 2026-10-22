import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Every API error carries a stable `code` that the web app translates
 * (`errors.<code>` in its i18n files). Never send user-facing text from the API.
 */
export class ApiError extends HttpException {
  constructor(status: HttpStatus, code: string, details?: Record<string, unknown>) {
    super({ code, ...details }, status);
  }
}

export const badRequest = (code: string, details?: Record<string, unknown>) =>
  new ApiError(HttpStatus.BAD_REQUEST, code, details);
export const unauthorized = (code = 'auth.required') => new ApiError(HttpStatus.UNAUTHORIZED, code);
export const forbidden = (code = 'auth.forbidden') => new ApiError(HttpStatus.FORBIDDEN, code);
export const notFound = (code = 'notFound') => new ApiError(HttpStatus.NOT_FOUND, code);
export const conflict = (code: string, details?: Record<string, unknown>) =>
  new ApiError(HttpStatus.CONFLICT, code, details);
export const tooManyRequests = (code: string, retryAfterSeconds: number) =>
  new ApiError(HttpStatus.TOO_MANY_REQUESTS, code, { retryAfterSeconds });
