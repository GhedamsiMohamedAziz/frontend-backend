import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodSchema } from 'zod';
import { ApiError } from './errors';

/**
 * Validate one argument against a Zod schema (spec §2: Zod on every boundary).
 *
 * The parsed value replaces the raw one, so a handler receives a typed, coerced
 * object and never re-checks what the schema already guaranteed.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw ApiError.badRequest(
          `Invalid ${metadata.type}`,
          error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }
      throw error;
    }
  }
}

export const zodPipe = <T>(schema: ZodSchema<T>): ZodValidationPipe<T> =>
  new ZodValidationPipe(schema);
