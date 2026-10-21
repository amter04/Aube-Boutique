// Clients Supabase (Auth).
//
// - `supabase` : client "admin" (clé service_role) — réservé aux opérations serveur
//   (créer/modifier/supprimer un compte, vérifier un jeton). Il ne garde AUCUNE session.
// - `authClient()` : renvoie un client neuf, sans session persistée, pour vérifier un mot de
//   passe (signInWithPassword), inscrire quelqu'un ou envoyer un mail de réinitialisation.
//   On n'utilise jamais le client admin pour ça : sinon la session d'une cliente resterait
//   attachée au client partagé par tout le serveur.
//
// Si SUPABASE_URL / clé sont absentes, le serveur démarre quand même (les comptes sont alors
// indisponibles et renvoient une erreur claire) au lieu de planter à l'import.
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

const supabaseConfigured = !!(supabaseUrl && (serviceKey || anonKey));

const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

let supabase = null;
if (supabaseUrl && serviceKey) {
  supabase = createClient(supabaseUrl, serviceKey, opts);
} else {
  console.warn('⚠ SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant : les comptes clientes/employés sont indisponibles.');
}

function authClient() {
  const key = anonKey || serviceKey;
  if (!supabaseUrl || !key) throw new Error('Supabase non configuré');
  return createClient(supabaseUrl, key, opts);
}

module.exports = { supabase, authClient, supabaseConfigured };
