(() => {
  const state = {
    products: [],
    cart: JSON.parse(localStorage.getItem('aube_cart') || '{}'), // { "productId::size": qty }
    wishlist: JSON.parse(localStorage.getItem('aube_wishlist') || '[]'), // [productId, ...]
    activeCategory: 'Tout',
    searchQuery: '',
    sortMode: 'new',
    config: { paypalClientId: '', currency: 'EUR', shippingFlatCents: 0, freeShippingThresholdCents: null, testCheckout: true },
    paypalLoaded: false,
    paypalButtonsInstance: null,
    modalProduct: null,
    modalSelectedSize: null,
    modalImageIndex: 0
  };

  const BADGE_LABELS = { promo: 'Promo', flash: 'Vente flash', tendance: 'Tendance' };
  const LOW_STOCK_THRESHOLD = 3;

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

  // ---------- Load data ----------
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
  }

  async function loadProducts() {
    const res = await fetch('/api/products');
    state.products = await res.json();
  }

  // ---------- Badges / promo helpers ----------
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

  // ---------- Render: category dropdown ----------
  function renderCategoryDropdown() {
    const cats = ['Tout', ...new Set(state.products.map(p => p.category).filter(Boolean))];
    const panel = el('#cat-dropdown-panel');
    panel.innerHTML = cats.map(c =>
      `<button data-cat="${c}" class="${c === state.activeCategory ? 'active' : ''}">${c}</button>`
    ).join('');
    panel.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeCategory = btn.dataset.cat;
        closeDropdown();
        renderFilters();
        renderGrid();
        document.getElementById('collection').scrollIntoView({ behavior: 'smooth' });
      });
    });
  }

  const dropdown = el('#cat-dropdown');
  function toggleDropdown() { dropdown.classList.toggle('open'); }
  function closeDropdown() { dropdown.classList.remove('open'); }
  el('#cat-dropdown-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(); });
  document.addEventListener('click', (e) => { if (!dropdown.contains(e.target)) closeDropdown(); });

  // ---------- Render: filter chips ----------
  function renderFilters() {
    const cats = ['Tout', ...new Set(state.products.map(p => p.category).filter(Boolean))];
    filtersEl.innerHTML = cats.map(c =>
      `<button class="filter-chip ${c === state.activeCategory ? 'active' : ''}" data-cat="${c}">${c}</button>`
    ).join('');
    filtersEl.querySelectorAll('.filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeCategory = btn.dataset.cat;
        renderFilters();
        renderCategoryDropdown();
        renderGrid();
      });
    });
  }

  // ---------- Search ----------
  const searchInput = el('#search-input');
  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.searchQuery = searchInput.value.trim().toLowerCase();
      renderGrid();
    }, 150);
  });

  // ---------- Sort ----------
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

  // ---------- Wishlist ----------
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
    renderGrid();
    renderTrending();
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

  // ---------- Render: trending / promo section ----------
  function renderTrending() {
    const items = state.products.filter(p => p.badges && p.badges.length > 0);
    const section = el('#trending');
    if (items.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';
    el('#trending-count').textContent = `${items.length} pièce${items.length > 1 ? 's' : ''}`;
    el('#trending-grid').innerHTML = items.map(p => cardHtml(p)).join('');
    bindCardClicks(el('#trending-grid'));
  }

  // ---------- Render: product card ----------
  function cardHtml(p) {
    const countdown = p.badges && p.badges.includes('flash') ? flashCountdownText(p.flashEndsAt) : '';
    const images = p.images && p.images.length ? p.images : (p.imageUrl ? [p.imageUrl] : []);
    return `
      <a href="/produit/${p.slug}" class="card" data-id="${p.id}">
        <div class="card-media">
          ${images[0] ? `<img class="img-main" src="${images[0]}" alt="${p.name}">` : `<div class="placeholder">Aube</div>`}
          ${images[1] ? `<img class="img-hover" src="${images[1]}" alt="${p.name}">` : ''}
          ${!p.inStock ? '<span class="badge-out">Épuisé</span>' : ''}
          <button type="button" class="card-heart ${isWishlisted(p.id) ? 'active' : ''}" data-wish="${p.id}" aria-label="Ajouter aux favoris">${isWishlisted(p.id) ? '♥' : '♡'}</button>
        </div>
        ${badgesHtml(p)}
        ${p.category ? `<div class="card-cat">${p.category}</div>` : ''}
        <div class="card-name">${p.name}</div>
        ${priceHtml(p)}
        ${p.inStock && p.stock <= LOW_STOCK_THRESHOLD ? `<div class="low-stock">Il reste ${p.stock} exemplaire${p.stock > 1 ? 's' : ''}</div>` : ''}
        ${countdown ? `<div class="flash-countdown">${countdown}</div>` : ''}
      </a>
    `;
  }

  function bindCardClicks(container) {
    container.querySelectorAll('.card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-heart')) return; // gere separement
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

  // ---------- Render: grid ----------
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

  // ---------- Product modal ----------
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
    modal.classList.add('open');

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

  // ---------- Zoom (clic pour zoomer en plein ecran) ----------
  const lightbox = el('#lightbox');
  const lightboxImg = el('#lightbox-img');
  el('#modal-main-img').addEventListener('click', () => {
    lightboxImg.src = el('#modal-img').src;
    lightbox.classList.add('open');
  });
  el('#lightbox-close').addEventListener('click', () => lightbox.classList.remove('open'));
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.classList.remove('open'); });
  // Zoom suiveur de souris sur desktop, pour voir le detail du tissu au survol
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
  lightbox.addEventListener('transitionend', () => {}, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox.classList.contains('open')) lightbox.classList.remove('open');
  });

  // ---------- Size guide ----------
  const sizeGuideModal = el('#size-guide-modal');
  el('#size-guide-link').addEventListener('click', () => sizeGuideModal.classList.add('open'));
  el('#size-guide-close').addEventListener('click', () => sizeGuideModal.classList.remove('open'));
  sizeGuideModal.addEventListener('click', (e) => { if (e.target === sizeGuideModal) sizeGuideModal.classList.remove('open'); });

  // ---------- Share link ----------
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
        data-size="${s.size}" ${!s.inStock ? 'disabled' : ''}>${s.size}</button>
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
    const hasSizes = p.sizes && p.sizes.length > 0;
    const selected = hasSizes ? p.sizes.find(s => s.size === state.modalSelectedSize) : null;

    if (!p.inStock) {
      addBtn.disabled = true;
      addBtn.textContent = 'Épuisé';
      note.textContent = '';
      return;
    }
    if (hasSizes && !state.modalSelectedSize) {
      addBtn.disabled = true;
      addBtn.textContent = 'Choisir une taille';
      note.textContent = '';
      return;
    }
    if (hasSizes && selected) {
      addBtn.disabled = !selected.inStock;
      note.textContent = selected.stock > 0 && selected.stock <= LOW_STOCK_THRESHOLD
        ? `Il reste ${selected.stock} exemplaire${selected.stock > 1 ? 's' : ''} dans cette taille`
        : '';
    } else {
      note.textContent = '';
    }
    addBtn.textContent = 'Ajouter au panier';
    addBtn.onclick = () => addToCart(p.id, state.modalSelectedSize || 'TU');
  }

  el('#modal-close').addEventListener('click', () => closeProductModal());
  modal.addEventListener('click', (e) => { if (e.target === modal) closeProductModal(); });

  // ---------- Cart ----------
  function addToCart(productId, size, qty = 1) {
    const key = cartKey(productId, size);
    state.cart[key] = (state.cart[key] || 0) + qty;
    saveCart();
    renderCartDrawer();
    showToast('Ajouté au panier');
  }

  function setQty(key, qty) {
    if (qty <= 0) delete state.cart[key];
    else state.cart[key] = qty;
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
    }).join('');

    cartItemsEl.querySelectorAll('.cart-item').forEach(row => {
      const key = row.dataset.key;
      const currentQty = state.cart[key];
      row.querySelector('.qty-minus').addEventListener('click', () => setQty(key, currentQty - 1));
      row.querySelector('.qty-plus').addEventListener('click', () => setQty(key, currentQty + 1));
      row.querySelector('.remove-link').addEventListener('click', () => setQty(key, 0));
    });

    const subtotal = cartSubtotal();
    const shipping = shippingAmount(subtotal);
    el('#cart-subtotal').textContent = fmt(subtotal);
    el('#cart-shipping').textContent = shipping > 0 ? fmt(shipping) : 'Offerte';
    cartTotalEl.textContent = fmt(subtotal + shipping);

    if (state.config.testCheckout) {
      el('#test-checkout-form').style.display = 'block';
      el('#paypal-buttons-container').innerHTML = '';
    } else {
      el('#test-checkout-form').style.display = 'none';
      renderPaypalButtons();
    }
  }

  // ---------- Checkout test (sans paiement) ----------
  el('#test-checkout-submit').addEventListener('click', async () => {
    const name = el('#cf-name').value.trim();
    const email = el('#cf-email').value.trim();
    const address = el('#cf-address').value.trim();
    const postalCode = el('#cf-postal').value.trim();
    const city = el('#cf-city').value.trim();
    const errorEl = el('#checkout-error');
    errorEl.textContent = '';

    if (!name || !email) {
      errorEl.textContent = 'Merci de renseigner au moins ton nom et ton email.';
      return;
    }

    const items = Object.keys(state.cart).map(key => {
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
        body: JSON.stringify({ items, customer: { name, email, address, postalCode, city } })
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || 'Erreur lors de la validation de la commande.';
        btn.disabled = false;
        btn.textContent = 'Valider la commande (mode test)';
        return;
      }
      state.cart = {};
      saveCart();
      window.location.href = `/commande/${data.token}`;
    } catch (e) {
      errorEl.textContent = 'Erreur réseau, réessaie.';
      btn.disabled = false;
      btn.textContent = 'Valider la commande (mode test)';
    }
  });

  // ---------- PayPal ----------
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
        const res = await fetch('/api/paypal/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items })
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
          saveCart();
          closeCart();
          if (result.token) {
            window.location.href = `/commande/${result.token}`;
          } else {
            await loadProducts();
            renderGrid();
            renderTrending();
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

  // ---------- Drawer open/close ----------
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

  // ---------- URL produit dediee ----------
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

  // ---------- Realtime sync ----------
  function connectRealtime() {
    try {
      const source = new EventSource('/api/stream');
      source.addEventListener('products-updated', async () => {
        await loadProducts();
        renderCategoryDropdown();
        renderFilters();
        renderGrid();
        renderTrending();
        if (drawer.classList.contains('open')) renderCartDrawer();
      });
      source.onerror = () => { /* le navigateur retente automatiquement */ };
    } catch (e) { /* SSE indisponible, tant pis, pas bloquant */ }
  }

  // Rafraîchit les comptes a rebours des ventes flash chaque minute
  setInterval(() => {
    if (!el('#trending').style.display || el('#trending').style.display !== 'none') renderTrending();
    if (state.modalProduct && modal.classList.contains('open')) renderSizePicker();
  }, 60000);

  // ---------- Init ----------
  (async function init() {
    el('#year').textContent = new Date().getFullYear();
    await loadConfig();
    await loadProducts();
    renderCategoryDropdown();
    renderFilters();
    renderGrid();
    renderTrending();
    renderCartCount();
    renderWishlistCount();
    connectRealtime();
    openProductFromUrl();
  })();
})();
