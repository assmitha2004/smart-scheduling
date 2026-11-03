import type { z } from 'zod';
import { badRequest } from '../utils/errors.js';

/** Parses `data` with a zod schema, throwing a 400 with field-level issues on failure. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      'Validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
