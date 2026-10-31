(() => {
  const el = (sel) => document.querySelector(sel);
  const fmt = (n) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n);
  const STANDARD_SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', 'S/M', 'M/L', 'L/XL', 'TU'];
  const BADGE_LABELS = { promo: 'Promo', flash: 'Vente flash', tendance: 'Tendance' };
  const MAX_IMAGES = 6;

  let products = [];
  let editingId = null;
  let existingImages = [];
  let newFiles = [];

  function showToast(msg) {
    const t = el('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- Auth ----------
  let role = null;
  let perms = [];
  let loginMode = 'admin';
  const can = (p) => role === 'admin' || perms.includes(p);

  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function checkAuth() {
    const res = await fetch('/api/admin/check');
    const data = await res.json();
    if (data.role) showAdmin(data.role, data.permissions || []); else showLogin();
  }

  function showLogin() {
    role = null;
    perms = [];
    el('#login-screen').style.display = 'flex';
    el('#admin-main').style.display = 'none';
    el('#logout-btn').style.display = 'none';
  }

  function showAdmin(userRole, userPerms) {
    role = userRole;
    perms = userPerms || [];
    el('#login-screen').style.display = 'none';
    el('#admin-main').style.display = 'block';
    el('#logout-btn').style.display = 'inline-flex';
    
    document.querySelectorAll('.admin-tab[data-role="admin"]').forEach(t => {
      t.style.display = role === 'admin' ? '' : 'none';
    });
    // Onglets liés à un droit (ex. Produits : patron, ou employé avec le droit « catalogue »)
    document.querySelectorAll('.admin-tab[data-perm]').forEach(t => {
      t.style.display = can(t.dataset.perm) ? '' : 'none';
    });
    if (can('catalogue')) loadProducts();
    if (role === 'admin') {
      loadStats();
      loadSettings();
      selectTab('dashboard');
    } else {
      selectTab('orders');
    }
  }

  function setLoginMode(mode) {
    loginMode = mode;
    el('#email-field').style.display = mode === 'staff' ? 'block' : 'none';
    el('#email').required = mode === 'staff';
    el('#password-label').textContent = mode === 'staff' ? 'Mot de passe' : 'Mot de passe administrateur';
    el('#mode-admin').className = 'btn ' + (mode === 'admin' ? 'wine' : 'secondary');
    el('#mode-staff').className = 'btn ' + (mode === 'staff' ? 'wine' : 'secondary');
    el('#login-error').textContent = '';
  }
  el('#mode-admin').addEventListener('click', () => setLoginMode('admin'));
  el('#mode-staff').addEventListener('click', () => setLoginMode('staff'));

  el('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = el('#password').value;
    el('#login-error').textContent = '';
    const isStaff = loginMode === 'staff';
    const res = await fetch(isStaff ? '/api/staff/login' : '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isStaff ? { email: el('#email').value, password } : { password })
    });
    const data = await res.json();
    if (res.ok) { el('#password').value = ''; await checkAuth(); } // relit le rôle et les droits côté serveur
    else { el('#login-error').textContent = data.error || 'Erreur de connexion'; }
  });

  el('#logout-btn').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    showLogin();
  });

  // ---------- Tabs ----------
  function selectTab(target) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
    ['dashboard', 'products', 'orders', 'customers', 'promos', 'reviews', 'team', 'settings'].forEach(name => {
      const tabEl = el('#tab-' + name);
      if (tabEl) tabEl.style.display = name === target ? 'block' : 'none';
    });
    if (target === 'orders') loadOrders();
    if (target === 'dashboard') loadStats();
    if (target === 'customers') loadCustomers();
    if (target === 'promos') loadPromos();
    if (target === 'reviews') loadAdminReviews();
    if (target === 'team') loadEmployees();
  }

  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  });

  // ---------- Équipe ----------
  async function loadEmployees() {
    const res = await fetch('/api/admin/employees');
    if (res.status === 401) return showLogin();
    const employees = await res.json();
    const tbody = el('#employee-rows');
    if (employees.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="color:#918A80; padding:18px 10px;">Aucun employé pour le moment.</td></tr>`;
      return;
    }
    tbody.innerHTML = employees.map(emp => `
      <tr data-id="${emp.id}" data-active="${emp.active}">
        <td>${esc(emp.name)}</td>
        <td>${esc(emp.email)}</td>
        <td>${emp.active ? 'Actif' : 'Désactivé'}</td>
        <td>
          <div class="row-actions">
            <button class="toggle-btn">${emp.active ? 'Désactiver' : 'Réactiver'}</button>
            <button class="pwd-btn">Mot de passe</button>
            <button class="danger del-btn">Supprimer</button>
          </div>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('tr').forEach(row => {
      const id = row.dataset.id;
      const active = row.dataset.active === 'true';
      row.querySelector('.toggle-btn').addEventListener('click', async () => {
        await fetch(`/api/admin/employees/${id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: !active })
        });
        loadEmployees();
      });
      row.querySelector('.pwd-btn').addEventListener('click', async () => {
        const password = window.prompt('Nouveau mot de passe (6 caractères minimum) :');
        if (!password) return;
        const r = await fetch(`/api/admin/employees/${id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const d = await r.json();
        showToast(r.ok ? 'Mot de passe modifié' : (d.error || 'Erreur'));
      });
      row.querySelector('.del-btn').addEventListener('click', async () => {
        if (!confirm('Supprimer ce compte employé définitivement ?')) return;
        await fetch(`/api/admin/employees/${id}`, { method: 'DELETE' });
        showToast('Compte supprimé');
        loadEmployees();
      });
    });
  }

  el('#employee-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('#employee-error').textContent = '';
    const res = await fetch('/api/admin/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: el('#emp-name').value,
        email: el('#emp-email').value,
        password: el('#emp-password').value
      })
    });
    const data = await res.json();
    if (!res.ok) { el('#employee-error').textContent = data.error || 'Erreur'; return; }
    el('#employee-form').reset();
    showToast('Compte employé créé');
    loadEmployees();
  });

  // ---------- Dashboard ----------
  async function loadStats() {
    if (role !== 'admin') return;
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

  // ---------- Settings ----------
  async function loadSettings() {
    const res = await fetch('/api/admin/settings');
    if (res.status === 401) return;
    const s = await res.json();
    el('#s-shipping').value = (s.shippingFlatCents / 100).toFixed(2);
    const hasThreshold = s.freeShippingThresholdCents != null;
    el('#s-free-enabled').checked = hasThreshold;
    el('#s-free-threshold').value = hasThreshold ? (s.freeShippingThresholdCents / 100).toFixed(2) : '';
    el('#s-free-threshold').disabled = !hasThreshold;
    el('#s-payments-enabled').checked = !!s.paymentsEnabled;
    const loyalty = s.loyalty || {};
    el('#s-loyalty-earn').value = loyalty.pointsPerEuro ?? 1;
    el('#s-loyalty-value').value = loyalty.pointValueCents ?? 1;
    el('#s-loyalty-min').value = loyalty.minRedeemPoints ?? 100;
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
    const paymentsEnabled = el('#s-payments-enabled').checked;
    const loyalty = {
      pointsPerEuro: parseFloat(el('#s-loyalty-earn').value || '0'),
      pointValueCents: parseFloat(el('#s-loyalty-value').value || '0'),
      minRedeemPoints: parseInt(el('#s-loyalty-min').value || '0', 10)
    };

    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shippingFlatCents, freeShippingThresholdCents, paymentsEnabled, loyalty })
    });
    const data = await res.json();
    if (!res.ok) { el('#settings-error').textContent = data.error || 'Erreur'; return; }
    el('#settings-saved').style.display = 'block';
    showToast('Réglages enregistrés');
  });

  // ---------- Clients ----------
  async function loadCustomers() {
    const res = await fetch('/api/admin/customers');
    if (res.status === 401) return showLogin();
    const customers = await res.json();
    el('#customers-count').textContent = `${customers.length} client${customers.length > 1 ? 'e' : ''}${customers.length > 1 ? 's' : ''}`;
    const tbody = el('#customer-rows');
    if (customers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="color:#918A80; padding:18px 10px;">Aucun compte client créé pour le moment.</td></tr>`;
      return;
    }
    tbody.innerHTML = customers.map(c => `
      <tr>
        <td>${esc(c.name)}</td>
        <td>${esc(c.email)}</td>
        <td><strong>${c.points}</strong></td>
        <td>${c.ordersCount}</td>
        <td>${new Date(c.createdAt).toLocaleDateString('fr-FR')}</td>
      </tr>
    `).join('');
  }

  // ---------- Codes promo ----------
  async function loadPromos() {
    const res = await fetch('/api/admin/promos');
    if (res.status === 401) return showLogin();
    const promos = await res.json();
    const tbody = el('#promo-rows');
    
    if (!promos || promos.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:#918A80; padding:18px 10px;">Aucun code promo créé.</td></tr>`;
      return;
    }

    tbody.innerHTML = promos.map(p => `
      <tr data-id="${p.id}" data-active="${p.active}">
        <td><strong>${esc(p.code)}</strong></td>
        <td>${p.type === 'percent' ? `-${p.value}%` : `-${p.value} €`}</td>
        <td>${p.minSubtotalCents ? fmt(p.minSubtotalCents / 100) : 'Aucun'}</td>
        <td>${p.usesCount || 0} ${p.maxUses ? `/ ${p.maxUses}` : ''}</td>
        <td>${p.active ? '<span style="color:var(--ok, green);">Actif</span>' : 'Inactif'}</td>
        <td>
          <div class="row-actions">
            <button class="toggle-promo-btn">${p.active ? 'Désactiver' : 'Activer'}</button>
            <button class="danger del-promo-btn">Supprimer</button>
          </div>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('tr').forEach(row => {
      const id = row.dataset.id;
      const active = row.dataset.active === 'true';

      row.querySelector('.toggle-promo-btn').addEventListener('click', async () => {
        await fetch(`/api/admin/promos/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: !active })
        });
        loadPromos();
      });

      row.querySelector('.del-promo-btn').addEventListener('click', async () => {
        if (!confirm('Supprimer ce code promo ?')) return;
        await fetch(`/api/admin/promos/${id}`, { method: 'DELETE' });
        showToast('Code promo supprimé');
        loadPromos();
      });
    });
  }

  el('#promo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('#promo-error').textContent = '';

    const body = {
      code: el('#pm-code').value.trim(),
      type: el('#pm-type').value,
      value: parseFloat(el('#pm-value').value),
      minSubtotal: el('#pm-min').value || null,
      maxUses: el('#pm-max-uses').value || null,
      startsAt: el('#pm-starts').value || null,
      endsAt: el('#pm-ends').value || null
    };

    const res = await fetch('/api/admin/promos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (!res.ok) {
      el('#promo-error').textContent = data.error || 'Erreur lors de la création';
      return;
    }

    el('#promo-form').reset();
    showToast('Code promo créé avec succès !');
    loadPromos();
  });

  // ---------- Avis Clients ----------
  async function loadAdminReviews() {
    try {
      const res = await fetch('/api/admin/reviews');
      if (res.status === 401) return showLogin();
      const reviews = await res.json();

      const container = document.getElementById('admin-reviews-list');
      if (!container) return;

      if (!reviews || reviews.length === 0) {
        container.innerHTML = '<p style="color:#918A80; padding:12px 0;">Aucun avis soumis pour le moment.</p>';
        return;
      }

      container.innerHTML = reviews.map(r => `
        <div class="admin-review-card status-${r.status}" style="border: 1px solid #e8e4e1; padding: 16px; border-radius: 8px; margin-bottom: 12px; background: #fff;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <strong>${esc(r.productName || 'Produit #' + r.productId)}</strong>
            <span style="color: #d4a373;">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} (${r.rating}/5)</span>
          </div>
          <p style="margin: 4px 0;"><strong>${esc(r.authorName)}</strong> : "${esc(r.comment)}"</p>
          ${r.imageUrl ? `<div style="margin: 8px 0;"><a href="${r.imageUrl}" target="_blank"><img src="${r.imageUrl}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 6px; border:1px solid #ddd;" /></a></div>` : ''}
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px; border-top:1px solid #f0ece9; padding-top:8px;">
            <small style="color: #766e65;">Statut : <strong>${r.status === 'pending' ? 'En attente ⏳' : (r.status === 'approved' ? 'Approuvé ✅' : 'Refusé ❌')}</strong></small>
            ${r.status === 'pending' ? `
              <div>
                <button data-id="${r.id}" data-status="approved" class="btn mod-review-btn" style="background:#2e7d32; color:#fff; padding:6px 12px; border-radius:4px; margin-right:6px; cursor:pointer; border:none;">Approuver</button>
                <button data-id="${r.id}" data-status="rejected" class="btn mod-review-btn" style="background:#c62828; color:#fff; padding:6px 12px; border-radius:4px; cursor:pointer; border:none;">Refuser</button>
              </div>
            ` : ''}
          </div>
        </div>
      `).join('');

      container.querySelectorAll('.mod-review-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const status = btn.dataset.status;
          await moderateReview(id, status);
        });
      });
    } catch (err) {
      console.error('Erreur chargement avis admin :', err);
    }
  }

  async function moderateReview(id, status) {
    try {
      const res = await fetch(`/api/admin/reviews/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (res.ok) {
        showToast(status === 'approved' ? 'Avis approuvé' : 'Avis refusé');
        loadAdminReviews();
      }
    } catch (err) {
      alert('Erreur lors de la modération de l\'avis.');
    }
  }

  // ---------- Catalogue : catégories (liste ordonnée fournie par le serveur) ----------
  let categories = []; // [{ name, count, archivedCount }]

  function categoryNames() {
    const names = categories.map(c => c.name);
    for (const p of products) if (p.category && !names.includes(p.category)) names.push(p.category);
    return names;
  }

  function refreshCategoryOptions(selected) {
    const select = el('#p-category');
    const names = categoryNames();
    const current = selected !== undefined ? selected : select.value;
    select.innerHTML = `<option value="">Sans catégorie</option>` + names.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (current && !names.includes(current)) select.insertAdjacentHTML('beforeend', `<option value="${esc(current)}">${esc(current)}</option>`);
    select.value = current || '';

    const filter = el('#filter-category');
    filter.innerHTML = `<option value="ALL">Toutes les catégories</option><option value="__none">Sans catégorie</option>` +
      names.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    filter.value = (view.cat === 'ALL' || view.cat === '__none' || names.includes(view.cat)) ? view.cat : 'ALL';
    view.cat = filter.value;

    el('#cat-datalist').innerHTML = names.map(c => `<option value="${esc(c)}"></option>`).join('');
  }

  el('#new-cat-btn').addEventListener('click', () => {
    const name = window.prompt('Nom de la nouvelle catégorie :');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    const select = el('#p-category');
    if (![...select.options].some(o => o.value === trimmed)) {
      select.insertAdjacentHTML('beforeend', `<option value="${esc(trimmed)}">${esc(trimmed)}</option>`);
    }
    select.value = trimmed;
    formDirty = true;
  });

  // ---------- Sizes ----------
  // Couleurs saisies dans le champ texte ("Écru, Noir=#111111") : on ne garde que les noms.
  function parseColorNames(text) {
    const seen = new Set();
    const out = [];
    String(text || '').split(',').forEach(tok => {
      const name = tok.split('=')[0].replace(/::/g, ' ').trim().slice(0, 40);
      if (name && !seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); out.push(name); }
    });
    return out.slice(0, 12);
  }
  function colorsToText(p) {
    const names = Array.isArray(p.colors) ? p.colors : [];
    const hex = p.colorHex || {};
    return names.map(n => hex[n] ? `${n}=${hex[n]}` : n).join(', ');
  }

  // Une grille de tailles par couleur (ou une seule grille si le produit n'a pas de couleur).
  function renderSizeGrid(activeSizes = [], colors = parseColorNames(el('#p-colors').value)) {
    const container = el('#size-grid');
    const groups = colors.length ? colors : [''];
    const lookup = (group, size) => {
      const exact = activeSizes.find(s => s.size === size && (s.color || '') === group);
      if (exact) return exact;
      if (activeSizes.some(s => (s.color || '') === group)) return null; // couleur déjà réglée : taille non cochée
      const legacy = group ? activeSizes.find(s => s.size === size && !s.color) : null; // ancien stock partagé
      if (legacy) return legacy;
      const other = activeSizes.find(s => s.size === size); // nouvelle couleur : on reprend les tailles déjà choisies
      return other ? { size, stock: group ? 1 : other.stock } : null;
    };
    container.innerHTML = groups.map(group => `
      <div class="size-group" data-color="${esc(group)}">
        ${group ? `<div class="size-group-title">Couleur : <strong>${esc(group)}</strong></div>` : ''}
        <div class="size-group-rows">${STANDARD_SIZES.map(size => {
          const existing = lookup(group, size);
          return `
        <div class="size-row ${existing ? 'active' : ''}" data-size="${size}" data-color="${esc(group)}">
          <label>
            <input type="checkbox" class="size-check" ${existing ? 'checked' : ''}>
            ${size}
          </label>
          <input type="number" class="size-stock" min="0" value="${existing ? existing.stock : 1}">
        </div>`;
        }).join('')}</div>
      </div>
    `).join('');
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
        sizes.push({ size: row.dataset.size, color: row.dataset.color || '', stock });
      }
    });
    return sizes;
  }

  // Quand on change la liste des couleurs, la grille de stock suit (en gardant ce qui est déjà saisi).
  let colorsTimer = null;
  el('#p-colors').addEventListener('input', () => {
    clearTimeout(colorsTimer);
    colorsTimer = setTimeout(() => renderSizeGrid(collectSizes(), parseColorNames(el('#p-colors').value)), 350);
  });

  // ---------- Photos (glisser-déposer ou flèches pour changer l'ordre) ----------
  const objectUrls = new WeakMap();
  const previewUrl = (file) => {
    let u = objectUrls.get(file);
    if (!u) { u = URL.createObjectURL(file); objectUrls.set(file, u); }
    return u;
  };

  function renderPhotoGrid() {
    const container = el('#photo-grid');
    const thumb = (kind, src, i, count) => {
      const main = (kind === 'existing' && i === 0) || (kind === 'new' && existingImages.length === 0 && i === 0);
      return `
      <div class="photo-thumb" draggable="true" data-kind="${kind}" data-i="${i}">
        <img src="${src}" alt="" draggable="false">
        ${main ? '<span class="photo-main">Principale</span>' : ''}
        <button type="button" class="photo-remove" data-act="remove" aria-label="Retirer la photo">&times;</button>
        <div class="photo-move">
          <button type="button" data-act="move" data-dir="-1" aria-label="Déplacer vers la gauche" ${i === 0 ? 'disabled' : ''}>‹</button>
          <button type="button" data-act="move" data-dir="1" aria-label="Déplacer vers la droite" ${i === count - 1 ? 'disabled' : ''}>›</button>
        </div>
      </div>`;
    };
    const total = existingImages.length + newFiles.length;
    const addSlot = total < MAX_IMAGES ? `<label class="photo-add" for="p-images">+ Ajouter</label>` : '';
    container.innerHTML =
      existingImages.map((url, i) => thumb('existing', url, i, existingImages.length)).join('') +
      newFiles.map((file, i) => thumb('new', previewUrl(file), i, newFiles.length)).join('') +
      addSlot;
  }

  function photoList(kind) { return kind === 'existing' ? existingImages : newFiles; }
  function movePhoto(kind, from, to) {
    const arr = photoList(kind);
    if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return;
    arr.splice(to, 0, arr.splice(from, 1)[0]);
    formDirty = true;
    renderPhotoGrid();
  }

  (() => {
    const grid = el('#photo-grid');
    let dragSrc = null;
    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      const t = e.target.closest('.photo-thumb');
      if (!btn || !t) return;
      const kind = t.dataset.kind;
      const i = parseInt(t.dataset.i, 10);
      if (btn.dataset.act === 'remove') { photoList(kind).splice(i, 1); formDirty = true; renderPhotoGrid(); }
      else movePhoto(kind, i, i + parseInt(btn.dataset.dir, 10));
    });
    grid.addEventListener('dragstart', (e) => {
      const t = e.target.closest && e.target.closest('.photo-thumb');
      if (!t) return;
      dragSrc = { kind: t.dataset.kind, i: parseInt(t.dataset.i, 10) };
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', 'photo'); } catch (err) { /* ignore */ }
      t.classList.add('dragging');
    });
    grid.addEventListener('dragend', () => {
      dragSrc = null;
      grid.querySelectorAll('.dragging, .drop-target').forEach(n => n.classList.remove('dragging', 'drop-target'));
    });
    grid.addEventListener('dragover', (e) => {
      const t = e.target.closest('.photo-thumb');
      if (dragSrc && t && t.dataset.kind === dragSrc.kind) { e.preventDefault(); t.classList.add('drop-target'); }
    });
    grid.addEventListener('dragleave', (e) => {
      const t = e.target.closest('.photo-thumb');
      if (t) t.classList.remove('drop-target');
    });
    grid.addEventListener('drop', (e) => {
      const t = e.target.closest('.photo-thumb');
      if (!dragSrc || !t || t.dataset.kind !== dragSrc.kind) return;
      e.preventDefault();
      const src = dragSrc;
      dragSrc = null;
      movePhoto(src.kind, src.i, parseInt(t.dataset.i, 10));
    });
  })();

  el('#p-images').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    const remainingSlots = MAX_IMAGES - existingImages.length - newFiles.length;
    newFiles = newFiles.concat(files.slice(0, Math.max(0, remainingSlots)));
    e.target.value = '';
    formDirty = true;
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

  // ---------- Catalogue : liste, recherche, tri, filtres ----------
  const SHOP_TZ = 'Europe/Paris';
  const STATUS_LABEL = { online: 'En ligne', hidden: 'Masquée', draft: 'Brouillon', archived: 'Archivée' };
  const STATUS_CHIPS = [
    ['active', 'Actives'], ['online', 'En ligne'], ['scheduled', 'Programmées'],
    ['hidden', 'Masquées'], ['draft', 'Brouillons'], ['archived', 'Archivées']
  ];
  const FLAG_CHIPS = [
    ['soldOut', 'Épuisé', 'Au moins une pièce épuisée (stock total à 0)'],
    ['lowStock', 'Stock faible', 'Une variante à 3 pièces ou moins'],
    ['onPromo', 'En promo', 'Remise active'],
    ['noPhoto', 'Sans photo', 'Fiche incomplète : aucune photo']
  ];
  const view = { q: '', sort: 'recent', status: 'active', cat: 'ALL', flags: { soldOut: false, lowStock: false, onPromo: false, noPhoto: false } };
  let selected = new Set();
  let visibleIds = [];

  const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Même règle que le serveur : « ROB 01 », « rob-01 » et « ROB01 » sont la même référence.
  const normRef = (r) => fold(r).replace(/[^a-z0-9]/g, '');

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString('fr-FR', { timeZone: SHOP_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  // ISO → valeur d'un <input datetime-local> à l'heure de la boutique (c'est l'heure que le serveur lit).
  function toShopDatetimeValue(iso) {
    const o = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(iso)).forEach(p => { if (p.type !== 'literal') o[p.type] = p.value; });
    return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`;
  }

  // Texte de recherche précalculé : référence, nom, catégorie, couleurs (accents et casse ignorés).
  function decorate(p) {
    p._hay = fold([p.reference, p.name, p.category, (p.colors || []).join(' ')].join(' ')) + ' ' + normRef(p.reference);
    return p;
  }

  const byRecent = (a, b) => (new Date(b.createdAt) - new Date(a.createdAt)) || (b.id - a.id);
  const SORTS = {
    recent: byRecent,
    best: (a, b) => (b.sold - a.sold) || byRecent(a, b),
    priceAsc: (a, b) => (a.price - b.price) || byRecent(a, b),
    priceDesc: (a, b) => (b.price - a.price) || byRecent(a, b),
    stockAsc: (a, b) => (a.stock - b.stock) || byRecent(a, b),
    stockDesc: (a, b) => (b.stock - a.stock) || byRecent(a, b),
    name: (a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
  };

  function statusMatches(p, key) {
    if (key === 'active') return p.status !== 'archived';
    if (key === 'online') return p.isActive;
    if (key === 'scheduled') return p.scheduled;
    return p.status === key;
  }

  function matchesView(p) {
    if (!statusMatches(p, view.status)) return false;
    if (view.cat === '__none') { if (p.category) return false; }
    else if (view.cat !== 'ALL' && p.category !== view.cat) return false;
    // « Épuisé » et « Stock faible » s'additionnent (pièces à réassortir) ; promo et photo restreignent.
    const stockOn = view.flags.soldOut || view.flags.lowStock;
    if (stockOn && !((view.flags.soldOut && p.soldOut) || (view.flags.lowStock && p.lowStock))) return false;
    if (view.flags.onPromo && !p.onPromo) return false;
    if (view.flags.noPhoto && !p.noPhoto) return false;
    if (view.q) {
      const tokens = fold(view.q).split(/\s+/).filter(Boolean);
      if (!tokens.every(t => p._hay.includes(t) || p._hay.includes(normRef(t)))) return false;
    }
    return true;
  }

  const filtersActive = () => view.q || view.cat !== 'ALL' || view.status !== 'active' || Object.values(view.flags).some(Boolean);
  function resetFilters() {
    view.q = ''; view.cat = 'ALL'; view.status = 'active';
    Object.keys(view.flags).forEach(k => { view.flags[k] = false; });
    el('#cat-search').value = '';
    el('#filter-category').value = 'ALL';
    renderProducts();
  }

  async function loadProducts() {
    const [pr, cr] = await Promise.all([fetch('/api/admin/products'), fetch('/api/admin/categories')]);
    if (pr.status === 401) return showLogin();
    products = (await pr.json()).map(decorate);
    if (cr.ok) categories = await cr.json();
    refreshCategoryOptions();
    renderProducts();
  }

  function replaceProduct(updated) {
    const i = products.findIndex(p => p.id === updated.id);
    if (i >= 0) products[i] = decorate(updated);
  }

  function renderChips() {
    el('#status-chips').innerHTML = STATUS_CHIPS.map(([key, label]) => {
      const n = products.filter(p => statusMatches(p, key)).length;
      return `<button type="button" class="cchip ${view.status === key ? 'on' : ''}" data-status="${key}" aria-pressed="${view.status === key}">${label} <small>${n}</small></button>`;
    }).join('');
    const clear = filtersActive() ? `<button type="button" class="cchip-clear" id="reset-filters">Réinitialiser les filtres</button>` : '';
    el('#flag-chips').innerHTML = FLAG_CHIPS.map(([key, label, tip]) => {
      const n = products.filter(p => p.status !== 'archived' && p[key]).length;
      return `<button type="button" class="cchip flag ${view.flags[key] ? 'on' : ''}" data-flag="${key}" title="${esc(tip)}" aria-pressed="${view.flags[key]}">${label} <small>${n}</small></button>`;
    }).join('') + clear;
  }

  function rowHtml(p) {
    const badgeTags = (p.badges || []).map(b => `<span class="badge-tag ${b}">${BADGE_LABELS[b] || b}</span>`).join('');
    const thumb = (p.images && p.images[0]) || '';
    const colorsStr = Array.isArray(p.colors) && p.colors.length ? p.colors.join(', ') : '—';
    const flags = [
      p.noPhoto ? '<span class="mini-flag">Sans photo</span>' : '',
      p.soldOut ? '<span class="mini-flag err">Épuisée</span>' : (p.lowStock ? '<span class="mini-flag warn">Stock faible</span>' : '')
    ].join('');
    const checked = selected.has(p.id);
    return `
      <tr data-id="${p.id}" class="${checked ? 'selected' : ''} ${p.status === 'archived' ? 'is-archived' : ''}">
        <td class="col-check"><input type="checkbox" class="row-check" ${checked ? 'checked' : ''} aria-label="Sélectionner ${esc(p.name)}"></td>
        <td>${thumb ? `<img src="${esc(thumb)}" alt="">` : '<span class="no-thumb"></span>'}</td>
        <td>
          ${p.reference ? `<div class="ref-line">${esc(p.reference)}</div>` : ''}
          <strong>${esc(p.name)}</strong>
          ${p.category ? `<div class="cat-line">${esc(p.category)}</div>` : ''}
          ${(badgeTags || flags) ? `<div style="margin-top:2px;">${badgeTags}${flags}</div>` : ''}
        </td>
        <td class="col-colors">${esc(colorsStr)}</td>
        <td class="col-price">
          <div class="qe"><input type="number" class="qi qi-price" data-act="price" step="0.01" min="0" value="${p.price.toFixed(2)}" aria-label="Prix de ${esc(p.name)}"> <span>€</span></div>
          <div class="qe small"><input type="number" class="qi qi-disc" data-act="discount" min="0" max="90" step="1" value="${p.discountPercent || 0}" aria-label="Remise de ${esc(p.name)}"> <span>% promo</span></div>
        </td>
        <td class="${p.stock === 0 ? 'stock-low' : ''}">${p.stock}</td>
        <td>${p.sold}</td>
        <td>
          <select class="qi qi-status" data-act="status" aria-label="Statut de ${esc(p.name)}">
            ${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          ${p.scheduled ? `<div class="sched">Programmée · ${esc(fmtDateTime(p.publishAt))}</div>` : ''}
        </td>
        <td>
          <div class="row-actions">
            <button type="button" data-btn="edit">Modifier</button>
            <button type="button" data-btn="duplicate">Dupliquer</button>
            ${p.status === 'archived'
              ? `<button type="button" data-btn="unarchive">Désarchiver</button><button type="button" class="danger" data-btn="purge">Supprimer</button>`
              : `<button type="button" data-btn="archive">Archiver</button>`}
          </div>
        </td>
      </tr>`;
  }

  function renderProducts() {
    const list = products.filter(matchesView).sort(SORTS[view.sort] || SORTS.recent);
    visibleIds = list.map(p => p.id);
    const visible = new Set(visibleIds);
    selected = new Set([...selected].filter(id => visible.has(id))); // jamais d'action groupée sur une pièce qu'on ne voit pas

    el('#cat-count').textContent = products.length ? `${list.length} / ${products.length}` : '';
    renderChips();

    const tbody = el('#product-rows');
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-row">${products.length
        ? `Aucune pièce ne correspond. ${filtersActive() ? '<button type="button" class="link-btn" id="reset-filters-2">Réinitialiser les filtres</button>' : ''}`
        : 'Aucune pièce pour le moment. Clique sur « + Nouvelle pièce » ou importe un fichier CSV.'}</td></tr>`;
    } else {
      tbody.innerHTML = list.map(rowHtml).join('');
    }
    renderBulkBar();
  }

  function renderBulkBar() {
    const bar = el('#bulk-bar');
    const n = selected.size;
    const chosen = products.filter(p => selected.has(p.id));
    bar.style.display = n ? 'flex' : 'none';
    el('#bulk-count').textContent = `${n} pièce${n > 1 ? 's' : ''} sélectionnée${n > 1 ? 's' : ''}`;
    bar.querySelector('[data-bulk="archive"]').style.display = chosen.some(p => p.status !== 'archived') ? '' : 'none';
    bar.querySelector('[data-bulk="unarchive"]').style.display = chosen.some(p => p.status === 'archived') ? '' : 'none';
    const all = el('#check-all');
    all.checked = n > 0 && n === visibleIds.length;
    all.indeterminate = n > 0 && n < visibleIds.length;
  }

  // Recherche, tri, filtres
  el('#cat-search').addEventListener('input', (e) => { view.q = e.target.value.trim(); renderProducts(); });
  el('#cat-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; view.q = ''; renderProducts(); } });
  el('#cat-sort').addEventListener('change', (e) => { view.sort = e.target.value; renderProducts(); });
  el('#filter-category').addEventListener('change', (e) => { view.cat = e.target.value; renderProducts(); });
  el('#status-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (b) { view.status = b.dataset.status; renderProducts(); }
  });
  el('#flag-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-flag]');
    if (b) { view.flags[b.dataset.flag] = !view.flags[b.dataset.flag]; renderProducts(); }
    else if (e.target.closest('#reset-filters')) resetFilters();
  });
  el('#product-rows').addEventListener('click', (e) => {
    if (e.target.closest('#reset-filters-2')) resetFilters();
  });
  document.addEventListener('keydown', (e) => {
    // « / » place le curseur dans la recherche (comme sur la plupart des outils)
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && el('#tab-products').style.display !== 'none') {
      e.preventDefault();
      el('#cat-search').focus();
    }
  });

  // Sélection
  el('#check-all').addEventListener('change', (e) => {
    selected = e.target.checked ? new Set(visibleIds) : new Set();
    renderProducts();
  });
  el('#bulk-clear').addEventListener('click', () => { selected = new Set(); renderProducts(); });

  // ---------- Catalogue : modification rapide dans la liste ----------
  async function quickEdit(id, body, okMessage) {
    const res = await fetch(`/api/admin/products/${id}/quick`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || 'Modification impossible'); renderProducts(); return false; }
    replaceProduct(data);
    renderProducts();
    loadStats();
    showToast(okMessage || 'Modifié');
    return true;
  }

  const rowsBody = el('#product-rows');
  rowsBody.addEventListener('change', (e) => {
    const t = e.target;
    const tr = t.closest('tr[data-id]');
    if (!tr) return;
    const id = parseInt(tr.dataset.id, 10);
    if (t.classList.contains('row-check')) {
      if (t.checked) selected.add(id); else selected.delete(id);
      tr.classList.toggle('selected', t.checked);
      renderBulkBar();
      return;
    }
    const act = t.dataset.act;
    if (act === 'price') {
      const v = parseFloat(String(t.value).replace(',', '.'));
      if (!Number.isFinite(v) || v < 0) { showToast('Prix invalide'); return renderProducts(); }
      quickEdit(id, { price: v }, 'Prix mis à jour');
    } else if (act === 'discount') {
      const v = parseInt(t.value, 10);
      if (!Number.isFinite(v) || v < 0 || v > 90) { showToast('Remise : 0 à 90 %'); return renderProducts(); }
      quickEdit(id, { discountPercent: v }, v ? `Promo de ${v} % appliquée` : 'Promo retirée');
    } else if (act === 'status') {
      quickEdit(id, { status: t.value }, `Pièce : ${STATUS_LABEL[t.value].toLowerCase()}`);
    }
  });
  rowsBody.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('qi')) e.target.blur();
  });
  rowsBody.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-btn]');
    if (!b) return;
    const id = parseInt(b.closest('tr').dataset.id, 10);
    const act = b.dataset.btn;
    if (act === 'edit') startEdit(id);
    else if (act === 'duplicate') duplicateProduct(id);
    else if (act === 'archive') quickEdit(id, { status: 'archived' }, 'Pièce archivée (elle reste liée à ses anciennes commandes)');
    else if (act === 'unarchive') quickEdit(id, { status: 'hidden' }, 'Pièce sortie des archives (masquée)');
    else if (act === 'purge') purgeProduct(id);
  });

  async function purgeProduct(id) {
    const p = products.find(x => x.id === id);
    if (!p || !confirm(`Supprimer définitivement « ${p.name} » ? Cette action est irréversible.`)) return;
    const res = await fetch(`/api/admin/products/${id}?permanent=1`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || 'Suppression impossible'); return; }
    showToast('Pièce supprimée définitivement');
    selected.delete(id);
    await loadProducts();
    loadStats();
  }

  async function duplicateProduct(id) {
    const res = await fetch(`/api/admin/products/${id}/duplicate`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erreur lors de la duplication'); return; }
    await loadProducts();
    view.status = 'active'; view.q = ''; el('#cat-search').value = '';
    renderProducts();
    showToast('Copie créée en brouillon : ajuste-la puis mets-la en ligne');
    startEdit(data.id);
  }

  // ---------- Fenêtre modale (import, catégories, actions groupées) ----------
  let modalClose = null;
  function showModal(title, bodyHtml, buttons = [], opts = {}) {
    const overlay = el('#modal-overlay');
    el('#modal-title').textContent = title;
    el('#modal-body').innerHTML = bodyHtml;
    el('#modal').classList.toggle('wide', !!opts.wide);
    const foot = el('#modal-foot');
    foot.innerHTML = '';
    const api = { body: el('#modal-body'), buttons: {}, close() { overlay.style.display = 'none'; modalClose = null; if (opts.onClose) opts.onClose(); } };
    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn sm ${b.cls || 'secondary'}`;
      btn.textContent = b.label;
      if (b.disabled) btn.disabled = true;
      btn.addEventListener('click', async () => {
        if (!b.onClick) return api.close();
        btn.disabled = true;
        let keepOpen = false;
        try { keepOpen = (await b.onClick(api)) === false; } finally { btn.disabled = false; }
        if (!keepOpen) api.close();
      });
      foot.appendChild(btn);
      if (b.id) api.buttons[b.id] = btn;
    });
    overlay.style.display = 'flex';
    modalClose = api.close;
    return api;
  }
  el('#modal-close').addEventListener('click', () => modalClose && modalClose());
  el('#modal-overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'modal-overlay' && modalClose) modalClose(); });

  // ---------- Actions groupées ----------
  async function bulkRequest(payload, okMessage) {
    const ids = [...selected];
    const res = await fetch('/api/admin/products/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, ...payload })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || 'Action impossible'); return false; }
    showToast(`${okMessage} (${data.count} pièce${data.count > 1 ? 's' : ''})`);
    selected = new Set();
    await loadProducts();
    loadStats();
    return true;
  }

  el('#bulk-bar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bulk]');
    if (!b || !selected.size) return;
    const n = selected.size;
    const what = `${n} pièce${n > 1 ? 's' : ''}`;
    switch (b.dataset.bulk) {
      case 'online': bulkRequest({ action: 'status', value: 'online' }, 'Mises en ligne'); break;
      case 'hidden': bulkRequest({ action: 'status', value: 'hidden' }, 'Masquées'); break;
      case 'archive': bulkRequest({ action: 'archive' }, 'Archivées'); break;
      case 'unarchive': bulkRequest({ action: 'unarchive' }, 'Sorties des archives (masquées)'); break;
      case 'discount':
        showModal(`Promo sur ${what}`, `
          <div class="field"><label for="bd-pct">Réduction (%)</label><input type="number" id="bd-pct" min="0" max="90" step="1" value="20"></div>
          <div class="field"><label for="bd-end">Fin de la promo (optionnel)</label><input type="datetime-local" id="bd-end"></div>
          <p class="hint">0 % retire la promo. Sans date de fin : badge « Promo » permanent ; avec une date : vente flash avec compte à rebours.</p>
          <p class="error-text" id="bd-err"></p>`, [
          { label: 'Annuler' },
          { label: 'Appliquer', cls: 'wine', onClick: async () => {
            const pct = parseInt(el('#bd-pct').value, 10);
            if (!Number.isFinite(pct) || pct < 0 || pct > 90) { el('#bd-err').textContent = 'Entre un pourcentage de 0 à 90.'; return false; }
            const endVal = el('#bd-end').value;
            const payload = { action: 'discount', value: pct };
            if (pct > 0 && endVal) payload.endsAt = new Date(endVal).toISOString();
            const ok = await bulkRequest(payload, pct ? `Promo de ${pct} % appliquée` : 'Promo retirée');
            return ok ? undefined : false;
          } }
        ]);
        setTimeout(() => el('#bd-pct') && el('#bd-pct').select(), 30);
        break;
      case 'category':
        showModal(`Changer la catégorie de ${what}`, `
          <div class="field"><label for="bc-name">Nouvelle catégorie</label>
            <input type="text" id="bc-name" list="cat-datalist" placeholder="Choisis ou tape une nouvelle catégorie" autocomplete="off"></div>
          <p class="hint">Laisse vide pour retirer la catégorie.</p>
          <p class="error-text" id="bc-err"></p>`, [
          { label: 'Annuler' },
          { label: 'Appliquer', cls: 'wine', onClick: async () => {
            const ok = await bulkRequest({ action: 'category', value: el('#bc-name').value.trim() }, 'Catégorie modifiée');
            return ok ? undefined : false;
          } }
        ]);
        setTimeout(() => el('#bc-name') && el('#bc-name').focus(), 30);
        break;
    }
  });

  // ---------- Gestion des catégories ----------
  function openCategories() {
    const m = showModal('Catégories', '<div id="cats-body"></div>', [{ label: 'Fermer' }], {
      onClose: () => { refreshCategoryOptions(); renderProducts(); }
    });
    const body = m.body.querySelector('#cats-body');
    const call = async (path, payload) => {
      const res = await fetch(`/api/admin/categories${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || 'Erreur'); return false; }
      categories = data;
      return true;
    };
    const refreshAll = async () => { await loadProducts(); draw(); };
    function draw() {
      const rows = categories;
      body.innerHTML = `
        <p class="hint" style="margin:0 0 12px;">L'ordre ci-dessous est celui de la liste des catégories dans l'admin. Renommer une catégorie la renomme sur toutes ses pièces (et fusionne si le nom existe déjà).</p>
        <div class="cats-list">${rows.length ? rows.map((c, i) => `
          <div class="cat-row" data-name="${esc(c.name)}">
            <div class="cat-name"><strong>${esc(c.name)}</strong> <small>${c.count} pièce${c.count > 1 ? 's' : ''}${c.archivedCount ? ` · ${c.archivedCount} archivée${c.archivedCount > 1 ? 's' : ''}` : ''}</small></div>
            <div class="row-actions">
              <button type="button" data-c="up" ${i === 0 ? 'disabled' : ''} aria-label="Monter">↑</button>
              <button type="button" data-c="down" ${i === rows.length - 1 ? 'disabled' : ''} aria-label="Descendre">↓</button>
              <button type="button" data-c="rename">Renommer</button>
              <button type="button" class="danger" data-c="delete">Supprimer</button>
            </div>
          </div>`).join('') : '<p class="hint">Aucune catégorie pour le moment.</p>'}
        </div>
        <form class="cat-add" id="cat-add-form">
          <input type="text" id="cat-add-name" placeholder="Nouvelle catégorie" maxlength="60" autocomplete="off">
          <button type="submit" class="btn wine sm">Ajouter</button>
        </form>`;
    }
    draw();
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-c]');
      if (!b) return;
      const name = b.closest('.cat-row').dataset.name;
      const names = categories.map(c => c.name);
      const i = names.indexOf(name);
      if (b.dataset.c === 'up' || b.dataset.c === 'down') {
        const j = b.dataset.c === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= names.length) return;
        [names[i], names[j]] = [names[j], names[i]];
        if (await call('/order', { order: names })) draw();
      } else if (b.dataset.c === 'rename') {
        const to = (window.prompt(`Renommer la catégorie « ${name} » en :`, name) || '').trim();
        if (!to || to === name) return;
        if (await call('/rename', { from: name, to })) { showToast('Catégorie renommée'); await refreshAll(); }
      } else if (b.dataset.c === 'delete') {
        const c = categories[i];
        if (!confirm(`Supprimer la catégorie « ${name} » ? Ses ${c.count + c.archivedCount} pièce(s) resteront, mais sans catégorie.`)) return;
        if (await call('/delete', { name })) { showToast('Catégorie supprimée'); await refreshAll(); }
      }
    });
    body.addEventListener('submit', async (e) => {
      if (e.target.id !== 'cat-add-form') return;
      e.preventDefault();
      const name = el('#cat-add-name').value.trim();
      if (!name) return;
      if (await call('', { name })) { showToast('Catégorie ajoutée'); draw(); refreshCategoryOptions(); }
    });
  }
  el('#cats-btn').addEventListener('click', openCategories);

  // ---------- Import CSV ----------
  async function readCsvFile(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder('windows-1252').decode(buf); } // export Excel « CSV (séparateur point-virgule) »
  }
  const impVal = (v) => (v === null || v === undefined || v === '') ? '(vide)' : String(v);

  function openImport() {
    let csvText = '';
    let last = null;
    const m = showModal('Importer le catalogue (CSV)', `
      <p class="hint" style="margin:0 0 12px;">Modifie les prix et les stocks dans un tableur, puis réimporte le fichier. <strong>Exporte d'abord ton catalogue</strong> pour avoir le bon format. Une cellule vide laisse la valeur actuelle ; les photos ne sont pas importées ; une nouvelle pièce arrive en brouillon.</p>
      <div class="field"><input type="file" id="imp-file" accept=".csv,text/csv,text/plain"></div>
      <div id="imp-result"></div>`, [
      { label: 'Fermer' },
      { id: 'apply', label: 'Appliquer l\'import', cls: 'wine', disabled: true, onClick: async () => {
        const res = await fetch('/api/admin/products/import?mode=apply', { method: 'POST', headers: { 'Content-Type': 'text/csv; charset=utf-8' }, body: csvText });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { showToast(data.error || 'Import impossible'); return false; }
        showToast(`Import terminé : ${data.counts.created} créée(s), ${data.counts.updated} modifiée(s)`);
        await loadProducts();
        loadStats();
      } }
    ], { wide: true });

    const out = m.body.querySelector('#imp-result');
    function drawResult(showUnchanged) {
      const c = last.counts;
      const rows = last.rows.filter(r => showUnchanged || r.action !== 'unchanged');
      const pill = { create: ['Création', 'ok'], update: ['Modification', 'info'], unchanged: ['Inchangée', ''], error: ['Erreur', 'err'] };
      out.innerHTML = `
        <div class="imp-counts">
          <span class="imp-c ok">${c.created} création${c.created > 1 ? 's' : ''}</span>
          <span class="imp-c info">${c.updated} modification${c.updated > 1 ? 's' : ''}</span>
          <span class="imp-c">${c.unchanged} inchangée${c.unchanged > 1 ? 's' : ''}</span>
          <span class="imp-c ${c.errors ? 'err' : ''}">${c.errors} erreur${c.errors > 1 ? 's' : ''}</span>
        </div>
        ${c.errors ? '<p class="hint" style="color:var(--err);">Les lignes en erreur seront ignorées ; les autres seront appliquées.</p>' : ''}
        <label class="check-line" style="margin:10px 0;"><input type="checkbox" id="imp-unch" ${showUnchanged ? 'checked' : ''}> Afficher aussi les lignes inchangées</label>
        <div class="imp-scroll"><table class="product-table imp-table">
          <thead><tr><th>Ligne</th><th>Pièce</th><th>Action</th><th>Détail</th></tr></thead>
          <tbody>${rows.length ? rows.map(r => `
            <tr>
              <td>${r.line}</td>
              <td>${esc(r.label)}</td>
              <td><span class="imp-pill ${pill[r.action][1]}">${pill[r.action][0]}</span></td>
              <td>
                ${r.changes.map(ch => `<div>${esc(ch.field)} : <span class="imp-from">${esc(impVal(ch.from))}</span> → <strong>${esc(impVal(ch.to))}</strong></div>`).join('')}
                ${r.errors.map(x => `<div class="imp-err">${esc(x)}</div>`).join('')}
                ${r.warnings.map(x => `<div class="imp-warn">${esc(x)}</div>`).join('')}
              </td>
            </tr>`).join('') : '<tr><td colspan="4" class="empty-row">Rien à afficher.</td></tr>'}
          </tbody></table></div>
        ${last.truncated ? '<p class="hint">Seules les 600 premières lignes sont affichées (toutes sont importées).</p>' : ''}`;
      const cb = out.querySelector('#imp-unch');
      if (cb) cb.addEventListener('change', () => drawResult(cb.checked));
      m.buttons.apply.disabled = (c.created + c.updated) === 0;
      m.buttons.apply.textContent = (c.created + c.updated) ? `Appliquer (${c.created + c.updated} pièce${c.created + c.updated > 1 ? 's' : ''})` : 'Rien à importer';
    }

    m.body.querySelector('#imp-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      out.innerHTML = '';
      m.buttons.apply.disabled = true;
      if (!file) return;
      out.innerHTML = '<p class="hint">Analyse du fichier…</p>';
      try {
        csvText = await readCsvFile(file);
        const res = await fetch('/api/admin/products/import?mode=preview', { method: 'POST', headers: { 'Content-Type': 'text/csv; charset=utf-8' }, body: csvText });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { out.innerHTML = `<p class="error-text">${esc(data.error || 'Fichier illisible')}</p>`; return; }
        last = data;
        drawResult(false);
      } catch (err) {
        out.innerHTML = '<p class="error-text">Impossible de lire ce fichier.</p>';
      }
    });
  }
  el('#import-btn').addEventListener('click', openImport);

  // ---------- Panneau latéral : fiche produit ----------
  let formDirty = false;

  function openDrawer() {
    el('#drawer-overlay').style.display = 'block';
    const d = el('#drawer');
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    document.body.classList.add('pd-open');
  }
  function closeDrawer(force) {
    if (!force && formDirty && !confirm('Fermer sans enregistrer ? Les modifications seront perdues.')) return;
    el('#drawer-overlay').style.display = 'none';
    const d = el('#drawer');
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('pd-open');
    resetForm();
  }
  el('#drawer-close').addEventListener('click', () => closeDrawer());
  el('#cancel-edit').addEventListener('click', () => closeDrawer());
  el('#drawer-overlay').addEventListener('click', () => closeDrawer());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (modalClose) modalClose();
    else if (el('#drawer').classList.contains('open')) closeDrawer();
  });
  el('#new-product-btn').addEventListener('click', () => {
    resetForm();
    openDrawer();
    setTimeout(() => el('#p-name').focus(), 60);
  });
  ['input', 'change'].forEach(ev => el('#product-form').addEventListener(ev, () => { formDirty = true; }));

  // Statut / date de mise en ligne
  function syncPublishField() {
    const online = el('#p-status').value === 'online';
    el('#publish-field').style.display = online ? '' : 'none';
    el('#publish-hint').style.display = online ? '' : 'none';
  }
  el('#p-status').addEventListener('change', syncPublishField);

  // Référence : avertissement immédiat si elle existe déjà
  function refClash() {
    const key = normRef(el('#p-ref').value);
    if (!key) return null;
    return products.find(p => p.id !== editingId && normRef(p.reference) === key) || null;
  }
  function updateRefWarn() {
    const clash = refClash();
    const w = el('#ref-warn');
    if (clash) { w.textContent = `⚠ Déjà utilisée par « ${clash.name} » (fiche n°${clash.id}).`; w.style.display = 'block'; }
    else { w.style.display = 'none'; w.textContent = ''; }
  }
  el('#p-ref').addEventListener('input', updateRefWarn);

  function startEdit(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    resetForm();
    editingId = id;
    el('#form-title').textContent = 'Modifier la pièce';
    el('#product-id').value = id;
    el('#p-ref').value = p.reference || '';
    el('#p-name').value = p.name;
    el('#p-colors').value = colorsToText(p);
    el('#p-desc').value = p.description || '';
    el('#p-price').value = p.price;
    refreshCategoryOptions(p.category || '');
    el('#p-status').value = p.status;
    el('#p-publish-at').value = p.publishAt ? toShopDatetimeValue(p.publishAt) : '';
    syncPublishField();

    renderSizeGrid(p.sizes || [], parseColorNames(el('#p-colors').value));

    existingImages = [...(p.images || [])];
    newFiles = [];
    renderPhotoGrid();

    const badges = p.badges || [];
    el('#p-trending').checked = badges.includes('tendance');
    el('#p-promo-active').checked = badges.includes('promo');
    el('#promo-fields').style.display = badges.includes('promo') ? 'block' : 'none';
    el('#p-discount').value = p.discountPercent || 10;
    el('#p-promo-end').value = p.flashEndsAt ? toLocalDatetimeValue(p.flashEndsAt) : '';

    el('#submit-btn').textContent = 'Enregistrer';
    updateRefWarn();
    formDirty = false;
    openDrawer();
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
    el('#p-ref').value = '';
    el('#p-colors').value = '';
    el('#p-status').value = 'online';
    el('#p-publish-at').value = '';
    syncPublishField();
    el('#submit-btn').textContent = 'Ajouter';
    el('#form-error').textContent = '';
    el('#promo-fields').style.display = 'none';
    el('#p-discount').value = 10;
    el('#ref-warn').style.display = 'none';
    refreshCategoryOptions('');
    renderSizeGrid([]);
    renderPhotoGrid();
    formDirty = false;
  }

  el('#product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('#form-error').textContent = '';

    const clash = refClash();
    if (clash) { el('#form-error').textContent = `La référence est déjà utilisée par « ${clash.name} » (fiche n°${clash.id}).`; return; }
    const sizes = collectSizes();
    if (sizes.length === 0) {
      el('#form-error').textContent = 'Choisis au moins une taille dans le catalogue.';
      return;
    }
    const { badges, discountPercent, flashEndsAt } = collectBadgesAndPromo();
    const status = el('#p-status').value;

    const formData = new FormData();
    formData.append('reference', el('#p-ref').value.trim());
    formData.append('name', el('#p-name').value);
    formData.append('colors', el('#p-colors').value.trim());
    formData.append('description', el('#p-desc').value);
    formData.append('price', el('#p-price').value);
    formData.append('category', el('#p-category').value);
    formData.append('sizes', JSON.stringify(sizes));
    formData.append('badges', JSON.stringify(badges));
    formData.append('discountPercent', discountPercent);
    formData.append('status', status);
    const publishAt = el('#p-publish-at').value;
    if (status === 'online' && (publishAt || editingId)) formData.append('publishAt', publishAt); // vide = en ligne tout de suite
    // La fin de vente flash est saisie à l'heure de l'appareil : on envoie un instant précis (ISO)
    if (flashEndsAt) formData.append('flashEndsAt', new Date(flashEndsAt).toISOString());
    else if (editingId) formData.append('flashEndsAt', '');
    if (editingId) formData.append('keepImages', JSON.stringify(existingImages));
    newFiles.forEach(file => formData.append('images', file));

    const url = editingId ? `/api/admin/products/${editingId}` : '/api/admin/products';
    const method = editingId ? 'PUT' : 'POST';

    const submitBtn = el('#submit-btn');
    submitBtn.disabled = true;
    let res, data;
    try {
      res = await fetch(url, { method, body: formData });
      data = await res.json();
    } catch (err) {
      submitBtn.disabled = false;
      el('#form-error').textContent = 'Connexion impossible, réessaie.';
      return;
    }
    submitBtn.disabled = false;
    if (!res.ok) { el('#form-error').textContent = data.error || 'Erreur'; return; }

    showToast(editingId ? 'Pièce mise à jour' : 'Pièce ajoutée');
    closeDrawer(true);
    loadProducts();
    loadStats();
  });

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
        <div style="color:#77706A;">${esc(o.payerName || 'Client')} ${o.payerEmail ? `· ${esc(o.payerEmail)}` : ''}</div>
        ${address ? `<div style="color:#918A80; font-size:13px;">${esc(address)}</div>` : ''}
        <div style="color:#918A80; font-size:13px;">${new Date(o.createdAt).toLocaleString('fr-FR')} · ${o.items.map(i => `${esc(i.name)}${(i.color || (i.size && i.size !== 'TU')) ? ` (${esc([i.color, i.size && i.size !== 'TU' ? i.size : ''].filter(Boolean).join(' / '))})` : ''} ×${i.qty}`).join(', ')}</div>
        <div style="color:#918A80; font-size:12.5px; margin-top:4px;">Sous-total ${fmt(o.subtotal)} + livraison ${fmt(o.shipping)}${o.discount > 0 ? ` − ${fmt(o.discount)}` : ''}</div>
        ${(o.pointsEarned > 0 || o.pointsRedeemed > 0) ? `<div style="color:var(--wine); font-size:12.5px; margin-top:2px;">${o.pointsEarned > 0 ? `+${o.pointsEarned} points gagnés` : ''}${o.pointsEarned > 0 && o.pointsRedeemed > 0 ? ' · ' : ''}${o.pointsRedeemed > 0 ? `${o.pointsRedeemed} points utilisés` : ''}</div>` : ''}
      </div>
    `;
    }).join('');
  }

  // ---------- Init ----------
  renderSizeGrid([]);
  renderPhotoGrid();
  checkAuth();
})();
