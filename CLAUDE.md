# Ecole : règles communes

Application de gestion scolaire multi-établissement pour le Cameroun, conçue pour le téléphone d'abord. Lire aussi `README.md` (démarrage, tests) et `docs/exploitation.md` (production, intégrations).

## Langue

Interface, messages d'erreur, documentation, messages de commit et réponses : en français.

## Préparer l'environnement (session cloud neuve)

PostgreSQL 16 et Redis sont installés mais arrêtés au démarrage du conteneur.

```bash
pg_ctlcluster 16 main start
su postgres -c "psql -c \"CREATE ROLE ecole WITH LOGIN SUPERUSER PASSWORD 'ecole';\""
su postgres -c "psql -c \"CREATE ROLE ecole_app WITH LOGIN PASSWORD 'ecole_app';\""
su postgres -c "psql -c \"CREATE ROLE ecole_system WITH NOLOGIN BYPASSRLS; GRANT ecole_system TO ecole_app WITH INHERIT FALSE, SET TRUE;\""
for db in ecole ecole_test ecole_e2e; do su postgres -c "createdb -O ecole $db"; done
redis-server --daemonize yes --port 6379
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
pnpm install
pnpm --filter @ecole/shared build
pnpm --filter @ecole/api exec prisma migrate deploy
pnpm --filter @ecole/api build && pnpm --filter @ecole/api db:seed
```

Chromium et Playwright sont préinstallés : ne pas lancer `playwright install`.

## Structure

- `packages/shared` : calculs de notes et de finances, schémas Zod, permissions (`src/permissions.ts` : `PERMISSIONS`, `ROLE_PERMISSIONS`, `MODULES`). Le recompiler (`pnpm --filter @ecole/shared build`) après chaque modification, avant l'API et le site.
- `apps/api` : NestJS 11, Prisma 6. Un module par domaine dans `src/modules`. Tâches de fond dans `src/worker.ts` et `src/jobs.ts`. Jeu de démonstration dans `src/seed.ts`.
- `apps/web` : Next.js 15, Tailwind 4, TanStack Query. Composants dans `src/components/ui`, navigation par rôle dans `src/lib/nav.ts`, appels API dans `src/lib/api.ts` et `src/lib/queries.ts`.
- `deploy` : docker-compose de production, Nginx, sauvegardes.

## Règles métier non négociables

- **Multi-établissement** : toute table métier porte `schoolId` et son modèle est ajouté à `TENANT_MODELS` dans `apps/api/src/common/prisma.ts`. Un test doit prouver qu'une école ne voit ni ne modifie les données d'une autre.
- **Row-Level Security** : la migration qui crée une table cloisonnée active aussi la RLS (`ENABLE` et `FORCE ROW LEVEL SECURITY`, politique `ecole_isolation` sur `"schoolId" = app_rls_school()`, voir `20261031130000_row_level_security` et `20261031130100_rls_role_systeme`) ; `test/rls.test.ts` échoue sinon. L'API se connecte avec le rôle `ecole_app` (`DATABASE_URL`), les migrations avec le propriétaire (`MIGRATION_DATABASE_URL`). Accès toutes écoles uniquement par `runAsSystem` sans `schoolId` (mode système journalisé : rôle `ecole_system`, BYPASSRLS, pris par `SET LOCAL ROLE`).
- **Montants** en FCFA entiers, **notes** en centièmes (1342 = 13,42) : jamais de virgule flottante.
- **Écritures comptables en ajout seul** : un paiement ne se modifie jamais, une correction crée une nouvelle écriture. Un bulletin publié est figé ; une correction crée une nouvelle version.
- **Permissions** : chaque route déclare sa permission ; un enseignant reste limité à ses classes. Les nouvelles permissions vont dans `packages/shared/src/permissions.ts`.
- **Audit** : toute action sensible (argent, notes, documents officiels, données personnelles) écrit une entrée dans le journal d'audit.
- **Notifications** : passer par la table d'envoi (outbox) dans la même transaction que l'action, jamais d'envoi direct.
- **Données personnelles** : accès minimal, données sensibles chiffrées (`src/common/crypto.ts`).

## Migrations Prisma

- Ne jamais modifier une migration existante. Ne jamais lancer `prisma migrate reset`.
- Pour en créer une : `pnpm --filter @ecole/api exec prisma migrate dev --create-only --name <nom>`, puis renommer le dossier avec le préfixe d'horodatage attribué à la tâche (par exemple `20261031010000_<nom>`) pour que l'ordre reste stable après fusion des branches. Ensuite `prisma migrate deploy`.
- Pour vider une base de test : `migrate deploy` puis `TRUNCATE`, jamais de reset.

## Interface

- Téléphone d'abord : cartes empilées sur téléphone, tableaux sur ordinateur, aucun défilement horizontal de la page (aide `expectNoHorizontalOverflow` dans `apps/web/e2e/helpers.ts`).
- Réutiliser les composants et le style existants ; libellés clairs en français ; zones tactiles d'au moins 44 px.
- Accessibilité WCAG 2.1 AA : ajouter chaque nouvel écran au contrôle `apps/web/e2e/a11y.spec.ts`.

## Tests et qualité (tout doit passer avant de pousser)

```bash
pnpm --filter @ecole/shared test
pnpm --filter @ecole/api test
pnpm --filter @ecole/web test
pnpm lint && pnpm typecheck && pnpm format:check
```

- Bout en bout : `pnpm --filter @ecole/shared build && pnpm --filter @ecole/api build`, puis `cd apps/web && npx playwright test`. L'API de test tourne sur le port 4100 et le site sur 3100, contre la base `ecole_e2e`.
- Arrêter tout `next dev` avant les tests de bout en bout (ils partagent `apps/web/.next`). Arrêter un processus par son PID, jamais avec `pkill`.
- Chaque fonctionnalité a des tests d'intégration API (vraie base `ecole_test`) et au moins un parcours Playwright sur téléphone et sur ordinateur. Les calculs vont dans `packages/shared` avec des tests unitaires stricts.
- L'outil Write décode les séquences `\u` : écrire ce genre de contenu avec Python.

## Git

- Ne jamais inclure d'identifiant de modèle d'IA dans le dépôt (code, commentaires, commits).
- Ne pas ouvrir de pull request et ne pas pousser sur une autre branche que celle attribuée à la session.
