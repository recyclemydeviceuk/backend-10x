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

/**
 * What a role needs to READ / WRITE each collection through the panel.
 *
 * Reads: a page usually needs more than its own module to render — the
 * dashboard sums orders, customers and subscriptions; an order page shows
 * the customer; a customer page lists their orders. So any role that can
 * open SOME part of the panel may read the store collections, and the
 * page-level permission decides which pages they can open. Writes stay
 * strict, and list every granular id the panel's actions assert, so a role
 * holding e.g. coupons.toggle alone can actually toggle.
 */
const ANY_VIEW = 'any-view';
const COLLECTION_ACCESS: Record<PanelCollection, { read: string; write: string | string[] }> = {
  orders: { read: ANY_VIEW, write: ['orders.status', 'orders.notes', 'orders.create', 'orders.delete'] },
  customers: { read: ANY_VIEW, write: ['customers.edit', 'customers.create', 'customers.delete', 'subscriptions.create'] },
  products: { read: ANY_VIEW, write: ['products.edit', 'products.create', 'products.delete', 'inventory.adjust'] },
  coupons: { read: ANY_VIEW, write: ['coupons.edit', 'coupons.create', 'coupons.toggle', 'coupons.delete'] },
  subscriptions: { read: ANY_VIEW, write: ['subscriptions.edit', 'subscriptions.create', 'subscriptions.pause', 'subscriptions.cancel', 'subscriptions.delete'] },
  returns: { read: ANY_VIEW, write: ['returns.refund', 'returns.notes', 'returns.approve', 'returns.reject', 'returns.receive'] },
  queries: { read: ANY_VIEW, write: ['queries.manage', 'queries.reply', 'queries.delete'] },
  // Store-wide configuration stays with the owner; the activity feed is
  // written by every action in the panel, so any staff member may log.
  settings: { read: ANY_VIEW, write: '*' },
  events: { read: ANY_VIEW, write: ANY_VIEW },
  carts: { read: ANY_VIEW, write: '*' },
  syncing: { read: 'settings.view', write: '*' },
};

/** Any signed-in staff role — a role with no permissions at all can't open a page anyway. */
function hasAnyView(permissions: string[]): boolean {
  return permissions.length > 0;
}

function assertAccess(permissions: string[], name: PanelCollection, kind: 'read' | 'write') {
  const needed = COLLECTION_ACCESS[name][kind];
  const options = Array.isArray(needed) ? needed : [needed];
  const allowed = options.some((id) =>
    id === '*' ? permissions.includes('*') : id === ANY_VIEW ? hasAnyView(permissions) : roleHas(permissions, id),
  );
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
    // An empty list is a real read set ("the collection was empty when I
    // looked") and must stay one: it is what protects a record someone else
    // created in the meantime from being swept by an unrelated write.
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
