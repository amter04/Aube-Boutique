(() => {
  const state = {
    products: [],
    cart: JSON.parse(localStorage.getItem('aube_cart') || '{}'),
    wishlist: JSON.parse(localStorage.getItem('aube_wishlist') || '[]'),
    activeCategory: 'Tout',
    searchQuery: '',
    sortMode: 'new',
    config: { paypalClientId: '', currency: 'EUR', shippingFlatCents: 0, freeShippingThresholdCents: null, testCheckout: true, loyalty: {} },
    paypalLoaded: false,
    paypalButtonsInstance: null,
    modalProduct: null,
    modalSelectedSize: null,
    modalImageIndex: 0,
    customer: null,
    redeemPoints: false,
    promo: null
  };

  const BADGE_LABELS = { promo: 'Promo', flash: 'Vente flash', tendance: 'Tendance' };
  const LOW_STOCK_THRESHOLD = 3;
  const NEW_PRODUCT_DAYS = 14;

  const DEFAULT_TEXTS = {
    handling: 'Commandes préparées sous 48 h ouvrées',
    returns: '14 jours pour changer d\'avis',
    payment: 'Paiement sécurisé'
  };
  function texts() { return { ...DEFAULT_TEXTS, ...(state.config.shopTexts || {}) }; }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function infoPage(key) {
    const L = state.config.loyalty || {};
    const flat = (state.config.shippingFlatCents || 0) / 100;
    const th = state.config.freeShippingThresholdCents;
    const t = texts();
    switch (key) {
      case 'livraison':
        return {
          title: 'Livraison',
          html: `<p>${flat > 0 ? `Les frais de livraison sont de <strong>${fmt(flat)}</strong>.` : 'La livraison est <strong>offerte</strong>.'}
            ${flat > 0 && th != null ? `Elle est <strong>offerte dès ${fmt(th / 100)}</strong> d'achat.` : ''}</p>
            <p>${t.handling}.</p>`
        };
      case 'retours':
        return {
          title: 'Retours & échanges',
          html: `<p>${t.returns}. Tu peux nous retourner ta commande à compter de sa réception, conformément au droit de rétractation.</p>`
        };
      case 'fidelite': {
        const perEuro = L.pointsPerEuro || 0;
        const worthOf100 = ((100 * (L.pointValueCents || 0)) / 100);
        if (!perEuro) return { title: 'Programme fidélité', html: '<p>Le programme de fidélité arrive bientôt.</p>' };
        return {
          title: 'Programme fidélité',
          html: `<p>Crée un compte et cumule des points à chaque commande : <strong>${perEuro} point${perEuro > 1 ? 's' : ''} par euro dépensé</strong> (hors livraison).</p>
            <p>100 points = <strong>${fmt(worthOf100)}</strong> de réduction${L.minRedeemPoints ? `, utilisables dès ${L.minRedeemPoints} points` : ''}.</p>`
        };
      }
      case 'contact':
        return {
          title: 'Contact',
          html: state.config.contactEmail
            ? `<p>Une question sur une commande ou une pièce ? Écris-nous à <a href="mailto:${state.config.contactEmail}">${state.config.contactEmail}</a>.</p>`
            : `<p>Une question ? Écris-nous directement sur nos réseaux sociaux ou par email.</p>`
        };
      case 'cgv':
        return { title: 'Conditions générales de vente', html: `<p>Conditions générales de vente de la boutique Aube.</p>` };
      case 'mentions':
        return { title: 'Mentions légales', html: `<p>Mentions légales de la boutique Aube.</p>` };
      case 'confidentialite':
        return { title: 'Politique de confidentialité', html: `<p>Politique de confidentialité et protection des données.</p>` };
      default:
        return { title: '', html: '' };
    }
  }

  const fmt = (n) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: state.config.currency || 'EUR' }).format(n);
  const el = (sel) => document.querySelector(sel);
  const grid = el('#product-grid');
  const filtersEl = el('#filters');
  const cartCount = el('#cart-count');
  const cartItemsEl = el('#cart-items');
  const cartTotalEl = el('#cart-total');
  const toastEl = el('#toast');

  function cartKey(productId, size) { return `${productId}::${size}`; }

  function saveCart() {
    localStorage.setItem('aube_cart', JSON.stringify(state.cart));
    renderCartCount();
  }

  function saveWishlist() {
    localStorage.setItem('aube_wishlist', JSON.stringify(state.wishlist));
    renderWishlistCount();
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  async function fetchJsonOptional(url) {
    try {
      const res = await fetch(url);
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.includes('application/json')) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async function loadConfig() {
    const res = await fetch('/api/config');
    state.config = await res.json();
    if (!state.config.testCheckout) {
      el('#checkout-note').textContent = "Paiement par carte ou compte PayPal, traité en toute sécurité par PayPal.";
      el('#footer-payment-note').textContent = 'Paiement sécurisé par PayPal · Carte bancaire acceptée';
    } else {
      el('#checkout-note').textContent = '';
      el('#footer-payment-note').textContent = 'Boutique en mode test — aucun paiement réel n\'est demandé pour le moment.';
    }
    applyConfigFlags();
  }

  function applyConfigFlags() {
    el('#promo-box').style.display = state.config.promoEnabled ? 'block' : 'none';
    el('#gift-box').style.display = state.config.giftNoteEnabled ? 'block' : 'none';
    el('#newsletter-box').style.display = state.config.newsletterEnabled ? 'block' : 'none';
  }

  async function loadProducts() {
    const res = await fetch('/api/products');
    state.products = await res.json();
  }

  let announceIndex = 0;
  let announceTimer = null;

  function freeShippingLabel() {
    const flat = state.config.shippingFlatCents || 0;
    const th = state.config.freeShippingThresholdCents;
    if (flat === 0) return 'Livraison offerte';
    if (th != null) return `Livraison offerte dès ${fmt(th / 100)} d'achat`;
    return null;
  }

  function buildAnnouncements() {
    const msgs = [];
    const custom = state.config.announcement;
    if (Array.isArray(custom)) msgs.push(...custom.filter(Boolean));
    else if (custom) msgs.push(custom);
    const ship = freeShippingLabel();
    if (ship) msgs.push(ship);
    const L = state.config.loyalty || {};
    if (L.pointsPerEuro > 0) msgs.push(`Programme fidélité : ${L.pointsPerEuro} point${L.pointsPerEuro > 1 ? 's' : ''} par euro dépensé`);
    msgs.push(texts().handling);
    return msgs;
  }

  function renderAnnounce() {
    const msgs = buildAnnouncements();
    const bar = el('#announce-bar');
    const textEl = el('#announce-text');
    clearInterval(announceTimer);
    if (!msgs.length) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    announceIndex = 0;
    textEl.textContent = msgs[0];
    if (msgs.length > 1) {
      announceTimer = setInterval(() => {
        textEl.classList.add('fade');
        setTimeout(() => {
          announceIndex = (announceIndex + 1) % msgs.length;
          textEl.textContent = msgs[announceIndex];
          textEl.classList.remove('fade');
        }, 300);
      }, 4500);
    }
  }

  function renderReassurance() {
    const t = texts();
    const ship = freeShippingLabel();
    const items = [
      { icon: '🚚', title: ship || 'Livraison', text: ship ? 'En France' : '' },
      { icon: '📦', title: 'Expédition rapide', text: t.handling },
      { icon: '↩️', title: 'Retours & échanges', text: t.returns },
      { icon: '🔒', title: t.payment, text: 'Carte bancaire ou PayPal' }
    ];
    el('#reassurance-grid').innerHTML = items.map(i => `
      <div class="reassure-item">
        <span class="reassure-icon">${i.icon}</span>
        <div><div class="reassure-title">${i.title}</div>${i.text ? `<div class="reassure-text">${i.text}</div>` : ''}</div>
      </div>
    `).join('');
  }

  let dropTimer = null;
  function renderNextDrop() {
    const nd = state.config.nextDrop;
    const section = el('#next-drop');
    clearInterval(dropTimer);
    if (!nd || !nd.date || new Date(nd.date).getTime() <= Date.now()) { section.style.display = 'none'; return; }
    section.style.display = '';
    el('#next-drop-title').textContent = nd.title || 'Nouvelle collection';
    el('#next-drop-text').textContent = nd.text || '';
    tickNextDrop();
    dropTimer = setInterval(tickNextDrop, 1000);
  }

  function tickNextDrop() {
    const nd = state.config.nextDrop;
    if (!nd || !nd.date) return;
    const diff = new Date(nd.date).getTime() - Date.now();
    if (diff <= 0) { el('#next-drop').style.display = 'none'; clearInterval(dropTimer); return; }
    const s = Math.floor(diff / 1000);
    el('#cd-days').textContent = Math.floor(s / 86400);
    el('#cd-hours').textContent = Math.floor((s % 86400) / 3600);
    el('#cd-mins').textContent = Math.floor((s % 3600) / 60);
    el('#cd-secs').textContent = s % 60;
  }

  async function loadCustomer() {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      state.customer = data.customer || null;
    } catch (e) {
      state.customer = null;
    }
    renderAccountButton();
  }

  function renderAccountButton() {
    const btn = el('#open-account');
    btn.classList.toggle('logged-in', !!state.customer);
    btn.title = state.customer ? `Mon compte (${state.customer.name})` : 'Mon compte';
  }

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    state.customer = null;
    state.redeemPoints = false;
    renderAccountButton();
    closeAccountDrawer();
    if (drawer.classList.contains('open')) renderCartDrawer();
    showToast('Déconnectée');
  }

  function orderStatusLabel(status) {
    const map = { paid: 'Payée', created: 'En attente', cancelled: 'Annulée' };
    return map[status] || status;
  }

  const authModal = el('#auth-modal');
  function openAuthModal(tab = 'login') {
    switchAuthTab(tab);
    authModal.classList.add('open');
  }
  function closeAuthModal() { authModal.classList.remove('open'); }
  el('#auth-close').addEventListener('click', closeAuthModal);
  authModal.addEventListener('click', (e) => { if (e.target === authModal) closeAuthModal(); });

  function switchAuthTab(tab) {
    el('#login-form').style.display = tab === 'login' ? 'block' : 'none';
    el('#register-form').style.display = tab === 'register' ? 'block' : 'none';
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    el('#login-error').textContent = '';
    el('#register-error').textContent = '';
  }
  document.querySelectorAll('.auth-tab').forEach(b => b.addEventListener('click', () => switchAuthTab(b.dataset.tab)));

  el('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el('#li-email').value.trim();
    const password = el('#li-password').value;
    const errorEl = el('#login-error');
    errorEl.textContent = '';
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) { errorEl.textContent = data.error || 'Connexion impossible.'; return; }
      state.customer = data.customer;
      renderAccountButton();
      closeAuthModal();
      if (drawer.classList.contains('open')) renderCartDrawer();
      showToast(`Bon retour, ${data.customer.name.split(' ')[0]} !`);
    } catch (err) {
      errorEl.textContent = 'Erreur réseau, réessaie.';
    } finally {
      btn.disabled = false;
    }
  });

  el('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el('#re-name').value.trim();
    const email = el('#re-email').value.trim();
    const password = el('#re-password').value;
    const errorEl = el('#register-error');
    errorEl.textContent = '';
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password })
      });
      const data = await res.json();
      if (!res.ok) { errorEl.textContent = data.error || 'Inscription impossible.'; return; }
      state.customer = data.customer;
      renderAccountButton();
      closeAuthModal();
      if (drawer.classList.contains('open')) renderCartDrawer();
      showToast(`Bienvenue, ${data.customer.name.split(' ')[0]} !`);
    } catch (err) {
      errorEl.textContent = 'Erreur réseau, réessaie.';
    } finally {
      btn.disabled = false;
    }
  });

  const accountOverlay = el('#account-overlay');
  const accountDrawer = el('#account-drawer');
  function openAccountDrawer() {
    accountOverlay.classList.add('open');
    accountDrawer.classList.add('open');
    renderAccountDrawer();
  }
  function closeAccountDrawer() {
    accountOverlay.classList.remove('open');
    accountDrawer.classList.remove('open');
  }
  el('#open-account').addEventListener('click', () => {
    if (state.customer) openAccountDrawer();
    else openAuthModal('login');
  });
  el('#close-account').addEventListener('click', closeAccountDrawer);
  accountOverlay.addEventListener('click', closeAccountDrawer);

  async function renderAccountDrawer() {
    if (!state.customer) { closeAccountDrawer(); return; }
    const body = el('#account-body');
    const loyalty = state.config.loyalty || {};
    const worth = ((state.customer.points || 0) * (loyalty.pointValueCents || 0)) / 100;
    body.innerHTML = `
      <div class="account-hero">
        <div class="acc-name">${state.customer.name}</div>
        <div class="acc-email">${state.customer.email}</div>
        <div class="points-value">${state.customer.points || 0}</div>
        <div class="points-label">points de fidélité</div>
        <div class="points-worth">soit ${fmt(worth)} de réduction à utiliser</div>
      </div>
      <p class="account-section-title">Mes commandes</p>
      <div id="account-orders-list"><p class="hint">Chargement…</p></div>
      <button class="btn secondary account-logout-btn" id="account-logout-btn">Se déconnecter</button>
    `;
    el('#account-logout-btn').addEventListener('click', logout);

    try {
      const res = await fetch('/api/account/orders');
      const orders = await res.json();
      const list = el('#account-orders-list');
      if (!orders.length) {
        list.innerHTML = `<p class="hint">Aucune commande pour l'instant — tes achats apparaîtront ici.</p>`;
        return;
      }
      list.innerHTML = orders.map(o => `
        <div class="mini-order">
          <div class="mo-top">
            <span>Commande n°${o.id}</span>
            <span class="mo-status">${orderStatusLabel(o.status)}</span>
          </div>
          <div class="mo-date">${new Date(o.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })} — ${fmt(o.total)}</div>
          ${o.pointsEarned ? `<div class="mo-points">+${o.pointsEarned} points gagnés${o.pointsRedeemed ? `, ${o.pointsRedeemed} utilisés` : ''}</div>` : ''}
        </div>
      `).join('');
    } catch (e) {
      el('#account-orders-list').innerHTML = `<p class="hint">Impossible de charger les commandes pour le moment.</p>`;
    }
  }

  el('#checkout-open-login').addEventListener('click', () => openAuthModal('login'));
  el('#cf-create-account').addEventListener('change', (e) => {
    el('#checkout-create-password-field').style.display = e.target.checked ? 'block' : 'none';
  });
  el('#cf-gift').addEventListener('change', (e) => {
    el('#gift-note-field').style.display = e.target.checked ? 'block' : 'none';
  });

  function badgesHtml(p) {
    if (!p.badges || p.badges.length === 0) return '';
    return `<div class="card-badges">${p.badges.map(b => `<span class="badge-pill ${b}">${BADGE_LABELS[b] || b}</span>`).join('')}</div>`;
  }

  function priceHtml(p) {
    if (p.discountPercent > 0) {
      return `<div class="price-row"><span class="price-strike">${fmt(p.price)}</span><span class="price-now">${fmt(p.finalPrice)}</span></div>`;
    }
    return `<div class="card-price">${fmt(p.price)}</div>`;
  }

  function isNewProduct(p) {
    if (!p.createdAt) return false;
    return (Date.now() - new Date(p.createdAt).getTime()) < NEW_PRODUCT_DAYS * 86400000;
  }

  function flashCountdownText(flashEndsAt) {
    if (!flashEndsAt) return '';
    const diff = new Date(flashEndsAt).getTime() - Date.now();
    if (diff <= 0) return '';
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      return `Se termine dans ${days} j`;
    }
    return `Se termine dans ${hours}h${String(mins).padStart(2, '0')}`;
  }

  function categoriesList() {
    return [...new Set(state.products.map(p => p.category).filter(Boolean))];
  }

  function selectCategory(cat, scroll) {
    state.activeCategory = cat;
    closeDropdown();
    renderFilters();
    renderCategoryDropdown();
    renderGrid();
    if (scroll) document.getElementById('collection').scrollIntoView({ behavior: 'smooth' });
  }

  function renderCategoryDropdown() {
    const cats = ['Tout', ...categoriesList()];
    const panel = el('#cat-dropdown-panel');
    panel.innerHTML = cats.map(c =>
      `<button data-cat="${c}" class="${c === state.activeCategory ? 'active' : ''}">${c}</button>`
    ).join('');
    panel.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => selectCategory(btn.dataset.cat, true));
    });
  }

  const dropdown = el('#cat-dropdown');
  function toggleDropdown() { dropdown.classList.toggle('open'); }
  function closeDropdown() { dropdown.classList.remove('open'); }
  el('#cat-dropdown-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(); });
  document.addEventListener('click', (e) => { if (!dropdown.contains(e.target)) closeDropdown(); });

  function renderFilters() {
    const cats = ['Tout', ...categoriesList()];
    filtersEl.innerHTML = cats.map(c =>
      `<button class="filter-chip ${c === state.activeCategory ? 'active' : ''}" data-cat="${c}">${c}</button>`
    ).join('');
    filtersEl.querySelectorAll('.filter-chip').forEach(btn => {
      btn.addEventListener('click', () => selectCategory(btn.dataset.cat, false));
    });
  }

  function renderUniverses() {
    const cats = categoriesList();
    const section = el('#universes');
    if (cats.length < 2) { section.style.display = 'none'; return; }
    section.style.display = '';
    el('#universes-grid').innerHTML = cats.map(c => {
      const inCat = state.products.filter(p => p.category === c);
      const cover = inCat.find(p => p.imageUrl);
      return `
        <button type="button" class="tile" data-cat="${c}">
          ${cover ? `<img src="${cover.imageUrl}" alt="${c}" loading="lazy">` : '<div class="tile-ph"></div>'}
          <span class="tile-label">${c}<small>${inCat.length} pièce${inCat.length > 1 ? 's' : ''}</small></span>
        </button>
      `;
    }).join('');
    el('#universes-grid').querySelectorAll('.tile').forEach(t => {
      t.addEventListener('click', () => selectCategory(t.dataset.cat, true));
    });
  }

  const searchInput = el('#search-input');
  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.searchQuery = searchInput.value.trim().toLowerCase();
      renderGrid();
    }, 150);
  });

  const sortSelect = el('#sort-select');
  sortSelect.addEventListener('change', () => {
    state.sortMode = sortSelect.value;
    renderGrid();
  });

  function sortItems(items) {
    const copy = [...items];
    switch (state.sortMode) {
      case 'price-asc': return copy.sort((a, b) => a.finalPrice - b.finalPrice);
      case 'price-desc': return copy.sort((a, b) => b.finalPrice - a.finalPrice);
      case 'name-asc': return copy.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
      case 'new':
      default: return copy.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
  }

  function isWishlisted(id) { return state.wishlist.includes(id); }

  function toggleWishlist(id) {
    if (isWishlisted(id)) {
      state.wishlist = state.wishlist.filter(x => x !== id);
      showToast('Retiré des favoris');
    } else {
      state.wishlist.push(id);
      showToast('Ajouté aux favoris');
    }
    saveWishlist();
    renderAllGrids();
    if (state.modalProduct) updateWishlistHeart();
    if (el('#wishlist-drawer').classList.contains('open')) renderWishlistDrawer();
  }

  function renderWishlistCount() {
    el('#wishlist-count').textContent = state.wishlist.length;
  }

  function renderWishlistDrawer() {
    const container = el('#wishlist-items');
    const items = state.products.filter(p => isWishlisted(p.id));
    if (items.length === 0) {
      container.innerHTML = `<div class="empty-state">
        <h3>Aucun favori</h3>
        <p>Cliquez sur le cœur d'une pièce pour la retrouver ici.</p>
      </div>`;
      return;
    }
    container.innerHTML = items.map(p => `
      <div class="cart-item" data-id="${p.id}">
        ${p.imageUrl ? `<img src="${p.imageUrl}" alt="${p.name}">` : `<div style="width:68px;height:88px;background:var(--paper-raised);"></div>`}
        <div class="cart-item-info">
          <div class="name">${p.name}</div>
          <div class="price">${fmt(p.finalPrice)}</div>
          <div class="qty-row">
            <button class="view-link">Voir la pièce</button>
          </div>
          <button class="remove-link">Retirer</button>
        </div>
      </div>
    `).join('');
    container.querySelectorAll('.cart-item').forEach(row => {
      const id = parseInt(row.dataset.id, 10);
      row.querySelector('.view-link').addEventListener('click', () => { closeWishlist(); openProductModal(id); });
      row.querySelector('.remove-link').addEventListener('click', () => toggleWishlist(id));
    });
  }

  const wishlistOverlay = el('#wishlist-overlay');
  const wishlistDrawer = el('#wishlist-drawer');
  function openWishlist() { wishlistOverlay.classList.add('open'); wishlistDrawer.classList.add('open'); renderWishlistDrawer(); }
  function closeWishlist() { wishlistOverlay.classList.remove('open'); wishlistDrawer.classList.remove('open'); }
  el('#open-wishlist').addEventListener('click', openWishlist);
  el('#close-wishlist').addEventListener('click', closeWishlist);
  wishlistOverlay.addEventListener('click', closeWishlist);

  function cardSizesHtml(p) {
    if (!p.sizes || p.sizes.length === 0) return '';
    if (p.sizes.length === 1 && p.sizes[0].size === 'TU') {
      return `<div class="card-sizes"><span class="sz ${p.sizes[0].inStock ? '' : 'out'}">Taille unique</span></div>`;
    }
    return `<div class="card-sizes">${p.sizes.map(s => `<span class="sz ${s.inStock ? '' : 'out'}">${s.size}</span>`).join('')}</div>`;
  }

  function cardHtml(p) {
    const countdown = p.badges && p.badges.includes('flash') ? flashCountdownText(p.flashEndsAt) : '';
    const images = p.images && p.images.length ? p.images : (p.imageUrl ? [p.imageUrl] : []);
    return `
      <a href="/produit/${p.slug}" class="card" data-id="${p.id}">
        <div class="card-media">
          ${images[0] ? `<img class="img-main" src="${images[0]}" alt="${p.name}" loading="lazy">` : `<div class="placeholder">Aube</div>`}
          ${images[1] ? `<img class="img-hover" src="${images[1]}" alt="${p.name}" loading="lazy">` : ''}
          ${!p.inStock ? '<span class="badge-out">Épuisé</span>' : (isNewProduct(p) ? '<span class="badge-new">Nouveau</span>' : '')}
          ${p.discountPercent > 0 ? `<span class="badge-discount">-${p.discountPercent}%</span>` : ''}
          <button type="button" class="card-heart ${isWishlisted(p.id) ? 'active' : ''}" data-wish="${p.id}" aria-label="Ajouter aux favoris">${isWishlisted(p.id) ? '♥' : '♡'}</button>
        </div>
        ${badgesHtml(p)}
        ${p.category ? `<div class="card-cat">${p.category}</div>` : ''}
        <div class="card-name">${p.name}</div>
        ${priceHtml(p)}
        ${cardSizesHtml(p)}
        ${p.inStock && p.stock <= LOW_STOCK_THRESHOLD ? `<div class="low-stock">Il reste ${p.stock} exemplaire${p.stock > 1 ? 's' : ''}</div>` : ''}
        ${countdown ? `<div class="flash-countdown">${countdown}</div>` : ''}
      </a>
    `;
  }

  function bindCardClicks(container) {
    container.querySelectorAll('.card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-heart')) return;
        e.preventDefault();
        openProductModal(parseInt(card.dataset.id, 10));
      });
    });
    container.querySelectorAll('.card-heart').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleWishlist(parseInt(btn.dataset.wish, 10));
      });
    });
  }

  function renderTrending() {
    const items = state.products.filter(p => p.badges && p.badges.length > 0);
    const section = el('#trending');
    if (items.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';
    el('#trending-count').textContent = `${items.length} pièce${items.length > 1 ? 's' : ''}`;
    el('#trending-grid').innerHTML = items.map(p => cardHtml(p)).join('');
    bindCardClicks(el('#trending-grid'));
  }

  function renderFeatured() {
    const items = state.products.filter(p => p.featured);
    const section = el('#featured');
    if (items.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';
    el('#featured-title').textContent = state.config.featuredTitle || 'Nos coups de cœur';
    el('#featured-count').textContent = `${items.length} pièce${items.length > 1 ? 's' : ''}`;
    el('#featured-grid').innerHTML = items.map(p => cardHtml(p)).join('');
    bindCardClicks(el('#featured-grid'));
  }

  function filteredItems() {
    let items = state.products.filter(p =>
      state.activeCategory === 'Tout' || p.category === state.activeCategory
    );
    if (state.searchQuery) {
      items = items.filter(p =>
        p.name.toLowerCase().includes(state.searchQuery) ||
        (p.description || '').toLowerCase().includes(state.searchQuery) ||
        (p.category || '').toLowerCase().includes(state.searchQuery)
      );
    }
    return sortItems(items);
  }

  function renderGrid() {
    const items = filteredItems();
    el('#product-count').textContent = `${items.length} pièce${items.length > 1 ? 's' : ''}`;

    if (items.length === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
        <h3>${state.searchQuery ? 'Aucun résultat' : 'La collection arrive bientôt'}</h3>
        <p>${state.searchQuery
          ? `Aucune pièce ne correspond à « ${searchInput.value.trim()} ».`
          : `Aucun produit n'a encore été ajouté${state.activeCategory !== 'Tout' ? ' dans cette catégorie' : ''}.`}</p>
      </div>`;
      return;
    }

    grid.innerHTML = items.map(p => cardHtml(p)).join('');
    bindCardClicks(grid);
  }

  function renderAllGrids() {
    renderFeatured();
    renderTrending();
    renderGrid();
  }

  // --- GESTION DES AVIS PRODUIT ---
  function renderStars(rating) {
    const full = Math.round(rating || 0);
    return '★'.repeat(full) + '☆'.repeat(5 - full);
  }

  async function loadProductReviews(productId) {
    const summaryEl = el('#reviews-summary');
    const listEl = el('#reviews-list');
    if (!listEl) return;

    try {
      const res = await fetch(`/api/products/${productId}/reviews`);
      if (!res.ok) return;
      
      const data = await res.json();

      if (el('#average-rating-stars')) el('#average-rating-stars').textContent = renderStars(data.averageRating);
      if (el('#average-rating-score')) el('#average-rating-score').textContent = `${data.averageRating || 0} / 5`;
      if (el('#total-reviews-count')) el('#total-reviews-count').textContent = `(${data.totalReviews || 0} avis)`;

      if (!data.reviews || data.reviews.length === 0) {
        listEl.innerHTML = '<p class="no-reviews">Aucun avis pour le moment sur cette pièce.</p>';
        return;
      }

      listEl.innerHTML = data.reviews.map(review => `
        <div class="review-card">
          <div class="review-header">
            <span class="review-author">${escapeHtml(review.authorName)}</span>
            <span class="review-stars">${renderStars(review.rating)}</span>
            <small class="review-date">${new Date(review.createdAt).toLocaleDateString('fr-FR')}</small>
          </div>
          <p class="review-comment">${escapeHtml(review.comment)}</p>
          ${review.imageUrl ? `
            <div class="review-image-wrap">
              <a href="${review.imageUrl}" target="_blank">
                <img src="${review.imageUrl}" alt="Photo de ${escapeHtml(review.authorName)}" />
              </a>
            </div>
          ` : ''}
        </div>
      `).join('');

    } catch (err) {
      console.error('Erreur chargement avis :', err);
    }
  }

  const reviewForm = el('#review-form');
  if (reviewForm) {
    reviewForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.modalProduct) {
        alert('Aucun produit sélectionné.');
        return;
      }

      const formData = new FormData(e.target);
      try {
        const res = await fetch(`/api/products/${state.modalProduct.id}/reviews`, {
          method: 'POST',
          body: formData
        });
        
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Erreur lors de l\'envoi de l\'avis.');

        alert(result.message);
        e.target.reset();
        loadProductReviews(state.modalProduct.id);
      } catch (err) {
        alert(err.message);
      }
    });
  }

  const modal = el('#product-modal');

  function productUrl(p) { return `/produit/${p.slug}`; }

  function openProductModal(id, pushHistory = true) {
    const p = state.products.find(x => x.id === id);
    if (!p) return;
    state.modalProduct = p;
    state.modalSelectedSize = (p.sizes && p.sizes.length === 1) ? p.sizes[0].size : null;
    state.modalImageIndex = 0;

    renderModalGallery();
    el('#modal-badges').innerHTML = badgesHtml(p);
    el('#modal-name').textContent = p.name;
    el('#modal-price').innerHTML = priceHtml(p);
    el('#modal-desc').textContent = p.description || '';
    updateWishlistHeart();
    renderSizePicker();
    updateModalAddButton();
    renderPerks(p);
    renderRelated(p);
    loadProductReviews(p.id);

    modal.classList.add('open');
    modal.querySelector('.modal-card').scrollTop = 0;

    if (pushHistory) {
      const url = productUrl(p);
      if (window.location.pathname !== url) history.pushState({ productId: p.id }, '', url);
    }
  }

  function closeProductModal(pushHistory = true) {
    modal.classList.remove('open');
    state.modalProduct = null;
    if (pushHistory && window.location.pathname.startsWith('/produit/')) {
      history.pushState({}, '', '/');
    }
  }

  function updateWishlistHeart() {
    const btn = el('#modal-wishlist-btn');
    const active = isWishlisted(state.modalProduct.id);
    btn.textContent = active ? '♥' : '♡';
    btn.classList.toggle('active', active);
  }
  el('#modal-wishlist-btn').addEventListener('click', () => toggleWishlist(state.modalProduct.id));

  function renderPerks(p) {
    const perks = [];
    const ship = freeShippingLabel();
    if (ship) perks.push(`🚚 ${ship}`);
    perks.push(`↩️ ${texts().returns}`);
    const L = state.config.loyalty || {};
    if (L.pointsPerEuro > 0) {
      const pts = Math.floor(p.finalPrice * L.pointsPerEuro);
      if (pts > 0) perks.push(`♡ +${pts} points fidélité avec un compte`);
    }
    el('#modal-perks').innerHTML = perks.map(x => `<li>${x}</li>`).join('');
  }

  function renderRelated(p) {
    const wrap = el('#modal-related-wrap');
    let list = [];
    
    if (p.ext && Array.isArray(p.ext.relatedIds) && p.ext.relatedIds.length > 0) {
      list = state.products.filter(x => p.ext.relatedIds.includes(x.id) && x.inStock);
    }

    if (list.length < 4) {
      const sameCat = state.products.filter(x => x.id !== p.id && x.inStock && p.category && x.category === p.category && !list.includes(x));
      const others = state.products.filter(x => x.id !== p.id && x.inStock && !sameCat.includes(x) && !list.includes(x));
      list = [...list, ...sameCat, ...others].slice(0, 4);
    }

    if (list.length === 0) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    el('#modal-related').innerHTML = list.map(x => `
      <button type="button" class="related-item" data-id="${x.id}">
        ${x.imageUrl ? `<img src="${x.imageUrl}" alt="${x.name}" loading="lazy">` : '<div class="tile-ph"></div>'}
        <span class="related-name">${x.name}</span>
        <span class="related-price">${fmt(x.finalPrice)}</span>
      </button>
    `).join('');
    el('#modal-related').querySelectorAll('.related-item').forEach(b => {
      b.addEventListener('click', () => openProductModal(parseInt(b.dataset.id, 10)));
    });
  }

  function renderModalGallery() {
    const p = state.modalProduct;
    const images = (p.images && p.images.length) ? p.images : (p.imageUrl ? [p.imageUrl] : []);
    el('#modal-img').src = images[state.modalImageIndex] || images[0] || '';
    const thumbs = el('#modal-thumbs');
    if (images.length <= 1) {
      thumbs.innerHTML = '';
      thumbs.style.display = 'none';
    } else {
      thumbs.style.display = 'flex';
      thumbs.innerHTML = images.map((src, i) => `
        <button type="button" class="thumb ${i === state.modalImageIndex ? 'active' : ''}" data-i="${i}">
          <img src="${src}" alt="Vue ${i + 1}">
        </button>
      `).join('');
      thumbs.querySelectorAll('.thumb').forEach(btn => {
        btn.addEventListener('click', () => {
          state.modalImageIndex = parseInt(btn.dataset.i, 10);
          renderModalGallery();
        });
      });
    }
  }

  const lightbox = el('#lightbox');
  const lightboxImg = el('#lightbox-img');
  el('#modal-main-img').addEventListener('click', () => {
    lightboxImg.src = el('#modal-img').src;
    lightbox.classList.add('open');
  });
  el('#lightbox-close').addEventListener('click', () => lightbox.classList.remove('open'));
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.classList.remove('open'); });

  let zoomedIn = false;
  lightboxImg.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomedIn = !zoomedIn;
    lightboxImg.classList.toggle('zoomed-in', zoomedIn);
  });
  lightboxImg.addEventListener('mousemove', (e) => {
    if (!zoomedIn) return;
    const rect = lightboxImg.getBoundingClientRect();
    const xPct = ((e.clientX - rect.left) / rect.width) * 100;
    const yPct = ((e.clientY - rect.top) / rect.height) * 100;
    lightboxImg.style.transformOrigin = `${xPct}% ${yPct}%`;
  });

  const sizeGuideModal = el('#size-guide-modal');
  el('#size-guide-link').addEventListener('click', () => sizeGuideModal.classList.add('open'));
  el('#size-guide-close').addEventListener('click', () => sizeGuideModal.classList.remove('open'));
  sizeGuideModal.addEventListener('click', (e) => { if (e.target === sizeGuideModal) sizeGuideModal.classList.remove('open'); });

  const infoModal = el('#info-modal');
  function openInfo(key) {
    const page = infoPage(key);
    el('#info-title').textContent = page.title;
    el('#info-body').innerHTML = page.html;
    infoModal.classList.add('open');
  }
  el('#info-close').addEventListener('click', () => infoModal.classList.remove('open'));
  infoModal.addEventListener('click', (e) => { if (e.target === infoModal) infoModal.classList.remove('open'); });
  document.querySelectorAll('.footer-link').forEach(b => b.addEventListener('click', () => openInfo(b.dataset.info)));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (lightbox.classList.contains('open')) lightbox.classList.remove('open');
    if (authModal.classList.contains('open')) closeAuthModal();
    if (accountDrawer.classList.contains('open')) closeAccountDrawer();
    if (infoModal.classList.contains('open')) infoModal.classList.remove('open');
    if (sizeGuideModal.classList.contains('open')) sizeGuideModal.classList.remove('open');
  });

  el('#modal-share').addEventListener('click', async () => {
    const url = window.location.origin + productUrl(state.modalProduct);
    try {
      await navigator.clipboard.writeText(url);
      showToast('Lien copié !');
    } catch (e) {
      showToast(url);
    }
  });

  function renderSizePicker() {
    const p = state.modalProduct;
    const container = el('#modal-sizes');
    if (!p.sizes || p.sizes.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = p.sizes.map(s => `
      <button type="button" class="size-opt ${s.size === state.modalSelectedSize ? 'selected' : ''} ${!s.inStock ? 'out' : ''}"
        data-size="${s.size}">${s.size}</button>
    `).join('');
    container.querySelectorAll('.size-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        state.modalSelectedSize = btn.dataset.size;
        renderSizePicker();
        updateModalAddButton();
      });
    });
  }

  function updateModalAddButton() {
    const p = state.modalProduct;
    const addBtn = el('#modal-add');
    const note = el('#modal-stock-note');
    const alertBox = el('#modal-alert');
    const alertsOn = !!state.config.stockAlertsEnabled;
    const hasSizes = p.sizes && p.sizes.length > 0;
    const selected = hasSizes ? p.sizes.find(s => s.size === state.modalSelectedSize) : null;

    alertBox.style.display = 'none';
    el('#alert-msg').textContent = '';
    note.textContent = '';
    addBtn.onclick = null;

    function showAlertBox() {
      alertBox.style.display = 'block';
      const emailInput = el('#alert-email');
      if (!emailInput.value && state.customer) emailInput.value = state.customer.email;
    }

    if (!p.inStock && !alertsOn) {
      addBtn.disabled = true;
      addBtn.textContent = 'Épuisé';
      return;
    }
    if (hasSizes && !selected) {
      addBtn.disabled = true;
      addBtn.textContent = 'Choisir une taille';
      return;
    }
    if (!hasSizes && !p.inStock) {
      addBtn.disabled = true;
      addBtn.textContent = 'Épuisé';
      if (alertsOn) showAlertBox();
      return;
    }
    if (hasSizes && selected && !selected.inStock) {
      addBtn.disabled = true;
      addBtn.textContent = 'Épuisé';
      if (alertsOn) showAlertBox();
      return;
    }
    if (hasSizes && selected) {
      note.textContent = selected.stock > 0 && selected.stock <= LOW_STOCK_THRESHOLD
        ? `Il reste ${selected.stock} exemplaire${selected.stock > 1 ? 's' : ''} dans cette taille`
        : '';
    }
    addBtn.disabled = false;
    addBtn.textContent = 'Ajouter au panier';
    addBtn.onclick = () => addToCart(p.id, state.modalSelectedSize || 'TU');
  }

  el('#alert-submit').addEventListener('click', async () => {
    const email = el('#alert-email').value.trim();
    const msg = el('#alert-msg');
    if (!email) { msg.textContent = 'Renseigne ton email.'; return; }
    const p = state.modalProduct;
    try {
      const res = await fetch('/api/stock-alerts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: p.id, size: state.modalSelectedSize, email })
      });
      const data = await res.json().catch(() => ({}));
      msg.textContent = res.ok ? 'C\'est noté, on te prévient dès que c\'est de retour !' : (data.error || 'Inscription impossible pour le moment.');
    } catch (e) {
      msg.textContent = 'Erreur réseau, réessaie.';
    }
  });

  el('#modal-close').addEventListener('click', () => closeProductModal());
  modal.addEventListener('click', (e) => { if (e.target === modal) closeProductModal(); });

  function addToCart(productId, size, qty = 1) {
    const key = cartKey(productId, size);
    state.cart[key] = (state.cart[key] || 0) + qty;
    state.promo = null;
    saveCart();
    renderCartDrawer();
    showToast('Ajouté au panier');
  }

  function setQty(key, qty) {
    if (qty <= 0) delete state.cart[key];
    else state.cart[key] = qty;
    state.promo = null;
    saveCart();
    renderCartDrawer();
  }

  function renderCartCount() {
    const total = Object.values(state.cart).reduce((a, b) => a + b, 0);
    cartCount.textContent = total;
  }

  function findProductAndSize(key) {
    const [idStr, size] = key.split('::');
    const p = state.products.find(x => x.id === parseInt(idStr, 10));
    return { product: p, size };
  }

  function unitPrice(p) { return p.discountPercent > 0 ? p.finalPrice : p.price; }

  function cartSubtotal() {
    let total = 0;
    for (const [key, qty] of Object.entries(state.cart)) {
      const { product } = findProductAndSize(key);
      if (product) total += unitPrice(product) * qty;
    }
    return total;
  }

  function shippingAmount(subtotal) {
    const threshold = state.config.freeShippingThresholdCents;
    const flat = (state.config.shippingFlatCents || 0) / 100;
    if (threshold != null && subtotal * 100 >= threshold) return 0;
    return flat;
  }

  function renderCartProgress(subtotal) {
    const box = el('#cart-progress');
    const th = state.config.freeShippingThresholdCents;
    const flat = state.config.shippingFlatCents || 0;
    if (th == null || flat === 0 || subtotal <= 0) { box.style.display = 'none'; return; }
    const target = th / 100;
    const remaining = target - subtotal;
    box.style.display = 'block';
    if (remaining > 0) {
      const pct = Math.min(100, Math.round((subtotal / target) * 100));
      box.innerHTML = `
        <div class="progress-text">Plus que <strong>${fmt(remaining)}</strong> pour la livraison offerte</div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>`;
    } else {
      box.innerHTML = `
        <div class="progress-text">🎉 Livraison offerte sur cette commande !</div>
        <div class="progress-track"><div class="progress-fill done" style="width:100%"></div></div>`;
    }
  }

  function cartSuggestionsHtml() {
    const inCartIds = new Set(Object.keys(state.cart).map(k => parseInt(k.split('::')[0], 10)));
    const cartCats = new Set([...inCartIds].map(id => (state.products.find(p => p.id === id) || {}).category).filter(Boolean));
    const candidates = state.products.filter(p => p.inStock && !inCartIds.has(p.id));
    candidates.sort((a, b) => (cartCats.has(b.category) ? 1 : 0) - (cartCats.has(a.category) ? 1 : 0));
    const list = candidates.slice(0, 3);
    if (list.length === 0) return '';
    return `
      <div class="cart-suggest">
        <p class="suggest-title">Vous aimerez aussi</p>
        <div class="suggest-row">
          ${list.map(p => `
            <button type="button" class="suggest-item" data-id="${p.id}">
              ${p.imageUrl ? `<img src="${p.imageUrl}" alt="${p.name}" loading="lazy">` : '<div class="tile-ph"></div>'}
              <span class="suggest-name">${p.name}</span>
              <span class="suggest-price">${fmt(p.finalPrice)}</span>
            </button>
          `).join('')}
        </div>
      </div>`;
  }

  function updateTotals() {
    const L = state.config.loyalty || {};
    const subtotal = cartSubtotal();
    const shipping = shippingAmount(subtotal);
    const promoAmount = state.promo ? (state.promo.discountCents || 0) / 100 : 0;
    let loyaltyAmount = 0;
    if (state.config.testCheckout && state.customer && state.redeemPoints) {
      loyaltyAmount = (checkoutMaxRedeemablePoints() * (L.pointValueCents || 0)) / 100;
    }

    el('#cart-subtotal').textContent = fmt(subtotal);
    el('#cart-shipping').textContent = shipping > 0 ? fmt(shipping) : 'Offerte';

    const promoRow = el('#cart-promo-row');
    if (promoAmount > 0) {
      promoRow.style.display = 'flex';
      el('#cart-promo-label').textContent = `Code ${state.promo.code}`;
      el('#cart-promo-amount').textContent = `− ${fmt(promoAmount)}`;
    } else {
      promoRow.style.display = 'none';
    }

    const loyaltyRow = el('#cart-loyalty-row');
    if (loyaltyAmount > 0) {
      loyaltyRow.style.display = 'flex';
      el('#cart-loyalty-amount').textContent = `− ${fmt(loyaltyAmount)}`;
    } else {
      loyaltyRow.style.display = 'none';
    }

    cartTotalEl.textContent = fmt(Math.max(0, subtotal + shipping - promoAmount - loyaltyAmount));
  }

  function renderCartDrawer() {
    const entries = Object.entries(state.cart);
    if (entries.length === 0) {
      cartItemsEl.innerHTML = `<div class="empty-state">
        <h3>Panier vide</h3>
        <p>Parcourez la collection pour ajouter une pièce.</p>
      </div>`;
      cartTotalEl.textContent = fmt(0);
      el('#cart-subtotal').textContent = fmt(0);
      el('#cart-shipping').textContent = fmt(0);
      el('#cart-promo-row').style.display = 'none';
      el('#cart-loyalty-row').style.display = 'none';
      el('#cart-progress').style.display = 'none';
      el('#paypal-buttons-container').innerHTML = '';
      el('#test-checkout-form').style.display = 'none';
      return;
    }

    cartItemsEl.innerHTML = entries.map(([key, qty]) => {
      const { product: p, size } = findProductAndSize(key);
      if (!p) return '';
      return `
        <div class="cart-item" data-key="${key}">
          ${p.imageUrl ? `<img src="${p.imageUrl}" alt="${p.name}">` : `<div style="width:68px;height:88px;background:var(--paper-raised);"></div>`}
          <div class="cart-item-info">
            <div class="name">${p.name}</div>
            ${size && size !== 'TU' ? `<div class="size-label">Taille ${size}</div>` : ''}
            <div class="price">${fmt(unitPrice(p))}</div>
            <div class="qty-row">
              <button class="qty-minus">−</button>
              <span>${qty}</span>
              <button class="qty-plus">+</button>
            </div>
            <button class="remove-link">Retirer</button>
          </div>
        </div>
      `;
    }).join('') + cartSuggestionsHtml();

    cartItemsEl.querySelectorAll('.cart-item').forEach(row => {
      const key = row.dataset.key;
      const currentQty = state.cart[key];
      row.querySelector('.qty-minus').addEventListener('click', () => setQty(key, currentQty - 1));
      row.querySelector('.qty-plus').addEventListener('click', () => setQty(key, currentQty + 1));
      row.querySelector('.remove-link').addEventListener('click', () => setQty(key, 0));
    });
    cartItemsEl.querySelectorAll('.suggest-item').forEach(b => {
      b.addEventListener('click', () => { closeCart(); openProductModal(parseInt(b.dataset.id, 10)); });
    });

    renderCartProgress(cartSubtotal());

    if (state.config.testCheckout) {
      el('#test-checkout-form').style.display = 'block';
      el('#paypal-buttons-container').innerHTML = '';
      renderCheckoutAccountArea();
    } else {
      el('#test-checkout-form').style.display = 'none';
      renderPaypalButtons();
    }
    updateTotals();
  }

  el('#promo-apply').addEventListener('click', async () => {
    const code = el('#promo-input').value.trim();
    const msg = el('#promo-msg');
    msg.textContent = '';
    if (!code) return;
    try {
      const res = await fetch('/api/promo/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          subtotalCents: Math.round(cartSubtotal() * 100),
          email: state.customer ? state.customer.email : (el('#cf-email').value.trim() || null)
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { state.promo = null; msg.textContent = data.error || 'Code invalide.'; updateTotals(); return; }
      state.promo = { code: data.code || code.toUpperCase(), discountCents: data.discountCents || 0, label: data.label || '' };
      msg.textContent = data.label || 'Code appliqué !';
      updateTotals();
    } catch (e) {
      msg.textContent = 'Erreur réseau, réessaie.';
    }
  });

  function checkoutMaxRedeemablePoints() {
    const loyalty = state.config.loyalty || {};
    if (!state.customer || !loyalty.pointValueCents) return 0;
    const subtotalCents = Math.round(cartSubtotal() * 100);
    const maxByBalance = state.customer.points || 0;
    const maxBySubtotal = Math.floor(subtotalCents / loyalty.pointValueCents);
    return Math.max(0, Math.min(maxByBalance, maxBySubtotal));
  }

  function renderCheckoutAccountArea() {
    const accountBox = el('#checkout-account-box');
    const guestFields = el('#checkout-guest-fields');
    const loyaltyBox = el('#checkout-loyalty-box');
    const loyalty = state.config.loyalty || {};

    if (state.customer) {
      guestFields.style.display = 'none';
      accountBox.style.display = 'block';
      accountBox.innerHTML = `
        <div class="acc-name">Connectée en tant que ${state.customer.name}</div>
        <div class="acc-email">${state.customer.email}</div>
        <button type="button" class="acc-logout">Pas moi, changer de compte</button>
      `;
      accountBox.querySelector('.acc-logout').addEventListener('click', async () => {
        await logout();
        renderCheckoutAccountArea();
      });

      const maxRedeem = checkoutMaxRedeemablePoints();
      const minRedeem = loyalty.minRedeemPoints || 0;
      if (maxRedeem > 0 && maxRedeem >= minRedeem) {
        const discount = (maxRedeem * (loyalty.pointValueCents || 0)) / 100;
        loyaltyBox.style.display = 'block';
        loyaltyBox.innerHTML = `
          <label>
            <input type="checkbox" id="cf-redeem-points" ${state.redeemPoints ? 'checked' : ''}>
            <span>Utiliser mes ${state.customer.points} points fidélité (− ${fmt(discount)} sur cette commande)</span>
          </label>
        `;
        el('#cf-redeem-points').addEventListener('change', (e) => {
          state.redeemPoints = e.target.checked;
          updateTotals();
        });
      } else {
        loyaltyBox.style.display = 'none';
        state.redeemPoints = false;
      }
    } else {
      accountBox.style.display = 'none';
      guestFields.style.display = 'block';
      loyaltyBox.style.display = 'none';
      state.redeemPoints = false;
    }
  }

  el('#test-checkout-submit').addEventListener('click', async () => {
    const errorEl = el('#checkout-error');
    errorEl.textContent = '';

    const address = el('#cf-address').value.trim();
    const postalCode = el('#cf-postal').value.trim();
    const city = el('#cf-city').value.trim();

    let payload;
    if (state.customer) {
      payload = {
        customer: { name: state.customer.name, email: state.customer.email, address, postalCode, city },
        redeemPoints: state.redeemPoints ? checkoutMaxRedeemablePoints() : 0
      };
    } else {
      const name = el('#cf-name').value.trim();
      const email = el('#cf-email').value.trim();
      if (!name || !email) {
        errorEl.textContent = 'Merci de renseigner au moins ton nom et ton email.';
        return;
      }
      payload = { customer: { name, email, address, postalCode, city } };
      if (el('#cf-create-account').checked) {
        const password = el('#cf-password').value;
        if (!password || password.length < 6) {
          errorEl.textContent = "Choisis un mot de passe d'au moins 6 caractères pour créer ton compte.";
          return;
        }
        payload.createAccount = true;
        payload.password = password;
      }
    }

    if (state.promo) payload.promoCode = state.promo.code;
    if (state.config.giftNoteEnabled && el('#cf-gift').checked) {
      payload.giftNote = el('#cf-gift-note').value.trim();
    }

    payload.items = Object.keys(state.cart).map(key => {
      const [idStr, size] = key.split('::');
      return { productId: parseInt(idStr, 10), size, qty: state.cart[key] };
    });

    const btn = el('#test-checkout-submit');
    btn.disabled = true;
    btn.textContent = 'Validation…';
    try {
      const res = await fetch('/api/checkout/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || 'Erreur lors de la validation de la commande.';
        btn.disabled = false;
        btn.textContent = 'Valider la commande (mode test)';
        return;
      }
      state.cart = {};
      state.redeemPoints = false;
      state.promo = null;
      saveCart();
      if (!state.customer) { await loadCustomer(); }
      window.location.href = `/commande/${data.token}`;
    } catch (e) {
      errorEl.textContent = 'Erreur réseau, réessaie.';
      btn.disabled = false;
      btn.textContent = 'Valider la commande (mode test)';
    }
  });

  function loadPaypalSdk() {
    return new Promise((resolve, reject) => {
      if (state.paypalLoaded) return resolve();
      if (!state.config.paypalClientId) return reject(new Error('no-client-id'));
      const script = document.createElement('script');
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(state.config.paypalClientId)}&currency=${encodeURIComponent(state.config.currency)}&intent=capture`;
      script.onload = () => { state.paypalLoaded = true; resolve(); };
      script.onerror = () => reject(new Error('sdk-failed'));
      document.head.appendChild(script);
    });
  }

  async function renderPaypalButtons() {
    const container = el('#paypal-buttons-container');
    container.innerHTML = '';
    if (Object.keys(state.cart).length === 0) return;

    try {
      await loadPaypalSdk();
    } catch (err) {
      container.innerHTML = `<p style="font-size:13px;color:#A5332A;">Paiement indisponible pour le moment.</p>`;
      return;
    }

    if (state.paypalButtonsInstance) {
      try { state.paypalButtonsInstance.close(); } catch (e) {}
    }

    state.paypalButtonsInstance = window.paypal.Buttons({
      style: { layout: 'vertical', color: 'black', shape: 'rect', label: 'pay' },
      createOrder: async () => {
        const items = Object.keys(state.cart).map(key => {
          const [idStr, size] = key.split('::');
          return { productId: parseInt(idStr, 10), size, qty: state.cart[key] };
        });
        const body = { items };
        if (state.promo) body.promoCode = state.promo.code;
        const res = await fetch('/api/paypal/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Erreur lors de la création de la commande'); throw new Error(data.error); }
        return data.id;
      },
      onApprove: async (data) => {
        const res = await fetch(`/api/paypal/capture-order/${data.orderID}`, { method: 'POST' });
        const result = await res.json();
        if (result.status === 'paid') {
          state.cart = {};
          state.promo = null;
          saveCart();
          closeCart();
          if (result.token) {
            window.location.href = `/commande/${result.token}`;
          } else {
            await loadProducts();
            renderAllGrids();
            showToast('Merci ! Votre commande est confirmée.');
          }
        } else {
          showToast("Le paiement n'a pas pu être confirmé.");
        }
      },
      onError: () => showToast('Une erreur est survenue pendant le paiement.')
    });
    state.paypalButtonsInstance.render('#paypal-buttons-container');
  }

  const overlay = el('#overlay');
  const drawer = el('#cart-drawer');
  function openCart() {
    overlay.classList.add('open');
    drawer.classList.add('open');
    renderCartDrawer();
  }
  function closeCart() {
    overlay.classList.remove('open');
    drawer.classList.remove('open');
  }
  el('#open-cart').addEventListener('click', openCart);
  el('#close-cart').addEventListener('click', closeCart);
  overlay.addEventListener('click', closeCart);

  el('#newsletter-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el('#newsletter-email').value.trim();
    const msg = el('#newsletter-msg');
    msg.textContent = '';
    if (!email) return;
    try {
      const res = await fetch('/api/newsletter', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        msg.textContent = data.message || 'Merci, tu es inscrite !';
        el('#newsletter-email').value = '';
      } else {
        msg.textContent = data.error || 'Inscription impossible pour le moment.';
      }
    } catch (err) {
      msg.textContent = 'Erreur réseau, réessaie.';
    }
  });

  function openProductFromUrl() {
    const match = window.location.pathname.match(/^\/produit\/(\d+)/);
    if (match) {
      const id = parseInt(match[1], 10);
      if (state.products.some(p => p.id === id)) openProductModal(id, false);
    }
  }

  window.addEventListener('popstate', () => {
    const match = window.location.pathname.match(/^\/produit\/(\d+)/);
    if (match) {
      openProductModal(parseInt(match[1], 10), false);
    } else {
      modal.classList.remove('open');
      state.modalProduct = null;
    }
  });

  function connectRealtime() {
    try {
      const source = new EventSource('/api/stream');
      source.addEventListener('products-updated', async () => {
        await loadProducts();
        renderCategoryDropdown();
        renderFilters();
        renderUniverses();
        renderAllGrids();
        if (drawer.classList.contains('open')) renderCartDrawer();
      });
      source.onerror = () => {};
    } catch (e) {}
  }

  setInterval(() => {
    if (el('#trending').style.display !== 'none') renderTrending();
    if (state.modalProduct && modal.classList.contains('open')) renderSizePicker();
  }, 60000);

  (async function init() {
    el('#year').textContent = new Date().getFullYear();
    await loadConfig();
    await Promise.all([loadProducts(), loadCustomer()]);
    renderAnnounce();
    renderReassurance();
    renderNextDrop();
    renderCategoryDropdown();
    renderFilters();
    renderUniverses();
    renderAllGrids();
    renderCartCount();
    renderWishlistCount();
    connectRealtime();
    openProductFromUrl();
  })();
})();
