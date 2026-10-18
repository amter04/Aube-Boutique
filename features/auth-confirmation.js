'use strict';
/**
 * Feature : Confirmation de compte par email via Resend
 * Emplacement : features/auth-confirmation.js
 */

module.exports = {
  register(ctx) {
    const { app, store, HttpError, asyncHandler, email, secureToken, validate } = ctx;
    const { esc } = validate;

    // 1. Route de validation du lien contenu dans l'email
    app.get('/api/auth/confirm/:token', asyncHandler(async (req, res) => {
      const { token } = req.params;

      const customer = await store.withTransaction(async (data) => {
        const c = data.customers.find(u => u.confirmToken === token);
        if (!c) throw new HttpError(400, 'Lien de confirmation invalide ou expiré.');

        c.confirmed = true;
        delete c.confirmToken;
        return c;
      });

      // Redirige la cliente vers la boutique avec un message de succès
      res.redirect('/?confirmed=true');
    }));

    // 2. Intercepter l'inscription pour envoyer l'email Resend
    ctx.hooks.on('customer.created', async ({ customer }) => {
      const confirmUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/auth/confirm/${customer.confirmToken}`;

      await email.send({
        to: customer.email,
        subject: 'Aube — Confirmez votre inscription',
        html: `<div style="font-family:sans-serif; color:#201A16; max-width:500px;">
          <h2>Bienvenue chez Aube !</h2>
          <p>Bonjour ${esc(customer.name)},</p>
          <p>Merci de cliquer sur le bouton ci-dessous pour valider votre adresse email et activer votre compte :</p>
          <p><a href="${esc(confirmUrl)}" style="display:inline-block; padding:12px 20px; background:#800020; color:#fff; text-decoration:none; border-radius:4px;">Confirmer mon compte</a></p>
        </div>`
      });
    });
  }
};
