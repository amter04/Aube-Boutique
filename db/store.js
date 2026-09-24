// Couche de donnees de la boutique.
//
// - Si DATABASE_URL est definie (Supabase en production), tout est stocke dans Postgres,
//   dans une seule ligne JSONB (table "store", voir schema.sql). Les operations sensibles
//   (passer une commande, decrementer un stock, crediter des points de fidelite) passent
//   par withTransaction(), qui pose un vrai verrou Postgres (SELECT ... FOR UPDATE) le temps
//   de l'operation : deux clientes ne peuvent pas emporter en meme temps la derniere piece en stock.
// - Sinon (developpement local sans Supabase configure), on retombe automatiquement sur un
//   fichier data.json local, pour pouvoir lancer le site immediatement sans rien installer.
//   Dans ce mode, withTransaction() serialise simplement les operations dans le process Node
//   (un seul serveur, pas de vrai risque de concurrence).
//
// Dans les deux cas, le reste du serveur (server.js) manipule le meme objet JS "data"
// ({ products, orders, customers, settings, ... }) : la source de stockage est invisible
// pour le reste du code.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('./pool');

const filePath = path.join(__dirname, 'data.json');
const USE_POSTGRES = !!pool;

if (USE_POSTGRES) {
  console.log('Stockage : Supabase/Postgres (DATABASE_URL detectee).');
} else {
  console.log('Stockage : fichier local db/data.json (definis DATABASE_URL pour utiliser Supabase).');
}

// Catalogue de tailles utilise par la boutique (admin + site)
const STANDARD_SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', 'S/M', 'M/L', 'L/XL', 'TU'];

function defaultData() {
  return {
    products: [],
    orders: [],
    customers: [],
    categories: [],
    settings: {
      // Frais de livraison par defaut : 4,90 EUR, offerte des 50 EUR d'achat
      shippingFlatCents: 490,
      freeShippingThresholdCents: 5000,
      // Tant que paymentsEnabled est false, la boutique fonctionne en mode test :
      // les clientes peuvent commander sans paiement reel (pratique le temps de configurer PayPal).
      paymentsEnabled: false,
      // Systeme de fidelite : points gagnes par euro depense, valeur d'un point a la conversion,
      // et solde minimum requis avant de pouvoir les utiliser.
      loyalty: {
        pointsPerEuro: 1,
        pointValueCents: 1, // 1 point = 0,01 EUR une fois utilise (100 points = 1 EUR)
        minRedeemPoints: 100
      }
    },
    nextProductId: 1,
    nextOrderId: 1,
    nextCustomerId: 1
  };
}

// Complete un objet data possiblement incomplet (ancien fichier, ligne Supabase pas encore migree...)
// avec les valeurs par defaut, sans ecraser ce qui existe deja.
function withDefaults(data) {
  const merged = { ...defaultData(), ...(data || {}) };
  merged.settings = { ...defaultData().settings, ...(data && data.settings || {}) };
  merged.settings.loyalty = { ...defaultData().settings.loyalty, ...(data && data.settings && data.settings.loyalty || {}) };
  if (!Array.isArray(merged.customers)) merged.customers = [];
  if (!merged.nextCustomerId) merged.nextCustomerId = 1;
  return merged;
}

// ---------- Backend fichier local (dev sans Supabase) ----------
function fileLoad() {
  if (!fs.existsSync(filePath)) {
    const initial = defaultData();
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return withDefaults(JSON.parse(raw));
  } catch (err) {
    console.error('Erreur de lecture de data.json, reinitialisation:', err.message);
    const initial = defaultData();
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2));
    return initial;
  }
}

function fileSave(data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// File d'attente simple pour serialiser les "transactions" en mode fichier local
// (un seul process Node : ca suffit a eviter les ecritures concurrentes qui s'ecrasent).
let fileQueue = Promise.resolve();
function fileWithTransaction(mutator) {
  const run = fileQueue.then(async () => {
    const data = fileLoad();
    const result = await mutator(data);
    fileSave(data);
    return result;
  });
  // On chaine meme si `run` echoue, pour ne pas bloquer les operations suivantes
  fileQueue = run.catch(() => {});
  return run;
}

// ---------- Backend Postgres (Supabase en production) ----------
async function pgEnsureRow() {
  await pool.query(
    `insert into store (id, data) values (1, $1::jsonb) on conflict (id) do nothing`,
    [JSON.stringify(defaultData())]
  );
}

async function pgLoad() {
  await pgEnsureRow();
  const { rows } = await pool.query('select data from store where id = 1');
  return withDefaults(rows[0] ? rows[0].data : null);
}

async function pgSave(data) {
  await pool.query(
    'update store set data = $1::jsonb, updated_at = now() where id = 1',
    [JSON.stringify(data)]
  );
}

// Verrouille la ligne (SELECT ... FOR UPDATE) le temps de la transaction : toute autre
// commande qui tente la meme operation attend que celle-ci soit terminee (commit ou rollback).
// C'est ce qui evite de vendre deux fois le dernier exemplaire d'une taille.
async function pgWithTransaction(mutator) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `insert into store (id, data) values (1, $1::jsonb) on conflict (id) do nothing`,
      [JSON.stringify(defaultData())]
    );
    const { rows } = await client.query('select data from store where id = 1 for update');
    const data = withDefaults(rows[0] ? rows[0].data : null);
    const result = await mutator(data);
    await client.query('update store set data = $1::jsonb, updated_at = now() where id = 1', [JSON.stringify(data)]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

// ---------- API publique (identique quel que soit le backend) ----------
// load() / save() : usage simple, hors section critique (ex: pages d'admin, lecture publique).
// withTransaction(mutator) : a utiliser pour toute ecriture ou l'on touche au stock, aux points
// de fidelite ou a une commande, afin d'eviter les conditions de course entre deux requetes.
async function load() {
  return USE_POSTGRES ? pgLoad() : fileLoad();
}

async function save(data) {
  return USE_POSTGRES ? pgSave(data) : fileSave(data);
}

// mutator: async (data) => result   (mutator modifie `data` en place)
async function withTransaction(mutator) {
  return USE_POSTGRES ? pgWithTransaction(mutator) : fileWithTransaction(mutator);
}

function totalStock(product) {
  if (!Array.isArray(product.sizes)) return 0;
  return product.sizes.reduce((sum, s) => sum + (s.stock || 0), 0);
}

// Prix effectif en centimes, compte tenu d'une promo active
function effectivePriceCents(product) {
  const promo = product.promo;
  if (promo && promo.active && promo.discountPercent > 0) {
    const now = Date.now();
    if (promo.endsAt && new Date(promo.endsAt).getTime() < now) return product.priceCents; // promo expiree
    return Math.round(product.priceCents * (1 - promo.discountPercent / 100));
  }
  return product.priceCents;
}

function isPromoActive(product) {
  const promo = product.promo;
  if (!promo || !promo.active || !(promo.discountPercent > 0)) return false;
  if (promo.endsAt && new Date(promo.endsAt).getTime() < Date.now()) return false;
  return true;
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enleve les accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'produit';
}

function randomToken(len = 20) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ---------- Comptes clients : mots de passe haches (scrypt, pas de dependance externe) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const attempt = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(attempt, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

module.exports = {
  load, save, withTransaction, USE_POSTGRES,
  totalStock, effectivePriceCents, isPromoActive, STANDARD_SIZES, slugify, randomToken,
  hashPassword, verifyPassword, normalizeEmail
};
