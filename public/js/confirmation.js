(() => {
  const fmt = (n) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n);
  const main = document.getElementById('confirm-main');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let flash = '';
  try { flash = sessionStorage.getItem('aube_flash') || ''; sessionStorage.removeItem('aube_flash'); } catch (e) {}

  function tokenFromUrl() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    // /commande/:token
    return parts.length >= 2 ? parts[1] : null;
  }

  function renderError() {
    main.innerHTML = `
      <h1 style="font-size:26px; margin-bottom:14px;">Commande introuvable</h1>
      <p style="color:#6B655D;">Le lien utilisé n'est plus valide, ou la commande n'existe pas.</p>
      <a href="/" class="btn wine" style="margin-top:20px;">Retour à la boutique</a>
    `;
  }

  function renderOrder(o) {
    const isTest = o.source === 'test';
    document.title = `Commande n°${o.id} confirmée — Aube`;
    main.innerHTML = `
      ${isTest ? `<div class="test-banner">🧪 Commande passée en mode test — aucun paiement réel n'a été effectué.</div>` : ''}
      <div class="confirm-check">✓</div>
      <h1 style="font-size:30px; margin-bottom:6px;">Commande confirmée</h1>
      <p style="color:#6B655D;">Merci ${o.payerName ? esc(o.payerName.split(' ')[0]) : ''} ! Un récapitulatif a été envoyé par email si une adresse a été renseignée.</p>

      <div class="confirm-card">
        <div class="confirm-row"><span>Numéro de commande</span><strong>#${o.id}</strong></div>
        <div class="confirm-row"><span>Date</span><span>${new Date(o.createdAt).toLocaleString('fr-FR')}</span></div>
        <div class="confirm-row"><span>Statut</span><span>${o.status === 'paid' ? 'Confirmée' : o.status}</span></div>
        ${o.payerEmail ? `<div class="confirm-row"><span>Email</span><span>${esc(o.payerEmail)}</span></div>` : ''}
        ${o.customer && o.customer.address ? `<div class="confirm-row"><span>Adresse de livraison</span><span>${esc(o.customer.address)}, ${esc(o.customer.postalCode || '')} ${esc(o.customer.city || '')}</span></div>` : ''}
      </div>

      <div class="confirm-card confirm-items">
        <h3 style="font-size:16px; margin-bottom:10px;">Articles</h3>
        ${o.items.map(it => `
          <div class="item-line">
            <span>${esc(it.name)}${it.color ? ` — ${esc(it.color)}` : ''}${it.size && it.size !== 'TU' ? ` — taille ${esc(it.size)}` : ''} × ${it.qty}</span>
            <span>${fmt(it.priceCents * it.qty / 100)}</span>
          </div>
        `).join('')}
        <div class="confirm-row" style="margin-top:8px;"><span>Sous-total</span><span>${fmt(o.subtotal)}</span></div>
        <div class="confirm-row"><span>Livraison</span><span>${o.shipping > 0 ? fmt(o.shipping) : 'Offerte'}</span></div>
        ${o.discount > 0 ? `<div class="confirm-row"><span>Remise fidélité (${o.pointsRedeemed} points)</span><span>− ${fmt(o.discount)}</span></div>` : ''}
        <div class="confirm-row confirm-total"><span>Total</span><strong>${fmt(o.total)}</strong></div>
      </div>

      ${o.pointsEarned > 0 ? `
        <div class="confirm-card confirm-loyalty">
          <span class="confirm-loyalty-icon">★</span>
          <div>
            <strong>+${o.pointsEarned} points de fidélité gagnés</strong>
            <p>Retrouve ton solde de points dans « Mon compte », sur la boutique.</p>
          </div>
        </div>
      ` : ''}

      ${flash ? `<div class="confirm-card"><p style="margin:0;">${esc(flash)}</p></div>` : ''}
      <a href="/" class="btn wine" style="margin-top:28px;">Continuer mes achats</a>
    `;
  }

  (async function init() {
    const token = tokenFromUrl();
    if (!token) return renderError();
    try {
      const res = await fetch(`/api/orders/token/${token}`);
      if (!res.ok) return renderError();
      const order = await res.json();
      renderOrder(order);
    } catch (e) {
      renderError();
    }
  })();
})();

