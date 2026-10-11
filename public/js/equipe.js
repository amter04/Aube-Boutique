(() => {
  // ---------- A ADAPTER ----------
  // Coordonnées de la boutique affichées comme "expéditeur" sur les bordereaux imprimés.
  const SHOP = {
    name: 'Aube',
    address: 'À compléter : adresse de retour de la boutique',
    email: ''
  };
  const LOW_STOCK = 3; // une taille est "faible" quand il en reste 3 ou moins

  const el = (sel) => document.querySelector(sel);
  const fmt = (n) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n);
  // Les noms et adresses viennent des clientes : on les "échappe" toujours avant de les afficher
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const STATUS_LABEL = { to_prepare: 'À préparer', prepared: 'Préparée', shipped: 'Expédiée', unpaid: 'En attente de paiement' };

  const state = {
    role: null,
    name: '',
    orders: [],
    products: [],
    tab: 'overview',
    orderFilter: 'to_prepare',
    orderSearch: '',
    stockFilter: 'all',
    stockSearch: '',
    stockEdits: {} // "productId::taille" -> quantité cible saisie
  };

  function showToast(msg) {
    const t = el('#toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- Connexion ----------
  function showLogin() {
    state.role = null;
    el('#eq-login').style.display = 'flex';
    el('#eq-main').style.display = 'none';
    el('#eq-user').style.display = 'none';
  }

  function enter(role, name) {
    state.role = role;
    state.name = role === 'admin' ? 'Patron' : (name || 'Équipe');
    el('#eq-login').style.display = 'none';
    el('#eq-main').style.display = 'block';
    el('#eq-user').style.display = 'flex';
    el('#eq-username').textContent = state.name;
    loadAll();
  }

  async function checkAuth() {
    try {
      const res = await fetch('/api/admin/check');
      const data = await res.json();
      if (data.role) enter(data.role, data.name); else showLogin();
    } catch (e) {
      showLogin();
    }
  }

  el('#eq-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = el('#eq-login-error');
    errorEl.textContent = '';
    try {
      const res = await fetch('/api/staff/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: el('#eq-email').value, password: el('#eq-password').value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { errorEl.textContent = data.error || 'Connexion impossible.'; return; }
      el('#eq-password').value = '';
      enter('employee', data.employee && data.employee.name);
    } catch (err) {
      errorEl.textContent = 'Erreur réseau, réessaie.';
    }
  });

  el('#eq-logout').addEventListener('click', async () => {
    try { await fetch('/api/staff/logout', { method: 'POST' }); } catch (e) {}
    state.orders = [];
    state.products = [];
    showLogin();
  });

  el('#eq-refresh').addEventListener('click', async () => {
    await loadAll();
    showToast('Données actualisées');
  });

  // ---------- Chargement des données ----------
  async function fetchJson(url) {
    const res = await fetch(url);
    if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error('http ' + res.status);
    return res.json();
  }

  async function loadOrders() { state.orders = await fetchJson('/api/admin/orders'); }
  async function loadProducts() { state.products = await fetchJson('/api/admin/products'); }

  async function loadAll() {
    try {
      await Promise.all([loadOrders(), loadProducts()]);
      renderAll();
    } catch (e) {
      if (e.message !== 'unauthorized') showToast('Impossible de charger les données.');
    }
  }

  // Actualisation automatique des commandes toutes les 60 s (sans écraser ce qu'on est en train de saisir)
  setInterval(async () => {
    if (!state.role || state.tab === 'stock') return;
    const active = document.activeElement;
    if (active && active.closest && active.closest('#orders-list')) return;
    try { await loadOrders(); renderAll(); } catch (e) { /* silencieux */ }
  }, 60000);

  // ---------- Helpers ----------
  function fulfillmentOf(o) {
    return o.status === 'paid' ? (o.fulfillmentStatus || 'to_prepare') : 'unpaid';
  }

  function productById(id) { return state.products.find(p => p.id === id); }
  function productImage(id) {
    const p = productById(id);
    return p && p.images && p.images[0] ? p.images[0] : '';
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `il y a ${Math.max(mins, 1)} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `il y a ${hours} h`;
    const days = Math.floor(hours / 24);
    return `il y a ${days} j`;
  }

  function isToday(iso) {
    const d = new Date(iso), n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }

  function lastEvent(o, status) {
    const list = (o.fulfillmentHistory || []).filter(h => h.status === status);
    return list.length ? list[list.length - 1] : null;
  }

  function sizeLabel(size) { return size && size !== 'TU' ? `Taille ${size}` : 'Taille unique'; }

  function addressLines(o) {
    const c = o.customer || {};
    const lines = [];
    if (c.address) lines.push(c.address);
    const cityLine = [c.postalCode, c.city].filter(Boolean).join(' ');
    if (cityLine) lines.push(cityLine);
    return lines;
  }

  function totalStockOf(p) { return (p.sizes || []).reduce((s, x) => s + (x.stock || 0), 0); }
  function hasOutSize(p) { return (p.sizes || []).some(s => s.stock === 0); }
  function hasLowSize(p) { return (p.sizes || []).some(s => s.stock > 0 && s.stock <= LOW_STOCK); }

  // ---------- Rendu global ----------
  function renderAll() {
    renderTabCounts();
    renderOverview();
    renderOrders();
    renderStock();
  }

  function renderTabCounts() {
    const toPrepare = state.orders.filter(o => fulfillmentOf(o) === 'to_prepare').length;
    el('#tab-count-orders').textContent = toPrepare || '';
    const active = state.products.filter(p => p.isActive);
    const attention = active.filter(p => hasOutSize(p) || hasLowSize(p)).length;
    el('#tab-count-stock').textContent = attention || '';
  }

  function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.eq-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    ['overview', 'orders', 'stock'].forEach(n => { el('#tab-' + n).style.display = n === tab ? 'block' : 'none'; });
  }
  document.querySelectorAll('.eq-tab').forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  // ---------- Aperçu ----------
  function renderOverview() {
    const toPrepare = state.orders.filter(o => fulfillmentOf(o) === 'to_prepare');
    const prepared = state.orders.filter(o => fulfillmentOf(o) === 'prepared');
    const shippedToday = state.orders.filter(o => {
      if (fulfillmentOf(o) !== 'shipped') return false;
      const ev = lastEvent(o, 'shipped');
      return ev && isToday(ev.at);
    });
    const active = state.products.filter(p => p.isActive);
    const outCount = active.filter(hasOutSize).length;
    const lowCount = active.filter(hasLowSize).length;

    const cards = [
      { label: 'À préparer', value: toPrepare.length, go: 'orders', filter: 'to_prepare', warn: toPrepare.length > 0 },
      { label: 'Préparées, prêtes à partir', value: prepared.length, go: 'orders', filter: 'prepared' },
      { label: 'Expédiées aujourd\'hui', value: shippedToday.length, go: 'orders', filter: 'shipped' },
      { label: 'Pièces avec une taille épuisée', value: outCount, go: 'stock', stockFilter: 'out', warn: outCount > 0 },
      { label: `Pièces à stock faible (≤ ${LOW_STOCK})`, value: lowCount, go: 'stock', stockFilter: 'low' }
    ];
    el('#eq-stats').innerHTML = cards.map((c, i) => `
      <button type="button" class="eq-stat ${c.warn ? 'warn' : ''}" data-i="${i}">
        <div class="eq-stat-value">${c.value}</div>
        <div class="eq-stat-label">${c.label}</div>
      </button>
    `).join('');
    el('#eq-stats').querySelectorAll('.eq-stat').forEach(b => {
      b.addEventListener('click', () => {
        const c = cards[parseInt(b.dataset.i, 10)];
        if (c.filter) state.orderFilter = c.filter;
        if (c.stockFilter) state.stockFilter = c.stockFilter;
        selectTab(c.go);
        renderOrders();
        renderStock();
      });
    });

    const oldest = [...toPrepare].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).slice(0, 5);
    el('#eq-urgent').innerHTML = oldest.length === 0
      ? `<div class="eq-empty">Aucune commande en attente de préparation. 🎉</div>`
      : oldest.map(o => `
        <button type="button" class="eq-urgent-row" data-id="${o.id}">
          <span><strong>#${o.id}</strong> — ${esc(o.payerName || 'Client')}</span>
          <span>${o.items.reduce((s, i) => s + i.qty, 0)} article(s) · ${timeAgo(o.createdAt)}</span>
        </button>
      `).join('');
    el('#eq-urgent').querySelectorAll('.eq-urgent-row').forEach(b => {
      b.addEventListener('click', () => {
        state.orderFilter = 'to_prepare';
        state.orderSearch = '#' + b.dataset.id;
        el('#order-search').value = state.orderSearch;
        selectTab('orders');
        renderOrders();
      });
    });
  }

  // ---------- Commandes ----------
  function matchesOrderSearch(o, q) {
    if (!q) return true;
    const query = q.replace(/^#/, '').toLowerCase();
    const c = o.customer || {};
    const hay = [String(o.id), o.payerName, o.payerEmail, c.city, c.postalCode, o.trackingNumber].join(' ').toLowerCase();
    return hay.includes(query);
  }

  function renderOrders() {
    const counts = { to_prepare: 0, prepared: 0, shipped: 0, all: state.orders.length };
    state.orders.forEach(o => { const f = fulfillmentOf(o); if (counts[f] !== undefined) counts[f]++; });
    const filters = [['to_prepare', 'À préparer'], ['prepared', 'Préparées'], ['shipped', 'Expédiées'], ['all', 'Toutes']];
    el('#order-pills').innerHTML = filters.map(([key, label]) => `
      <button type="button" class="eq-pill ${state.orderFilter === key ? 'active' : ''}" data-filter="${key}">${label}<small>${counts[key]}</small></button>
    `).join('');
    el('#order-pills').querySelectorAll('.eq-pill').forEach(b => {
      b.addEventListener('click', () => { state.orderFilter = b.dataset.filter; renderOrders(); });
    });

    el('#print-picklist').disabled = counts.to_prepare === 0;
    el('#print-all-slips').disabled = counts.to_prepare === 0;

    let list = state.orders.filter(o => state.orderFilter === 'all' || fulfillmentOf(o) === state.orderFilter);
    list = list.filter(o => matchesOrderSearch(o, state.orderSearch));
    // À préparer : les plus anciennes d'abord (premier arrivé, premier servi). Sinon : les plus récentes d'abord.
    list.sort((a, b) => state.orderFilter === 'to_prepare'
      ? new Date(a.createdAt) - new Date(b.createdAt)
      : new Date(b.createdAt) - new Date(a.createdAt));

    el('#orders-list').innerHTML = list.length === 0
      ? `<div class="eq-empty">Aucune commande dans cette catégorie.</div>`
      : list.map(orderCardHtml).join('');
  }

  function orderCardHtml(o) {
    const f = fulfillmentOf(o);
    const items = o.items.map(it => {
      const img = productImage(it.productId);
      return `
        <div class="eq-item">
          ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<div class="eq-ph"></div>'}
          <div class="eq-item-info">
            <div class="eq-item-name">${esc(it.name)}</div>
            <div class="eq-item-meta">${esc(sizeLabel(it.size))}</div>
          </div>
          <div class="eq-qty">× ${it.qty}</div>
        </div>`;
    }).join('');

    const lines = addressLines(o);
    const address = lines.length
      ? `<div class="eq-address"><strong>${esc(o.payerName || (o.customer && o.customer.name) || '')}</strong><br>${lines.map(esc).join('<br>')}</div>`
      : `<div class="eq-address eq-warn"><strong>${esc(o.payerName || 'Client')}</strong><br>Adresse de livraison non renseignée${o.source === 'paypal' ? ' (commande PayPal)' : ''}.</div>`;

    let buttons = '';
    if (f === 'to_prepare') {
      buttons = `<button type="button" class="btn wine" data-action="status" data-status="prepared" data-id="${o.id}">✓ Marquer préparée</button>`;
    } else if (f === 'prepared') {
      buttons = `
        <button type="button" class="btn wine" data-action="status" data-status="shipped" data-id="${o.id}">📦 Marquer expédiée</button>
        <button type="button" class="btn secondary" data-action="status" data-status="to_prepare" data-id="${o.id}">↩ Remettre à préparer</button>`;
    } else if (f === 'shipped') {
      buttons = `<button type="button" class="btn secondary" data-action="status" data-status="prepared" data-id="${o.id}">↩ Remettre en « préparée »</button>`;
    }
    buttons += `<button type="button" class="btn secondary" data-action="print" data-id="${o.id}">🖨 Bordereau</button>`;

    const tracking = f === 'unpaid' ? '' : `
      <p class="eq-label">Numéro de suivi</p>
      <div class="eq-tracking-row">
        <input type="text" class="eq-tracking" data-id="${o.id}" value="${esc(o.trackingNumber)}" placeholder="Coller le n° de suivi du colis" maxlength="60">
        <button type="button" class="btn secondary eq-sm" data-action="save-tracking" data-id="${o.id}">Enregistrer</button>
      </div>`;

    const history = (o.fulfillmentHistory || []).map(h =>
      `<div>${esc(STATUS_LABEL[h.status] || h.status)} par ${esc(h.by)} · ${fmtDate(h.at)}</div>`
    ).join('');

    return `
      <article class="eq-order" data-id="${o.id}">
        <div class="eq-order-head">
          <div><span class="eq-order-num">Commande #${o.id}</span><span class="eq-order-date">${fmtDate(o.createdAt)} · ${timeAgo(o.createdAt)}</span></div>
          <span class="eq-status ${f}">${STATUS_LABEL[f]}</span>
        </div>
        <div class="eq-order-body">
          <div>
            <p class="eq-label">À mettre dans le colis</p>
            ${items}
          </div>
          <div>
            <p class="eq-label">Livraison</p>
            ${address}
            <div class="eq-total">Montant de la commande : ${fmt(o.total)}</div>
            ${tracking}
          </div>
        </div>
        <div class="eq-order-foot">${buttons}</div>
        ${history ? `<div class="eq-history">${history}</div>` : ''}
      </article>`;
  }

  async function patchFulfillment(id, body) {
    const res = await fetch(`/api/admin/orders/${id}/fulfillment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401) { showLogin(); return null; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || 'Erreur, réessaie.'); return null; }
    const i = state.orders.findIndex(o => o.id === id);
    if (i >= 0) state.orders[i] = data;
    return data;
  }

  el('#orders-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = parseInt(btn.dataset.id, 10);
    const order = state.orders.find(o => o.id === id);
    if (!order) return;
    const action = btn.dataset.action;

    if (action === 'print') { printSlips([order]); return; }

    const input = el(`#orders-list .eq-tracking[data-id="${id}"]`);
    const tracking = input ? input.value.trim() : undefined;
    btn.disabled = true;
    try {
      if (action === 'save-tracking') {
        const r = await patchFulfillment(id, { trackingNumber: tracking });
        if (r) { showToast('Numéro de suivi enregistré'); renderAll(); }
      } else if (action === 'status') {
        const status = btn.dataset.status;
        if (status === 'shipped' && !tracking && !order.trackingNumber) {
          if (!confirm("Aucun numéro de suivi n'est renseigné. Marquer comme expédiée quand même ?")) return;
        }
        const body = { status };
        if (tracking !== undefined) body.trackingNumber = tracking;
        const r = await patchFulfillment(id, body);
        if (r) {
          showToast(status === 'shipped' ? `Commande #${id} expédiée` : status === 'prepared' ? `Commande #${id} préparée` : `Commande #${id} remise à préparer`);
          renderAll();
        }
      }
    } finally {
      btn.disabled = false;
    }
  });

  el('#order-search').addEventListener('input', (e) => {
    state.orderSearch = e.target.value.trim();
    renderOrders();
  });

  // ---------- Impression : bordereaux et liste de préparation ----------
  const PRINT_CSS = `
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; }
    .page { padding: 28px 34px; page-break-after: always; min-height: 95vh; }
    .page:last-child { page-break-after: auto; }
    h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .02em; }
    .sub { color: #555; font-size: 13px; margin-bottom: 22px; }
    .cols { display: flex; gap: 24px; margin-bottom: 22px; }
    .box { flex: 1; border: 1.5px solid #111; padding: 14px 16px; }
    .box h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #555; margin: 0 0 8px; }
    .dest { font-size: 18px; line-height: 1.45; }
    .small { font-size: 13px; line-height: 1.5; color: #333; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #ccc; font-size: 14px; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #555; }
    td.q { font-size: 18px; font-weight: bold; width: 60px; }
    .chk { display: inline-block; width: 16px; height: 16px; border: 1.5px solid #111; margin-right: 6px; vertical-align: middle; }
    .track { margin-top: 18px; font-size: 14px; }
    .foot { margin-top: 28px; font-size: 12px; color: #555; border-top: 1px solid #ccc; padding-top: 10px; }
    @media print { .noprint { display: none; } }
  `;

  function openPrint(title, bodyHtml) {
    const w = window.open('', '_blank');
    if (!w) { showToast('Autorise les fenêtres pop-up pour imprimer.'); return; }
    w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${bodyHtml}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); }, 350);
  }

  function slipHtml(o) {
    const lines = addressLines(o);
    const name = o.payerName || (o.customer && o.customer.name) || '';
    const rows = o.items.map(it => `
      <tr>
        <td><span class="chk"></span>${esc(it.name)}</td>
        <td>${esc(sizeLabel(it.size))}</td>
        <td class="q">× ${it.qty}</td>
      </tr>`).join('');
    return `
      <div class="page">
        <h1>BORDEREAU D'EXPÉDITION</h1>
        <div class="sub">Commande n°${o.id} — passée le ${fmtDate(o.createdAt)}</div>
        <div class="cols">
          <div class="box">
            <h2>Expéditeur</h2>
            <div class="small"><strong>${esc(SHOP.name)}</strong><br>${esc(SHOP.address)}${SHOP.email ? `<br>${esc(SHOP.email)}` : ''}</div>
          </div>
          <div class="box" style="flex:1.4;">
            <h2>Destinataire</h2>
            <div class="dest"><strong>${esc(name)}</strong><br>${lines.length ? lines.map(esc).join('<br>') : '<em>Adresse non renseignée</em>'}</div>
          </div>
        </div>
        <h2 style="font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:#555; margin:0;">Contenu du colis</h2>
        <table>
          <thead><tr><th>Article</th><th>Taille</th><th>Qté</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="track">Numéro de suivi : <strong>${o.trackingNumber ? esc(o.trackingNumber) : '____________________'}</strong></div>
        <div class="foot">Préparé par : ${esc(state.name)} — le ${new Date().toLocaleDateString('fr-FR')} &nbsp;·&nbsp; Merci pour votre commande !</div>
      </div>`;
  }

  function printSlips(orders) {
    if (!orders.length) return;
    openPrint(orders.length === 1 ? `Bordereau commande ${orders[0].id}` : 'Bordereaux', orders.map(slipHtml).join(''));
  }

  function printPickList() {
    const orders = state.orders.filter(o => fulfillmentOf(o) === 'to_prepare');
    if (!orders.length) return;
    // On regroupe par pièce + taille pour aller chercher les articles en une seule tournée
    const map = new Map();
    orders.forEach(o => o.items.forEach(it => {
      const key = `${it.productId}::${it.size}`;
      if (!map.has(key)) map.set(key, { name: it.name, size: it.size, qty: 0, orders: [] });
      const entry = map.get(key);
      entry.qty += it.qty;
      if (!entry.orders.includes(o.id)) entry.orders.push(o.id);
    }));
    const lines = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr') || String(a.size).localeCompare(String(b.size)));
    const totalPieces = lines.reduce((s, l) => s + l.qty, 0);
    const rows = lines.map(l => `
      <tr>
        <td><span class="chk"></span>${esc(l.name)}</td>
        <td>${esc(sizeLabel(l.size))}</td>
        <td class="q">× ${l.qty}</td>
        <td class="small">${l.orders.map(id => '#' + id).join(', ')}</td>
      </tr>`).join('');
    openPrint('Liste de préparation', `
      <div class="page">
        <h1>LISTE DE PRÉPARATION</h1>
        <div class="sub">${orders.length} commande(s) à préparer · ${totalPieces} pièce(s) · éditée le ${new Date().toLocaleString('fr-FR')}</div>
        <table>
          <thead><tr><th>Article</th><th>Taille</th><th>Qté</th><th>Pour les commandes</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="foot">Édité par : ${esc(state.name)}</div>
      </div>`);
  }

  el('#print-picklist').addEventListener('click', printPickList);
  el('#print-all-slips').addEventListener('click', () => {
    const orders = state.orders
      .filter(o => fulfillmentOf(o) === 'to_prepare')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    printSlips(orders);
  });

  // ---------- Stock ----------
  function editKey(pid, size) { return `${pid}::${size}`; }
  function targetOf(pid, s) {
    const k = editKey(pid, s.size);
    return state.stockEdits[k] !== undefined ? state.stockEdits[k] : s.stock;
  }
  function productDirty(p) { return (p.sizes || []).some(s => targetOf(p.id, s) !== s.stock); }

  function renderStock() {
    const active = state.products;
    const counts = {
      all: active.length,
      low: active.filter(p => p.isActive && hasLowSize(p)).length,
      out: active.filter(p => p.isActive && hasOutSize(p)).length
    };
    const filters = [['all', 'Toutes les pièces'], ['low', 'Stock faible'], ['out', 'Taille épuisée']];
    el('#stock-pills').innerHTML = filters.map(([key, label]) => `
      <button type="button" class="eq-pill ${state.stockFilter === key ? 'active' : ''}" data-filter="${key}">${label}<small>${counts[key]}</small></button>
    `).join('');
    el('#stock-pills').querySelectorAll('.eq-pill').forEach(b => {
      b.addEventListener('click', () => { state.stockFilter = b.dataset.filter; renderStock(); });
    });

    const q = state.stockSearch.toLowerCase();
    let list = state.products.filter(p => !q || p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q));
    if (state.stockFilter === 'low') list = list.filter(p => p.isActive && hasLowSize(p));
    if (state.stockFilter === 'out') list = list.filter(p => p.isActive && hasOutSize(p));

    el('#stock-list').innerHTML = list.length === 0
      ? `<div class="eq-empty">Aucune pièce dans cette catégorie.</div>`
      : list.map(productRowHtml).join('');
  }

  function productRowHtml(p) {
    const img = p.images && p.images[0];
    const tags = [
      !p.isActive ? '<span class="eq-tagpill">Masquée</span>' : '',
      hasOutSize(p) ? '<span class="eq-tagpill out">Taille épuisée</span>' : (hasLowSize(p) ? '<span class="eq-tagpill low">Stock faible</span>' : '')
    ].join('');
    const dirty = productDirty(p);
    const sizes = (p.sizes || []).map(s => {
      const key = editKey(p.id, s.size);
      const target = targetOf(p.id, s);
      const delta = target - s.stock;
      return `
        <div class="eq-size ${delta !== 0 ? 'changed' : ''}" data-key="${esc(key)}">
          <span class="eq-size-label">${esc(s.size)}</span>
          <div class="eq-stepper">
            <button type="button" data-action="minus" data-key="${esc(key)}" aria-label="Retirer 1">−</button>
            <input type="number" min="0" class="eq-stock-input" data-key="${esc(key)}" value="${target}">
            <button type="button" data-action="plus" data-key="${esc(key)}" aria-label="Ajouter 1">+</button>
          </div>
          <span class="eq-size-note ${delta !== 0 ? 'delta' : ''}">${delta !== 0 ? `Actuel ${s.stock} → ${target} (${delta > 0 ? '+' : ''}${delta})` : `En stock : ${s.stock}`}</span>
        </div>`;
    }).join('');
    return `
      <div class="eq-prod ${dirty ? 'dirty' : ''}" data-pid="${p.id}">
        <div class="eq-prod-head">
          ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<div class="eq-ph"></div>'}
          <div class="eq-prod-title">
            <div class="eq-prod-name">${esc(p.name)} ${tags}</div>
            <div class="eq-prod-meta">${esc(p.category || 'Sans catégorie')} · ${totalStockOf(p)} pièce(s) au total</div>
          </div>
          <div class="eq-prod-actions">
            <button type="button" class="btn secondary eq-sm" data-action="reset" data-pid="${p.id}" ${dirty ? '' : 'disabled'}>Annuler</button>
            <button type="button" class="btn wine eq-sm" data-action="save" data-pid="${p.id}" ${dirty ? '' : 'disabled'}>Enregistrer</button>
          </div>
        </div>
        <div class="eq-sizes">${sizes}</div>
      </div>`;
  }

  // Met à jour une quantité saisie sans recréer toute la liste (pour ne pas perdre le focus)
  function setTarget(key, value) {
    const [pidStr, ...rest] = key.split('::');
    const size = rest.join('::');
    const pid = parseInt(pidStr, 10);
    const p = productById(pid);
    if (!p) return;
    const s = p.sizes.find(x => x.size === size);
    if (!s) return;
    const target = Math.max(0, parseInt(value, 10) || 0);
    if (target === s.stock) delete state.stockEdits[key]; else state.stockEdits[key] = target;

    const row = el(`.eq-prod[data-pid="${pid}"]`);
    if (!row) return;
    const sizeEl = [...row.querySelectorAll('.eq-size')].find(x => x.dataset.key === key);
    if (sizeEl) {
      const input = sizeEl.querySelector('.eq-stock-input');
      if (document.activeElement !== input) input.value = target;
      const delta = target - s.stock;
      sizeEl.classList.toggle('changed', delta !== 0);
      const note = sizeEl.querySelector('.eq-size-note');
      note.classList.toggle('delta', delta !== 0);
      note.textContent = delta !== 0 ? `Actuel ${s.stock} → ${target} (${delta > 0 ? '+' : ''}${delta})` : `En stock : ${s.stock}`;
    }
    const dirty = productDirty(p);
    row.classList.toggle('dirty', dirty);
    row.querySelector('[data-action="save"]').disabled = !dirty;
    row.querySelector('[data-action="reset"]').disabled = !dirty;
  }

  async function saveStock(pid) {
    const p = productById(pid);
    if (!p) return;
    const changes = p.sizes
      .map(s => ({ size: s.size, baseline: s.stock, target: targetOf(pid, s) }))
      .filter(c => c.target !== c.baseline);
    if (!changes.length) return;

    const btn = el(`.eq-prod[data-pid="${pid}"] [data-action="save"]`);
    if (btn) btn.disabled = true;
    try {
      // On relit le stock actuel juste avant d'enregistrer : si une vente a eu lieu entre-temps,
      // on applique la différence saisie sur le stock réel, au lieu d'écraser la vente.
      const fresh = await fetchJson('/api/admin/products');
      const fp = fresh.find(x => x.id === pid);
      if (!fp) { showToast('Cette pièce n\'existe plus.'); return; }
      let moved = false;
      const sizes = changes.map(c => {
        const fs = fp.sizes.find(x => x.size === c.size);
        const freshStock = fs ? fs.stock : c.baseline;
        if (freshStock !== c.baseline) moved = true;
        return { size: c.size, stock: Math.max(0, freshStock + (c.target - c.baseline)) };
      });

      const res = await fetch(`/api/admin/products/${pid}/stock`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sizes })
      });
      if (res.status === 401) { showLogin(); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || 'Erreur, le stock n\'a pas été modifié.'); return; }

      changes.forEach(c => delete state.stockEdits[editKey(pid, c.size)]);
      state.products = await fetchJson('/api/admin/products');
      renderAll();
      showToast(moved ? 'Stock enregistré (des ventes ont eu lieu entre-temps, la différence a été appliquée au stock réel).' : 'Stock enregistré');
    } catch (e) {
      if (e.message !== 'unauthorized') showToast('Erreur réseau, réessaie.');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  el('#stock-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'minus' || action === 'plus') {
      const key = btn.dataset.key;
      const input = btn.parentElement.querySelector('.eq-stock-input');
      const current = parseInt(input.value, 10) || 0;
      const next = action === 'plus' ? current + 1 : current - 1;
      input.value = Math.max(0, next);
      setTarget(key, input.value);
    } else if (action === 'save') {
      saveStock(parseInt(btn.dataset.pid, 10));
    } else if (action === 'reset') {
      const pid = parseInt(btn.dataset.pid, 10);
      const p = productById(pid);
      if (p) p.sizes.forEach(s => delete state.stockEdits[editKey(pid, s.size)]);
      renderStock();
    }
  });

  el('#stock-list').addEventListener('input', (e) => {
    if (e.target.classList.contains('eq-stock-input')) setTarget(e.target.dataset.key, e.target.value);
  });

  el('#stock-search').addEventListener('input', (e) => {
    state.stockSearch = e.target.value.trim();
    renderStock();
  });

  // ---------- Démarrage ----------
  checkAuth();
})();
