# Préproduction sur Vercel

La préproduction sert à essayer et à montrer l'application avec les données de démonstration
(« Collège Démo »). Elle tourne entièrement sur Vercel : le site, l'API et une base PostgreSQL
Neon ajoutée depuis la Marketplace de Vercel. La production réelle (passerelle SMS, stockage S3,
offre Vercel Pro pour un usage commercial) reste décrite dans `docs/exploitation.md`.

## Deux projets Vercel, un dépôt

| Projet              | Dossier racine | Rôle                                                           |
| ------------------- | -------------- | -------------------------------------------------------------- |
| `ecole-preprod-api` | `apps/api`     | API Nest dans une fonction (`api/index.js`), tâches planifiées |
| `ecole-preprod`     | `apps/web`     | Site Next.js ; `/api/*` est relayé vers l'API (`API_URL`)      |

La configuration de chaque projet est dans son `vercel.json` (installation pnpm à la racine du dépôt,
compilation de `@ecole/shared`, région `fra1`). Les deux projets déploient la même branche en
production.

## Base de données (Neon)

1. Dans Vercel, **Storage → Create Database → Neon**, région **Frankfurt (eu-central-1)**, puis
   connecter la base au projet `ecole-preprod-api` (environnement Production). Préfixe des variables :
   `NEON` ou aucun, les deux sont reconnus.
2. À chaque construction, `scripts/vercel-prepare.cjs` prépare la base avec le rôle propriétaire
   fourni par Neon : rôles `ecole_app` (connexion de l'API, soumise à la Row-Level Security) et
   `ecole_system` (mode système), migrations, droits, puis jeu de démonstration s'il n'existe pas.
3. À l'exécution, `src/config/platform-env.ts` déduit l'adresse du rôle `ecole_app` (pool de
   connexions de Neon) et celle du propriétaire (migrations) à partir des variables de Neon et de
   `APP_DB_PASSWORD`.

## Variables d'environnement

API (`ecole-preprod-api`, environnements Production et Preview).

Deux secrets sont saisis par l'exploitant dans Vercel (type « Sensitive »), jamais dans le dépôt :

| Variable      | Rôle                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| `APP_SECRET`  | secret maître, 32 caractères au moins ; ne plus jamais le changer ensuite   |
| `CRON_SECRET` | secret des tâches planifiées (Vercel l'envoie dans l'en-tête Authorization) |

Les autres secrets en sont dérivés au démarrage (HKDF-SHA256, `src/config/platform-env.ts`) :
`JWT_SECRET`, `OTP_SECRET`, `DATA_ENCRYPTION_KEY`, `APP_DB_PASSWORD` (mot de passe du rôle
`ecole_app`) et `MOBILE_MONEY_WEBHOOK_SECRET`. Changer `APP_SECRET` les change tous : les données
déjà chiffrées deviendraient illisibles et toutes les sessions seraient fermées.

Variables ordinaires :

| Variable                                | Valeur en préproduction                       |
| --------------------------------------- | --------------------------------------------- |
| `DEPLOY_STAGE`                          | `preprod`                                     |
| `SMS_PROVIDER`, `EMAIL_PROVIDER`        | `console` (messages écrits dans les journaux) |
| `MOBILE_MONEY_PROVIDER`                 | `simulator`                                   |
| `QUEUES_ENABLED`                        | `false` (pas de Redis : tâches planifiées)    |
| `WEB_ORIGIN`, `PUBLIC_VERIFY_URL`       | adresse du site, et `…/verifier`              |
| `STORAGE_PROVIDER`, `STORAGE_LOCAL_DIR` | `local`, `/tmp/ecole-storage` (temporaire)    |

Site (`ecole-preprod`) : `API_URL` (adresse de l'API), `NEXT_PUBLIC_DEPLOY_STAGE=preprod` (bandeau
« Préproduction »), `NEXT_PUBLIC_MOBILE_MONEY_SIMULATOR=true`.

## Ce qui diffère de la production

- **SMS** : écrits dans les journaux de la fonction au lieu d'être envoyés. Pour se connecter comme
  parent, le code se lit dans **Vercel → ecole-preprod-api → Logs** (« votre code de connexion est … »).
- **Tâches de fond** : pas de worker permanent ni de Redis. Les tâches planifiées de Vercel appellent
  `/jobs/<tâche>` (secret `CRON_SECRET`). Sur l'offre Hobby, chacune tourne une fois par jour :
  relances, rappels, envoi des messages en attente, écritures comptables, alertes.
- **Fichiers déposés** (photos, pièces) : gardés dans `/tmp` de la fonction, donc temporaires.
- **Comptes de démonstration** : ceux du `README.md` (mot de passe `Ecole2026!demo`).

## Vérifier un déploiement

`node deploy/preprod-smoke.mjs <adresse de l’API> <CRON_SECRET>` (test de fumée : santé, en-têtes de
sécurité, routes fermées, connexion, recherche, PDF, limitation des tentatives). Les mêmes contrôles
ont été joués en local contre la fonction serverless en mode production avant le premier déploiement.
