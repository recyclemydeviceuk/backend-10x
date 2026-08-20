import type { Request } from 'express';

export type PageQuery = { page: number; per: number; skip: number };

/** ?page=&per= with the same 10/25/50 steps the admin panel uses. */
export function pageQuery(req: Request): PageQuery {
  const per = [10, 25, 50].includes(Number(req.query.per)) ? Number(req.query.per) : 25;
  const page = Math.max(1, Number(req.query.page) || 1);
  return { page, per, skip: (page - 1) * per };
}

export function pageMeta(total: number, q: PageQuery) {
  return { total, page: q.page, per: q.per, totalPages: Math.max(1, Math.ceil(total / q.per)) };
}
