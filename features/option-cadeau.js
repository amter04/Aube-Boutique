'use strict';
/**
 * Feature : Option Cadeau & Message personnalisé
 *
 * Emplacement : features/option-cadeau.js
 * 
 * Permet à la cliente d'indiquer que sa commande est un cadeau et d'écrire un mot personnalisé.
 * Le message est enregistré sur la commande et s'affiche pour l'équipe sur le bordereau.
 */

module.exports = {
  register(ctx) {
    const { orderExtras, publicConfig, validate } = ctx;
    const { cleanText } = validate;

    // ----- 1. ANNONCER L'OPTION À LA BOUTIQUE -----
    // Indique au frontend (app.js) d'afficher la case cadeau au checkout
    publicConfig.add(async () => {
      return { giftNoteEnabled: true };
    });

    // ----- 2. CAPTURER LE MESSAGE LORS DE LA COMMANDE -----
    // S'exécute automatiquement lors de la création d'une commande
    orderExtras.add(async (body) => {
      if (!body || !body.giftNote) return {};
      
      const note = cleanText(body.giftNote, 300);
      if (!note) return {};

      return {
        gift: true,
        giftNote: note
      };
    });
  }
};
