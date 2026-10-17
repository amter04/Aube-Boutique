'use strict';
/**
 * Feature : Cross-Selling (« Complétez le look »)
 *
 * Emplacement : features/cross-selling.js
 * 
 * Permet d'associer des pièces complémentaires à un produit.
 * Les pièces associées s'affichent sur la fiche produit pour inciter à l'achat groupé.
 */

module.exports = {
  register(ctx) {
    const { app, store, HttpError, asyncHandler, requireAdmin, validate, publicConfig } = ctx;
    const { parseId } = validate;

    // ----- 1. ANNONCER L'OPTION À LA BOUTIQUE -----
    publicConfig.add(async () => {
      return { crossSellingEnabled: true };
    });

    // ----- 2. ROUTE D'ADMINISTRATION : ASSOCIER DES PRODUITS SUGGÉRÉS -----
    app.put('/api/admin/products/:id/cross-selling', requireAdmin, asyncHandler(async (req, res) => {
      const productId = parseId(req.params.id);
      const { relatedIds } = req.body || {};

      if (!Array.isArray(relatedIds)) {
        throw new HttpError(400, 'Liste des identifiants invalide.');
      }

      const cleanIds = relatedIds.map(id => parseInt(id, 10)).filter(id => Number.isInteger(id) && id !== productId);

      const product = await store.withTransaction(async (data) => {
        const p = data.products.find(x => x.id === productId);
        if (!p) throw new HttpError(404, 'Produit introuvable.');

        if (!p.ext) p.ext = {};
        p.ext.relatedIds = cleanIds.slice(0, 6); // 6 suggestions max

        return p;
      });

      res.json({ ok: true, relatedIds: product.ext.relatedIds });
    }));
  }
};
