import type { Request, Response, NextFunction } from 'express';
import { verifyCustomerToken } from '../utils/jwt';
import { Customer } from '../models/Customer';
import { ApiError } from '../utils/ApiError';
import { customerTokenFromRequest } from '../utils/customerSession';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      customer?: { id: string; name: string; email: string };
    }
  }
}

/** Requires a signed-in customer. */
export async function requireCustomer(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = customerTokenFromRequest(req);
    const payload = token ? verifyCustomerToken(token) : null;
    if (!payload) throw ApiError.unauthorized();
    const customer = await Customer.findById(payload.sub).select('name email sessionVersion');
    if (!customer || (customer.sessionVersion ?? 0) !== payload.v) throw ApiError.unauthorized();
    req.customer = { id: customer.id, name: customer.name, email: customer.email };
    next();
  } catch (err) {
    next(err);
  }
}

/** Attaches the customer when signed in; carries on anonymously otherwise. */
export async function optionalCustomer(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = customerTokenFromRequest(req);
    const payload = token ? verifyCustomerToken(token) : null;
    if (payload) {
      const customer = await Customer.findById(payload.sub).select('name email sessionVersion');
      if (customer && (customer.sessionVersion ?? 0) === payload.v) {
        req.customer = { id: customer.id, name: customer.name, email: customer.email };
      }
    }
  } catch {
    /* anonymous */
  }
  next();
}
