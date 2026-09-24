// Stockage des photos produits.
//
// - Si SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont definies, les photos sont envoyees dans
//   un bucket Supabase Storage public ("product-images") et servies directement depuis l'URL
//   Supabase. C'est indispensable des que le site est heberge : le disque d'un hebergeur comme
//   Render/Railway est efface a chaque redeploiement, donc des photos ecrites uniquement en
//   local finiraient par disparaitre meme si les commandes/produits, eux, sont bien dans Postgres.
// - Sinon (dev local sans Supabase configure), les photos sont ecrites dans /uploads comme avant.
//
// Prerequis cote Supabase (une seule fois) : Storage -> New bucket -> nom "product-images" ->
// active "Public bucket" (les photos produits n'ont pas besoin d'etre privees).

const path = require('path');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'product-images';

const USE_SUPABASE_STORAGE = !!(SUPABASE_URL && SERVICE_KEY);

if (USE_SUPABASE_STORAGE) {
  console.log(`Stockage photos : Supabase Storage (bucket "${BUCKET}").`);
} else {
  console.log('Stockage photos : dossier local /uploads (definis SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY pour utiliser Supabase Storage).');
}

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif'
};

// Envoie un fichier deja pret (buffer) dans le bucket Supabase Storage, renvoie son URL publique.
async function uploadToSupabase(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${filename}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'apikey': SERVICE_KEY,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Envoi Supabase Storage echoue (${resp.status}) : ${detail}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`;
}

async function deleteFromSupabase(filename) {
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${filename}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY }
    });
  } catch (err) {
    console.error('Suppression Supabase Storage echouee (non bloquant):', err.message);
  }
}

module.exports = { USE_SUPABASE_STORAGE, uploadToSupabase, deleteFromSupabase, BUCKET };
