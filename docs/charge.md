# Tests de charge

Objectif : vérifier que la pile Docker de production tient les pics de l'année scolaire sur le serveur cible (2 vCPU, 4 Go de RAM), et corriger les goulets d'étranglement évidents.

## Campagne finale : surcoût de la Row-Level Security (30 octobre 2026)

L'isolation des écoles est désormais aussi assurée par PostgreSQL (Row-Level Security, voir `docs/exploitation.md`). Cette campagne mesure son coût sur les mêmes scénarios, plus un nouveau parcours complet du portail des parents.

### Résumé

- **Aucune erreur serveur** sur les 82 364 requêtes des deux campagnes complètes : seuls 17 refus 429 voulus à la caisse (limite de 30 encaissements par minute et par caissier, ajoutée après la campagne initiale), autant avant qu'après.
- **Parents (bulletins, portail complet) : pas de surcoût mesurable** une fois les corrections faites. Bulletins p95 38 ms avant comme après ; portail complet 56 ms avant, 55 ms après.
- **Personnel : surcoût réel mais acceptable.** Saisie des notes (120 enseignants, scénario saturé en CPU) p95 152 → 255 ms, rentrée 70 → 83 ms, toujours très en deçà des seuils (800 à 1 000 ms). Cause : chaque requête hors transaction devient une transaction courte (`BEGIN`, réglage de la portée, requête, `COMMIT`), du travail en plus pour l'API, qui est le goulet de ce scénario.
- **Une régression grave trouvée et corrigée** : la première version de la RLS doublait le temps de réponse du portail (p95 95 ms) et triplait le CPU de PostgreSQL (60 %). Voir « Corrections ».
- Mémoire : API 426 Mo au plus fort (402 Mo avant) ; API, PostgreSQL, worker et Redis ensemble : 1 Go au plus fort, sur 4 Go.

### Banc et méthode

- Même banc que la campagne initiale (pile `deploy/` avec la surcouche `loadtest/`, application épinglée sur 2 cœurs, k6 0.57 sur les autres), mêmes données : 5 écoles de 1 500 élèves, générées par `seed-volume.ts` avec le rôle applicatif `ecole_app` (11 min).
- **Avant** : image de la version de départ (sans RLS), connectée en propriétaire superutilisateur. **Après** : image RLS, connectée en `ecole_app`. Même base, mêmes scénarios, enchaînés dans la foulée.
- Chaque passage de « notes » ajoute environ 3 000 évaluations et leurs notes : la version de départ, repassée en fin de campagne sur les données grossies, donne 152 ms au p95 au lieu de 124. Les comparaisons de la saisie des notes se font donc avec ce second passage.
- Réglages propres au banc (dans `deploy/.env`, jamais en production) : `OTP_DAILY_SMS_BUDGET=1000000` (plafond anonyme de SMS, dépassé sinon par les milliers de connexions de parents) et `PAYMENT_RATE_CALLBACK=100000/60` (tous les webhooks de k6 viennent de la même adresse IP).

### Nouveau scénario : portail des parents complet (`portail.js`)

Parents en arrivée progressive jusqu'à 3 par seconde, palier de 3 min (689 parcours, 10 335 requêtes) : demande de code, lecture du SMS, connexion, accueil (enfants, messages non lus), espace de l'enfant (notes, absences, bulletins, compte), devoirs, fils de discussion, contacts de la classe, **nouveau message à un enseignant**, lecture du fil, **paiement Mobile Money simulé** : demande depuis le portail, confirmation par le webhook signé de l'opérateur, suivi du statut (le paiement doit être confirmé).

### Résultats

Latences en millisecondes au 95e centile. « RLS v1 » : première version (mode système par réglage de session), « après » : version finale, avec les corrections. CPU en pourcentage d'un cœur (200 % = les 2 vCPU).

| Scénario et mesure                             |  Avant | RLS v1 |  Après |
| ---------------------------------------------- | -----: | -----: | -----: |
| **Bulletins** (5 parents/s), toutes            |     38 |     63 |     38 |
| connexion par code                             |     43 |     55 |     38 |
| espace de l'enfant                             |     44 |     60 |     45 |
| bulletin PDF                                   |     45 |     61 |     45 |
| CPU API / PostgreSQL, moyenne                  |  40/12 |  44/29 |  41/13 |
| **Portail complet** (3 parents/s), toutes      |     56 |     95 |     55 |
| espace de l'enfant                             |     49 |     82 |     56 |
| devoirs                                        |     32 |     53 |     37 |
| nouveau message                                |     80 |    134 |     80 |
| demande de paiement                            |     37 |     68 |     44 |
| webhook de l'opérateur                         |     56 |     86 |     57 |
| CPU API / PostgreSQL, moyenne                  |  52/23 |  60/60 |  59/26 |
| **Saisie des notes** (120 enseignants), toutes |    152 |    287 |    255 |
| grille de notes                                |    128 |    216 |    198 |
| enregistrement des notes                       |    150 |    249 |    237 |
| CPU API / PostgreSQL, moyenne                  | 107/29 | 114/38 | 115/37 |
| **Rentrée**, toutes                            |     70 |     93 |     83 |
| inscription                                    |    106 |    139 |    111 |
| encaissement                                   |     64 |     86 |     73 |
| reçu PDF                                       |     38 |     52 |     48 |
| CPU API / PostgreSQL, moyenne                  |  42/15 |  54/24 |  52/21 |

Taux d'erreur : 0 % partout, sauf la rentrée (0,16 % avant, 0 % en v1, 0,15 % après), uniquement des 429 de la limite par caissier. Saisie des notes « avant » sur les données du début de campagne : 124 ms (grille 85, enregistrement 106).

Mémoire maximale observée par conteneur (après) : API 426 Mo (402 avant, pendant la saisie des notes), PostgreSQL 447 Mo (cache des pages, croît avec les données au fil des passages, 231 Mo au premier), worker 128 Mo, Redis 6 Mo. Le site et Nginx ne sont pas sollicités (63 et 12 Mo lors de la campagne initiale).

### Corrections

| Problème                                                                                                                                                                                                                                            | Effet mesuré                                                                                                                                | Correction                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RLS v1 : mode système par réglage de session, politique `app_rls_system() OR "schoolId" = …`. L'optimiseur estime ce OU à une fraction des lignes de chaque table, même en mode système où tout est visible : les jointures partent du mauvais côté | « Enfants du parent » : 1,2 ms → 35 à 47 ms (parcours des 8 461 élèves au lieu de partir du parent) ; portail p95 ×1,7, CPU PostgreSQL ×2,6 | Mode système par rôle : `SET LOCAL ROLE ecole_system` (BYPASSRLS, sans connexion) ; politique réduite à `"schoolId" = app_rls_school()`. Plans identiques à une base sans RLS en mode système (`20261031130100_rls_role_systeme`) |
| Messagerie : trois lectures de la file des notifications par message (regroupement des SMS), sans index                                                                                                                                             | Parcours séquentiel des 22 000 notifications : 3 × 4 ms par message de parent                                                               | Index `NotificationOutbox(template, recipient, createdAt)` et `(schoolId, template, status)`                                                                                                                                      |
| Portail : liens parent-enfant par `StudentGuardian.guardianId`, clé étrangère sans index                                                                                                                                                            | 1,2 à 1,5 ms par ouverture du portail                                                                                                       | Index `StudentGuardian(guardianId)` : hors des requêtes coûteuses                                                                                                                                                                 |
| Budget des codes anonymes sur 24 h : index `(sent, createdAt)` sans `trusted`                                                                                                                                                                       | 0,7 à 1,4 ms par demande de code                                                                                                            | Index `OtpCode(sent, trusted, createdAt)`                                                                                                                                                                                         |

Migration des index : `20261031130200_index_charge_rls`.

Essayé sans effet : un pool de 15 connexions au lieu du défaut de Prisma (9 sur ce banc de 4 cœurs physiques, 5 sur un VPS de 2 vCPU) donne 225 ms au lieu de 255 sur la saisie des notes, dans le bruit de mesure ; le goulet est le CPU de l'API, pas l'attente de connexions.

### Limites et pistes

- **Surcoût par requête du personnel** : quatre allers-retours au lieu d'un pour chaque requête hors transaction. Pistes si besoin : regrouper dans une même transaction les lectures lancées ensemble (`Promise.all`) d'une même requête HTTP ; seconde réplique de l'API (le goulet reste son CPU).
- La recherche d'élève (4 ms par requête, `ILIKE`) reste la requête la plus coûteuse de la rentrée, comme lors de la campagne initiale (voir plus bas).

## Campagne initiale (avant la Row-Level Security)

### Résumé

- Les trois pics passent **sans aucune erreur** (0 % d'échec sur les 78 714 requêtes des sept passages) avec des temps de réponse au 95e centile entre 30 et 130 ms.
- Publication des bulletins : jusqu'à **12 connexions de parents par seconde** en moyenne (pointe à 15), soit plus de 40 000 parents à l'heure, p95 de 56 ms. Le pic réaliste (5 écoles, 7 500 parents) est loin de la limite.
- Saisie des notes : 120 enseignants simultanés, p95 de 126 ms à l'enregistrement d'une classe après correction (554 ms avant).
- Rentrée : 2 inscriptions et 4 encaissements par seconde, p95 de 59 ms à l'encaissement et 105 ms à l'inscription.
- Mémoire de toute la pile, collecte des journaux comprise : moins de 1 Go au plus fort, sur 4 Go.
- Goulets corrigés : 5 index manquants (parcours séquentiels sur les tables des parents, des factures et des paiements) et un N+1 en écriture dans la saisie des notes (une requête par élève).
- Point de vigilance : 120 connexions **par mot de passe** dans la même seconde saturent les 2 vCPU (hachage argon2), voir plus bas.

### Méthode

#### Banc d'essai

- Pile de production (`deploy/docker-compose.yml`) avec les images construites depuis le dépôt, la collecte des journaux (`docker-compose.logs.yml`) et la surcouche `loadtest/docker-compose.loadtest.yml`, qui :
  - épingle PostgreSQL, Redis, l'API, le worker, le site et Nginx sur **les deux mêmes cœurs** (`cpuset: 0,1`), pour reproduire le serveur de 2 vCPU ; k6 tourne sur les autres cœurs de la machine de test ;
  - expose l'API (port 4000) et PostgreSQL (55432) en local, active `pg_stat_statements` ;
  - remplace la passerelle SMS par une fausse passerelle HTTP (`loadtest/sms-sink.mjs`) qui garde le dernier SMS de chaque numéro : k6 y lit le code de connexion des parents, comme un parent lit son SMS.
- k6 0.57 (image `grafana/k6`), scripts dans `loadtest/k6/`. Chaque utilisateur virtuel présente une adresse IP distincte (`X-Forwarded-For`), comme des téléphones distincts, pour que les limites de débit par IP de l'API s'appliquent normalement.
- Les requêtes visent l'API directement : Nginx, dont la limitation de débit par IP est volontaire (10 connexions par minute et par IP), et le rendu des pages Next.js ne sont pas mesurés.

#### Données

`apps/api/src/loadtest/seed-volume.ts` crée **5 établissements de 1 500 élèves** par les services métier (matricules, factures, pièces du dossier), soit :

- 7 500 élèves et 7 500 parents, 150 classes de 50 élèves, 8 matières par classe, 120 enseignants, 15 secrétaires et 15 comptables ;
- 5 000 paiements de rentrée (deux familles sur trois), 37 500 lignes de facture ;
- 2 400 compositions et 120 000 notes du 1er trimestre, soumises ;
- 7 500 bulletins du 1er trimestre préparés puis **publiés**.

Durée de génération : 10 minutes.

#### Scénarios

| Scénario                  | Script         | Charge                                                                                                                                                                                                   |
| ------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publication des bulletins | `bulletins.js` | Parents en arrivée progressive jusqu'à 5 par seconde, palier de 3 min : demande de code, lecture du SMS, connexion, liste des enfants, espace de l'enfant, bulletin PDF                                  |
| Publication (palier haut) | `bulletins.js` | Même parcours jusqu'à 15 parents par seconde, palier de 2 min                                                                                                                                            |
| Saisie des notes          | `notes.js`     | 120 enseignants simultanés pendant 4 min : grille, création d'une évaluation, saisie de la classe (50 notes), correction, relecture ; 2 à 5 s de réflexion entre les actions                             |
| Portail complet           | `portail.js`   | Parents jusqu'à 3 par seconde, palier de 3 min : connexion par code, accueil, notes, devoirs, nouveau message à un enseignant, paiement Mobile Money simulé et confirmé par le webhook (campagne finale) |
| Rentrée                   | `rentree.js`   | 4 min : 2 inscriptions par seconde (contrôle des doublons, inscription, recherche) et 4 encaissements en espèces par seconde (recherche, compte, paiement, reçu PDF)                                     |

### Résultats

Latences en millisecondes (p95 : 95 % des requêtes sont plus rapides). « Avant » : version de départ ; « après » : avec les index et la saisie groupée des notes. CPU en pourcentage d'un cœur (200 % = les 2 vCPU).

#### Publication des bulletins (5 parents par seconde, 1 129 parcours, 7 903 requêtes)

| Mesure                                          |   Avant |   Après |
| ----------------------------------------------- | ------: | ------: |
| p95, toutes requêtes                            |      67 |      33 |
| p95 connexion par code (`otp/verify`)           |      35 |      31 |
| p95 espace de l'enfant                          |      47 |      32 |
| p95 bulletin PDF                                |      50 |      44 |
| Taux d'erreur                                   |     0 % |     0 % |
| CPU API, moyenne / maximum                      | 36 / 70 | 34 / 52 |
| CPU PostgreSQL, moyenne / maximum               | 29 / 38 |  9 / 31 |
| Requête « enfants du parent » (moyenne en base) |      41 |     1,3 |

#### Publication, palier haut (jusqu'à 15 parents par seconde, 2 429 parcours, 17 003 requêtes, après correction)

p95 de 56 ms (toutes requêtes), 76 ms pour la connexion, 59 ms pour l'espace de l'enfant, 69 ms pour le PDF ; 0 % d'erreur ; 85 requêtes par seconde ; CPU de l'API 79 % en moyenne (113 % au plus), PostgreSQL 23 % (33 %).

#### Saisie des notes (120 enseignants, 4 min)

| Mesure                                |     Avant |    Après |
| ------------------------------------- | --------: | -------: |
| Parcours complets                     |     2 835 |    2 999 |
| p95, toutes requêtes                  |       480 |      131 |
| p95 grille de notes                   |       248 |      101 |
| p95 enregistrement des notes          |       554 |      126 |
| Taux d'erreur                         |       0 % |      0 % |
| Requêtes d'insertion de notes en base |   145 152 |    2 890 |
| CPU API, moyenne / maximum            | 126 / 187 | 95 / 185 |
| CPU PostgreSQL, moyenne / maximum     |   38 / 73 |  26 / 38 |

Le maximum de 18 s, avant comme après, vient de la première minute : les 120 enseignants se connectent par mot de passe dans la même seconde (voir « Limites »).

#### Rentrée (4 min, 1 442 parcours, 5 332 requêtes)

| Mesure                            |    Avant |    Après |
| --------------------------------- | -------: | -------: |
| p95, toutes requêtes              |       72 |       66 |
| p95 inscription                   |      105 |      105 |
| p95 encaissement                  |       74 |       59 |
| p95 reçu PDF                      |       44 |       40 |
| Maximum                           |    1 350 |      606 |
| Taux d'erreur                     |      0 % |      0 % |
| CPU API, moyenne / maximum        | 44 / 142 | 40 / 156 |
| CPU PostgreSQL, moyenne / maximum |  24 / 43 |  17 / 45 |

#### Ressources (maximum observé par conteneur, tous scénarios, après correction)

| Conteneur      | Mémoire max | Remarque                                            |
| -------------- | ----------: | --------------------------------------------------- |
| API            |      367 Mo | Pic pendant la saisie des notes                     |
| PostgreSQL     |      294 Mo | `shared_buffers` par défaut (128 Mo)                |
| Worker         |       76 Mo |                                                     |
| Site (Next.js) |       63 Mo | Non sollicité par les tests                         |
| Redis, Nginx   |       12 Mo |                                                     |
| Loki           |      110 Mo | Collecte des journaux (facultative)                 |
| Grafana        |       66 Mo | Facultatif                                          |
| Vector         |       18 Mo | 2 à 5 % de CPU pour environ 85 lignes par seconde   |
| **Total**      |  **≈ 1 Go** | Sur 4 Go : marge pour le cache disque de PostgreSQL |

Le goulet est le **CPU de l'API** (un processus Node.js) : PostgreSQL reste sous 50 % d'un cœur dans tous les scénarios après correction.

### Corrections apportées

Repérées avec `pg_stat_statements` pendant les tests :

| Problème                                                                                    | Effet mesuré                                                                                   | Correction                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Portail parent : enfants du parent par `Guardian.userId`, sans index                        | Parcours séquentiel des parents à chaque ouverture du portail : 41 ms en moyenne sous charge   | Index `Guardian(userId)` → 1,3 ms                                                                                                 |
| Compte de l'élève : lignes de facture par `invoiceId`, sans index                           | Parcours séquentiel des 37 500 lignes : 2 ms par compte, à chaque consultation et encaissement | Index `InvoiceLine(invoiceId)`                                                                                                    |
| Imputations par ligne ou par paiement, index `(schoolId, …)` inutilisable par les jointures | Parcours séquentiel : 4 ms par compte                                                          | Index `PaymentAllocation(invoiceLineId)` et `(paymentId)`                                                                         |
| Décompte des inscriptions de l'année par établissement                                      | Parcours de toutes les inscriptions de l'établissement                                         | Index `Enrollment(schoolId, academicYearId)`                                                                                      |
| Saisie des notes : un `INSERT … ON CONFLICT` par élève (N+1)                                | 51 requêtes par grille, 145 000 en 4 min                                                       | Création groupée (`createMany`) des nouvelles notes et effacement groupé ; mises à jour une par une (corrections, peu nombreuses) |

Migration : `apps/api/prisma/migrations/20261031060100_load_indexes`. Sur la base de 7 500 élèves, le déploiement complet par `deploy/deploy.sh` (sauvegarde, migration, redémarrage, contrôle de santé) a pris 16 s.

### Limites et pistes

- **Rafale de connexions par mot de passe** : 120 connexions dans la même seconde prennent jusqu'à 17 s (médiane 8 s) et ralentissent tout le reste pendant ce temps (grille de notes à 1,3 s au p95 dans la première minute). Le hachage argon2id utilise les réglages par défaut de la bibliothèque (64 Mo, 3 passes, 4 fils), file de 4 hachages à la fois. En pratique, la session se renouvelle sans mot de passe pendant 30 jours ; une rafale réelle reste rare. Si besoin : réglage OWASP minimal (19 Mo, 2 passes, 1 fil), environ 5 fois moins coûteux, à décider avec la sécurité (les hachages existants gardent leurs réglages).
- **Recherche d'élève** (`GET /students?search=`) : environ 4 ms par requête en base (trois requêtes : liste, total, décomptes), recherche `ILIKE '%…%'` sur les noms. Correct à 1 500 élèves par école ; au-delà de 5 000, un index trigramme (`pg_trgm`) serait utile. Non fait : Prisma ne sait pas le décrire sans fonctionnalité expérimentale, et un index absent du schéma serait supprimé par la migration suivante.
- **Un seul processus API** : au-delà d'environ 15 parents par seconde, ajouter une seconde réplique de l'API (le serveur a 2 vCPU et la mémoire le permet).
- Nginx et le site Next.js ne sont pas mesurés (voir « Banc d'essai »).
- Tests menés dans un conteneur de développement de 4 cœurs, l'application limitée à 2 d'entre eux : un VPS réel a des disques et des cœurs partagés, souvent plus lents. Garder une marge d'un facteur 2.

## Reproduire

```bash
# 1. Pile de production locale avec la surcouche de charge (depuis deploy/, .env rempli) :
#    COMPOSE_FILE=docker-compose.yml:docker-compose.logs.yml:../loadtest/docker-compose.loadtest.yml
docker compose up -d
docker compose exec -T postgres psql -U ecole -d ecole -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'

# 2. Données volumineuses (base vide, environ 11 min), depuis apps/api après pnpm build,
#    avec le rôle applicatif (Row-Level Security) :
LOADTEST_SEED=oui DATABASE_URL=postgresql://ecole_app:<mot de passe applicatif>@127.0.0.1:55432/ecole \
  MIGRATION_DATABASE_URL=postgresql://ecole:<mot de passe>@127.0.0.1:55432/ecole \
  JWT_SECRET=… OTP_SECRET=… DATA_ENCRYPTION_KEY=… MOBILE_MONEY_WEBHOOK_SECRET=… QUEUES_ENABLED=false \
  node dist/loadtest/seed-volume.js 5 1500 ../../loadtest/data/loadtest-fixtures.json

# 3. Scénarios (résultats dans loadtest/results/) :
loadtest/run.sh bulletins -e PARENT_OFFSET=0          # changer de décalage à chaque passage (3 codes par numéro et par quart d'heure)
loadtest/run.sh bulletins -e PARENT_OFFSET=4000 -e RATE=15 -e HOLD=2m
loadtest/run.sh notes
loadtest/run.sh rentree -e OFFSET=0                   # changer de décalage à chaque passage (nouveaux numéros de parents)
loadtest/run.sh portail -e PARENT_OFFSET=1500 -e WEBHOOK_SECRET=<MOBILE_MONEY_WEBHOOK_SECRET>   # MOBILE_MONEY_PROVIDER=simulator

# 4. Requêtes les plus coûteuses :
docker compose exec -T postgres psql -U ecole -d ecole -c \
  "select calls, round(mean_exec_time::numeric,2) ms, left(query,120) from pg_stat_statements order by total_exec_time desc limit 10"
```

Le générateur refuse de tourner sans `LOADTEST_SEED=oui` et sur une base qui contient déjà ses établissements : ne jamais le lancer sur la base de production.
