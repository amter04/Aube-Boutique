'use strict';
/**
 * Feature : Codes Promo & Réductions
 *
 * Emplacement : features/codes-promo.js
 * 
 * Permet au patron de :
 *  - Créer, modifier, désactiver et supprimer des codes promo.
 *  - Choisir le type de réduction : Pourcentage (%) ou Montant fixe (€).
 *  - Définir un montant minimum d'achat pour que le code s'applique.
 *  - Fixer une date d'expiration et/ou une limite du nombre d'utilisations.
 *  - Suivre le nombre d'utilisations en temps réel.
 */

module.exports = {
  register(ctx) {
    const { app, store, HttpError, asyncHandler, requireAdmin, validate, pricing, hooks, publicConfig } = ctx;
    const { clean, intInRange, parseId } = validate;

    // ----- 1. INITIALISATION DE LA BASE -----
    // S'assure que la structure des codes promo existe dans les données du store
    async function getPromos(data) {
      if (!data.ext) data.ext = {};
      if (!Array.isArray(data.ext.promos)) data.ext.promos = [];
      return data.ext.promos;
    }

    // ----- 2. ANNONCER L'OPTION À LA BOUTIQUE -----
    // Indique au frontend (app.js) que la case code promo peut s'afficher
    publicConfig.add(async () => {
      return { promoEnabled: true };
    });

    // ----- 3. CALCUL DE LA RÉDUCTION (HOOK PRICING) -----
    pricing.add(async ({ subtotalCents, body, data }) => {
      const codeInput = body && body.promoCode ? String(body.promoCode).trim().toUpperCase() : null;
      if (!codeInput) return null;

      const promos = await getPromos(data);
      const promo = promos.find(p => p.code === codeInput && p.active);

      if (!promo) {
        throw new HttpError(400, 'Code promo invalide ou expiré.');
      }

      // Vérification des dates
      const now = new Date();
      if (promo.startsAt && new Date(promo.startsAt) > now) {
        throw new HttpError(400, 'Ce code promo n\'est pas encore actif.');
      }
      if (promo.endsAt && new Date(promo.endsAt) < now) {
        throw new HttpError(400, 'Ce code promo a expiré.');
      }

      // Vérification de la limite d'utilisations
      if (promo.maxUses != null && promo.usesCount >= promo.maxUses) {
        throw new HttpError(400, 'Ce code promo a atteint sa limite d\'utilisations.');
      }

      // Vérification du montant minimum d'achat
      if (promo.minSubtotalCents && subtotalCents < promo.minSubtotalCents) {
        const minEur = (promo.minSubtotalCents / 100).toFixed(2);
        throw new HttpError(400, `Ce code nécessite un panier minimum de ${minEur} €.`);
      }

      // Calcul du montant de la remise
      let discountCents = 0;
      if (promo.type === 'percent') {
        discountCents = Math.round(subtotalCents * (promo.value / 100));
      } else if (promo.type === 'fixed') {
        discountCents = Math.round(promo.value * 100);
      }

      // La remise ne peut pas dépasser le sous-total
      discountCents = Math.min(discountCents, subtotalCents);

      return {
        type: 'promo',
        code: promo.code,
        label: `Code promo (${promo.code})`,
        discountCents
      };
    });

    // ----- 4. COMPTAGE DES UTILISATIONS DANS LA TRANSACTION (HOOK ORDER.PAID) -----
    hooks.tx('order.paid', async (data, { order }) => {
      const promoAdj = (order.adjustments || []).find(a => a.type === 'promo' && a.code);
      if (!promoAdj) return;

      const promos = await getPromos(data);
      const promo = promos.find(p => p.code === promoAdj.code);
      if (promo) {
        promo.usesCount = (promo.usesCount || 0) + 1;
      }
    });

    // ----- 5. ROUTE PUBLIQUE : VALIDATION DU CODE PROMO AU CHECKOUT -----
    app.post('/api/promo/validate', asyncHandler(async (req, res) => {
      const { code, subtotalCents } = req.body || {};
      if (!code) throw new HttpError(400, 'Code requis.');

      const cleanCode = String(code).trim().toUpperCase();
      const subtotal = intInRange(subtotalCents, 0, 100000000, 0);

      const data = await store.load();
      const promos = await getPromos(data);
      const promo = promos.find(p => p.code === cleanCode && p.active);

      if (!promo) throw new HttpError(404, 'Code promo introuvable ou expiré.');

      const now = new Date();
      if (promo.startsAt && new Date(promo.startsAt) > now) throw new HttpError(400, 'Code promo pas encore valide.');
      if (promo.endsAt && new Date(promo.endsAt) < now) throw new HttpError(400, 'Code promo expiré.');
      if (promo.maxUses != null && promo.usesCount >= promo.maxUses) throw new HttpError(400, 'Code promo épuisé.');
      if (promo.minSubtotalCents && subtotal < promo.minSubtotalCents) {
        const minEur = (promo.minSubtotalCents / 100).toFixed(2);
        throw new HttpError(400, `Panier minimum de ${minEur} € requis pour ce code.`);
      }

      let discountCents = 0;
      if (promo.type === 'percent') {
        discountCents = Math.round(subtotal * (promo.value / 100));
      } else if (promo.type === 'fixed') {
        discountCents = Math.round(promo.value * 100);
      }
      discountCents = Math.min(discountCents, subtotal);

      res.json({
        ok: true,
        code: promo.code,
        discountCents,
        label: promo.type === 'percent' ? `-${promo.value}%` : `-${promo.value} €`
      });
    }));

    // ----- 6. ROUTES D'ADMINISTRATION (PATRON) -----

    // Liste des codes promo
    app.get('/api/admin/promos', requireAdmin, asyncHandler(async (req, res) => {
      const data = await store.load();
      const promos = await getPromos(data);
      res.json(promos);
    }));

    // Créer un code promo
    app.post('/api/admin/promos', requireAdmin, asyncHandler(async (req, res) => {
      const b = req.body || {};
      const code = clean(b.code, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (!code || code.length < 2) throw new HttpError(400, 'Code invalide (2 caractères alfanumériques minimum).');

      const type = ['percent', 'fixed'].includes(b.type) ? b.type : 'percent';
      const value = type === 'percent' ? intInRange(b.value, 1, 100, 10) : Number(b.value) || 0;
      if (value <= 0) throw new HttpError(400, 'Valeur de réduction invalide.');

      const minSubtotalCents = b.minSubtotal ? Math.round(parseFloat(b.minSubtotal) * 100) : null;
      const maxUses = b.maxUses ? intInRange(b.maxUses, 1, 1000000, 100) : null;
      const startsAt = b.startsAt ? new Date(b.startsAt).toISOString() : null;
      const endsAt = b.endsAt ? new Date(b.endsAt).toISOString() : null;

      const newPromo = await store.withTransaction(async (data) => {
        const promos = await getPromos(data);
        if (promos.some(p => p.code === code)) {
          throw new HttpError(409, 'Un code promo existe déjà avec ce nom.');
        }
        const p = {
          id: Date.now(),
          code,
          type,
          value,
          minSubtotalCents,
          maxUses,
          usesCount: 0,
          startsAt,
          endsAt,
          active: true,
          createdAt: new Date().toISOString()
        };
        promos.push(p);
        return p;
      });

      res.status(201).json(newPromo);
    }));

    // Modifier le statut (activer/désactiver) ou supprimer un code
    app.put('/api/admin/promos/:id', requireAdmin, asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const { active } = req.body || {};

      const updated = await store.withTransaction(async (data) => {
        const promos = await getPromos(data);
        const p = promos.find(x => x.id === id);
        if (!p) throw new HttpError(404, 'Code promo introuvable.');
        if (active !== undefined) p.active = !!active;
        return p;
      });

      res.json(updated);
    }));

    app.delete('/api/admin/promos/:id', requireAdmin, asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);

      await store.withTransaction(async (data) => {
        const promos = await getPromos(data);
        data.ext.promos = promos.filter(p => p.id !== id);
      });

      res.json({ ok: true });
    }));
  }
};
