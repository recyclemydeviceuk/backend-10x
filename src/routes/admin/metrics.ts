import { Router } from 'express';
import { Order } from '../../models/Order';
import { Customer } from '../../models/Customer';
import { Subscription } from '../../models/Subscription';
import { Product } from '../../models/Product';
import { ReturnRequest } from '../../models/ReturnRequest';
import { asyncHandler } from '../../utils/asyncHandler';
import { requirePermission } from '../../middleware/adminAuth';

export const adminMetricsRouter = Router();

/**
 * GET /metrics?range=7|30|90|all — the analytics payload the panel charts
 * from: KPIs, daily series, breakdowns, previous-period compare.
 */
adminMetricsRouter.get(
  '/',
  requirePermission('analytics.view'),
  asyncHandler(async (req, res) => {
    const raw = String(req.query.range ?? '30');
    const isLifetime = raw === 'all';
    const now = new Date();

    let rangeDays: number;
    if (isLifetime) {
      const first = await Order.findOne().sort({ placedAt: 1 }).select('placedAt');
      rangeDays = first
        ? Math.min(Math.max(Math.ceil((now.getTime() - first.placedAt.getTime()) / 86400_000) + 1, 7), 365)
        : 30;
    } else {
      rangeDays = [7, 30, 90].includes(Number(raw)) ? Number(raw) : 30;
    }

    const startOf = (daysBack: number) => {
      const d = new Date(now);
      d.setDate(d.getDate() - daysBack);
      d.setHours(0, 0, 0, 0);
      return d;
    };
    const rangeStart = startOf(rangeDays - 1);
    const prevStart = startOf(rangeDays * 2 - 1);

    const [inRange, inPrev, customers, activeSubs, products, pendingReturns] = await Promise.all([
      Order.find({ placedAt: { $gte: rangeStart } }),
      Order.find({ placedAt: { $gte: prevStart, $lt: rangeStart } }),
      Customer.find().select('createdAt totalSpent name email hasSubscription'),
      Subscription.find({ status: 'active' }),
      Product.find(),
      ReturnRequest.countDocuments({ status: 'requested' }),
    ]);

    const counted = inRange.filter((o) => o.status !== 'cancelled');
    const revenue = counted.reduce((s, o) => s + o.total, 0);
    const prevRevenue = inPrev.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0);
    const unitsSold = counted.reduce((s, o) => s + o.items.reduce((x, i) => x + i.quantity, 0), 0);
    const newCustomers = customers.filter((c) => c.createdAt >= rangeStart).length;
    const prevNewCustomers = customers.filter((c) => c.createdAt >= prevStart && c.createdAt < rangeStart).length;

    /* ---------------------------------------------------------- daily series */
    const days: { date: string; label: string; revenue: number; orders: number; units: number }[] = [];
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = startOf(i);
      days.push({
        date: d.toISOString().slice(0, 10),
        label: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        revenue: 0,
        orders: 0,
        units: 0,
      });
    }
    const byDate = new Map(days.map((d) => [d.date, d]));
    for (const o of inRange) {
      const day = byDate.get(o.placedAt.toISOString().slice(0, 10));
      if (!day) continue;
      day.orders++;
      if (o.status !== 'cancelled') {
        day.revenue += o.total;
        day.units += o.items.reduce((x, i) => x + i.quantity, 0);
      }
    }

    /* ------------------------------------------------------------ breakdowns */
    const countBy = (key: (o: (typeof inRange)[number]) => string) => {
      const m: Record<string, number> = {};
      for (const o of inRange) m[key(o)] = (m[key(o)] ?? 0) + 1;
      return m;
    };
    const cityRevenue: Record<string, { revenue: number; orders: number }> = {};
    for (const o of counted) {
      const cur = (cityRevenue[o.address.city] ??= { revenue: 0, orders: 0 });
      cur.revenue += o.total;
      cur.orders++;
    }

    const trend = (cur: number, prev: number) => (prev === 0 ? (cur > 0 ? 100 : 0) : ((cur - prev) / prev) * 100);

    res.json({
      ok: true,
      isLifetime,
      rangeDays,
      kpis: {
        revenue,
        revenueTrend: trend(revenue, prevRevenue),
        orderCount: inRange.length,
        orderTrend: trend(inRange.length, inPrev.length),
        unitsSold,
        aov: Math.round(revenue / Math.max(counted.length, 1)) || 0,
        newCustomers,
        customerTrend: trend(newCustomers, prevNewCustomers),
        activeSubscriptions: activeSubs.length,
        subscriptionMrr: activeSubs.reduce((s, x) => s + x.price * x.quantity, 0),
        pendingReturns,
        refundedAmount: inRange.filter((o) => o.paymentStatus === 'refunded').reduce((s, o) => s + o.total, 0),
      },
      days,
      statusCounts: countBy((o) => o.status),
      typeCounts: countBy((o) => o.channel),
      payMethodCounts: countBy((o) => o.paymentMethod),
      topCities: Object.entries(cityRevenue)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .slice(0, 8),
      previous: { revenue: prevRevenue, orders: inPrev.length, newCustomers: prevNewCustomers },
      topCustomers: customers
        .sort((a, b) => b.totalSpent - a.totalSpent)
        .slice(0, 6)
        .map((c) => ({ id: c.id, name: c.name, email: c.email, totalSpent: c.totalSpent })),
      stockAlerts: products.flatMap((prod) =>
        prod.tiers
          .filter((t) => t.available && t.stock <= t.lowStockAt)
          .map((t) => ({ productId: prod.id, productName: prod.name, tierName: t.name, stock: t.stock })),
      ),
    });
  }),
);
