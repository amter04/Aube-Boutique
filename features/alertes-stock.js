'use strict';
/**
 * Feature : Alertes Réassort / Retour en stock
 *
 * Emplacement : features/alertes-stock.js
 * 
 * Permet aux clientes de s'inscrire avec leur email sur une taille épuisée.
 * Lorsqu'un employé ou le patron augmente le stock, un email est envoyé automatiquement
 * aux clientes inscrites via l'outil d'emailing (Resend).
 */

module.exports = {
  register(ctx) {
    const { app, store, HttpError, asyncHandler, hooks, publicConfig, email, validate } = ctx;
    const { validEmail, parseId, clean, esc } = validate;
    const alertLimiter = ctx.limiters.request({ name: 'stock-alert', max: 10, windowMs: 60 * 60 * 1000 });
    const MAX_ALERTS = 5000;
    const baseUrl = () => (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

    // ----- 1. ANNONCER L'OPTION À LA BOUTIQUE -----
    publicConfig.add(async () => {
      return { stockAlertsEnabled: true };
    });

    // Structure de stockage des alertes dans la base
    async function getAlerts(data) {
      if (!data.ext) data.ext = {};
      if (!Array.isArray(data.ext.stockAlerts)) data.ext.stockAlerts = [];
      return data.ext.stockAlerts;
    }

    // ----- 2. ROUTE PUBLIQUE : INSCRIPTION À UNE ALERTE -----
    app.post('/api/stock-alerts', alertLimiter, asyncHandler(async (req, res) => {
      const { productId, size, email: mailInput } = req.body || {};
      const id = parseId(productId);
      const mail = validEmail(mailInput);
      const cleanSize = clean(size, 10);

      if (!mail) throw new HttpError(400, 'Adresse email invalide.');
      if (!cleanSize) throw new HttpError(400, 'Taille requise.');

      const data = await store.load();
      const product = data.products.find(p => p.id === id && p.isActive);
      if (!product) throw new HttpError(404, 'Produit introuvable.');

      await store.withTransaction(async (dbData) => {
        const alerts = await getAlerts(dbData);
        if (alerts.length >= MAX_ALERTS) throw new HttpError(503, 'Les alertes sont momentanément indisponibles.');
        // Évite les doublons d'inscription
        const exists = alerts.some(a => a.productId === id && a.size === cleanSize && a.email === mail);
        if (!exists) {
          alerts.push({
            id: ctx.secureToken(16), // sert aussi de jeton de désinscription
            productId: id,
            size: cleanSize,
            email: mail,
            createdAt: new Date().toISOString()
          });
        }
      });

      res.json({ ok: true, message: 'Inscription enregistrée !' });
    }));

    // Désinscription en un clic (lien présent dans chaque email)
    app.get('/api/stock-alerts/unsubscribe/:token', asyncHandler(async (req, res) => {
      const token = String(req.params.token || '').slice(0, 64);
      await store.withTransaction(async (dbData) => {
        const alerts = await getAlerts(dbData);
        dbData.ext.stockAlerts = alerts.filter(a => String(a.id) !== token);
      });
      res.redirect('/?alerte=supprimee');
    }));

    // ----- 3. ÉVÉNEMENT : DÉTECTION DU RÉASSORT & ENVOI D'EMAILS -----
    hooks.on('stock.changed', async ({ productId, changes, by }) => {
      if (!Array.isArray(changes) || changes.length === 0) return;

      const data = await store.load();
      const product = data.products.find(p => p.id === productId);
      if (!product) return;

      const alerts = await getAlerts(data);
      if (alerts.length === 0) return;

      // On repère les tailles dont le stock est passé de 0 à au moins 1
      const restockedSizes = changes
        .filter(c => c.before === 0 && c.after > 0)
        .map(c => c.size);

      if (restockedSizes.length === 0) return;

      const toRemoveIds = [];

      for (const alert of alerts) {
        if (alert.productId === productId && restockedSizes.includes(alert.size)) {
          toRemoveIds.push(alert.id);

          // Envoi de l'email via Resend
          const productUrl = `${process.env.PUBLIC_URL || ''}/produit/${product.id}`;
          await email.send({
            to: alert.email,
            subject: `Aube — Bonne nouvelle ! ${product.name} est de retour`,
            html: `<div style="font-family:sans-serif; color:#201A16; max-width:500px;">
              <h2>De nouveau disponible !</h2>
              <p>La pièce <strong>${esc(product.name)}</strong> (Taille ${esc(alert.size)}) que vous attendiez est de nouveau en stock.</p>
              <p><a href="${esc(productUrl)}" style="display:inline-block; padding:10px 18px; background:#800020; color:#fff; text-decoration:none; border-radius:4px;">Voir la pièce</a></p>
              <p style="font-size:12px; color:#777;">Vous recevez cet email car vous vous êtes inscrite à une alerte sur notre boutique. <a href="${esc(baseUrl() + '/api/stock-alerts/unsubscribe/' + alert.id)}">Me désinscrire</a>.</p>
            </div>`
          });
        }
      }

      // Nettoyage des alertes envoyées dans la base de données
      if (toRemoveIds.length > 0) {
        await store.withTransaction(async (dbData) => {
          const currentAlerts = await getAlerts(dbData);
          dbData.ext.stockAlerts = currentAlerts.filter(a => !toRemoveIds.includes(a.id));
        });
      }
    });
  }
};
