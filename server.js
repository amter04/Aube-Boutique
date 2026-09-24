require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const store = require('./db/store');
const storage = require('./db/storage');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.warn('sharp indisponible : les images ne seront pas compressees.'); }

const app = express();
const PORT = process.env.PORT || 3000;
const CURRENCY = process.env.CURRENCY || 'EUR';
const ALLOWED_BADGES = ['promo', 'flash', 'tendance'];
const MAX_IMAGES_PER_PRODUCT = 6;

// ---------- Setup ----------
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 8, // 8h
    secure: process.env.NODE_ENV === 'production'
  }
}));

// On garde les photos en memoire le temps de les redimensionner/compresser
// avant de les ecrire sur disque (evite de stocker des photos de 5-8 Mo telles quelles).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Le fichier doit etre une image'));
  }
});

// Redimensionne et compresse une image uploadee, puis l'envoie sur Supabase Storage (production)
// ou l'ecrit dans /uploads (dev local sans Supabase), et renvoie son URL publique.
async function saveProcessedImage(fileBuffer, originalName) {
  const base = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  let filename = `${base}.jpg`;
  let processed = fileBuffer;

  if (sharp) {
    try {
      processed = await sharp(fileBuffer)
        .rotate() // respecte l'orientation EXIF (photos prises au telephone)
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
    } catch (err) {
      console.error('Compression image echouee, sauvegarde brute:', err.message);
      const ext = path.extname(originalName || '').toLowerCase();
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
      filename = `${base}${safeExt}`;
      processed = fileBuffer;
    }
  } else {
    const ext = path.extname(originalName || '').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
    filename = `${base}${safeExt}`;
  }

  if (storage.USE_SUPABASE_STORAGE) {
    return storage.uploadToSupabase(processed, filename);
  }
  fs.writeFileSync(path.join(uploadsDir, filename), processed);
  return `/uploads/${filename}`;
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Non autorise' });
}

function requireCustomer(req, res, next) {
  if (req.session && req.session.customerId) return next();
  return res.status(401).json({ error: 'Merci de vous connecter' });
}

// ---------- Comptes clients / fidelite : helpers ----------
function toPublicCustomer(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    points: c.points || 0,
    createdAt: c.createdAt
  };
}

function findCustomerByEmail(data, email) {
  const norm = store.normalizeEmail(email);
  return data.customers.find(c => store.normalizeEmail(c.email) === norm);
}

function createCustomer(data, { name, email, password }) {
  const customer = {
    id: data.nextCustomerId++,
    name: String(name || '').trim(),
    email: store.normalizeEmail(email),
    passwordHash: store.hashPassword(password),
    points: 0,
    createdAt: new Date().toISOString()
  };
  data.customers.push(customer);
  return customer;
}

// Calcule la remise fidelite applicable (jamais plus que le sous-total, jamais de solde negatif)
function computeLoyaltyRedemption(customer, subtotalCents, requestedPoints, loyaltySettings) {
  const minRedeem = loyaltySettings.minRedeemPoints || 0;
  let points = Math.max(0, parseInt(requestedPoints, 10) || 0);
  if (!customer || points <= 0) return { pointsRedeemed: 0, discountCents: 0 };
  points = Math.min(points, customer.points || 0);
  if (points < minRedeem) return { pointsRedeemed: 0, discountCents: 0 };
  let discountCents = Math.floor(points * (loyaltySettings.pointValueCents || 0));
  if (discountCents > subtotalCents) {
    // On ne rembourse jamais plus que le sous-total ; on recalcule les points effectivement utilises
    discountCents = subtotalCents;
    points = Math.floor(discountCents / (loyaltySettings.pointValueCents || 1));
  }
  return { pointsRedeemed: points, discountCents };
}

function computeLoyaltyEarnings(subtotalAfterDiscountCents, loyaltySettings) {
  const perEuro = loyaltySettings.pointsPerEuro || 0;
  return Math.floor((subtotalAfterDiscountCents / 100) * perEuro);
}

// ---------- Realtime (Server-Sent Events) ----------
const sseClients = new Set();

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcastUpdate() {
  const payload = `event: products-updated\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (e) { sseClients.delete(client); }
  }
}

setInterval(() => {
  for (const client of sseClients) {
    try { client.write(': ping\n\n'); } catch (e) { sseClients.delete(client); }
  }
}, 25000);

// ---------- Helpers ----------
function computeStock(p) {
  return (p.sizes || []).reduce((sum, s) => sum + (s.stock || 0), 0);
}

function finalPriceCents(p) {
  const discount = p.discountPercent || 0;
  if (discount <= 0) return p.priceCents;
  return Math.round(p.priceCents * (1 - discount / 100));
}

function productImages(p) {
  if (Array.isArray(p.images) && p.images.length > 0) return p.images;
  if (p.imageUrl) return [p.imageUrl]; // compat avec d'anciennes fiches
  return [];
}

function productSlug(p) {
  return `${p.id}-${store.slugify(p.name)}`;
}

function toPublicProduct(p) {
  const stock = computeStock(p);
  const price = p.priceCents / 100;
  const discountPercent = p.discountPercent || 0;
  const images = productImages(p);
  return {
    id: p.id,
    slug: productSlug(p),
    name: p.name,
    description: p.description,
    category: p.category,
    images,
    imageUrl: images[0] || '',
    price,
    finalPrice: finalPriceCents(p) / 100,
    discountPercent,
    badges: p.badges || [],
    flashEndsAt: p.flashEndsAt || null,
    sizes: (p.sizes || []).map(s => ({ size: s.size, stock: s.stock, inStock: s.stock > 0 })),
    inStock: stock > 0,
    stock,
    createdAt: p.createdAt
  };
}

function parseSizes(raw) {
  let sizes = [];
  try { sizes = JSON.parse(raw || '[]'); } catch (e) { sizes = []; }
  if (!Array.isArray(sizes)) sizes = [];
  return sizes
    .filter(s => s && s.size)
    .map(s => ({ size: String(s.size).trim(), stock: Math.max(0, parseInt(s.stock, 10) || 0) }));
}

function parseBadges(raw) {
  let badges = [];
  try { badges = JSON.parse(raw || '[]'); } catch (e) { badges = []; }
  if (!Array.isArray(badges)) badges = [];
  return badges.filter(b => ALLOWED_BADGES.includes(b));
}

function shippingForSubtotal(settings, subtotalCents) {
  const threshold = settings.freeShippingThresholdCents;
  if (threshold != null && threshold >= 0 && subtotalCents >= threshold) return 0;
  return settings.shippingFlatCents || 0;
}

function isSameDay(dateA, dateB) {
  return dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate();
}

// Envoie un email de confirmation via Resend, si configure (best effort, jamais bloquant).
async function sendConfirmationEmail(order, customerEmail) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'Aube <onboarding@resend.dev>';
  if (!apiKey || !customerEmail) return;
  try {
    const itemsHtml = order.items.map(it =>
      `<li>${it.name}${it.size && it.size !== 'TU' ? ` — taille ${it.size}` : ''} × ${it.qty} — ${(it.priceCents * it.qty / 100).toFixed(2)} €</li>`
    ).join('');
    const html = `
      <div style="font-family:sans-serif; color:#201A16;">
        <h2>Merci pour votre commande, Aube !</h2>
        <p>Commande n°${order.id} confirmee.</p>
        <ul>${itemsHtml}</ul>
        <p>Livraison : ${(order.shippingCents / 100).toFixed(2)} €</p>
        <p><strong>Total : ${(order.totalCents / 100).toFixed(2)} €</strong></p>
        <p>Vous pouvez suivre votre commande ici : ${process.env.PUBLIC_URL || ''}/commande/${order.token}</p>
      </div>`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [customerEmail],
        subject: `Aube — confirmation de votre commande n°${order.id}`,
        html
      })
    });
  } catch (err) {
    console.error('Envoi email de confirmation echoue (non bloquant):', err.message);
  }
}

// ---------- Public config ----------
app.get('/api/config', async (req, res) => {
  const data = await store.load();
  // Le paiement PayPal n'est actif que si la boutique le declare active (reglages admin)
  // ET qu'une cle PayPal valide est configuree. Sinon, on reste en mode test (commande sans paiement).
  const paypalReady = !!process.env.PAYPAL_CLIENT_ID && !!data.settings.paymentsEnabled;
  res.json({
    paypalClientId: paypalReady ? process.env.PAYPAL_CLIENT_ID : '',
    currency: CURRENCY,
    shippingFlatCents: data.settings.shippingFlatCents,
    freeShippingThresholdCents: data.settings.freeShippingThresholdCents,
    testCheckout: !paypalReady, // mode test tant que le paiement n'est pas active
    loyalty: data.settings.loyalty
  });
});

// ---------- Products (public) ----------
app.get('/api/products', async (req, res) => {
  const data = await store.load();
  const rows = data.products
    .filter(p => p.isActive)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(rows.map(toPublicProduct));
});

app.get('/api/products/:id', async (req, res) => {
  const data = await store.load();
  const idPart = parseInt(req.params.id, 10);
  const row = data.products.find(p => p.id === idPart && p.isActive);
  if (!row) return res.status(404).json({ error: 'Produit introuvable' });
  res.json(toPublicProduct(row));
});

// ---------- Admin auth ----------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: "ADMIN_PASSWORD n'est pas configure sur le serveur" });
  }
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Mot de passe incorrect' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ---------- Comptes clients : inscription / connexion / profil ----------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nom, email et mot de passe requis' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caracteres' });
    }
    // Transaction pour eviter que deux inscriptions simultanees avec le meme email passent toutes les deux
    const customer = await store.withTransaction(async (data) => {
      if (findCustomerByEmail(data, email)) {
        const err = new Error('Un compte existe deja avec cet email');
        err.status = 409;
        throw err;
      }
      return createCustomer(data, { name, email, password });
    });
    req.session.customerId = customer.id;
    res.status(201).json({ ok: true, customer: toPublicCustomer(customer) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  const data = await store.load();
  const customer = findCustomerByEmail(data, email);
  if (!customer || !store.verifyPassword(password, customer.passwordHash)) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  }
  req.session.customerId = customer.id;
  res.json({ ok: true, customer: toPublicCustomer(customer) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.customerId = null;
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session || !req.session.customerId) return res.json({ customer: null });
  const data = await store.load();
  const customer = data.customers.find(c => c.id === req.session.customerId);
  if (!customer) return res.json({ customer: null });
  res.json({ customer: toPublicCustomer(customer) });
});

// Historique des commandes du compte connecte
app.get('/api/account/orders', requireCustomer, async (req, res) => {
  const data = await store.load();
  const rows = data.orders
    .filter(o => o.customerId === req.session.customerId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(rows.map(toAdminOrder));
});

// ---------- Admin: dashboard ----------
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const data = await store.load();
  const paidOrders = data.orders.filter(o => o.status === 'paid');
  const totalSales = paidOrders.reduce((sum, o) => sum + o.totalCents, 0) / 100;
  const today = new Date();
  const ordersToday = data.orders.filter(o => isSameDay(new Date(o.createdAt), today)).length;
  const outOfStock = data.products.filter(p => p.isActive && computeStock(p) === 0).length;
  const lowStock = data.products.filter(p => p.isActive && computeStock(p) > 0 && computeStock(p) <= 3).length;
  res.json({
    totalSales,
    ordersCount: data.orders.length,
    ordersToday,
    paidOrdersCount: paidOrders.length,
    productsCount: data.products.length,
    activeProductsCount: data.products.filter(p => p.isActive).length,
    outOfStock,
    lowStock
  });
});

// ---------- Admin: settings (frais de livraison) ----------
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const data = await store.load();
  res.json(data.settings);
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const { shippingFlatCents, freeShippingThresholdCents, paymentsEnabled, loyalty } = req.body || {};
  const settings = await store.withTransaction(async (data) => {
    if (shippingFlatCents !== undefined) {
      data.settings.shippingFlatCents = Math.max(0, Math.round(Number(shippingFlatCents) || 0));
    }
    if (freeShippingThresholdCents !== undefined) {
      data.settings.freeShippingThresholdCents = (freeShippingThresholdCents === null || freeShippingThresholdCents === '')
        ? null
        : Math.max(0, Math.round(Number(freeShippingThresholdCents) || 0));
    }
    if (paymentsEnabled !== undefined) {
      data.settings.paymentsEnabled = !!paymentsEnabled;
    }
    if (loyalty && typeof loyalty === 'object') {
      if (loyalty.pointsPerEuro !== undefined) {
        data.settings.loyalty.pointsPerEuro = Math.max(0, Number(loyalty.pointsPerEuro) || 0);
      }
      if (loyalty.pointValueCents !== undefined) {
        data.settings.loyalty.pointValueCents = Math.max(0, Number(loyalty.pointValueCents) || 0);
      }
      if (loyalty.minRedeemPoints !== undefined) {
        data.settings.loyalty.minRedeemPoints = Math.max(0, Math.round(Number(loyalty.minRedeemPoints) || 0));
      }
    }
    return data.settings;
  });
  res.json({ ok: true, settings });
});

// ---------- Admin: clients / fidelite ----------
app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  const data = await store.load();
  const rows = [...data.customers].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(rows.map(c => ({
    id: c.id,
    name: c.name,
    email: c.email,
    points: c.points || 0,
    ordersCount: data.orders.filter(o => o.customerId === c.id).length,
    createdAt: c.createdAt
  })));
});

// ---------- Admin: products management ----------
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  const data = await store.load();
  const rows = [...data.products].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(rows.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.priceCents / 100,
    category: p.category,
    images: productImages(p),
    sizes: p.sizes || [],
    stock: computeStock(p),
    badges: p.badges || [],
    discountPercent: p.discountPercent || 0,
    flashEndsAt: p.flashEndsAt || null,
    isActive: !!p.isActive
  })));
});

app.post('/api/admin/products', requireAdmin, upload.array('images', MAX_IMAGES_PER_PRODUCT), async (req, res) => {
  try {
    const { name, description, price, category } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'Nom et prix requis' });

    const priceCents = Math.round(parseFloat(price) * 100);
    if (Number.isNaN(priceCents) || priceCents < 0) {
      return res.status(400).json({ error: 'Prix invalide' });
    }

    const images = [];
    for (const file of (req.files || [])) {
      images.push(await saveProcessedImage(file.buffer, file.originalname));
    }

    const sizes = parseSizes(req.body.sizes);
    const badges = parseBadges(req.body.badges);
    const discountPercent = Math.min(90, Math.max(0, parseInt(req.body.discountPercent, 10) || 0));
    const flashEndsAt = req.body.flashEndsAt ? new Date(req.body.flashEndsAt).toISOString() : null;

    const product = await store.withTransaction(async (data) => {
      const p = {
        id: data.nextProductId++,
        name,
        description: description || '',
        priceCents,
        category: category || '',
        images,
        sizes,
        badges,
        discountPercent,
        flashEndsAt,
        isActive: true,
        createdAt: new Date().toISOString()
      };
      data.products.push(p);
      return p;
    });
    broadcastUpdate();

    res.status(201).json({ id: product.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/products/:id', requireAdmin, upload.array('images', MAX_IMAGES_PER_PRODUCT), async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);

    // On compresse les nouvelles images AVANT la transaction (operation lente, pas besoin du verrou pour ca)
    const newImages = [];
    for (const file of (req.files || [])) {
      newImages.push(await saveProcessedImage(file.buffer, file.originalname));
    }

    const result = await store.withTransaction(async (data) => {
      const existing = data.products.find(p => p.id === productId);
      if (!existing) {
        const err = new Error('Produit introuvable');
        err.status = 404;
        throw err;
      }

      const { name, description, price, category, isActive } = req.body;
      if (price !== undefined) existing.priceCents = Math.round(parseFloat(price) * 100);
      if (name !== undefined) existing.name = name;
      if (description !== undefined) existing.description = description;
      if (category !== undefined) existing.category = category;
      if (req.body.sizes !== undefined) existing.sizes = parseSizes(req.body.sizes);
      if (req.body.badges !== undefined) existing.badges = parseBadges(req.body.badges);
      if (req.body.discountPercent !== undefined) {
        existing.discountPercent = Math.min(90, Math.max(0, parseInt(req.body.discountPercent, 10) || 0));
      }
    if (req.body.flashEndsAt !== undefined) {
        existing.flashEndsAt = req.body.flashEndsAt ? new Date(req.body.flashEndsAt).toISOString() : null;
      }
      if (isActive !== undefined) existing.isActive = (isActive === 'true' || isActive === true);

      // Images existantes conservees (envoyees par le front sous forme de tableau JSON d'URLs)
      let keptImages = productImages(existing);
      if (req.body.keepImages !== undefined) {
        try {
          const parsed = JSON.parse(req.body.keepImages);
          if (Array.isArray(parsed)) keptImages = parsed.filter(u => typeof u === 'string');
        } catch (e) { /* on garde les images actuelles si le champ est invalide */ }
      }
      existing.images = [...keptImages, ...newImages].slice(0, MAX_IMAGES_PER_PRODUCT);
      delete existing.imageUrl; // migre les anciennes fiches vers "images"
    });
    broadcastUpdate();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/admin/products/:id/duplicate', requireAdmin, async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    const copy = await store.withTransaction(async (data) => {
      const existing = data.products.find(p => p.id === productId);
      if (!existing) {
        const err = new Error('Produit introuvable');
        err.status = 404;
        throw err;
      }
      const c = {
        ...JSON.parse(JSON.stringify(existing)),
        id: data.nextProductId++,
        name: `${existing.name} (copie)`,
        isActive: false, // masquee par defaut, le temps d'ajuster (ex. couleur) avant publication
        createdAt: new Date().toISOString()
      };
      data.products.push(c);
      return c;
    });
    broadcastUpdate();
    res.status(201).json({ id: copy.id });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const productId = parseInt(req.params.id, 10);
  await store.withTransaction(async (data) => {
    data.products = data.products.filter(p => p.id !== productId);
  });
  broadcastUpdate();
  res.json({ ok: true });
});

// ---------- Admin: orders ----------
function toAdminOrder(o) {
  return {
    id: o.id,
    source: o.source || 'paypal',
    paypalOrderId: o.paypalOrderId || null,
    status: o.status,
    total: o.totalCents / 100,
    subtotal: (o.subtotalCents != null ? o.subtotalCents : o.totalCents) / 100,
    shipping: (o.shippingCents || 0) / 100,
    discount: (o.discountCents || 0) / 100,
    items: o.items,
    payerName: o.payerName || (o.customer && o.customer.name) || '',
    payerEmail: o.payerEmail || (o.customer && o.customer.email) || '',
    customer: o.customer || null,
    customerId: o.customerId || null,
    pointsEarned: o.pointsEarned || 0,
    pointsRedeemed: o.pointsRedeemed || 0,
    createdAt: o.createdAt
  };
}

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const data = await store.load();
  const rows = [...data.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(rows.map(toAdminOrder));
});

app.get('/api/admin/orders/export.csv', requireAdmin, async (req, res) => {
  const data = await store.load();
  const rows = [...data.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = ['Numero', 'Date', 'Statut', 'Mode', 'Client', 'Email', 'Adresse', 'Articles', 'Sous-total', 'Livraison', 'Total'];
  const lines = [header.map(esc).join(';')];
  for (const o of rows) {
    const customer = o.customer || {};
    const address = [customer.address, customer.postalCode, customer.city].filter(Boolean).join(', ');
    const itemsSummary = (o.items || []).map(it => `${it.name}${it.size && it.size !== 'TU' ? ` (${it.size})` : ''} x${it.qty}`).join(' | ');
    lines.push([
      o.id,
      new Date(o.createdAt).toLocaleString('fr-FR'),
      o.status === 'paid' ? 'Payee' : o.status,
      o.source === 'test' ? 'Test (sans paiement)' : 'PayPal',
      o.payerName || customer.name || '',
      o.payerEmail || customer.email || '',
      address,
      itemsSummary,
      ((o.subtotalCents != null ? o.subtotalCents : o.totalCents) / 100).toFixed(2),
      ((o.shippingCents || 0) / 100).toFixed(2),
      (o.totalCents / 100).toFixed(2)
    ].map(esc).join(';'));
  }
  const csv = '\uFEFF' + lines.join('\r\n'); // BOM pour un bon affichage des accents dans Excel
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="commandes-aube-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// ---------- Order lookup (page de confirmation, publique via token) ----------
app.get('/api/orders/token/:token', async (req, res) => {
  const data = await store.load();
  const order = data.orders.find(o => o.token === req.params.token);
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  res.json(toAdminOrder(order));
});

// Calcule et verifie le contenu du panier cote serveur (jamais de confiance dans le prix envoye par le navigateur)
function buildOrderFromCart(data, items) {
  let subtotalCents = 0;
  const orderItems = [];
  for (const item of items) {
    const product = data.products.find(p => p.id === parseInt(item.productId, 10) && p.isActive);
    if (!product) throw new Error(`Produit ${item.productId} introuvable`);

    const sizeEntry = (product.sizes || []).find(s => s.size === item.size);
    if (!sizeEntry) throw new Error(`Taille indisponible pour "${product.name}"`);

    const qty = Math.max(1, parseInt(item.qty, 10) || 1);
    if (sizeEntry.stock < qty) throw new Error(`Stock insuffisant pour "${product.name}" (${item.size})`);

    const unitCents = finalPriceCents(product);
    subtotalCents += unitCents * qty;
    orderItems.push({ productId: product.id, size: item.size, name: product.name, qty, priceCents: unitCents });
  }
  const shippingCents = shippingForSubtotal(data.settings, subtotalCents);
  return { orderItems, subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}

function decrementStock(data, orderItems) {
  for (const it of orderItems) {
    const product = data.products.find(p => p.id === it.productId);
    const sizeEntry = product && (product.sizes || []).find(s => s.size === it.size);
    if (sizeEntry) sizeEntry.stock = Math.max(0, sizeEntry.stock - it.qty);
  }
}

// ---------- Commande sans paiement (mode test tant que les paiements ne sont pas actives) ----------
// Accepte une commande en tant qu'invite, ou en tant que compte client connecte (avec fidelite).
// Un invite peut aussi cocher "creer un compte" au moment de la commande (createAccount + password).
// Tout se passe dans une seule transaction Postgres verrouillee (store.withTransaction) : verification
// du stock, decrement, creation/maj du compte et credit des points sont atomiques - deux clientes ne
// peuvent pas emporter en meme temps la derniere piece d'une taille.
app.post('/api/checkout/test', async (req, res) => {
  try {
    const { items, customer, redeemPoints, createAccount, password } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Panier vide' });
    }
    if (!customer || !customer.name || !customer.email) {
      return res.status(400).json({ error: 'Nom et email requis' });
    }

    const sessionCustomerId = req.session && req.session.customerId;

    const result = await store.withTransaction(async (data) => {
      const built = buildOrderFromCart(data, items); // leve une erreur (stock/produit) si invalide

      // Determine le client : compte deja connecte, nouveau compte cree a la volee, ou invite
      let account = null;
      if (sessionCustomerId) {
        account = data.customers.find(c => c.id === sessionCustomerId) || null;
      } else if (createAccount) {
        if (!password || String(password).length < 6) {
          const err = new Error('Choisis un mot de passe d\'au moins 6 caracteres pour creer ton compte');
          err.status = 400;
          throw err;
        }
        if (findCustomerByEmail(data, customer.email)) {
          const err = new Error('Un compte existe deja avec cet email. Connecte-toi pour continuer.');
          err.status = 409;
          throw err;
        }
        account = createCustomer(data, { name: customer.name, email: customer.email, password });
      }

      // Fidelite : remise eventuelle avec les points, puis calcul des points gagnes sur ce qui est reellement paye
      const loyaltySettings = data.settings.loyalty;
      const { pointsRedeemed, discountCents } = account
        ? computeLoyaltyRedemption(account, built.subtotalCents, redeemPoints, loyaltySettings)
        : { pointsRedeemed: 0, discountCents: 0 };
      const totalCents = Math.max(0, built.totalCents - discountCents);
      const pointsEarned = account ? computeLoyaltyEarnings(built.subtotalCents - discountCents, loyaltySettings) : 0;

      const order = {
        id: data.nextOrderId++,
        token: store.randomToken(),
        source: 'test',
        status: 'paid', // pas de vrai paiement : on marque directement comme validee pour tester le flux
        subtotalCents: built.subtotalCents,
        shippingCents: built.shippingCents,
        discountCents,
        totalCents,
        items: built.orderItems,
        customerId: account ? account.id : null,
        pointsRedeemed,
        pointsEarned,
        customer: {
          name: customer.name,
          email: customer.email,
          address: customer.address || '',
          postalCode: customer.postalCode || '',
          city: customer.city || ''
        },
        payerName: customer.name,
        payerEmail: customer.email,
        createdAt: new Date().toISOString()
      };

      if (account) {
        account.points = Math.max(0, (account.points || 0) - pointsRedeemed) + pointsEarned;
      }

      decrementStock(data, order.items);
      data.orders.push(order);

      return { order, account, newAccountCreated: !sessionCustomerId && !!account };
    });

    broadcastUpdate();

    if (result.newAccountCreated) {
      req.session.customerId = result.account.id; // connecte automatiquement la cliente apres creation de compte
    }

    sendConfirmationEmail(result.order, customer.email); // best effort, ne bloque pas la reponse

    res.json({
      ok: true,
      orderId: result.order.id,
      token: result.order.token,
      pointsEarned: result.order.pointsEarned,
      pointsRedeemed: result.order.pointsRedeemed,
      pointsBalance: result.account ? result.account.points : null
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 400).json({ error: err.message });
  }
});

// ---------- PayPal ----------
const PAYPAL_BASE = process.env.PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

async function getPaypalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('Identifiants PayPal manquants dans .env');

  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!resp.ok) throw new Error('Impossible d\'obtenir un token PayPal');
  const data = await resp.json();
  return data.access_token;
}

app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const { items, redeemPoints } = req.body; // [{ productId, size, qty }]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Panier vide' });
    }

    // Lecture seule pour calculer le montant a facturer : pas besoin de verrou ici,
    // le stock ne sera reellement decremente qu'a la capture du paiement.
    const readData = await store.load();
    let built;
    try {
      built = buildOrderFromCart(readData, items);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const customerId = (req.session && req.session.customerId) || null;
    const account = customerId ? readData.customers.find(c => c.id === customerId) : null;
    const { pointsRedeemed, discountCents } = account
      ? computeLoyaltyRedemption(account, built.subtotalCents, redeemPoints, readData.settings.loyalty)
      : { pointsRedeemed: 0, discountCents: 0 };
    const totalCents = Math.max(0, built.totalCents - discountCents);

    const accessToken = await getPaypalAccessToken();
    const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: CURRENCY,
            value: (totalCents / 100).toFixed(2),
            breakdown: {
              item_total: { currency_code: CURRENCY, value: (built.subtotalCents / 100).toFixed(2) },
              shipping: { currency_code: CURRENCY, value: (built.shippingCents / 100).toFixed(2) },
              discount: { currency_code: CURRENCY, value: (discountCents / 100).toFixed(2) }
            }
          }
        }]
      })
    });
    const order = await resp.json();
    if (!resp.ok) return res.status(500).json({ error: 'Erreur PayPal', details: order });

    // Enregistrement local dans une transaction courte (juste pour l'attribution d'un id unique)
    await store.withTransaction(async (data) => {
      data.orders.push({
        id: data.nextOrderId++,
        token: store.randomToken(),
        source: 'paypal',
        paypalOrderId: order.id,
        status: 'created',
        subtotalCents: built.subtotalCents,
        shippingCents: built.shippingCents,
        discountCents,
        totalCents,
        items: built.orderItems,
        customerId,
        pointsRedeemed,
        pointsEarned: 0, // calcule a la capture, une fois le paiement confirme
        payerName: '',
        payerEmail: '',
        createdAt: new Date().toISOString()
      });
    });

    res.json({ id: order.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/paypal/capture-order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const accessToken = await getPaypalAccessToken();
    const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const capture = await resp.json();
    if (!resp.ok) return res.status(500).json({ error: 'Erreur de capture PayPal', details: capture });

    const payer = capture.payer || {};
    const payerName = payer.name ? `${payer.name.given_name || ''} ${payer.name.surname || ''}`.trim() : '';
    const status = capture.status === 'COMPLETED' ? 'paid' : capture.status.toLowerCase();

    // Decrement de stock + credit des points dans une transaction verrouillee : si PayPal
    // notifie deux fois la meme capture (retry), le stock n'est jamais decremente en double
    // (on ne touche au stock/points que si la commande locale n'etait pas deja "paid").
    const { token, localOrderId } = await store.withTransaction(async (data) => {
      const localOrder = data.orders.find(o => o.paypalOrderId === orderId);
      if (!localOrder) return { token: null, localOrderId: null };

      const alreadyPaid = localOrder.status === 'paid';
      localOrder.status = status;
      localOrder.payerName = payerName;
      localOrder.payerEmail = payer.email_address || '';

      if (status === 'paid' && !alreadyPaid) {
        decrementStock(data, localOrder.items);
        if (localOrder.customerId) {
          const account = data.customers.find(c => c.id === localOrder.customerId);
          if (account) {
            const pointsEarned = computeLoyaltyEarnings(
              (localOrder.subtotalCents || 0) - (localOrder.discountCents || 0),
              data.settings.loyalty
            );
            account.points = Math.max(0, (account.points || 0) - (localOrder.pointsRedeemed || 0)) + pointsEarned;
            localOrder.pointsEarned = pointsEarned;
          }
        }
      }
      return { token: localOrder.token, localOrderId: localOrder.id, order: localOrder };
    }).then(async (r) => {
      if (r.order && status === 'paid') {
        sendConfirmationEmail(r.order, r.order.payerEmail); // best effort, hors transaction
        broadcastUpdate();
      }
      return r;
    });

    res.json({ status, id: capture.id, orderId: localOrderId, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Fallback pages ----------
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/commande/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'confirmation.html'));
});

// Fiche produit avec URL dediee et partageable, ex: /produit/12-robe-lin-ecru
// (le rendu se fait cote client dans app.js a partir de l'id present dans l'URL)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Aube boutique lancee sur http://localhost:${PORT}`);
});
