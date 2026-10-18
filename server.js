'use strict';
/**
 * AUBE — serveur de la boutique (version consolidée et sécurisée)
 *
 * ORGANISATION DU FICHIER
 *    0. Configuration et vérifications au démarrage
 *    1. Outils : erreurs, validation des saisies, limiteurs de tentatives
 *    2. Sécurité : en-têtes (CSP), contrôle d'origine, sessions en base
 *    3. Points d'extension : c'est ICI que se branchent les futures options
 *    4. Images, produits, commandes, fidélité, emails
 *    5. Routes (publiques, clientes, équipe, patron, paiement)
 *    6. Démarrage
 *
 * AJOUTER UNE OPTION SANS TOUCHER À CE FICHIER
 *    Crée un fichier  features/mon-option.js  qui exporte :
 *        module.exports = { register(ctx) { ... } };
 *    Le serveur le charge tout seul au démarrage. Dans register(ctx) tu peux :
 *      ctx.app.get/post(...)            ajouter des routes (avec ctx.requireAdmin / requireStaff)
 *      ctx.hooks.on('order.paid', fn)    réagir à un évènement (email, alerte...) APRÈS la commande
 *      ctx.hooks.tx('order.paid', fn)    agir DANS la transaction (ex : compter l'usage d'un code promo)
 *      ctx.pricing.add(fn)              ajouter une réduction au calcul du panier (code promo...)
 *      ctx.orderExtras.add(fn)          enregistrer une info en plus sur la commande (message cadeau...)
 *      ctx.publicConfig.add(fn)          annoncer l'option à la boutique via /api/config
 *      ctx.frontend.addScript(chemin)    charger un script boutique (/js/features/xxx.js)
 *    Évènements : order.created, order.paid, order.fulfillment, stock.changed, product.saved
 *    Tes données : range-les dans data.ext.<nom-de-ton-option> (jamais dans les champs du cœur).
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const store = require('./db/store');
const storage = require('./db/storage');

let pool = null;
try { pool = require('./db/pool').pool || null; } catch (e) { pool = null; }

let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.warn('sharp indisponible : les images ne seront pas compressees.'); }

// ======================================================================
// 0. CONFIGURATION
// ======================================================================
const PORT = process.env.PORT || 3000;
const CURRENCY = process.env.CURRENCY || 'EUR';
const ALLOWED_BADGES = ['promo', 'flash', 'tendance'];
const MAX_IMAGES_PER_PRODUCT = 6;
const MAX_CART_LINES = 30;
const MAX_QTY_PER_LINE = 20;
const STAFF_SESSION_MS = 8 * 60 * 60 * 1000;          // patron / employé : 8 h
const CUSTOMER_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // cliente : 30 jours
const STAFF_CHECK_TTL_MS = 15 * 1000;                  // un employé désactivé perd l'accès en 15 s au plus
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Si SESSION_SECRET est absent ou trop court, on en génère un au hasard.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('⚠ SESSION_SECRET absent ou trop court (16 caractères min.) : un secret temporaire est utilisé, les connexions seront perdues à chaque redémarrage. Définis-le dans Render > Environment.');
}
if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠ ADMIN_PASSWORD n\'est pas défini : la connexion patron est impossible.');
} else if (process.env.ADMIN_PASSWORD.length < 12) {
  console.warn('⚠ ADMIN_PASSWORD est court (moins de 12 caractères). Choisis une phrase de passe plus longue.');
}

// ======================================================================
// 1. OUTILS
// ======================================================================
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function secureToken(len = 24) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
const cleanText = (v, max) => String(v == null ? '' : v).replace(CTRL, '').replace(/\r\n/g, '\n').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
function validEmail(v) { const e = clean(v, 254); return EMAIL_RE.test(e) ? e : null; }
function intInRange(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function parseId(v) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Identifiant invalide');
  return n;
}
function checkPassword(pw) {
  const s = String(pw == null ? '' : pw);
  if (s.length < PASSWORD_MIN) throw new HttpError(400, `Le mot de passe doit faire au moins ${PASSWORD_MIN} caractères`);
  if (s.length > PASSWORD_MAX) throw new HttpError(400, 'Mot de passe trop long');
  return s;
}
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function audit(event, req, extra) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ip: req && req.ip, ...(extra || {}) }));
}

// ----- Limiteurs -----
function createAttemptLimiter({ name, max, windowMs }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k); }, 5 * 60 * 1000).unref();
  const keyOf = (req, id) => `${name}|${req.ip}|${id || ''}`;
  return {
    check(req, id) {
      const rec = hits.get(keyOf(req, id));
      if (rec && rec.resetAt > Date.now() && rec.count >= max) {
        const err = new HttpError(429, `Trop de tentatives. Réessaie dans ${Math.max(1, Math.ceil((rec.resetAt - Date.now()) / 60000))} min.`);
        err.retryAfter = Math.ceil((rec.resetAt - Date.now()) / 1000);
        throw err;
      }
    },
    fail(req, id) {
      const k = keyOf(req, id);
      const rec = hits.get(k);
      if (!rec || rec.resetAt <= Date.now()) hits.set(k, { count: 1, resetAt: Date.now() + windowMs });
      else rec.count++;
    },
    reset(req, id) { hits.delete(keyOf(req, id)); }
  };
}

function createRequestLimiter({ name, max, windowMs }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k); }, 5 * 60 * 1000).unref();
  return (req, res, next) => {
    const k = `${name}|${req.ip}`;
    const now = Date.now();
    let rec = hits.get(k);
    if (!rec || rec.resetAt <= now) { rec = { count: 0, resetAt: now + windowMs }; hits.set(k, rec); }
    rec.count++;
    if (rec.count > max) {
      const err = new HttpError(429, `Trop de requêtes. Réessaie dans ${Math.max(1, Math.ceil((rec.resetAt - now) / 60000))} min.`);
      err.retryAfter = Math.ceil((rec.resetAt - now) / 1000);
      return next(err);
    }
    next();
  };
}

const adminLoginLimiter = createAttemptLimiter({ name: 'admin-login', max: 8, windowMs: 15 * 60 * 1000 });
const staffLoginIpLimiter = createAttemptLimiter({ name: 'staff-login-ip', max: 10, windowMs: 15 * 60 * 1000 });
const staffLoginMailLimiter = createAttemptLimiter({ name: 'staff-login-mail', max: 5, windowMs: 15 * 60 * 1000 });
const customerLoginIpLimiter = createAttemptLimiter({ name: 'cust-login-ip', max: 15, windowMs: 15 * 60 * 1000 });
const customerLoginMailLimiter = createAttemptLimiter({ name: 'cust-login-mail', max: 6, windowMs: 15 * 60 * 1000 });
const registerLimiter = createRequestLimiter({ name: 'register', max: 6, windowMs: 60 * 60 * 1000 });
const checkoutLimiter = createRequestLimiter({ name: 'checkout', max: 15, windowMs: 60 * 60 * 1000 });
const paypalLimiter = createRequestLimiter({ name: 'paypal', max: 40, windowMs: 60 * 60 * 1000 });
const tokenLookupLimiter = createRequestLimiter({ name: 'token-lookup', max: 40, windowMs: 10 * 60 * 1000 });

const DUMMY_HASH = store.hashPassword('aube-faux-mot-de-passe-pour-le-timing');

// ======================================================================
// 2. SÉCURITÉ HTTP
// ======================================================================
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://*.paypal.com https://*.paypalobjects.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.paypal.com https://*.paypalobjects.com",
  "frame-src https://*.paypal.com",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join('; ');
const CSP_MODE = (process.env.CSP_MODE || 'enforce').toLowerCase();

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  if (CSP_MODE === 'report-only') res.setHeader('Content-Security-Policy-Report-Only', CSP);
  else if (CSP_MODE !== 'off') res.setHeader('Content-Security-Policy', CSP);
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  if (req.path === '/admin' || req.path.startsWith('/equipe') || req.path === '/admin.html' || req.path.startsWith('/commande/')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
  next();
}

function sameOriginGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const source = req.get('origin') || req.get('referer');
  if (!source) return next();
  try {
    if (new URL(source).host !== req.get('host')) return next(new HttpError(403, 'Origine non autorisée'));
  } catch (e) {
    return next(new HttpError(403, 'Origine non autorisée'));
  }
  next();
}

app.use(securityHeaders);
app.use(express.json({ limit: '100kb' }));
app.use(sameOriginGuard);
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'ignore' }));
app.use('/uploads', express.static(uploadsDir, { dotfiles: 'deny', index: false }));

// ----- Sessions stockées dans la base -----
class PgSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.ready = this.init();
    setInterval(() => this.prune(), 30 * 60 * 1000).unref();
  }
  async init() {
    await this.db.query('create table if not exists aube_sessions (sid text primary key, sess jsonb not null, expire timestamptz not null)');
    await this.db.query('create index if not exists aube_sessions_expire_idx on aube_sessions (expire)');
    await this.db.query('alter table aube_sessions enable row level security');
  }
  get(sid, cb) {
    this.ready.then(() => this.db.query('select sess from aube_sessions where sid = $1 and expire > now()', [sid]))
      .then(r => cb(null, r.rows[0] ? r.rows[0].sess : null)).catch(cb);
  }
  set(sid, sess, cb) {
    const expire = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + STAFF_SESSION_MS);
    this.ready.then(() => this.db.query(
      'insert into aube_sessions (sid, sess, expire) values ($1, $2::jsonb, $3) on conflict (sid) do update set sess = excluded.sess, expire = excluded.expire',
      [sid, JSON.stringify(sess), expire]
    )).then(() => cb && cb(null)).catch(e => cb && cb(e));
  }
  touch(sid, sess, cb) {
    const expire = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + STAFF_SESSION_MS);
    this.ready.then(() => this.db.query('update aube_sessions set expire = $2 where sid = $1', [sid, expire]))
      .then(() => cb && cb(null)).catch(e => cb && cb(e));
  }
  destroy(sid, cb) {
    this.ready.then(() => this.db.query('delete from aube_sessions where sid = $1', [sid]))
      .then(() => cb && cb(null)).catch(e => cb && cb(e));
  }
  prune() { this.db.query('delete from aube_sessions where expire < now()').catch(() => {}); }
}

async function buildSessionStore() {
  if (!pool) { console.warn('Sessions : mémoire locale (pas de base configurée).'); return new session.MemoryStore(); }
  try {
    const s = new PgSessionStore(pool);
    await s.ready;
    console.log('Sessions : stockées dans la base (table aube_sessions).');
    return s;
  } catch (e) {
    console.warn('⚠ Sessions : impossible d\'utiliser la base (' + e.message + '), repli sur la mémoire locale.');
    return new session.MemoryStore();
  }
}

function destroySession(req, res) {
  return new Promise((resolve) => {
    if (!req.session) return resolve();
    req.session.destroy(() => { if (res) res.clearCookie('aube.sid'); resolve(); });
  });
}

function establishSession(req, values, maxAgeMs) {
  return new Promise((resolve, reject) => {
    const prev = req.session ? { role: req.session.role, employeeId: req.session.employeeId, roleSince: req.session.roleSince, customerId: req.session.customerId } : {};
    req.session.regenerate((err) => {
      if (err) return reject(err);
      Object.entries(prev).forEach(([k, v]) => { if (v != null) req.session[k] = v; });
      Object.assign(req.session, values);
      req.session.cookie.maxAge = Math.max(maxAgeMs, req.session.customerId ? CUSTOMER_SESSION_MS : 0);
      req.session.save((e2) => (e2 ? reject(e2) : resolve()));
    });
  });
}

const staffCache = new Map();
async function employeeStatus(id) {
  const hit = staffCache.get(id);
  if (hit && hit.until > Date.now()) return hit;
  const data = await store.load();
  const emp = (data.employees || []).find(e => e.id === id);
  const rec = { ok: !!emp && emp.active !== false, name: emp ? emp.name : '', until: Date.now() + STAFF_CHECK_TTL_MS };
  staffCache.set(id, rec);
  return rec;
}
const invalidateStaff = (id) => staffCache.delete(id);

function staffSessionFresh(s) { return s && s.roleSince && (Date.now() - s.roleSince) < STAFF_SESSION_MS; }

async function resolveStaff(req) {
  const s = req.session;
  if (!s || !s.role || !staffSessionFresh(s)) return null;
  if (s.role === 'admin') return { role: 'admin', name: 'Patron' };
  if (s.role === 'employee') {
    const st = await employeeStatus(s.employeeId);
    if (st.ok) return { role: 'employee', name: st.name, id: s.employeeId };
  }
  return null;
}

const requireStaff = asyncHandler(async (req, res, next) => {
  const who = await resolveStaff(req);
  if (!who) throw new HttpError(401, 'Non autorise');
  req.staff = who;
  next();
});
const requireAdmin = asyncHandler(async (req, res, next) => {
  const who = await resolveStaff(req);
  if (!who || who.role !== 'admin') throw new HttpError(401, 'Non autorise');
  req.staff = who;
  next();
});
function requireCustomer(req, res, next) {
  if (req.session && req.session.customerId) return next();
  next(new HttpError(401, 'Merci de vous connecter'));
}

// ======================================================================
// 3. POINTS D'EXTENSION
// ======================================================================
const eventHandlers = {};
const txHandlers = {};
const pricingAdjusters = [];
const orderExtraBuilders = [];
const publicConfigExtras = [];
const frontendScripts = [];

const hooks = {
  on(evt, fn) { (eventHandlers[evt] = eventHandlers[evt] || []).push(fn); },
  tx(evt, fn) { (txHandlers[evt] = txHandlers[evt] || []).push(fn); },
  emit(evt, payload) {
    (eventHandlers[evt] || []).forEach(fn => Promise.resolve().then(() => fn(payload)).catch(e => console.error(`[option ${evt}]`, e.message)));
  },
  async runTx(evt, data, payload) {
    for (const fn of (txHandlers[evt] || [])) {
      try { await fn(data, payload); } catch (e) { if (e instanceof HttpError) throw e; console.error(`[option tx ${evt}]`, e.message); }
    }
  }
};

async function runPricing(data, input) {
  const adjustments = [];
  let remaining = input.subtotalCents;
  for (const fn of pricingAdjusters) {
    try {
      const r = await fn({ ...input, data, remainingCents: remaining });
      if (r && r.discountCents > 0) {
        const d = Math.min(Math.round(r.discountCents), remaining);
        if (d > 0) {
          adjustments.push({ type: String(r.type || 'adjustment').slice(0, 30), code: r.code ? String(r.code).slice(0, 40) : null, label: String(r.label || '').slice(0, 120), discountCents: d });
          remaining -= d;
        }
      }
    } catch (e) { if (e instanceof HttpError) throw e; console.error('[option pricing]', e.message); }
  }
  return adjustments;
}

async function buildOrderExtras(body, data) {
  const ext = {};
  for (const fn of orderExtraBuilders) {
    try { Object.assign(ext, (await fn(body, data)) || {}); } catch (e) { if (e instanceof HttpError) throw e; console.error('[option orderExtras]', e.message); }
  }
  return ext;
}

// ======================================================================
// 4. DOMAINE
// ======================================================================
const MAX_SSE_CLIENTS = 300;
const sseClients = new Set();

function broadcastUpdate() {
  const payload = `event: products-updated\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`;
  for (const client of sseClients) { try { client.write(payload); } catch (e) { sseClients.delete(client); } }
}
setInterval(() => {
  for (const client of sseClients) { try { client.write(': ping\n\n'); } catch (e) { sseClients.delete(client); } }
}, 25000).unref();

// ----- Images -----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: MAX_IMAGES_PER_PRODUCT },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, 'Format de photo non accepté (JPG, PNG, WebP ou GIF).'));
  }
});

function uploadImages(req, res, next) {
  upload.array('images', MAX_IMAGES_PER_PRODUCT)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(400, 'Photo trop lourde (12 Mo maximum).'));
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return next(new HttpError(400, `${MAX_IMAGES_PER_PRODUCT} photos maximum par pièce.`));
    next(new HttpError(400, 'Envoi des photos impossible.'));
  });
}

function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

async function saveProcessedImage(fileBuffer) {
  const type = detectImageType(fileBuffer);
  if (!type) throw new HttpError(400, 'Un des fichiers n\'est pas une image valide.');
  const base = `${Date.now()}-${secureToken(10)}`;
  let processed = fileBuffer;
  let filename = `${base}.${type}`;
  if (sharp) {
    try {
      processed = await sharp(fileBuffer, { limitInputPixels: 40e6 })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
      filename = `${base}.jpg`;
    } catch (err) {
      throw new HttpError(400, 'Une des photos est illisible ou trop grande.');
    }
  }
  if (storage.USE_SUPABASE_STORAGE) return storage.uploadToSupabase(processed, filename);
  fs.writeFileSync(path.join(uploadsDir, filename), processed);
  return `/uploads/${filename}`;
}

// ----- Produits -----
function computeStock(p) { return (p.sizes || []).reduce((sum, s) => sum + (s.stock || 0), 0); }
function finalPriceCents(p) {
  const discount = p.discountPercent || 0;
  return discount <= 0 ? p.priceCents : Math.round(p.priceCents * (1 - discount / 100));
}
function productImages(p) {
  if (Array.isArray(p.images) && p.images.length > 0) return p.images;
  if (p.imageUrl) return [p.imageUrl];
  return [];
}
const productSlug = (p) => `${p.id}-${store.slugify(p.name)}`;

function toPublicProduct(p) {
  const stock = computeStock(p);
  const images = productImages(p);
  return {
    id: p.id, slug: productSlug(p), name: p.name, description: p.description, category: p.category,
    images, imageUrl: images[0] || '',
    price: p.priceCents / 100, finalPrice: finalPriceCents(p) / 100, discountPercent: p.discountPercent || 0,
    badges: p.badges || [], flashEndsAt: p.flashEndsAt || null,
    sizes: (p.sizes || []).map(s => ({ size: s.size, stock: s.stock, inStock: s.stock > 0 })),
    inStock: stock > 0, stock, createdAt: p.createdAt,
    ...(p.ext && p.ext.public ? p.ext.public : {})
  };
}

function toAdminProduct(p) {
  return {
    id: p.id, name: p.name, description: p.description, price: p.priceCents / 100, category: p.category,
    images: productImages(p), sizes: p.sizes || [], stock: computeStock(p), badges: p.badges || [],
    discountPercent: p.discountPercent || 0, flashEndsAt: p.flashEndsAt || null, isActive: !!p.isActive
  };
}

function parseSizes(raw) {
  let arr;
  try { arr = JSON.parse(raw || '[]'); } catch (e) { throw new HttpError(400, 'Tailles invalides'); }
  if (!Array.isArray(arr)) throw new HttpError(400, 'Tailles invalides');
  const seen = new Set();
  const out = [];
  for (const s of arr.slice(0, 30)) {
    const size = clean(s && s.size, 10);
    if (!/^[A-Za-z0-9\/.\- ]{1,10}$/.test(size) || seen.has(size)) continue;
    seen.add(size);
    out.push({ size, stock: intInRange(s.stock, 0, 100000, 0) });
  }
  return out;
}

function parseBadges(raw) {
  let b;
  try { b = JSON.parse(raw || '[]'); } catch (e) { b = []; }
  return Array.isArray(b) ? b.filter(x => ALLOWED_BADGES.includes(x)) : [];
}

function parsePriceCents(v) {
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new HttpError(400, 'Prix invalide');
  return Math.round(n * 100);
}

function parseFlashEnd(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Date de fin invalide');
  return d.toISOString();
}

// ----- Commandes -----
function shippingForSubtotal(settings, subtotalCents) {
  const threshold = settings.freeShippingThresholdCents;
  if (threshold != null && threshold >= 0 && subtotalCents >= threshold) return 0;
  return settings.shippingFlatCents || 0;
}

function toAdminOrder(o) {
  return {
    id: o.id, source: o.source || 'paypal', paypalOrderId: o.paypalOrderId || null, status: o.status,
    total: o.totalCents / 100,
    subtotal: (o.subtotalCents != null ? o.subtotalCents : o.totalCents) / 100,
    shipping: (o.shippingCents || 0) / 100, discount: (o.discountCents || 0) / 100,
    adjustments: o.adjustments || [],
    items: o.items,
    payerName: o.payerName || (o.customer && o.customer.name) || '',
    payerEmail: o.payerEmail || (o.customer && o.customer.email) || '',
    customer: o.customer || null,
    fulfillmentStatus: o.fulfillmentStatus || 'to_prepare',
    trackingNumber: o.trackingNumber || '',
    fulfillmentHistory: o.fulfillmentHistory || [],
    customerId: o.customerId || null,
    pointsEarned: o.pointsEarned || 0, pointsRedeemed: o.pointsRedeemed || 0,
    ext: o.ext || {},
    createdAt: o.createdAt
  };
}

function toPublicOrder(o) {
  return {
    id: o.id, token: o.token, source: o.source || 'paypal', status: o.status,
    total: o.totalCents / 100,
    subtotal: (o.subtotalCents != null ? o.subtotalCents : o.totalCents) / 100,
    shipping: (o.shippingCents || 0) / 100, discount: (o.discountCents || 0) / 100,
    items: (o.items || []).map(i => ({ productId: i.productId, size: i.size, name: i.name, qty: i.qty, priceCents: i.priceCents })),
    payerName: o.payerName || (o.customer && o.customer.name) || '',
    payerEmail: o.payerEmail || (o.customer && o.customer.email) || '',
    customer: o.customer || null,
    fulfillmentStatus: o.fulfillmentStatus || 'to_prepare',
    trackingNumber: o.trackingNumber || '',
    pointsEarned: o.pointsEarned || 0, pointsRedeemed: o.pointsRedeemed || 0,
    createdAt: o.createdAt
  };
}

function normalizeCart(items) {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Panier vide');
  if (items.length > MAX_CART_LINES) throw new HttpError(400, 'Panier trop volumineux');
  const merged = new Map();
  for (const it of items) {
    const productId = parseInt(it && it.productId, 10);
    const size = clean(it && it.size, 10);
    if (!Number.isInteger(productId) || !size) throw new HttpError(400, 'Panier invalide');
    const qty = intInRange(it.qty, 1, MAX_QTY_PER_LINE, 1);
    const key = `${productId}::${size}`;
    const prev = merged.get(key);
    merged.set(key, { productId, size, qty: Math.min(MAX_QTY_PER_LINE, (prev ? prev.qty : 0) + qty) });
  }
  return [...merged.values()];
}

function buildOrderFromCart(data, cart) {
  let subtotalCents = 0;
  const orderItems = [];
  for (const item of cart) {
    const product = data.products.find(p => p.id === item.productId && p.isActive);
    if (!product) throw new HttpError(400, 'Un produit de ton panier n\'est plus disponible.');
    const sizeEntry = (product.sizes || []).find(s => s.size === item.size);
    if (!sizeEntry) throw new HttpError(400, `Taille indisponible pour "${product.name}"`);
    if (sizeEntry.stock < item.qty) throw new HttpError(400, `Stock insuffisant pour "${product.name}" (${item.size})`);
    const unitCents = finalPriceCents(product);
    subtotalCents += unitCents * item.qty;
    orderItems.push({ productId: product.id, size: item.size, name: product.name, qty: item.qty, priceCents: unitCents });
  }
  const shippingCents = shippingForSubtotal(data.settings, subtotalCents);
  return { orderItems, subtotalCents, shippingCents };
}

function decrementStock(data, orderItems) {
  for (const it of orderItems) {
    const product = data.products.find(p => p.id === it.productId);
    const sizeEntry = product && (product.sizes || []).find(s => s.size === it.size);
    if (sizeEntry) sizeEntry.stock = Math.max(0, sizeEntry.stock - it.qty);
  }
}

// ----- Fidélité -----
function computeLoyaltyRedemption(customer, baseCents, requestedPoints, loyalty) {
  const minRedeem = loyalty.minRedeemPoints || 0;
  let points = Math.max(0, intInRange(requestedPoints, 0, 10000000, 0));
  if (!customer || points <= 0) return { pointsRedeemed: 0, discountCents: 0 };
  points = Math.min(points, customer.points || 0);
  if (points < minRedeem) return { pointsRedeemed: 0, discountCents: 0 };
  const value = loyalty.pointValueCents || 0;
  if (value <= 0) return { pointsRedeemed: 0, discountCents: 0 };
  let discountCents = Math.floor(points * value);
  if (discountCents > baseCents) { discountCents = baseCents; points = Math.floor(discountCents / value); }
  return { pointsRedeemed: points, discountCents };
}
function computeLoyaltyEarnings(cents, loyalty) {
  return Math.max(0, Math.floor((cents / 100) * (loyalty.pointsPerEuro || 0)));
}

async function priceOrder(data, { cart, account, redeemPoints, body }) {
  const built = buildOrderFromCart(data, cart);
  const adjustments = await runPricing(data, { cart: built.orderItems, subtotalCents: built.subtotalCents, account, body });
  const adjustDiscount = adjustments.reduce((s, a) => s + a.discountCents, 0);
  const { pointsRedeemed, discountCents: loyaltyDiscount } = account
    ? computeLoyaltyRedemption(account, built.subtotalCents - adjustDiscount, redeemPoints, data.settings.loyalty)
    : { pointsRedeemed: 0, discountCents: 0 };
  const discountCents = adjustDiscount + loyaltyDiscount;
  const totalCents = Math.max(0, built.subtotalCents - discountCents + built.shippingCents);
  return { ...built, adjustments, discountCents, pointsRedeemed, totalCents };
}

// ----- Clientes / employés -----
function toPublicCustomer(c) { return c ? { id: c.id, name: c.name, email: c.email, points: c.points || 0, createdAt: c.createdAt } : null; }
function toPublicEmployee(e) { return { id: e.id, name: e.name, email: e.email, active: e.active !== false, createdAt: e.createdAt }; }
function findCustomerByEmail(data, email) {
  const norm = store.normalizeEmail(email);
  return data.customers.find(c => store.normalizeEmail(c.email) === norm);
}
function createCustomer(data, { name, email, password }) {
  const customer = {
    id: data.nextCustomerId++, name, email: store.normalizeEmail(email),
    passwordHash: store.hashPassword(password), points: 0, createdAt: new Date().toISOString()
  };
  data.customers.push(customer);
  return customer;
}
function sanitizeCustomerInfo(c) {
  if (!c || typeof c !== 'object') throw new HttpError(400, 'Nom et email requis');
  const name = clean(c.name, 100);
  const email = validEmail(c.email);
  if (!name) throw new HttpError(400, 'Nom requis');
  if (!email) throw new HttpError(400, 'Adresse email invalide');
  return { name, email, address: clean(c.address, 200), postalCode: clean(c.postalCode, 12), city: clean(c.city, 80) };
}

// ----- Emails (Resend, jamais bloquant) -----
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return false;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM || 'Aube <onboarding@resend.dev>', to: [to], subject, html })
    });
    return resp.ok;
  } catch (err) {
    console.error('Envoi email echoue (non bloquant):', err.message);
    return false;
  }
}

function sendConfirmationEmail(order, email) {
  if (!email) return;
  const itemsHtml = order.items.map(it =>
    `<li>${esc(it.name)}${it.size && it.size !== 'TU' ? ` — taille ${esc(it.size)}` : ''} × ${it.qty} — ${(it.priceCents * it.qty / 100).toFixed(2)} €</li>`
  ).join('');
  sendEmail({
    to: email,
    subject: `Aube — confirmation de votre commande n°${order.id}`,
    html: `<div style="font-family:sans-serif; color:#201A16;">
      <h2>Merci pour votre commande !</h2>
      <p>Commande n°${order.id} confirmée.</p>
      <ul>${itemsHtml}</ul>
      <p>Livraison : ${((order.shippingCents || 0) / 100).toFixed(2)} €</p>
      <p><strong>Total : ${(order.totalCents / 100).toFixed(2)} €</strong></p>
      <p>Suivre votre commande : ${esc(process.env.PUBLIC_URL || '')}/commande/${esc(order.token)}</p>
    </div>`
  });
}

function paymentsLive(data) {
  return !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET && !!data.settings.paymentsEnabled;
}

hooks.on('order.paid', ({ order }) => sendConfirmationEmail(order, order.payerEmail || (order.customer && order.customer.email)));

// ======================================================================
// 5. ROUTES
// ======================================================================
const ctx = {
  app, express, store, hooks, HttpError, asyncHandler, requireAdmin, requireStaff, requireCustomer,
  limiters: { attempt: createAttemptLimiter, request: createRequestLimiter },
  validate: { clean, cleanText, validEmail, intInRange, parseId, checkPassword, esc },
  pricing: { add: (fn) => pricingAdjusters.push(fn) },
  orderExtras: { add: (fn) => orderExtraBuilders.push(fn) },
  publicConfig: { add: (fn) => publicConfigExtras.push(fn) },
  frontend: { addScript: (p) => { if (/^\/js\/features\/[a-z0-9_-]+\.js$/i.test(p)) frontendScripts.push(p); else console.warn('Script boutique refusé :', p); } },
  email: { send: sendEmail },
  broadcast: broadcastUpdate,
  secureToken,
  helpers: { toAdminOrder, toPublicOrder, toPublicProduct, finalPriceCents, computeStock, audit }
};

function mountRoutes() {
  // ----- Public : configuration, produits, temps réel -----
  app.get('/api/config', asyncHandler(async (req, res) => {
    const data = await store.load();
    const live = paymentsLive(data);
    const base = {
      paypalClientId: live ? process.env.PAYPAL_CLIENT_ID : '',
      currency: CURRENCY,
      shippingFlatCents: data.settings.shippingFlatCents,
      freeShippingThresholdCents: data.settings.freeShippingThresholdCents,
      testCheckout: !live,
      loyalty: data.settings.loyalty,
      frontendScripts
    };
    for (const fn of publicConfigExtras) {
      try { Object.assign(base, (await fn(data)) || {}); } catch (e) { console.error('[option publicConfig]', e.message); }
    }
    res.json(base);
  }));

  app.get('/api/products', asyncHandler(async (req, res) => {
    const data = await store.load();
    const rows = data.products.filter(p => p.isActive).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(rows.map(toPublicProduct));
  }));

  app.get('/api/products/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const data = await store.load();
    const row = data.products.find(p => p.id === id && p.isActive);
    if (!row) throw new HttpError(404, 'Produit introuvable');
    res.json(toPublicProduct(row));
  }));

  app.get('/api/stream', (req, res) => {
    if (sseClients.size >= MAX_SSE_CLIENTS) return res.status(503).end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  app.get('/api/orders/token/:token', tokenLookupLimiter, asyncHandler(async (req, res) => {
    if (!/^[A-Za-z0-9]{16,64}$/.test(req.params.token)) throw new HttpError(404, 'Commande introuvable');
    const data = await store.load();
    const order = data.orders.find(o => o.token === req.params.token);
    if (!order) throw new HttpError(404, 'Commande introuvable');
    res.json(toPublicOrder(order));
  }));

  // ----- Connexion patron / employé -----
  app.post('/api/admin/login', asyncHandler(async (req, res) => {
    adminLoginLimiter.check(req);
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) throw new HttpError(500, "ADMIN_PASSWORD n'est pas configure sur le serveur");
    const password = String((req.body && req.body.password) || '').slice(0, 500);
    if (!safeEqual(password, expected)) {
      adminLoginLimiter.fail(req);
      audit('login.admin.fail', req);
      throw new HttpError(401, 'Mot de passe incorrect');
    }
    adminLoginLimiter.reset(req);
    await establishSession(req, { role: 'admin', employeeId: null, roleSince: Date.now() }, STAFF_SESSION_MS);
    audit('login.admin.ok', req);
    res.json({ ok: true });
  }));

  app.post('/api/staff/login', asyncHandler(async (req, res) => {
    const email = validEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '').slice(0, PASSWORD_MAX);
    if (!email || !password) throw new HttpError(400, 'Email et mot de passe requis');
    staffLoginIpLimiter.check(req);
    staffLoginMailLimiter.check(req, email.toLowerCase());

    const data = await store.load();
    const employee = (data.employees || []).find(e => store.normalizeEmail(e.email) === store.normalizeEmail(email));
    const ok = store.verifyPassword(password, employee ? employee.passwordHash : DUMMY_HASH) && employee && employee.active !== false;
    if (!ok) {
      staffLoginIpLimiter.fail(req);
      staffLoginMailLimiter.fail(req, email.toLowerCase());
      audit('login.staff.fail', req, { email });
      throw new HttpError(401, 'Identifiants incorrects');
    }
    staffLoginMailLimiter.reset(req, email.toLowerCase());
    await establishSession(req, { role: 'employee', employeeId: employee.id, roleSince: Date.now() }, STAFF_SESSION_MS);
    audit('login.staff.ok', req, { employeeId: employee.id });
    res.json({ ok: true, employee: toPublicEmployee(employee) });
  }));

  const logoutStaff = asyncHandler(async (req, res) => { await destroySession(req, res); res.json({ ok: true }); });
  app.post('/api/admin/logout', logoutStaff);
  app.post('/api/staff/logout', logoutStaff);

  app.get('/api/admin/check', asyncHandler(async (req, res) => {
    const who = await resolveStaff(req);
    if (!who) return res.json({ isAdmin: false, role: null });
    res.json({ isAdmin: who.role === 'admin', role: who.role, name: who.name });
  }));

  // ----- Comptes employés (patron) -----
  app.get('/api/admin/employees', requireAdmin, asyncHandler(async (req, res) => {
    const data = await store.load();
    res.json((data.employees || []).map(toPublicEmployee));
  }));

  app.post('/api/admin/employees', requireAdmin, asyncHandler(async (req, res) => {
    const name = clean(req.body && req.body.name, 80);
    const email = validEmail(req.body && req.body.email);
    if (!name || !email) throw new HttpError(400, 'Nom et email valides requis');
    const password = checkPassword(req.body.password);
    const employee = await store.withTransaction(async (data) => {
      if (data.employees.length >= 50) throw new HttpError(400, 'Nombre maximum d\'employés atteint');
      if (data.employees.some(e => store.normalizeEmail(e.email) === store.normalizeEmail(email))) {
        throw new HttpError(400, 'Un compte employe existe deja avec cet email');
      }
      const e = { id: data.nextEmployeeId++, name, email, passwordHash: store.hashPassword(password), active: true, createdAt: new Date().toISOString() };
      data.employees.push(e);
      return e;
    });
    audit('employee.created', req, { employeeId: employee.id });
    res.status(201).json(toPublicEmployee(employee));
  }));

  app.put('/api/admin/employees/:id', requireAdmin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const { active, password } = req.body || {};
    const newPassword = password ? checkPassword(password) : null;
    const employee = await store.withTransaction(async (data) => {
      const e = data.employees.find(x => x.id === id);
      if (!e) throw new HttpError(404, 'Employe introuvable');
      if (active !== undefined) e.active = !!active;
      if (newPassword) e.passwordHash = store.hashPassword(newPassword);
      return e;
    });
    invalidateStaff(id);
    audit('employee.updated', req, { employeeId: id });
    res.json(toPublicEmployee(employee));
  }));

  app.delete('/api/admin/employees/:id', requireAdmin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    await store.withTransaction(async (data) => { data.employees = data.employees.filter(e => e.id !== id); });
    invalidateStaff(id);
    audit('employee.deleted', req, { employeeId: id });
    res.json({ ok: true });
  }));

  // ----- Comptes clients -----
  app.post('/api/auth/register', registerLimiter, asyncHandler(async (req, res) => {
    const name = clean(req.body && req.body.name, 100);
    const email = validEmail(req.body && req.body.email);
    if (!name || !email) throw new HttpError(400, 'Nom et email valides requis');
    const password = checkPassword(req.body.password);
    const customer = await store.withTransaction(async (data) => {
      if (findCustomerByEmail(data, email)) throw new HttpError(409, 'Un compte existe deja avec cet email');
      return createCustomer(data, { name, email, password });
    });
    await establishSession(req, { customerId: customer.id }, CUSTOMER_SESSION_MS);
    res.status(201).json({ ok: true, customer: toPublicCustomer(customer) });
  }));

  app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const email = validEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '').slice(0, PASSWORD_MAX);
    if (!email || !password) throw new HttpError(400, 'Email et mot de passe requis');
    customerLoginIpLimiter.check(req);
    customerLoginMailLimiter.check(req, email.toLowerCase());
    const data = await store.load();
    const customer = findCustomerByEmail(data, email);
    
    // Supporte à la fois customer.passwordHash et customer.password
    const pwdHash = customer ? (customer.passwordHash || customer.password) : DUMMY_HASH;
    const ok = store.verifyPassword(password, pwdHash) && !!customer;

    if (!ok) {
      customerLoginIpLimiter.fail(req);
      customerLoginMailLimiter.fail(req, email.toLowerCase());
      throw new HttpError(401, 'Email ou mot de passe incorrect');
    }
    customerLoginMailLimiter.reset(req, email.toLowerCase());
    await establishSession(req, { customerId: customer.id }, CUSTOMER_SESSION_MS);
    res.json({ ok: true, customer: toPublicCustomer(customer) });
  }));

  app.post('/api/auth/logout', (req, res) => {
    if (req.session) req.session.customerId = null;
    res.json({ ok: true });
  });

  app.get('/api/auth/me', asyncHandler(async (req, res) => {
    if (!req.session || !req.session.customerId) return res.json({ customer: null });
    const data = await store.load();
    const customer = data.customers.find(c => c.id === req.session.customerId);
    res.json({ customer: customer ? toPublicCustomer(customer) : null });
  }));

  app.get('/api/account/orders', requireCustomer, asyncHandler(async (req, res) => {
    const data = await store.load();
    const rows = data.orders.filter(o => o.customerId === req.session.customerId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(rows.map(toPublicOrder));
  }));

  // ----- Patron : tableau de bord, réglages, clientes -----
  app.get('/api/admin/stats', requireAdmin, asyncHandler(async (req, res) => {
    const data = await store.load();
    const paid = data.orders.filter(o => o.status === 'paid');
    const today = new Date().toDateString();
    res.json({
      totalSales: paid.reduce((s, o) => s + o.totalCents, 0) / 100,
      ordersCount: data.orders.length,
      ordersToday: data.orders.filter(o => new Date(o.createdAt).toDateString() === today).length,
      paidOrdersCount: paid.length,
      productsCount: data.products.length,
      activeProductsCount: data.products.filter(p => p.isActive).length,
      outOfStock: data.products.filter(p => p.isActive && computeStock(p) === 0).length,
      lowStock: data.products.filter(p => p.isActive && computeStock(p) > 0 && computeStock(p) <= 3).length
    });
  }));

  app.get('/api/admin/settings', requireAdmin, asyncHandler(async (req, res) => {
    const data = await store.load();
    res.json(data.settings);
  }));

  app.put('/api/admin/settings', requireAdmin, asyncHandler(async (req, res) => {
    const { shippingFlatCents, freeShippingThresholdCents, paymentsEnabled, loyalty } = req.body || {};
    const settings = await store.withTransaction(async (data) => {
      const s = data.settings;
      if (shippingFlatCents !== undefined) s.shippingFlatCents = intInRange(shippingFlatCents, 0, 100000, 0);
      if (freeShippingThresholdCents !== undefined) {
        s.freeShippingThresholdCents = (freeShippingThresholdCents === null || freeShippingThresholdCents === '')
          ? null : intInRange(freeShippingThresholdCents, 0, 10000000, 0);
      }
      if (paymentsEnabled !== undefined) {
        if (paymentsEnabled && !(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET)) {
          throw new HttpError(400, 'Impossible d\'activer les paiements : les identifiants PayPal ne sont pas configurés sur le serveur.');
        }
        s.paymentsEnabled = !!paymentsEnabled;
      }
      if (loyalty && typeof loyalty === 'object') {
        const L = s.loyalty;
        if (loyalty.pointsPerEuro !== undefined) L.pointsPerEuro = Math.min(100, Math.max(0, Number(loyalty.pointsPerEuro) || 0));
        if (loyalty.pointValueCents !== undefined) L.pointValueCents = Math.min(1000, Math.max(0, Number(loyalty.pointValueCents) || 0));
        if (loyalty.minRedeemPoints !== undefined) L.minRedeemPoints = intInRange(loyalty.minRedeemPoints, 0, 1000000, 0);
      }
      return s;
    });
    audit('settings.updated', req);
    res.json({ ok: true, settings });
  }));

  app.get('/api/admin/customers', requireAdmin, asyncHandler(async (req, res) => {
    const data = await store.load();
    const counts = new Map();
    data.orders.forEach(o => { if (o.customerId) counts.set(o.customerId, (counts.get(o.customerId) || 0) + 1); });
    res.json([...data.customers].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(c => ({
      id: c.id, name: c.name, email: c.email, points: c.points || 0, ordersCount: counts.get(c.id) || 0, createdAt: c.createdAt
    })));
  }));

  // ----- Produits -----
  app.get('/api/admin/products', requireStaff, asyncHandler(async (req, res) => {
    const data = await store.load();
    res.json([...data.products].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(toAdminProduct));
  }));

  app.post('/api/admin/products', requireAdmin, uploadImages, asyncHandler(async (req, res) => {
    const name = clean(req.body.name, 120);
    if (!name) throw new HttpError(400, 'Nom requis');
    const priceCents = parsePriceCents(req.body.price);
    const description = cleanText(req.body.description, 3000);
    const category = clean(req.body.category, 60);
    const sizes = parseSizes(req.body.sizes);
    const badges = parseBadges(req.body.badges);
    const discountPercent = intInRange(req.body.discountPercent, 0, 90, 0);
    const flashEndsAt = parseFlashEnd(req.body.flashEndsAt);

    const images = [];
    for (const file of (req.files || [])) images.push(await saveProcessedImage(file.buffer));

    const product = await store.withTransaction(async (data) => {
      const p = { id: data.nextProductId++, name, description, priceCents, category, images, sizes, badges, discountPercent, flashEndsAt, isActive: true, createdAt: new Date().toISOString() };
      data.products.push(p);
      return p;
    });
    broadcastUpdate();
    hooks.emit('product.saved', { product, created: true });
    res.status(201).json({ id: product.id });
  }));

  app.put('/api/admin/products/:id', requireAdmin, uploadImages, asyncHandler(async (req, res) => {
    const productId = parseId(req.params.id);
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) { patch.name = clean(b.name, 120); if (!patch.name) throw new HttpError(400, 'Nom requis'); }
    if (b.description !== undefined) patch.description = cleanText(b.description, 3000);
    if (b.price !== undefined) patch.priceCents = parsePriceCents(b.price);
    if (b.category !== undefined) patch.category = clean(b.category, 60);
    if (b.sizes !== undefined) patch.sizes = parseSizes(b.sizes);
    if (b.badges !== undefined) patch.badges = parseBadges(b.badges);
    if (b.discountPercent !== undefined) patch.discountPercent = intInRange(b.discountPercent, 0, 90, 0);
    if (b.flashEndsAt !== undefined) patch.flashEndsAt = parseFlashEnd(b.flashEndsAt);
    if (b.isActive !== undefined) patch.isActive = (b.isActive === 'true' || b.isActive === true);
    let keep = null;
    if (b.keepImages !== undefined) {
      try { const parsed = JSON.parse(b.keepImages); if (Array.isArray(parsed)) keep = parsed.filter(u => typeof u === 'string'); } catch (e) { keep = null; }
    }

    const newImages = [];
    for (const file of (req.files || [])) newImages.push(await saveProcessedImage(file.buffer));

    const product = await store.withTransaction(async (data) => {
      const existing = data.products.find(p => p.id === productId);
      if (!existing) throw new HttpError(404, 'Produit introuvable');
      Object.assign(existing, patch);
      const current = productImages(existing);
      const kept = keep === null ? current : keep.filter(u => current.includes(u));
      existing.images = [...kept, ...newImages].slice(0, MAX_IMAGES_PER_PRODUCT);
      delete existing.imageUrl;
      return existing;
    });
    broadcastUpdate();
    hooks.emit('product.saved', { product, created: false });
    res.json({ ok: true });
  }));

  app.patch('/api/admin/products/:id/stock', requireStaff, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const updates = req.body && req.body.sizes;
    if (!Array.isArray(updates) || updates.length === 0 || updates.length > 30) throw new HttpError(400, 'Liste de tailles requise');
    const result = await store.withTransaction(async (data) => {
      const product = data.products.find(p => p.id === id);
      if (!product) throw new HttpError(404, 'Produit introuvable');
      const changes = [];
      for (const u of updates) {
        const size = clean(u && u.size, 10);
        const entry = (product.sizes || []).find(s => s.size === size);
        if (!entry) throw new HttpError(400, `Taille inconnue : ${size}`);
        const stock = parseInt(u.stock, 10);
        if (!Number.isInteger(stock) || stock < 0 || stock > 100000) throw new HttpError(400, `Stock invalide pour ${size}`);
        changes.push({ size, before: entry.stock, after: stock });
        entry.stock = stock;
      }
      return { sizes: product.sizes, changes, productId: product.id };
    });
    broadcastUpdate();
    audit('stock.changed', req, { productId: id, by: req.staff.name, changes: result.changes });
    hooks.emit('stock.changed', { productId: result.productId, changes: result.changes, by: req.staff.name });
    res.json({ ok: true, sizes: result.sizes });
  }));

  app.post('/api/admin/products/:id/duplicate', requireAdmin, asyncHandler(async (req, res) => {
    const productId = parseId(req.params.id);
    const copy = await store.withTransaction(async (data) => {
      const existing = data.products.find(p => p.id === productId);
      if (!existing) throw new HttpError(404, 'Produit introuvable');
      const c = { ...JSON.parse(JSON.stringify(existing)), id: data.nextProductId++, name: `${existing.name} (copie)`.slice(0, 120), isActive: false, createdAt: new Date().toISOString() };
      data.products.push(c);
      return c;
    });
    broadcastUpdate();
    res.status(201).json({ id: copy.id });
  }));

  app.delete('/api/admin/products/:id', requireAdmin, asyncHandler(async (req, res) => {
    const productId = parseId(req.params.id);
    await store.withTransaction(async (data) => { data.products = data.products.filter(p => p.id !== productId); });
    broadcastUpdate();
    audit('product.deleted', req, { productId });
    res.json({ ok: true });
  }));

  // ----- Commandes (équipe) -----
  app.get('/api/admin/orders', requireStaff, asyncHandler(async (req, res) => {
    const data = await store.load();
    res.json([...data.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(toAdminOrder));
  }));

  const FULFILLMENT_STATUSES = ['to_prepare', 'prepared', 'shipped'];
  app.patch('/api/admin/orders/:id/fulfillment', requireStaff, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const { status, trackingNumber } = req.body || {};
    if (status !== undefined && !FULFILLMENT_STATUSES.includes(status)) throw new HttpError(400, 'Statut invalide');
    const result = await store.withTransaction(async (data) => {
      const order = data.orders.find(o => o.id === id);
      if (!order) throw new HttpError(404, 'Commande introuvable');
      if (order.status !== 'paid') throw new HttpError(400, 'Seules les commandes payees peuvent etre preparees');
      const previous = order.fulfillmentStatus || 'to_prepare';
      if (trackingNumber !== undefined) order.trackingNumber = clean(trackingNumber, 60);
      if (status !== undefined && status !== previous) {
        order.fulfillmentStatus = status;
        order.fulfillmentHistory = order.fulfillmentHistory || [];
        order.fulfillmentHistory.push({ status, by: req.staff.name, at: new Date().toISOString() });
      }
      return { order, previous, changed: status !== undefined && status !== previous };
    });
    if (result.changed) {
      audit('order.fulfillment', req, { orderId: id, status, by: req.staff.name });
      hooks.emit('order.fulfillment', { order: result.order, status, previous: result.previous, by: req.staff.name });
    }
    res.json(toAdminOrder(result.order));
  }));

  app.get('/api/admin/orders/export.csv', requireAdmin, asyncHandler(async (req, res) => {
    const data = await store.load();
    const rows = [...data.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const header = ['Numero', 'Date', 'Statut', 'Mode', 'Client', 'Email', 'Adresse', 'Articles', 'Sous-total', 'Livraison', 'Total'];
    const lines = [header.map(csvCell).join(';')];
    for (const o of rows) {
      const c = o.customer || {};
      lines.push([
        o.id, new Date(o.createdAt).toLocaleString('fr-FR'), o.status === 'paid' ? 'Payee' : o.status,
        o.source === 'test' ? 'Test (sans paiement)' : 'PayPal',
        o.payerName || c.name || '', o.payerEmail || c.email || '',
        [c.address, c.postalCode, c.city].filter(Boolean).join(', '),
        (o.items || []).map(it => `${it.name}${it.size && it.size !== 'TU' ? ` (${it.size})` : ''} x${it.qty}`).join(' | '),
        ((o.subtotalCents != null ? o.subtotalCents : o.totalCents) / 100).toFixed(2),
        ((o.shippingCents || 0) / 100).toFixed(2), (o.totalCents / 100).toFixed(2)
      ].map(csvCell).join(';'));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="commandes-aube-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  }));

  // ----- Commande SANS paiement -----
  app.post('/api/checkout/test', checkoutLimiter, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const customerInfo = sanitizeCustomerInfo(body.customer);
    const cart = normalizeCart(body.items);
    const sessionCustomerId = req.session && req.session.customerId;
    const createAccount = !!body.createAccount && !sessionCustomerId;
    const newPassword = createAccount ? checkPassword(body.password) : null;

    const result = await store.withTransaction(async (data) => {
      if (paymentsLive(data)) throw new HttpError(403, 'Les commandes de test sont désactivées. Utilise le paiement.');

      let account = null;
      if (sessionCustomerId) account = data.customers.find(c => c.id === sessionCustomerId) || null;
      else if (createAccount) {
        if (findCustomerByEmail(data, customerInfo.email)) throw new HttpError(409, 'Un compte existe deja avec cet email. Connecte-toi pour continuer.');
        account = createCustomer(data, { name: customerInfo.name, email: customerInfo.email, password: newPassword });
      }

      const priced = await priceOrder(data, { cart, account, redeemPoints: body.redeemPoints, body });
      const pointsEarned = account ? computeLoyaltyEarnings(priced.subtotalCents - priced.discountCents, data.settings.loyalty) : 0;
      const ext = await buildOrderExtras(body, data);

      const order = {
        id: data.nextOrderId++, token: secureToken(24), source: 'test', status: 'paid',
        subtotalCents: priced.subtotalCents, shippingCents: priced.shippingCents,
        discountCents: priced.discountCents, adjustments: priced.adjustments, totalCents: priced.totalCents,
        items: priced.orderItems, customerId: account ? account.id : null,
        pointsRedeemed: priced.pointsRedeemed, pointsEarned,
        customer: customerInfo, payerName: customerInfo.name, payerEmail: customerInfo.email,
        fulfillmentStatus: 'to_prepare', ext, createdAt: new Date().toISOString()
      };
      if (account) account.points = Math.max(0, (account.points || 0) - priced.pointsRedeemed) + pointsEarned;
      decrementStock(data, order.items);
      data.orders.push(order);
      await hooks.runTx('order.paid', data, { order, account });
      return { order, account, newAccount: !sessionCustomerId && !!account };
    });

    broadcastUpdate();
    if (result.newAccount) await establishSession(req, { customerId: result.account.id }, CUSTOMER_SESSION_MS);
    hooks.emit('order.created', { order: result.order });
    hooks.emit('order.paid', { order: result.order });
    res.json({
      ok: true, orderId: result.order.id, token: result.order.token,
      pointsEarned: result.order.pointsEarned, pointsRedeemed: result.order.pointsRedeemed,
      pointsBalance: result.account ? result.account.points : null
    });
  }));

  // ----- PayPal -----
  const PAYPAL_BASE = process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

  async function getPaypalAccessToken() {
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    if (!resp.ok) throw new Error('Impossible d\'obtenir un token PayPal');
    return (await resp.json()).access_token;
  }

  app.post('/api/paypal/create-order', paypalLimiter, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const cart = normalizeCart(body.items);
    const readData = await store.load();
    if (!paymentsLive(readData)) throw new HttpError(403, 'Les paiements ne sont pas activés.');

    const customerId = (req.session && req.session.customerId) || null;
    const account = customerId ? readData.customers.find(c => c.id === customerId) || null : null;
    const priced = await priceOrder(readData, { cart, account, redeemPoints: body.redeemPoints, body });

    const accessToken = await getPaypalAccessToken();
    const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: CURRENCY,
            value: (priced.totalCents / 100).toFixed(2),
            breakdown: {
              item_total: { currency_code: CURRENCY, value: (priced.subtotalCents / 100).toFixed(2) },
              shipping: { currency_code: CURRENCY, value: (priced.shippingCents / 100).toFixed(2) },
              discount: { currency_code: CURRENCY, value: (priced.discountCents / 100).toFixed(2) }
            }
          }
        }]
      })
    });
    const paypalOrder = await resp.json();
    if (!resp.ok) { console.error('PayPal create-order:', JSON.stringify(paypalOrder).slice(0, 500)); throw new HttpError(502, 'Le paiement est momentanément indisponible.'); }

    await store.withTransaction(async (data) => {
      const ext = await buildOrderExtras(body, data);
      data.orders.push({
        id: data.nextOrderId++, token: secureToken(24), source: 'paypal', paypalOrderId: paypalOrder.id, status: 'created',
        subtotalCents: priced.subtotalCents, shippingCents: priced.shippingCents,
        discountCents: priced.discountCents, adjustments: priced.adjustments, totalCents: priced.totalCents,
        items: priced.orderItems, customerId: account ? account.id : null,
        pointsRedeemed: priced.pointsRedeemed, pointsEarned: 0,
        payerName: '', payerEmail: '', fulfillmentStatus: 'to_prepare', ext, createdAt: new Date().toISOString()
      });
    });
    res.json({ id: paypalOrder.id });
  }));

  app.post('/api/paypal/capture-order/:orderId', paypalLimiter, asyncHandler(async (req, res) => {
    const orderId = String(req.params.orderId || '');
    if (!/^[A-Za-z0-9_-]{5,64}$/.test(orderId)) throw new HttpError(400, 'Commande invalide');

    const readData = await store.load();
    const pending = readData.orders.find(o => o.paypalOrderId === orderId);
    if (!pending) throw new HttpError(404, 'Commande introuvable');
    if (pending.status === 'paid') return res.json({ status: 'paid', orderId: pending.id, token: pending.token });
    if (pending.status !== 'created') throw new HttpError(400, 'Cette commande ne peut plus être payée.');

    const accessToken = await getPaypalAccessToken();
    const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });
    const capture = await resp.json();
    if (!resp.ok) { console.error('PayPal capture:', JSON.stringify(capture).slice(0, 500)); throw new HttpError(502, 'Le paiement n\'a pas pu être confirmé.'); }

    const unit = (capture.purchase_units && capture.purchase_units[0]) || {};
    const cap = unit.payments && unit.payments.captures && unit.payments.captures[0];
    const payer = capture.payer || {};
    const payerName = payer.name ? `${payer.name.given_name || ''} ${payer.name.surname || ''}`.trim() : '';
    const completed = capture.status === 'COMPLETED' && cap && cap.status === 'COMPLETED';

    const out = await store.withTransaction(async (data) => {
      const order = data.orders.find(o => o.paypalOrderId === orderId);
      if (!order) return null;
      if (order.status === 'paid') return { order, newlyPaid: false };

      const paidCents = cap ? Math.round(parseFloat(cap.amount && cap.amount.value) * 100) : NaN;
      const amountOk = completed && paidCents === order.totalCents && cap.amount.currency_code === CURRENCY;
      order.payerName = clean(payerName, 100);
      order.payerEmail = validEmail(payer.email_address) || '';
      order.paypalCaptureId = cap ? cap.id : null;

      const ship = unit.shipping;
      if (ship && ship.address) {
        const a = ship.address;
        order.customer = {
          name: clean((ship.name && ship.name.full_name) || payerName, 100),
          email: order.payerEmail,
          address: clean([a.address_line_1, a.address_line_2].filter(Boolean).join(', '), 200),
          postalCode: clean(a.postal_code, 12), city: clean(a.admin_area_2, 80), country: clean(a.country_code, 2)
        };
      }

      if (!amountOk) {
        order.status = completed ? 'review' : String(capture.status || 'failed').toLowerCase().slice(0, 20);
        if (completed) console.error(`⚠ Montant PayPal incohérent pour la commande ${order.id} : attendu ${order.totalCents}, reçu ${paidCents}`);
        return { order, newlyPaid: false };
      }

      order.status = 'paid';
      decrementStock(data, order.items);
      if (order.customerId) {
        const account = data.customers.find(c => c.id === order.customerId);
        if (account) {
          const earned = computeLoyaltyEarnings((order.subtotalCents || 0) - (order.discountCents || 0), data.settings.loyalty);
          account.points = Math.max(0, (account.points || 0) - (order.pointsRedeemed || 0)) + earned;
          order.pointsEarned = earned;
        }
      }
      await hooks.runTx('order.paid', data, { order });
      return { order, newlyPaid: true };
    });

    if (!out) throw new HttpError(404, 'Commande introuvable');
    if (out.newlyPaid) {
      broadcastUpdate();
      hooks.emit('order.created', { order: out.order });
      hooks.emit('order.paid', { order: out.order });
    }
    res.json({ status: out.order.status === 'paid' ? 'paid' : 'failed', id: capture.id, orderId: out.order.id, token: out.order.token });
  }));

  // ----- Options (dossier features/) -----
  loadFeatures();

  // ----- Pages -----
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
  app.get('/equipe', (req, res) => res.sendFile(path.join(__dirname, 'public', 'equipe.html')));
  app.get('/commande/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'confirmation.html')));
  app.all('/api/*', (req, res) => res.status(404).json({ error: 'Introuvable' }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  // ----- Erreurs -----
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    let status = 500;
    let message = 'Erreur serveur, réessaie dans un instant.';
    if (err instanceof HttpError) { status = err.status; message = err.message; }
    else if (err && err.type === 'entity.parse.failed') { status = 400; message = 'Requête invalide'; }
    else if (err && err.type === 'entity.too.large') { status = 413; message = 'Requête trop volumineuse'; }
    if (status >= 500) console.error(`[${req.method} ${req.path}]`, err && err.stack ? err.stack : err);
    if (err && err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    res.status(status).json({ error: message });
  });
}

function loadFeatures() {
  const dir = path.join(__dirname, 'features');
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort().forEach(file => {
    try {
      const mod = require(path.join(dir, file));
      if (mod && typeof mod.register === 'function') { mod.register(ctx); console.log(`Option chargée : ${file}`); }
    } catch (e) {
      console.error(`⚠ Option "${file}" ignorée (erreur) :`, e.message);
    }
  });
}

// ======================================================================
// 6. DÉMARRAGE
// ======================================================================
process.on('unhandledRejection', (reason) => console.error('Promesse non gérée :', reason));
process.on('uncaughtException', (err) => console.error('Exception non gérée :', err));

async function start() {
  const sessionStore = await buildSessionStore();
  app.use(session({
    name: 'aube.sid',
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: CUSTOMER_SESSION_MS }
  }));
  mountRoutes();
  return app.listen(PORT, () => console.log(`Aube boutique lancee sur http://localhost:${PORT}`));
}

start().catch((e) => { console.error('Échec du démarrage :', e); process.exit(1); });

module.exports = { app, ctx };
