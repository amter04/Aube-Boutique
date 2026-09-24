(() => {
  const el = (sel) => document.querySelector(sel);
  const fmt = (n) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n);
  const STANDARD_SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', 'S/M', 'M/L', 'L/XL', 'TU'];
  const BADGE_LABELS = { promo: 'Promo', flash: 'Vente flash', tendance: 'Tendance' };
  const MAX_IMAGES = 6;

  let products = [];
  let editingId = null;
  let existingImages = []; // URLs deja sur le serveur, conservees a l'enregistrement
  let newFiles = []; // File[] nouvellement selectionnes

  function showToast(msg) {
    const t = el('#toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- Auth ----------
  async function checkAuth() {
    const res = await fetch('/api/admin/check');
    const data = await res.json();
    if (data.isAdmin) showAdmin(); else showLogin();
  }

  function showLogin() {
    el('#login-screen').style.display = 'flex';
    el('#admin-main').style.display = 'none';
    el('#logout-btn').style.display = 'none';
  }

  function showAdmin() {
    el('#login-screen').style.display = 'none';
    el('#admin-main').style.display = 'block';
    el('#logout-btn').style.display = 'inline-flex';
    loadStats();
    loadProducts();
    loadSettings();
  }

  el('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = el('#password').value;
    el('#login-error').textContent = '';
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (res.ok) { showAdmin(); }
    else { el('#login-error').textContent = data.error || 'Erreur de connexion'; }
  });

  el('#logout-btn').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    showLogin();
  });

  // ---------- Tabs ----------
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      el('#tab-dashboard').style.display = target === 'dashboard' ? 'block' : 'none';
      el('#tab-products').style.display = target === 'products' ? 'block' : 'none';
      el('#tab-orders').style.display = target === 'orders' ? 'block' : 'none';
      el('#tab-settings').style.display = target === 'settings' ? 'block' : 'none';
      if (target === 'orders') loadOrders();
      if (target === 'dashboard') loadStats();
    });
  });

  // ---------- Dashboard ----------
  async function loadStats() {
    const res = await fetch('/api/admin/stats');
    if (res.status === 401) return showLogin();
    const s = await res.json();
    const cards = [
      { label: 'Ventes totales (payées)', value: fmt(s.totalSales) },
      { label: 'Commandes aujourd\'hui', value: s.ordersToday },
      { label: 'Commandes au total', value: s.ordersCount },
      { label: 'Produits en ligne', value: s.activeProductsCount },
      { label: 'Ruptures de stock', value: s.outOfStock, warn: s.outOfStock > 0 },
      { label: 'Stock faible (≤ 3)', value: s.lowStock, warn: s.lowStock > 0 }
    ];
    el('#stats-grid').innerHTML = cards.map(c => `
      <div class="stat-card ${c.warn ? 'warn' : ''}">
        <div class="stat-value">${c.value}</div>
        <div class="stat-label">${c.label}</div>
      </div>
    `).join('');
  }

  // ---------- Settings (frais de livraison) ----------
  async function loadSettings() {
    const res = await fetch('/api/admin/settings');
    if (res.status === 401) return;
    const s = await res.json();
    el('#s-shipping').value = (s.shippingFlatCents / 100).toFixed(2);
    const hasThreshold = s.freeShippingThresholdCents != null;
    el('#s-free-enabled').checked = hasThreshold;
    el('#s-free-threshold').value = hasThreshold ? (s.freeShippingThresholdCents / 100).toFixed(2) : '';
    el('#s-free-threshold').disabled = !hasThreshold;
  }

  el('#s-free-enabled').addEventListener('change', (e) => {
    el('#s-free-threshold').disabled = !e.target.checked;
  });

  el('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('#settings-error').textContent = '';
    el('#settings-saved').style.display = 'none';
    const shippingFlatCents = Math.round(parseFloat(el('#s-shipping').value || '0') * 100);
    const freeEnabled = el('#s-free-enabled').checked;
    const freeShippingThresholdCents = freeEnabled
      ? Math.round(parseFloat(el('#s-free-threshold').value || '0') * 100)
      : null;

    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shippingFlatCents, freeShippingThresholdCents })
    });
    const data = await res.json();
    if (!res.ok) { el('#settings-error').textContent = data.error || 'Erreur'; return; }
    el('#settings-saved').style.display = 'block';
    showToast('Réglages enregistrés');
  });

  // ---------- Category select ----------
  function refreshCategoryOptions(selected) {
    const select = el('#p-category');
    const cats = [...new Set(products.map(p => p.category).filter(Boolean))].sort();
    const current = selected !== undefined ? selected : select.value;
    select.innerHTML = `<option value="">Sans catégorie</option>` +
      cats.map(c => `<option value="${c}">${c}</option>`).join('');
    if (current && ![...select.options].some(o => o.value === current)) {
      select.insertAdjacentHTML('beforeend', `<option value="${current}">${current}</option>`);
    }
    if (current) select.value = current;
  }

  el('#new-cat-btn').addEventListener('click', () => {
    const name = window.prompt('Nom de la nouvelle catégorie :');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    const select = el('#p-category');
    if (![...select.options].some(o => o.value === trimmed)) {
      select.insertAdjacentHTML('beforeend', `<option value="${trimmed}">${trimmed}</option>`);
    }
    select.value = trimmed;
  });

  // ---------- Sizes ----------
  function renderSizeGrid(activeSizes = []) {
    const container = el('#size-grid');
    container.innerHTML = STANDARD_SIZES.map(size => {
      const existing = activeSizes.find(s => s.size === size);
      return `
        <div class="size-row ${existing ? 'active' : ''}" data-size="${size}">
          <label>
            <input type="checkbox" class="size-check" ${existing ? 'checked' : ''}>
            ${size}
          </label>
          <input type="number" class="size-stock" min="0" value="${existing ? existing.stock : 1}">
        </div>
      `;
    }).join('');
    container.querySelectorAll('.size-row').forEach(row => {
      row.querySelector('.size-check').addEventListener('change', (e) => {
        row.classList.toggle('active', e.target.checked);
      });
    });
  }

  function collectSizes() {
    const sizes = [];
    el('#size-grid').querySelectorAll('.size-row').forEach(row => {
      if (row.querySelector('.size-check').checked) {
        const stock = Math.max(0, parseInt(row.querySelector('.size-stock').value, 10) || 0);
        sizes.push({ size: row.dataset.size, stock });
      }
    });
    return sizes;
  }

  // ---------- Photos (multi) ----------
  function renderPhotoGrid() {
    const container = el('#photo-grid');
    const existingThumbs = existingImages.map((url, i) => `
      <div class="photo-thumb" data-kind="existing" data-i="${i}">
        <img src="${url}">
        <button type="button" class="photo-remove" data-kind="existing" data-i="${i}">&times;</button>
      </div>
    `);
    const newThumbs = newFiles.map((file, i) => `
      <div class="photo-thumb" data-kind="new" data-i="${i}">
        <img src="${URL.createObjectURL(file)}">
        <button type="button" class="photo-remove" data-kind="new" data-i="${i}">&times;</button>
      </div>
    `);
    const total = existingImages.length + newFiles.length;
    const addSlot = total < MAX_IMAGES ? `<label class="photo-add" for="p-images">+ Ajouter</label>` : '';
    container.innerHTML = existingThumbs.join('') + newThumbs.join('') + addSlot;
    container.querySelectorAll('.photo-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.i, 10);
        if (btn.dataset.kind === 'existing') existingImages.splice(i, 1);
        else newFiles.splice(i, 1);
        renderPhotoGrid();
      });
    });
  }

  el('#p-images').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    const remainingSlots = MAX_IMAGES - existingImages.length - newFiles.length;
    newFiles = newFiles.concat(files.slice(0, Math.max(0, remainingSlots)));
    e.target.value = '';
    renderPhotoGrid();
  });

  // ---------- Promo fields ----------
  el('#p-promo-active').addEventListener('change', (e) => {
    el('#promo-fields').style.display = e.target.checked ? 'block' : 'none';
  });

  function collectBadgesAndPromo() {
    const badges = [];
    if (el('#p-trending').checked) badges.push('tendance');

    let discountPercent = 0;
    let flashEndsAt = null;
    if (el('#p-promo-active').checked) {
      badges.push('promo');
      discountPercent = Math.min(90, Math.max(1, parseInt(el('#p-discount').value, 10) || 0));
      const endVal = el('#p-promo-end').value;
      if (endVal) {
        badges.push('flash');
        flashEndsAt = endVal;
      }
    }
    return { badges, discountPercent, flashEndsAt };
  }

  // ---------- Products ----------
  async function loadProducts() {
    const res = await fetch('/api/admin/products');
    if (res.status === 401) return showLogin();
    products = await res.json();
    refreshCategoryOptions();
    renderProductRows();
  }

  function renderProductRows() {
    const tbody = el('#product-rows');
    if (products.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:#918A80; padding:18px 10px;">Aucune pièce ajoutée pour le moment.</td></tr>`;
      return;
    }
    tbody.innerHTML = products.map(p => {
      const badgeTags = (p.badges || []).map(b => `<span class="badge-tag ${b}">${BADGE_LABELS[b] || b}</span>`).join('');
      const thumb = (p.images && p.images[0]) || '';
      return `
      <tr data-id="${p.id}">
        <td>${thumb ? `<img src="${thumb}" alt="">` : ''}</td>
        <td>${p.name}${badgeTags ? `<div style="margin-top:4px;">${badgeTags}</div>` : ''}</td>
        <td>${fmt(p.price)}${p.discountPercent ? ` <span style="color:#77706A;font-size:12px;">(-${p.discountPercent}%)</span>` : ''}</td>
        <td class="${p.stock === 0 ? 'stock-low' : ''}">${p.stock}</td>
        <td>${p.isActive ? 'En ligne' : 'Masqué'}</td>
        <td>
          <div class="row-actions">
            <button class="edit-btn">Modifier</button>
            <button class="duplicate-btn">Dupliquer</button>
            <button class="danger delete-btn">Supprimer</button>
          </div>
        </td>
      </tr>
    `;
    }).join('');

    tbody.querySelectorAll('tr').forEach(row => {
      const id = parseInt(row.dataset.id, 10);
      row.querySelector('.edit-btn').addEventListener('click', () => startEdit(id));
      row.querySelector('.duplicate-btn').addEventListener('click', () => duplicateProduct(id));
      row.querySelector('.delete-btn').addEventListener('click', () => deleteProduct(id));
    });
  }

  function startEdit(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    editingId = id;
    el('#form-title').textContent = 'Modifier la pièce';
    el('#product-id').value = id;
    el('#p-name').value = p.name;
    el('#p-desc').value = p.description || '';
    el('#p-price').value = p.price;
    refreshCategoryOptions(p.category || '');

    renderSizeGrid(p.sizes || []);

    existingImages = [...(p.images || [])];
    newFiles = [];
    renderPhotoGrid();

    const badges = p.badges || [];
    el('#p-trending').checked = badges.includes('tendance');
    el('#p-promo-active').checked = badges.includes('promo');
    el('#promo-fields').style.display = badges.includes('promo') ? 'block' : 'none';
    el('#p-discount').value = p.discountPercent || 10;
    el('#p-promo-end').value = p.flashEndsAt ? toLocalDatetimeValue(p.flashEndsAt) : '';

    el('#p-active').checked = p.isActive;
    el('#active-field').style.display = 'block';
    el('#submit-btn').textContent = 'Enregistrer';
    el('#cancel-edit').style.display = 'inline-flex';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toLocalDatetimeValue(isoString) {
    const d = new Date(isoString);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function resetForm() {
    editingId = null;
    existingImages = [];
    newFiles = [];
    el('#product-form').reset();
    el('#form-title').textContent = 'Ajouter une pièce';
    el('#submit-btn').textContent = 'Ajouter';
    el('#cancel-edit').style.display = 'none';
    el('#active-field').style.display = 'none';
    el('#form-error').textContent = '';
    el('#promo-fields').style.display = 'none';
    el('#p-discount').value = 10;
    refreshCategoryOptions('');
    renderSizeGrid([]);
    renderPhotoGrid();
  }
  el('#cancel-edit').addEventListener('click', resetForm);

  el('#product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('#form-error').textContent = '';

    const sizes = collectSizes();
    if (sizes.length === 0) {
      el('#form-error').textContent = 'Choisis au moins une taille dans le catalogue.';
      return;
    }
    const { badges, discountPercent, flashEndsAt } = collectBadgesAndPromo();

    const formData = new FormData();
    formData.append('name', el('#p-name').value);
    formData.append('description', el('#p-desc').value);
    formData.append('price', el('#p-price').value);
    formData.append('category', el('#p-category').value);
    formData.append('sizes', JSON.stringify(sizes));
    formData.append('badges', JSON.stringify(badges));
    formData.append('discountPercent', discountPercent);
    if (flashEndsAt) formData.append('flashEndsAt', flashEndsAt);
    else if (editingId) formData.append('flashEndsAt', '');
    if (editingId) {
      formData.append('isActive', el('#p-active').checked);
      formData.append('keepImages', JSON.stringify(existingImages));
    }
    newFiles.forEach(file => formData.append('images', file));

    const url = editingId ? `/api/admin/products/${editingId}` : '/api/admin/products';
    const method = editingId ? 'PUT' : 'POST';

    const submitBtn = el('#submit-btn');
    submitBtn.disabled = true;
    const res = await fetch(url, { method, body: formData });
    submitBtn.disabled = false;
    const data = await res.json();
    if (!res.ok) { el('#form-error').textContent = data.error || 'Erreur'; return; }

    showToast(editingId ? 'Pièce mise à jour' : 'Pièce ajoutée');
    resetForm();
    loadProducts();
    loadStats();
  });

  async function duplicateProduct(id) {
    const res = await fetch(`/api/admin/products/${id}/duplicate`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erreur lors de la duplication'); return; }
    showToast('Pièce dupliquée (masquée, à ajuster puis republier)');
    loadProducts();
  }

  async function deleteProduct(id) {
    if (!confirm('Supprimer cette pièce définitivement ?')) return;
    await fetch(`/api/admin/products/${id}`, { method: 'DELETE' });
    showToast('Pièce supprimée');
    loadProducts();
    loadStats();
  }

  // ---------- Orders ----------
  async function loadOrders() {
    const res = await fetch('/api/admin/orders');
    if (res.status === 401) return showLogin();
    const orders = await res.json();
    const list = el('#orders-list');
    if (orders.length === 0) {
      list.innerHTML = `<p style="color:#918A80;">Aucune commande pour le moment.</p>`;
      return;
    }
    list.innerHTML = orders.map(o => {
      const customer = o.customer || {};
      const address = [customer.address, customer.postalCode, customer.city].filter(Boolean).join(', ');
      return `
      <div class="order-row">
        <div class="top">
          <strong>${fmt(o.total)}</strong>
          <span>
            ${o.source === 'test' ? `<span class="status-pill test">Test</span>` : ''}
            <span class="status-pill ${o.status === 'paid' ? 'paid' : 'created'}">${o.status === 'paid' ? 'Payée' : o.status}</span>
          </span>
        </div>
        <div style="color:#77706A;">${o.payerName || 'Client'} ${o.payerEmail ? `· ${o.payerEmail}` : ''}</div>
        ${address ? `<div style="color:#918A80; font-size:13px;">${address}</div>` : ''}
        <div style="color:#918A80; font-size:13px;">${new Date(o.createdAt).toLocaleString('fr-FR')} · ${o.items.map(i => `${i.name}${i.size && i.size !== 'TU' ? ` (${i.size})` : ''} ×${i.qty}`).join(', ')}</div>
        <div style="color:#918A80; font-size:12.5px; margin-top:4px;">Sous-total ${fmt(o.subtotal)} + livraison ${fmt(o.shipping)}</div>
      </div>
    `;
    }).join('');
  }

  // ---------- Init ----------
  renderSizeGrid([]);
  renderPhotoGrid();
  checkAuth();
})();
