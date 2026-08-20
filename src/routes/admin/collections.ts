import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { requireAdmin } from '../../middleware/adminAuth';
import { roleHas } from '../../auth/permissions';
import { isPanelCollection, loadCollection, saveCollection, WriteConflict, type PanelCollection } from '../../services/panelMap';

// =========================================================
// The admin panel's data layer. The panel reads a collection,
// edits it, and writes it back — that contract is served here
// against the real database, so the panel, the storefront and
// this API all operate on one set of records.
//
// Access follows the ROLE, per collection: viewing the orders
// page needs orders.view, saving from it needs orders.status,
// and so on. Panel actions still assert their own finer
// permissions on top (e.g. products.delete) before writing.
// Store-wide surfaces (settings, syncing) stay Super Admin.
// =========================================================

export const adminCollectionsRouter = Router();

/** What a role needs to READ / WRITE each collection through the panel. */
const COLLECTION_ACCESS: Record<PanelCollection, { read: string; write: string | string[] }> = {
  orders: { read: 'orders.view', write: 'orders.status' },
  customers: { read: 'customers.view', write: 'customers.edit' },
  products: { read: 'products.view', write: ['products.edit', 'inventory.adjust'] },
  coupons: { read: 'coupons.view', write: 'coupons.edit' },
  subscriptions: { read: 'subscriptions.view', write: 'subscriptions.edit' },
  returns: { read: 'returns.view', write: 'returns.refund' },
  queries: { read: 'queries.view', write: 'queries.manage' },
  // Store-wide configuration and the live feeds stay with the owner.
  settings: { read: 'settings.view', write: '*' },
  events: { read: 'dashboard.view', write: '*' },
  carts: { read: 'customers.view', write: '*' },
  syncing: { read: 'settings.view', write: '*' },
};

function assertAccess(permissions: string[], name: PanelCollection, kind: 'read' | 'write') {
  const needed = COLLECTION_ACCESS[name][kind];
  const options = Array.isArray(needed) ? needed : [needed];
  const allowed = options.some((id) => (id === '*' ? permissions.includes('*') : roleHas(permissions, id)));
  if (!allowed) {
    throw ApiError.forbidden(`Your role does not allow this (${options[0] === '*' ? 'Super Admin' : options.join(' or ')}).`);
  }
}

adminCollectionsRouter.get(
  '/:name',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name } = req.params;
    if (!isPanelCollection(name)) throw ApiError.notFound(`Unknown collection "${name}".`);
    assertAccess(req.admin!.permissions, name, 'read');
    res.json({ ok: true, data: await loadCollection(name) });
  }),
);

adminCollectionsRouter.put(
  '/:name',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name } = req.params;
    if (!isPanelCollection(name)) throw ApiError.notFound(`Unknown collection "${name}".`);
    assertAccess(req.admin!.permissions, name, 'write');
    if (!('data' in (req.body ?? {}))) throw ApiError.badRequest('Send { data } to write a collection.');

    // `knownIds` is what the writer saw when they read; it scopes deletions so
    // a colleague's newly created record can't be swept away by an unrelated
    // edit. Optional, for older clients.
    const knownIds = Array.isArray(req.body.knownIds) ? (req.body.knownIds as unknown[]).map(String) : undefined;

    try {
      await saveCollection(name, req.body.data, knownIds);
    } catch (err) {
      // 409 so the panel can tell "someone else got there first" apart from a
      // genuine failure, and say so rather than showing a generic error.
      if (err instanceof WriteConflict) throw ApiError.conflict(err.message);
      throw err;
    }
    res.json({ ok: true });
  }),
);
