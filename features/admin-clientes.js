'use strict';
/**
 * Admin — clientes
 *
 *  - liste enrichie (commandes, total dépensé, dernière commande) et fiche détaillée
 *  - ajustement manuel des points (geste commercial, correction d'erreur), tracé dans un historique
 *  - export des données d'une cliente et suppression de son compte (droits RGPD d'accès et d'effacement)
 */
module.exports = {
  register(ctx) {
    const { app, store, HttpError, asyncHandler, requirePerm, requireAdmin, validate } = ctx;
    const { clean, parseId } = validate;
    const audit = ctx.helpers.audit;
    const norm = store.normalizeEmail;
    const perm = requirePerm('customers');

    const orderEmail = (o) => norm(o.payerEmail || (o.customer && o.customer.email) || '');
    const visible = (o) => !['created', 'expired'].includes(o.status);

    // Les commandes d'une cliente : celles rattachées à son compte + celles passées « en invitée »
    // avec la même adresse email (avant qu'elle crée son compte).
    function ordersOf(data, c) {
      const email = norm(c.email);
      return data.orders.filter(o => visible(o) && (o.customerId === c.id || (!o.customerId && email && orderEmail(o) === email)));
    }
    function statsOf(orders) {
      const paid = orders.filter(o => o.status === 'paid');
      const spent = paid.reduce((s, o) => s + o.totalCents, 0);
      const times = orders.map(o => new Date(o.createdAt).getTime());
      return {
        ordersCount: orders.length,
        paidCount: paid.length,
        totalSpent: spent / 100,
        avgBasket: paid.length ? paid.reduce((s, o) => s + ((o.subtotalCents != null ? o.subtotalCents : o.totalCents) - (o.discountCents || 0)), 0) / paid.length / 100 : 0,
        firstOrderAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
        lastOrderAt: times.length ? new Date(Math.max(...times)).toISOString() : null
      };
    }
    const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return u ? `${u[0]}***@${d || ''}` : ''; };

    app.get('/api/admin/customers', perm, asyncHandler(async (req, res) => {
      const data = await store.load();
      const byCustomer = new Map();
      const byEmail = new Map();
      for (const o of data.orders) {
        if (!visible(o)) continue;
        if (o.customerId) { (byCustomer.get(o.customerId) || byCustomer.set(o.customerId, []).get(o.customerId)).push(o); }
        else if (orderEmail(o)) { (byEmail.get(orderEmail(o)) || byEmail.set(orderEmail(o), []).get(orderEmail(o))).push(o); }
      }
      const rows = data.customers.map(c => {
        const orders = [...(byCustomer.get(c.id) || []), ...(byEmail.get(norm(c.email)) || [])];
        return { id: c.id, name: c.name, email: c.email, points: c.points || 0, createdAt: c.createdAt, ...statsOf(orders) };
      }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      res.json(rows);
    }));

    app.get('/api/admin/customers/:id', perm, asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const data = await store.load();
      const c = data.customers.find(x => x.id === id);
      if (!c) throw new HttpError(404, 'Cliente introuvable');
      const orders = ordersOf(data, c).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      res.json({
        id: c.id, name: c.name, email: c.email, points: c.points || 0, createdAt: c.createdAt,
        hasLoginAccount: !!c.supabaseUid,
        ...statsOf(orders),
        orders: orders.map(o => ({
          id: o.id, createdAt: o.createdAt, status: o.status, total: o.totalCents / 100, source: o.source || 'paypal',
          fulfillmentStatus: o.fulfillmentStatus || 'to_prepare', guest: !o.customerId,
          itemsCount: (o.items || []).reduce((s, i) => s + i.qty, 0),
          items: (o.items || []).map(i => `${i.name}${i.color ? ' ' + i.color : ''}${i.size && i.size !== 'TU' ? ' ' + i.size : ''} ×${i.qty}`),
          pointsEarned: o.pointsEarned || 0, pointsRedeemed: o.pointsRedeemed || 0
        })),
        pointsLog: [...(c.pointsLog || [])].reverse(),
        reviewsCount: (data.reviews || []).filter(r => r.customerId === c.id).length
      });
    }));

    // ----- Points : ajustement manuel -----
    app.post('/api/admin/customers/:id/points', perm, asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const delta = parseInt(req.body && req.body.delta, 10);
      const reason = clean(req.body && req.body.reason, 200);
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) throw new HttpError(400, 'Nombre de points invalide (ex. 50 ou -20).');
      if (!reason) throw new HttpError(400, 'Indique un motif (geste commercial, erreur, etc.).');
      const out = await store.withTransaction(async (data) => {
        const c = data.customers.find(x => x.id === id);
        if (!c) throw new HttpError(404, 'Cliente introuvable');
        const balance = (c.points || 0) + delta;
        if (balance < 0) throw new HttpError(400, `Solde insuffisant : ${c.name} n'a que ${c.points || 0} points.`);
        c.points = balance;
        c.pointsLog = c.pointsLog || [];
        c.pointsLog.push({ delta, reason, by: req.staff.name, at: new Date().toISOString(), balanceAfter: balance });
        c.pointsLog = c.pointsLog.slice(-200);
        return { name: c.name, balance, log: c.pointsLog };
      });
      audit('customer.points', req, { customerId: id, name: out.name, delta, reason, balance: out.balance });
      res.json({ ok: true, points: out.balance, pointsLog: [...out.log].reverse() });
    }));

    // ----- RGPD : export des données d'une cliente (patron) -----
    app.get('/api/admin/customers/:id/export', requireAdmin, asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const data = await store.load();
      const c = data.customers.find(x => x.id === id);
      if (!c) throw new HttpError(404, 'Cliente introuvable');
      const email = norm(c.email);
      const orders = ordersOf(data, c);
      const payload = {
        exportedAt: new Date().toISOString(),
        note: 'Données personnelles détenues par la boutique pour cette cliente (RGPD, droit d\'accès).',
        compte: { id: c.id, nom: c.name, email: c.email, inscriteLe: c.createdAt, pointsFidelite: c.points || 0, historiquePoints: c.pointsLog || [] },
        commandes: orders.map(o => ({
          numero: o.id, date: o.createdAt, statut: o.status, mode: o.source || 'paypal',
          total: o.totalCents / 100, livraison: (o.shippingCents || 0) / 100, remise: (o.discountCents || 0) / 100,
          articles: (o.items || []).map(i => ({ nom: i.name, couleur: i.color || '', taille: i.size, quantite: i.qty, prixUnitaire: i.priceCents / 100 })),
          coordonnees: o.customer || null, nomPaiement: o.payerName || '', emailPaiement: o.payerEmail || '',
          suivi: { transporteur: o.carrier || '', numero: o.trackingNumber || '' },
          pointsGagnes: o.pointsEarned || 0, pointsUtilises: o.pointsRedeemed || 0
        })),
        avis: (data.reviews || []).filter(r => r.customerId === c.id).map(r => ({ produit: r.productId, note: r.rating, commentaire: r.comment, date: r.createdAt, statut: r.status })),
        alertesStock: ((data.ext && data.ext.stockAlerts) || []).filter(a => norm(a.email) === email).map(a => ({ produit: a.productId, taille: a.size, couleur: a.color || '', date: a.createdAt }))
      };
      audit('customer.exported', req, { customerId: id });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="donnees-cliente-${id}-${new Date().toISOString().slice(0, 10)}.json"`);
      res.send(JSON.stringify(payload, null, 2));
    }));

    // ----- RGPD : suppression du compte (patron) -----
    // Les commandes sont des pièces comptables (conservation légale, 10 ans) : par défaut on les garde,
    // détachées du compte. « anonymizeOrders » efface aussi nom, email et adresse sur ces commandes.
    app.post('/api/admin/customers/:id/delete', requireAdmin, asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const confirmEmail = norm(req.body && req.body.confirmEmail);
      const anonymize = !!(req.body && req.body.anonymizeOrders);
      const data0 = await store.load();
      const c0 = data0.customers.find(x => x.id === id);
      if (!c0) throw new HttpError(404, 'Cliente introuvable');
      if (confirmEmail !== norm(c0.email)) throw new HttpError(400, 'Pour confirmer, retape l\'adresse email exacte de la cliente.');

      // 1) Le compte de connexion (Supabase Auth) : si on n'y arrive pas, on s'arrête là,
      // sinon la cliente pourrait encore se connecter à un compte « fantôme ».
      let authDeleted = false;
      if (c0.supabaseUid) {
        const { error } = await ctx.supaAdmin().auth.admin.deleteUser(c0.supabaseUid);
        if (error && !/not.?found/i.test(error.message || '')) throw new HttpError(502, 'Impossible de supprimer le compte de connexion : ' + error.message);
        authDeleted = true;
      }

      // 2) Les données de la boutique
      const result = await store.withTransaction(async (data) => {
        const c = data.customers.find(x => x.id === id);
        if (!c) return { orders: 0 };
        const email = norm(c.email);
        const mine = data.orders.filter(o => o.customerId === id || (!o.customerId && orderEmail(o) === email));
        for (const o of mine) {
          o.customerId = null;
          if (anonymize) {
            o.payerName = 'Compte supprimé';
            o.payerEmail = '';
            o.customer = { name: 'Compte supprimé', email: '', address: '', postalCode: '', city: '' };
            o.ext = {};
          }
        }
        data.customers = data.customers.filter(x => x.id !== id);
        data.reviews = (data.reviews || []).filter(r => r.customerId !== id);
        if (data.ext && Array.isArray(data.ext.stockAlerts)) data.ext.stockAlerts = data.ext.stockAlerts.filter(a => norm(a.email) !== email);
        return { orders: mine.length };
      });
      audit('customer.deleted', req, { customerId: id, emailMasked: maskEmail(c0.email), anonymized: anonymize, orders: result.orders, authDeleted });
      res.json({ ok: true, authDeleted, orders: result.orders, anonymized: anonymize });
    }));
  }
};
