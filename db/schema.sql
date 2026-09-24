-- Schema Aube boutique — a executer une fois dans Supabase (SQL Editor > New query > Run)
-- Stockage "document" simple : toute la boutique (produits, commandes, clientes, reglages)
-- vit dans une seule ligne JSONB. C'est volontairement proche du fichier data.json d'origine
-- (portage rapide, zero risque de perte de donnees), mais avec un vrai SGBD derriere :
-- - les donnees survivent aux redemarrages/redeploiements (contrairement a un fichier local
--   sur un hebergeur comme Render/Railway, dont le disque est efface a chaque deploiement)
-- - les operations sensibles (passer une commande, decrementer le stock, crediter des points)
--   sont executees dans une vraie transaction Postgres avec verrou de ligne (SELECT ... FOR UPDATE),
--   ce qui evite les ventes en double si deux clientes commandent la derniere piece en meme temps.

create table if not exists store (
  id smallint primary key default 1,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint store_singleton check (id = 1)
);

-- Ligne initiale (uniquement si la table est vide) : reprend les valeurs par defaut
-- historiques du site (frais de port 4,90 EUR, offerts des 50 EUR, mode test actif).
insert into store (id, data)
values (1, jsonb_build_object(
  'products', '[]'::jsonb,
  'orders', '[]'::jsonb,
  'customers', '[]'::jsonb,
  'categories', '[]'::jsonb,
  'settings', jsonb_build_object(
    'shippingFlatCents', 490,
    'freeShippingThresholdCents', 5000,
    'paymentsEnabled', false,
    'loyalty', jsonb_build_object(
      'pointsPerEuro', 1,
      'pointValueCents', 1,
      'minRedeemPoints', 100
    )
  ),
  'nextProductId', 1,
  'nextOrderId', 1,
  'nextCustomerId', 1
))
on conflict (id) do nothing;
