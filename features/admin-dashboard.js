'use strict';
/**
 * Admin — tableau de bord : courbe des ventes, meilleures ventes, alertes de stock faible,
 * panier moyen et part des commandes passées avec un code promo.
 */
const tz = require('../lib/tz');

module.exports = {
  register(ctx) {
    const { app, store, asyncHandler, requirePerm, validate } = ctx;
    const { intInRange } = validate;
    const { isLive } = ctx.catalogue;
    const LOW = ctx.LOW_STOCK_THRESHOLD;

    // Liste des N derniers jours (aujourd'hui compris), au format AAAA-MM-JJ, dans le fuseau de la boutique.
    function lastDays(n, offsetDays = 0) {
      const [y, m, d] = tz.dayKey(Date.now()).split('-').map(Number);
      const out = [];
      for (let i = n - 1 + offsetDays; i >= offsetDays; i--) {
        const dt = new Date(Date.UTC(y, m - 1, d - i));
        out.push(dt.toISOString().slice(0, 10));
      }
      return out;
    }

    app.get('/api/admin/dashboard', requirePerm('dashboard'), asyncHandler(async (req, res) => {
      const days = [7, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : intInRange(req.query.days, 1, 90, 30);
      const data = await store.load();
      const current = lastDays(days);
      const previous = lastDays(days, days);
      const curSet = new Set(current);
      const prevSet = new Set(previous);

      const paid = data.orders.filter(o => o.status === 'paid');
      const series = new Map(current.map(d => [d, { date: d, revenue: 0, orders: 0 }]));
      const inPeriod = [];
      const prev = { revenue: 0, orders: 0 };
      for (const o of paid) {
        const key = tz.dayKey(new Date(o.createdAt).getTime());
        if (curSet.has(key)) {
          const s = series.get(key);
          s.revenue += o.totalCents; s.orders++;
          inPeriod.push(o);
        } else if (prevSet.has(key)) {
          prev.revenue += o.totalCents; prev.orders++;
        }
      }

      const n = inPeriod.length;
      const revenue = inPeriod.reduce((s, o) => s + o.totalCents, 0);
      const basketSum = inPeriod.reduce((s, o) => s + ((o.subtotalCents != null ? o.subtotalCents : o.totalCents) - (o.discountCents || 0)), 0);
      const units = inPeriod.reduce((s, o) => s + (o.items || []).reduce((a, i) => a + i.qty, 0), 0);

      // Meilleures ventes
      const prod = new Map();
      for (const o of inPeriod) {
        for (const it of o.items || []) {
          const r = prod.get(it.productId) || { productId: it.productId, name: it.name, units: 0, revenue: 0 };
          r.units += it.qty; r.revenue += it.qty * it.priceCents;
          prod.set(it.productId, r);
        }
      }
      const bestSellers = [...prod.values()].sort((a, b) => b.units - a.units || b.revenue - a.revenue).slice(0, 8).map(r => {
        const p = data.products.find(x => x.id === r.productId);
        return { ...r, name: p ? p.name : r.name, reference: p ? p.reference || '' : '', image: p && p.images && p.images[0] || '', archived: !!p && p.status === 'archived', revenue: r.revenue / 100 };
      });

      // Alertes de stock : pièces en ligne dont une variante est épuisée ou presque
      const lowStock = [];
      for (const p of data.products) {
        if (!isLive(p)) continue;
        const bad = (p.sizes || []).filter(s => (s.stock || 0) <= LOW);
        if (!bad.length) continue;
        lowStock.push({
          productId: p.id, name: p.name, reference: p.reference || '', image: p.images && p.images[0] || '',
          total: ctx.helpers.computeStock(p),
          out: bad.filter(s => s.stock === 0).length,
          variants: bad.map(s => ({ color: s.color || '', size: s.size, stock: s.stock || 0 })).sort((a, b) => a.stock - b.stock)
        });
      }
      lowStock.sort((a, b) => (b.out > 0) - (a.out > 0) || a.total - b.total);

      // Codes promo
      const codes = new Map();
      let withCode = 0;
      for (const o of inPeriod) {
        const adj = (o.adjustments || []).find(a => a.type === 'promo' && a.code);
        if (!adj) continue;
        withCode++;
        const r = codes.get(adj.code) || { code: adj.code, orders: 0, revenue: 0, discount: 0 };
        r.orders++; r.revenue += o.totalCents; r.discount += adj.discountCents;
        codes.set(adj.code, r);
      }

      res.json({
        days,
        series: [...series.values()].map(s => ({ date: s.date, revenue: s.revenue / 100, orders: s.orders })),
        totals: { revenue: revenue / 100, orders: n, avgBasket: n ? basketSum / n / 100 : 0, units },
        previous: { revenue: prev.revenue / 100, orders: prev.orders },
        bestSellers,
        lowStock: lowStock.slice(0, 20),
        lowStockThreshold: LOW,
        promo: {
          ordersWithCode: withCode, ordersTotal: n, rate: n ? Math.round((withCode / n) * 1000) / 10 : 0,
          codes: [...codes.values()].sort((a, b) => b.orders - a.orders).map(c => ({ ...c, revenue: c.revenue / 100, discount: c.discount / 100, rate: n ? Math.round((c.orders / n) * 1000) / 10 : 0 }))
        }
      });
    }));
  }
};
