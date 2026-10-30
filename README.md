# Ecole

Application de gestion scolaire multi-établissement pour le Cameroun : élèves et inscriptions, appel, notes et bulletins, scolarité et Mobile Money, portail des parents. Interface pensée pour le téléphone d'abord.

- **API** : NestJS 11, Prisma 6, PostgreSQL 16, Redis + BullMQ (`apps/api`)
- **Web** : Next.js 15, React 19, Tailwind CSS 4, TanStack Query (`apps/web`)
- **Partagé** : calculs de notes et de finances, schémas Zod, permissions (`packages/shared`)
- Maquettes : [docs/ui-ux.md](docs/ui-ux.md) · Exploitation : [docs/exploitation.md](docs/exploitation.md) · Tests de charge : [docs/charge.md](docs/charge.md)

## Démarrage en local

Prérequis : Node 22, pnpm 10, PostgreSQL 16 et Redis 7.

```bash
pnpm install
```

```bash
cp apps/api/.env.example apps/api/.env
```

```bash
cp apps/web/.env.example apps/web/.env.local
```

```bash
pnpm --filter @ecole/shared build
```

```bash
pnpm --filter @ecole/api exec prisma migrate deploy
```

```bash
pnpm --filter @ecole/api build && pnpm --filter @ecole/api db:seed
```

Puis, dans trois terminaux :

```bash
pnpm --filter @ecole/api start
```

```bash
pnpm --filter @ecole/api start:worker
```

```bash
pnpm --filter @ecole/web dev
```

Le site est sur http://localhost:3000 et la documentation de l'API sur http://localhost:4000/docs.

### Comptes de démonstration (Collège Démo)

Mot de passe commun : `Ecole2026!demo`

| Rôle                                                                                       | Identifiant                                                |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Direction                                                                                  | direction@demo.cm                                          |
| Censeur                                                                                    | censeur@demo.cm                                            |
| Surveillant général                                                                        | surveillant@demo.cm                                        |
| Secrétariat                                                                                | secretariat@demo.cm                                        |
| Comptabilité                                                                               | compta@demo.cm                                             |
| Infirmerie                                                                                 | infirmerie@demo.cm                                         |
| Enseignant (mathématiques, professeur principal de 4e A)                                   | prof.maths@demo.cm                                         |
| Chauffeur ou accompagnateur du car (appel de la ligne 1 – Bastos)                          | chauffeur@demo.cm                                          |
| Super-administrateur de la plateforme (double authentification à activer au premier accès) | admin@ecole.cm                                             |
| Parent (Marie-Claire et Paul-Henri Ngono)                                                  | 6 77 12 34 56, code SMS affiché dans les journaux de l'API |

## Tests

| Commande                                           | Contenu                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @ecole/shared test`                 | Calculs de notes (moyennes, rangs ex aequo, bulletins), finances, identité, permissions                                                                                                                                                                                                                                                                                                     |
| `pnpm --filter @ecole/api test`                    | Intégration sur une vraie base PostgreSQL (`TEST_DATABASE_URL`) : authentification, isolation des établissements, inscriptions, présences, notes, bulletins, paiements, webhooks, MTN MoMo et Orange Money, limites de paiement, codes SMS, facturation des abonnements, annonces, messagerie, calendrier, e-mail, photo de l'élève et consentement, déplacement des cours, listes paginées |
| `pnpm --filter @ecole/web test`                    | Navigation par rôle, formats                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm --filter @ecole/web test:e2e`                | Parcours Playwright sur téléphone (Pixel 7) et ordinateur (dont glisser-déposer et lecture hors connexion), contrôle d'accessibilité axe-core (WCAG 2.1 AA), contre une base dédiée `ecole_e2e`                                                                                                                                                                                             |
| `pnpm lint`, `pnpm typecheck`, `pnpm format:check` | Qualité                                                                                                                                                                                                                                                                                                                                                                                     |

Les tests d'intégration et de bout en bout appliquent les migrations puis vident leur base de test : ne jamais les pointer vers une base de production.

## Principes techniques

- **Multi-établissement** : chaque table métier porte un `schoolId`. Une extension Prisma ajoute le filtre automatiquement et refuse toute écriture inter-établissement ; une requête sans contexte d'établissement échoue.
- **Montants** en FCFA entiers, **notes** en centièmes de point (1342 = 13,42) : aucun calcul en virgule flottante.
- **Écritures comptables en ajout seul**, paiements non modifiables et bulletins publiés figés : des déclencheurs PostgreSQL l'imposent en plus du code.
- **Notifications fiables** : SMS écrits dans une table d'envoi (outbox) dans la même transaction que l'action, envoyés par le worker avec nouvelles tentatives.
- **Sécurité** : jeton d'accès de 15 minutes en mémoire, jeton de rafraîchissement en cookie httpOnly avec rotation et détection de réutilisation, double authentification TOTP pour les rôles administratifs, connexion des parents par code SMS, fiches santé chiffrées (AES-256-GCM) et consultées sur motif journalisé, journal d'audit.

## Structure

```
apps/api        API NestJS, worker, migrations Prisma, jeu de démonstration
apps/web        Site Next.js (personnel, portail parents), tests Playwright
packages/shared Calculs et schémas partagés
deploy          docker-compose de production, Nginx, sauvegardes
docs            Maquettes UI/UX et guide d'exploitation
```
