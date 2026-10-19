import { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { badRequest } from './api-error';

/**
 * Validates and normalizes a request body with a shared schema from @puantaj/schemas.
 * Issues keep the schema's translation keys, so the web app shows them per field:
 * `{ code: 'validation', issues: [{ path: 'phone', message: 'validation.phoneInvalid' }] }`.
 */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw badRequest('validation', {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message.startsWith('validation.') ? issue.message : 'validation.invalid',
        })),
      });
    }
    return result.data;
  }
}
