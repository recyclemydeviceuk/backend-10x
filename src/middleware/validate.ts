import type { Request, Response, NextFunction } from 'express';
import type { ZodTypeAny } from 'zod';

/** Parse and replace req.body with the validated value; Zod errors flow to the error middleware. */
export const validateBody =
  (schema: ZodTypeAny) => (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return next(parsed.error);
    req.body = parsed.data;
    next();
  };
