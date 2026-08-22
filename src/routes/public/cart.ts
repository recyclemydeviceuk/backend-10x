import { Router, type Request } from 'express';
import { z } from 'zod';
import { CartSession } from '../../models/CartSession';
import { verifyCustomerToken } from '../../utils/jwt';
import { customerTokenFromRequest } from '../../utils/customerSession';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { CART_EXPIRES_MS, cartForRequest, clearCartForRequest, ensureCartSession } from '../../services/cartSession';

export const cartRouter = Router();
function customerId(req: Request): string | null {
  const token = customerTokenFromRequest(req);
  return token ? verifyCustomerToken(token)?.sub ?? null : null;
}

const lineSchema = z.object({
  productId: z.string().min(1),
  tierId: z.string().min(1),
  sku: z.string().default(''),
  productName: z.string().min(1),
  tierName: z.string().default(''),
  packets: z.string().default(''),
  image: z.string().default(''),
  price: z.number().min(0),
  quantity: z.number().int().min(1).max(9),
  isSubscription: z.boolean(),
  oneTimePrice: z.number().min(0),
  stock: z.number().int().min(0).optional(),
}).nullable();

type Line = NonNullable<z.infer<typeof lineSchema>>;

/**
 * The catalogue is the only source of prices and stock. Whatever the browser
 * sent (or whatever was true when the line was added) is replaced with the
 * live figures, so the cart and the "Pay ₹X" button always show what the
 * checkout will actually charge. A pack that has since vanished empties the line.
 */
async function repriced(line: Line | null): Promise<Line | null> {
  if (!line) return null;
  const { Product } = await import('../../models/Product');
  const product = await Product.findOne({ _id: line.productId, status: 'active' });
  const tier = product?.tiers.id(line.tierId);
  if (!product || !tier || !tier.available) return null;
  return {
    ...line,
    productName: product.name,
    tierName: tier.name,
    price: line.isSubscription ? tier.subscribePrice : tier.oneTimePrice,
    oneTimePrice: tier.oneTimePrice,
    stock: tier.stock,
    quantity: Math.min(line.quantity, Math.max(tier.stock, 1)),
  };
}

cartRouter.get('/cart', asyncHandler(async (req, res) => {
  const cart = await cartForRequest(req, res, customerId(req));
  res.json({ ok: true, cart: { line: await repriced(cart?.line ?? null), couponCode: cart?.couponCode ?? '', pincode: cart?.pincode ?? '' } });
}));

cartRouter.put(
  '/cart',
  validateBody(
    z.object({
      line: lineSchema,
      couponCode: z.string().trim().toUpperCase().max(50).default(''),
      pincode: z.string().trim().regex(/^\d{6}$|^$/).default(''),
    }),
  ),
  asyncHandler(async (req, res) => {
    const id = ensureCartSession(req, res);
    await CartSession.findOneAndUpdate(
      { sessionId: id },
      {
        $set: {
          customerId: customerId(req),
          line: await repriced(req.body.line),
          couponCode: req.body.couponCode,
          pincode: req.body.pincode,
          expiresAt: new Date(Date.now() + CART_EXPIRES_MS),
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    res.json({ ok: true });
  }),
);

cartRouter.delete('/cart', asyncHandler(async (req, res) => {
  await clearCartForRequest(req, res);
  res.json({ ok: true });
}));
