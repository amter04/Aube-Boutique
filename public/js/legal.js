// Textes légaux de la boutique (CGV, mentions légales, politique de confidentialité).
// Les informations propres à ta société viennent des variables d'environnement LEGAL_* et
// CONTACT_EMAIL (voir .env.example) : tout champ vide s'affiche « à compléter » en surbrillance.
// Ces textes sont des modèles de départ : fais-les relire avant l'ouverture au public.
(function () {
  const VERSION = '21 octobre 2026';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const v = (x) => (x && String(x).trim()) ? esc(x) : '<mark class="todo">[à compléter]</mark>';
  const euro = (n) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n);

  function editor(L) {
    return `<strong>${v(L.name)}</strong>${L.form ? `, ${esc(L.form)}` : ''}, SIRET ${v(L.siret)},
      dont le siège est situé ${v(L.address)}. Contact : <a href="mailto:${esc(L.email)}">${v(L.email)}</a>${L.phone ? `, ${esc(L.phone)}` : ''}.`;
  }

  function mentions(L) {
    return `
      <h4>Éditeur du site</h4>
      <p>${editor(L)}</p>
      <p>Directrice / directeur de la publication : ${v(L.owner)}.</p>
      <p>${L.vat ? esc(L.vat) : 'Numéro de TVA / mention de TVA : <mark class="todo">[à compléter]</mark>'}</p>
      <h4>Hébergement</h4>
      <p>Le site est hébergé par ${v(L.host)}. Les données (produits, commandes, comptes) sont stockées chez Supabase, et les photos sur Supabase Storage.</p>
      <h4>Propriété intellectuelle</h4>
      <p>Les textes, photographies, logos et éléments graphiques du site sont protégés. Toute reproduction sans autorisation écrite est interdite.</p>
      <h4>Données personnelles</h4>
      <p>Le traitement de tes données est décrit dans la politique de confidentialité.</p>`;
  }

  function cgv(L, ctx) {
    const loyalty = ctx.loyalty || {};
    const loyaltyBlock = loyalty.pointsPerEuro
      ? `<h4>11. Programme de fidélité</h4>
         <p>Les clientes disposant d'un compte cumulent ${esc(loyalty.pointsPerEuro)} point(s) par euro dépensé (hors livraison). 100 points équivalent à ${euro((100 * (loyalty.pointValueCents || 0)) / 100)} de réduction${loyalty.minRedeemPoints ? `, utilisables à partir de ${esc(loyalty.minRedeemPoints)} points` : ''}. Les points n'ont pas de valeur monétaire, ne sont ni échangeables ni remboursables. En cas de retour ou de remboursement d'une commande, les points correspondants peuvent être retirés.</p>`
      : '';
    const returnCosts = L.returnCosts === 'shop'
      ? 'Les frais de retour sont pris en charge par la boutique.'
      : 'Les frais de retour sont à la charge de la cliente.';
    return `
      <p><em>Version du ${VERSION}</em></p>
      <h4>1. Identification du vendeur</h4>
      <p>${editor(L)}</p>
      <h4>2. Champ d'application</h4>
      <p>Les présentes conditions générales de vente (CGV) s'appliquent à toute commande passée sur ce site par une cliente consommatrice. Passer commande implique l'acceptation sans réserve des CGV en vigueur au moment de la commande.</p>
      <h4>3. Produits</h4>
      <p>Les produits sont présentés avec la plus grande exactitude possible. Les photographies ne sont pas contractuelles et les couleurs peuvent légèrement varier selon les écrans. Les mesures du guide des tailles sont données à titre indicatif.</p>
      <h4>4. Prix</h4>
      <p>Les prix sont indiqués en euros, toutes taxes comprises le cas échéant, hors frais de livraison. ${L.vat ? esc(L.vat) : ''} Les frais de livraison sont affichés dans le panier avant toute validation. Le prix applicable est celui affiché au moment de la commande.</p>
      <h4>5. Commande</h4>
      <p>La cliente sélectionne ses articles, renseigne ses informations de livraison, accepte les présentes CGV puis valide sa commande, ce qui emporte <strong>obligation de paiement</strong>. Un email de confirmation est envoyé après validation. Les produits sont proposés dans la limite des stocks disponibles ; en cas d'indisponibilité après commande, la cliente en est informée et remboursée des sommes versées.</p>
      <h4>6. Paiement</h4>
      <p>Le paiement s'effectue en ligne via PayPal (par compte PayPal ou carte bancaire). Le vendeur n'a jamais accès aux données bancaires de la cliente. La commande est traitée une fois le paiement confirmé.</p>
      <h4>7. Livraison</h4>
      <p>Les articles sont expédiés à l'adresse indiquée lors de la commande. Les délais sont donnés à titre indicatif. En cas de retard de livraison, la cliente peut contacter le vendeur à l'adresse ${v(L.email)}. Les risques sont transférés à la cliente à la réception du colis.</p>
      <h4>8. Droit de rétractation</h4>
      <p>Conformément au Code de la consommation, la cliente dispose de <strong>14 jours</strong> à compter de la réception de sa commande pour exercer son droit de rétractation, sans avoir à justifier de motif. Pour cela, elle notifie sa décision par email à ${v(L.email)} (en précisant son numéro de commande) et renvoie les articles sous 14 jours après cette notification. Le vendeur rembourse la totalité des sommes versées (y compris les frais de livraison standard) au plus tard 14 jours après avoir reçu la notification, par le même moyen de paiement ; il peut différer le remboursement jusqu'à la réception des articles ou la preuve de leur expédition.</p>
      <p>${returnCosts} Les articles doivent être retournés dans leur état d'origine, non portés, non lavés et avec leurs étiquettes. La cliente est responsable de la dépréciation résultant de manipulations autres que celles nécessaires pour s'assurer de la nature et du bon fonctionnement du bien. Ne peuvent faire l'objet d'un retrait, le cas échéant, les articles confectionnés sur mesure ou personnalisés, ainsi que les articles qui ne peuvent être renvoyés pour des raisons d'hygiène ou de protection de la santé et dont l'emballage de protection a été ouvert (par exemple maillots de bain, lingerie).</p>
      <h4>9. Garanties légales</h4>
      <p>Le vendeur est tenu de la garantie légale de conformité (Code de la consommation) et de la garantie des vices cachés (articles 1641 et suivants du Code civil). La cliente peut en bénéficier en contactant le vendeur à l'adresse ${v(L.email)}.</p>
      <h4>10. Données personnelles</h4>
      <p>Les données collectées sont nécessaires au traitement de la commande. Elles sont traitées conformément à la politique de confidentialité du site.</p>
      ${loyaltyBlock}
      <h4>12. Médiation de la consommation</h4>
      <p>En cas de litige, la cliente peut d'abord contacter le vendeur à ${v(L.email)}. Si aucune solution n'est trouvée, elle peut recourir gratuitement à un médiateur de la consommation : ${v(L.mediator)}.</p>
      <h4>13. Droit applicable</h4>
      <p>Les présentes CGV sont soumises au droit français. Les litiges relèvent des tribunaux compétents, sans préjudice des règles protectrices applicables aux consommateurs.</p>`;
  }

  function privacy(L) {
    return `
      <p><em>Version du ${VERSION}</em></p>
      <h4>Qui est responsable de tes données ?</h4>
      <p>${editor(L)}</p>
      <h4>Quelles données, pourquoi, et combien de temps ?</h4>
      <p><strong>Commande</strong> (nom, email, adresse de livraison, contenu de la commande, éventuel message cadeau) : pour traiter, expédier et facturer ta commande (exécution du contrat). Conservation : durée nécessaire à la commande, puis 10 ans en archivage comptable (obligation légale).</p>
      <p><strong>Compte client</strong> (nom, email, mot de passe — chiffré et géré par Supabase, jamais lisible par la boutique —, points de fidélité, historique de commandes) : pour te permettre de te connecter et de cumuler des points. Conservation : jusqu'à la suppression du compte, ou après 3 ans sans activité.</p>
      <p><strong>Avis</strong> (prénom, note, commentaire, photo éventuelle) : publiés après modération, avec ton accord. Conservation : tant que l'avis est en ligne ou jusqu'à ta demande de retrait.</p>
      <p><strong>Alerte retour en stock</strong> (email, pièce et taille) : pour te prévenir une seule fois. Conservation : jusqu'à l'envoi de l'alerte ou jusqu'à désinscription (lien dans l'email).</p>
      <p><strong>Sécurité</strong> (adresse IP, journaux techniques) : pour protéger le site contre les abus et la fraude (intérêt légitime). Conservation courte.</p>
      <h4>Qui reçoit tes données ?</h4>
      <p>Uniquement les prestataires nécessaires au service : Supabase (base de données et comptes), PayPal (paiement), Resend (envoi des emails), et ${v(L.host)} (hébergement). Certains peuvent être situés hors de l'Union européenne ; ces transferts sont encadrés par des garanties appropriées (notamment clauses contractuelles types). Tes données ne sont ni vendues ni utilisées à des fins publicitaires.</p>
      <h4>Cookies et stockage local</h4>
      <p>Ce site utilise un cookie de session strictement nécessaire (connexion, sécurité) et le stockage de ton navigateur pour retenir ton panier et tes favoris. Il n'utilise aucun traceur publicitaire ni outil de mesure d'audience. PayPal peut déposer ses propres cookies au moment du paiement.</p>
      <h4>Tes droits</h4>
      <p>Tu peux demander l'accès, la rectification, l'effacement, la limitation, la portabilité de tes données ou t'opposer à leur traitement, en écrivant à ${v(L.email)}. Tu peux aussi introduire une réclamation auprès de la CNIL (<a href="https://www.cnil.fr" target="_blank" rel="noopener">cnil.fr</a>).</p>`;
  }

  window.AubeLegal = {
    page(key, config) {
      const L = (config && config.legal) || {};
      if (!L.email && config && config.contactEmail) L.email = config.contactEmail;
      if (key === 'cgv') return { title: 'Conditions générales de vente', html: cgv(L, { loyalty: config && config.loyalty }) };
      if (key === 'mentions') return { title: 'Mentions légales', html: mentions(L) };
      if (key === 'confidentialite') return { title: 'Politique de confidentialité', html: privacy(L) };
      return null;
    }
  };
})();
