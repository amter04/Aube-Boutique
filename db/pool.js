// Connexion a la base Postgres de Supabase.
// DATABASE_URL vient de Supabase -> Project Settings -> Database -> Connection string
// (choisis "Connection pooling" / mode "Transaction", port 6543, c'est celle qui marche
// le mieux sur un hebergeur comme Render/Railway). Colle-la telle quelle dans .env.
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    "DATABASE_URL n'est pas definie : la boutique ne pourra pas se connecter a Supabase. " +
    'Copie l\'URL de connexion Postgres depuis Supabase (Project Settings > Database) dans ton fichier .env.'
  );
}

const pool = connectionString
  ? new Pool({
      connectionString,
      // Supabase exige une connexion chiffree ; en environnement de dev le certificat
      // n'est pas toujours reconnu localement, donc on ne bloque pas dessus.
      ssl: { rejectUnauthorized: false }
    })
  : null;

pool && pool.on('error', (err) => {
  // Erreur sur une connexion inactive du pool (ex: coupure reseau) : on log sans planter le serveur.
  console.error('Erreur inattendue du pool Postgres :', err.message);
});

module.exports = { pool };
