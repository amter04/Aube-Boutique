// Stockage simple en fichier JSON local. Pas de dependance native,
// donc pas de compilation requise a l'installation (npm install).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const filePath = path.join(__dirname, 'data.json');

// Catalogue de tailles utilise par la boutique (admin + site)
const STANDARD_SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', 'S/M', 'M/L', 'L/XL', 'TU'];

function defaultData() {
  return {
    products: [],
    orders: [],
    categories: [],
    settings: {
      // Frais de livraison par defaut : 4,90 EUR, offerte des 50 EUR d'achat
      shippingFlatCents: 490,
      freeShippingThresholdCents: 5000
    },
    // Comptes employes : acces restreint a l'admin (gere par le patron, voir server.js)
    employees: [],
    nextProductId: 1,
    nextOrderId: 1,
    nextEmployeeId: 1
  };
}

function load() {
  if (!fs.existsSync(filePath)) {
    const initial = defaultData();
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const merged = { ...defaultData(), ...data };
    // Fusionne les reglages pour ne pas perdre les defauts si le fichier est ancien
    merged.settings = { ...defaultData().settings, ...(data.settings || {}) };
    return merged;
  } catch (err) {
    console.error('Erreur de lecture de data.json, reinitialisation:', err.message);
    const initial = defaultData();
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2));
    return initial;
  }
}

function save(data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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

// Hash d'un mot de passe (comptes employes), sans dependance externe (module crypto natif de Node)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch (e) {
    return false;
  }
}

module.exports = {
  load, save, totalStock, effectivePriceCents, isPromoActive, STANDARD_SIZES, slugify, randomToken,
  hashPassword, verifyPassword
};
