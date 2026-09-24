# Aube — boutique en ligne

Site e-commerce complet pour une boutique de vêtements femme.

## Nouveautés de cette version

**Fiches produit**
- Jusqu'à 6 photos par produit (dos, détail tissu, porté...), avec galerie et miniatures
- Zoom : clic sur la photo → plein écran, puis clic pour zoomer et suivre la souris sur le détail
- Guide des tailles accessible depuis chaque fiche produit
- Catalogue de tailles : S, M, L, XL, 2XL, 3XL, 4XL, S/M, M/L, L/XL, TU

**Tunnel d'achat**
- Frais de livraison configurables (montant fixe + seuil de livraison offerte), réglables dans l'admin
- **Mode test sans paiement** : tant qu'aucune clé PayPal n'est configurée, les clientes peuvent passer une vraie commande de test (nom, email, adresse) sans qu'aucun paiement ne soit demandé. Idéal pour valider tout le tunnel avant de brancher un vrai moyen de paiement.
- Email de confirmation automatique (optionnel, via Resend)
- Page de confirmation dédiée avec numéro de commande et récapitulatif (`/commande/xxxxx`)

**Boutique / navigation**
- Barre de recherche
- Tri (nouveautés, prix croissant/décroissant, nom)
- Liste de favoris (wishlist), sauvegardée dans le navigateur
- Fiche produit avec URL dédiée et partageable (`/produit/12-robe-lin-ecru`)

**Admin**
- Tableau de bord : ventes totales, commandes du jour, ruptures de stock...
- Duplication d'un produit en un clic (pratique pour une variante de couleur)
- Export CSV des commandes
- Réglages des frais de livraison

**Performance**
- Les photos envoyées depuis l'admin sont automatiquement redimensionnées et compressées (via `sharp`), même si tu uploades une photo de 5-8 Mo prise au téléphone.

## 1. Installer en local

Prérequis : [Node.js](https://nodejs.org) version 18 ou plus.

```bash
npm install
cp .env.example .env
```

Ouvre `.env` et renseigne au minimum :
- `ADMIN_PASSWORD` : le mot de passe pour te connecter à `/admin`
- `SESSION_SECRET` : une chaîne aléatoire quelconque (peu importe laquelle, juste longue)

Puis lance le site :
```bash
npm start
```
Le site est accessible sur `http://localhost:3000`, l'admin sur `http://localhost:3000/admin`.

Tant que tu n'as pas renseigné `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`, le site est automatiquement en **mode test** : les clientes peuvent passer commande sans paiement réel, ce qui te permet de tester tout le parcours (panier, tailles, stock, email, page de confirmation, admin) avant de brancher PayPal.

## 2. Ajouter tes produits

Va sur `/admin`, connecte-toi avec `ADMIN_PASSWORD`, puis ajoute tes pièces (photos, nom, description, prix, tailles/stock, catégorie). Elles apparaissent immédiatement sur la boutique.

## 3. Déployer en ligne gratuitement (pour tester)

Le plus simple pour commencer, **gratuitement**, est **Render.com** :

**Option rapide : Blueprint (un clic)**
1. Mets ce dossier sur un dépôt GitHub (crée un repo, `git init`, `git add .`, `git commit`, push).
2. Sur [render.com/deploy](https://render.com/deploy), colle l'URL de ton repo. Render lit `render.yaml` et crée le service tout seul.
3. Render te demande de renseigner les variables marquées comme secrètes (`ADMIN_PASSWORD`, `DATABASE_URL`, etc.) — voir la section 3bis pour `DATABASE_URL`/Supabase.

**Option manuelle :**
1. Mets ce dossier sur un dépôt GitHub.
2. Sur [render.com](https://render.com), crée un compte, puis "New +" → "Web Service", connecte ton repo GitHub.
3. Render détecte Node.js automatiquement :
   - Build command : `npm install`
   - Start command : `npm start`
   - Plan : **Free**
4. Dans l'onglet "Environment", ajoute les mêmes variables que dans ton `.env` (`ADMIN_PASSWORD`, `SESSION_SECRET`, et éventuellement `RESEND_API_KEY` / `PUBLIC_URL`). Laisse `PAYPAL_CLIENT_ID` vide pour rester en mode test tant que tu ne veux pas encaisser de vrais paiements.
5. Une fois déployé, Render te donne une URL du type `https://aube-boutique.onrender.com` — envoie-la à qui tu veux pour tester.

**Important à savoir sur le plan gratuit de Render (et la plupart des hébergeurs gratuits) :**
- Le site "s'endort" après 15 minutes sans visite, et met quelques secondes à se réveiller à la prochaine visite — normal pour tester, pas idéal pour une vraie ouverture.
- Le disque du serveur **n'est pas garanti persistant** sur le plan gratuit : un redéploiement peut effacer ce qui n'est pas dans Supabase. C'est pour ça que l'étape suivante (3bis) est fortement recommandée avant toute vraie mise en ligne.

Railway.app, Fly.io ou Glitch fonctionnent sur un principe similaire si tu préfères essayer ailleurs.

## 3bis. Brancher Supabase (recommandé avant une vraie ouverture)

Le site sait déjà se connecter à Supabase — il suffit de renseigner deux jeux de variables d'environnement, rien à coder.

**Base de données (produits, commandes, comptes, points de fidélité) :**
1. Crée un compte sur [supabase.com](https://supabase.com) et un nouveau projet (choisis un mot de passe de base de données, garde-le de côté).
2. Une fois le projet prêt : `SQL Editor` → `New query`, colle le contenu du fichier `db/schema.sql` de ce projet, puis `Run`. Ça crée la table qui contiendra toute la boutique.
3. `Project Settings` → `Database` → `Connection string` → onglet **Transaction** (port 6543, le mieux adapté à Render/Railway) → copie l'URL et renseigne-la dans `DATABASE_URL`.

**Photos produits :**
1. `Storage` → `New bucket` → nom `product-images` → active **Public bucket**.
2. `Project Settings` → `API` → copie `Project URL` dans `SUPABASE_URL`, et la clé secrète **service_role** (pas `anon`) dans `SUPABASE_SERVICE_ROLE_KEY`.

Redémarre le site (ou redéploie) : le terminal affiche `Stockage : Supabase/Postgres` et `Stockage photos : Supabase Storage` au démarrage pour confirmer que tout est bien branché. Sans ces variables, le site continue de fonctionner comme avant (fichier local + dossier `/uploads`), pratique pour du développement rapide.

**Ce que ça change concrètement :**
- Les données survivent aux redéploiements.
- Toute opération qui touche au stock ou aux points de fidélité (passer commande, capturer un paiement PayPal) se fait dans une vraie transaction Postgres avec verrou de ligne : si deux clientes commandent la dernière pièce d'une taille en même temps, une seule l'obtient — jamais de survente ni de points de fidélité mal comptés.

## 4. Activer un vrai paiement plus tard

Quand tu seras prête à encaisser de vrais paiements :

1. Crée un compte sur [developer.paypal.com](https://developer.paypal.com) avec ton compte PayPal Business.
2. Dans "Apps & Credentials", crée une app. Commence en mode **Sandbox** (`PAYPAL_ENV=sandbox`) pour tester avec de faux comptes, sans vrai argent.
3. Renseigne `PAYPAL_CLIENT_ID` et `PAYPAL_CLIENT_SECRET` dans les variables d'environnement — le site bascule alors automatiquement du mode test vers le vrai paiement PayPal (carte bancaire ou compte PayPal).
4. Quand tu es prête à encaisser en vrai, passe `PAYPAL_ENV=live` et remplace les identifiants par ceux de la section "Live".

## 5. Email de confirmation automatique (optionnel)

1. Crée un compte gratuit sur [resend.com](https://resend.com).
2. Récupère une clé API et renseigne `RESEND_API_KEY` dans tes variables d'environnement.
3. Renseigne aussi `PUBLIC_URL` (l'adresse de ton site en ligne) pour que le lien dans l'email fonctionne.

Sans ces variables, le site fonctionne normalement, juste sans email envoyé.

## 6. Sécurité — à ne jamais faire

- Ne mets jamais ton fichier `.env` sur GitHub (il est déjà exclu via `.gitignore`).
- Change `ADMIN_PASSWORD` régulièrement et choisis un mot de passe fort.
- Garde `PAYPAL_ENV=sandbox` jusqu'à ce que tu aies testé un achat complet de bout en bout.

## Structure du projet

```
server.js               → serveur Express (API produits, admin, comptes clients, fidélité, commandes, PayPal, mode test)
db/store.js              → couche de données (Postgres/Supabase si DATABASE_URL est définie, sinon fichier JSON local), avec store.withTransaction() pour les opérations sensibles (stock, points)
db/pool.js               → connexion Postgres (Supabase)
db/storage.js            → upload des photos produits (Supabase Storage si configuré, sinon /uploads)
db/schema.sql             → à exécuter une fois dans Supabase (SQL Editor) pour créer la table
public/index.html        → boutique
public/admin.html        → espace admin
public/confirmation.html → page de confirmation de commande
public/css/              → styles
public/js/app.js         → logique boutique (panier, favoris, recherche, tri, PayPal / mode test)
public/js/admin.js       → logique admin
public/js/confirmation.js→ logique page de confirmation
uploads/                 → photos produits envoyées depuis l'admin (redimensionnées automatiquement)
```
