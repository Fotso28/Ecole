# Kit de vente Ecole

Guide interne de l'équipe commerciale : ce qu'il faut avoir avant d'aller voir une école, le parcours de vente, les prix, les réponses aux objections et ce qu'il ne faut pas promettre. La plaquette à remettre au chef d'établissement est [plaquette.pdf](plaquette.pdf) (source : [plaquette.html](plaquette.html)).

Chaque affirmation de la plaquette correspond à une fonction présente dans le code au 1er novembre 2026. Les points marqués **à valider** sont des propositions de l'équipe commerciale, pas des décisions.

## 1. À régler avant la première vente

Ces points bloquent une vente honnête. Les quatre premiers sont signalés dans `docs/exploitation.md` ou `docs/rh-paie.md`.

| Point                                       | Pourquoi c'est bloquant                                                                                                                                                                                                            | Responsable          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Passerelle SMS de production                | Sans agrégateur SMS raccordé, l'API refuse de démarrer en production : pas de connexion des parents, pas de relances, pas de SMS d'absence.                                                                                        | Technique            |
| Comptes marchands MTN MoMo et Orange Money  | Le paiement en ligne n'est réel qu'après le dossier marchand (KYC) et un paiement test par opérateur. D'ici là, la caisse enregistre les paiements Mobile Money reçus, mais le parent ne paie pas depuis l'application.            | Direction, technique |
| Avis juridique sur les données personnelles | La conformité à la loi camerounaise sur la protection des données personnelles (loi n° 2024/017 du 23 décembre 2024) est à faire valider par un juriste avant le pilote : contrat, consentements, droits des parents, hébergement. | Direction, juriste   |
| Barème de paie et plan de comptes           | Chaque taux de paie (CNPS, IRPP, CAC, redevance, taxe communale) et les comptes de la comptabilité sont marqués « à vérifier par un comptable ». Ne pas vendre les modules RH et paie ou Comptabilité avant cette vérification.    | Expert-comptable     |
| Règles des bulletins                        | Faire relire `docs/bulletins.md` par un censeur expérimenté (seuils, redoublants, absences notées 0). Les réglages existent, mais il faut des valeurs par défaut sûres.                                                            | Censeur partenaire   |
| Hébergement et sauvegardes                  | Serveur de production, HTTPS, sauvegarde nocturne planifiée, copie hors du serveur, test de restauration mensuel. La plaquette promet une sauvegarde chaque nuit conservée 30 jours.                                               | Technique            |
| Entreprise en règle                         | RCCM, numéro d'identifiant unique (NIU), attestation de conformité fiscale, compte bancaire professionnel. Les réseaux confessionnels et les grands établissements les demandent avant de signer.                                  | Direction            |
| Nom commercial                              | « Ecole » est un nom générique : impossible à protéger et difficile à retrouver sur internet. Choisir un nom distinctif, vérifier sa disponibilité, le déposer à l'OAPI (Yaoundé), réserver le nom de domaine.                     | Direction            |

### Le point Mobile Money à trancher

Aujourd'hui, les identifiants MTN MoMo et Orange Money sont communs à toute la plateforme (variables d'environnement globales). Tous les paiements des parents de toutes les écoles arriveraient donc sur **un seul compte marchand, le vôtre**, et vous devriez reverser l'argent à chaque école.

Conséquences : vous détenez des fonds pour le compte de tiers (réglementation des services de paiement de la CEMAC, à vérifier avec un juriste), vous devez faire des reversements et une comptabilité de tiers, et le fondateur doit vous faire confiance avec sa trésorerie.

Trois options :

1. **Un compte marchand par école** (recommandé) : l'argent va directement à l'école. Demande une évolution du code (identifiants par établissement).
2. **Un agrégateur de paiement agréé** qui reverse aux écoles : moins de développement, mais des frais en plus.
3. **Démarrer sans paiement en ligne** : les parents paient comme aujourd'hui (guichet ou numéro Mobile Money de l'école) et la caisse l'enregistre. Les relances, les reçus et le suivi des impayés fonctionnent déjà.

Tant que ce point n'est pas réglé, présenter le paiement en ligne comme « bientôt disponible » et vendre l'option 3.

## 2. Les documents à avoir

### A. Pour convaincre (avant la signature)

| Document                                   | Contenu                                                                                                                                                                  | État                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Plaquette (4 pages A4)                     | Promesse, bénéfices par domaine, rôles, modules, sécurité, démarrage, offre, contact.                                                                                    | **Prête** : compléter le contact et le QR |
| Fiche tarifaire (1 page, séparée)          | Offres, prix par élève et par module, minimum annuel, frais de mise en route, SMS, modalités de paiement, date de validité. Séparée pour ne pas réimprimer la plaquette. | À faire                                   |
| Démonstration en ligne                     | L'établissement « Collège Démo » sur la préproduction, avec un compte par rôle. Prévoir une remise à zéro des données avant chaque démonstration importante.             | Existe (préproduction Vercel)             |
| Scénario de démonstration (20 minutes)     | Trois moments forts, voir section 4. Une version courte de 5 minutes pour les rendez-vous debout.                                                                        | À faire                                   |
| Échantillons imprimés                      | Un bulletin, un reçu, un certificat de scolarité et une carte d'élève générés depuis le Collège Démo, avec le QR code que le chef d'établissement scanne lui-même.       | À générer depuis l'application            |
| Fiche « Sécurité et données personnelles » | Une page pour le fondateur et le juriste du réseau : cloisonnement, chiffrement, journal d'audit, sauvegardes, hébergement, restitution des données.                     | À faire                                   |
| Questionnaire de découverte                | Effectif, cycles, sous-système, nombre de tranches, taux d'impayés estimé, outils actuels, délai de sortie des bulletins, équipement des enseignants.                    | À faire                                   |
| Proposition commerciale type               | Rappel des besoins, modules retenus, prix calculé sur l'effectif, calendrier de mise en route, conditions. Envoyée sous 48 heures après la démonstration.                | À faire                                   |
| Fiche réponses aux objections              | Section 7 de ce document, à apprendre par cœur.                                                                                                                          | Ce document                               |
| Références                                 | Témoignage signé, lettre de recommandation et chiffres avant/après des écoles pilotes.                                                                                   | Après les pilotes                         |
| Dépliant et affiche pour les parents       | « Comment suivre votre enfant sur votre téléphone » : connexion par code SMS, ce qu'on y trouve. Aide l'école à lancer le portail, et rassure le chef d'établissement.   | À faire                                   |
| Carte de visite, profil WhatsApp Business  | Catalogue WhatsApp avec la plaquette en PDF et une vidéo de 60 secondes.                                                                                                 | À faire                                   |

### B. Pour contractualiser

| Document                                     | Points essentiels                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contrat d'abonnement et conditions générales | Objet, durée (année scolaire), modules, prix et révision, modalités de paiement, retard de paiement, résiliation, responsabilité, propriété intellectuelle (le logiciel reste à vous, les données à l'école).                                                                                  |
| Annexe protection des données                | L'école est responsable du traitement, vous êtes sous-traitant. Finalités, catégories de données (dont santé et photos), mesures de sécurité, sous-traitants (hébergeur, agrégateur SMS, opérateurs Mobile Money), notification des incidents, restitution puis suppression en fin de contrat. |
| Engagement de service                        | Horaires d'assistance, canaux (téléphone, WhatsApp), délais de réponse selon la gravité, disponibilité visée, fréquence et durée des sauvegardes, fenêtres de maintenance.                                                                                                                     |
| Convention de pilote                         | Durée (un trimestre), prix (gratuit ou réduit), engagements de l'école (référent, saisie des notes par les enseignants, données de départ), critères de réussite, accord pour un témoignage, conditions de passage au contrat annuel.                                                          |
| Bon de commande et facture pro forma         | Mentions légales, NIU, TVA selon votre régime fiscal (à confirmer avec votre comptable), échéances.                                                                                                                                                                                            |
| Procès-verbal de mise en service             | Signé à la fin de la formation : paramétrage contrôlé, élèves importés, comptes créés, personnes formées. Il déclenche la facturation.                                                                                                                                                         |
| Formulaire de consentement photo             | Modèle à faire signer par les parents : l'application n'accepte une photo d'élève qu'après l'enregistrement du consentement.                                                                                                                                                                   |

Faire rédiger ou relire ces documents par un avocat d'affaires camerounais. Pour les réseaux de plusieurs écoles, prévoir une clause de réversibilité solide (export des données dans un format lisible) : c'est souvent la condition pour signer.

### C. Pour réussir la mise en route

Ces documents servent après la vente, mais les montrer pendant la vente rassure : le chef d'établissement voit que le démarrage est organisé.

- **Fiche de collecte des paramètres** : classes, matières et coefficients, frais et tranches avec leurs dates, personnel et rôles, numéros des parents.
- **Modèle d'import Excel des élèves** : il existe déjà dans l'application (import CSV et Excel, avec essai à blanc).
- **Plan de déploiement type sur trois semaines** : semaine 1 collecte et paramétrage, semaine 2 import et contrôle, semaine 3 formation et lancement auprès des parents.
- **Guides express d'une page par rôle** : enseignant, caissier, censeur, secrétariat, parent. Compléter par de courtes vidéos à partager sur WhatsApp.
- **Procédure d'assistance** : un numéro WhatsApp unique, des horaires, une escalade vers l'équipe technique.

## 3. Qui cibler

1. **Collèges et lycées privés laïcs de 300 à 1 500 élèves**, à Douala et Yaoundé d'abord. Le fondateur décide vite, la scolarité est sa principale recette et les impayés lui coûtent cher.
2. **Réseaux confessionnels et groupes scolaires** ensuite. Le logiciel est multi-établissement : une seule signature peut couvrir plusieurs écoles, avec du personnel partagé et des parents qui suivent des enfants dans plusieurs écoles sur un seul compte. Cycle de vente plus long, mais panier bien plus gros.
3. **Établissements publics** plus tard : décision centralisée, budgets contraints, cycle très long.

L'offre actuelle vise le secondaire (notes sur 20, séquences et trimestres, classes d'examen). Ne pas démarcher le primaire et la maternelle avant d'avoir vérifié que leur mode d'évaluation est couvert.

**Qui décide, qui influence :**

| Personne               | Ce qui l'intéresse                                    | Ce qu'il faut lui montrer                                 |
| ---------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Fondateur ou promoteur | Recettes, contrôle de l'argent, image de l'école      | Impayés, relances, caisse à quatre yeux, journal d'audit  |
| Chef d'établissement   | Tranquillité, délais tenus, relation avec les parents | Tableau de bord, bulletins, portail des parents           |
| Économe ou intendant   | Moins de saisie, caisse juste                         | Encaissement, reçu, clôture de caisse                     |
| Censeur                | Bulletins sans erreur et à l'heure                    | Grille de notes, rangs ex æquo, préparation des bulletins |
| Enseignants            | Ne pas perdre de temps                                | Appel et notes sur téléphone                              |

Le fondateur signe, mais il écoute son économe et son censeur : les convaincre aussi.

## 4. Le parcours de vente

1. **Premier contact** (recommandation, visite, WhatsApp). Objectif : un rendez-vous de 30 minutes avec le décideur. Laisser la plaquette seulement si le rendez-vous est impossible.
2. **Découverte** (10 minutes, questionnaire). Faire parler des impayés et des bulletins : ce sont les deux douleurs.
3. **Démonstration** (20 minutes), sur le téléphone du décideur, en trois moments :
   - **Le parent** : il voit le reste à payer, les dernières notes et l'absence du jour, sans mot de passe.
   - **Le bulletin** : la grille de notes calcule moyenne, rang et appréciation ; on montre un bulletin imprimé et le chef d'établissement scanne son QR code avec son propre téléphone.
   - **La direction** : le tableau de bord avec le recouvrement, les impayés et les actions à valider ; puis la liste des impayés avec les relances automatiques.
4. **Proposition écrite sous 48 heures** : prix calculé sur l'effectif réel, avec le calcul de la page 4 de la plaquette refait avec les chiffres de l'école.
5. **Pilote ou signature.** Pour une école hésitante, un pilote d'un trimestre ; pour une école convaincue, le contrat annuel directement.
6. **Mise en route et formation** (trois semaines), puis procès-verbal de mise en service.
7. **Suivi** : appel à 30 jours, bilan à la fin du trimestre (bulletins publiés, taux de parents connectés, recouvrement), demande de témoignage et de recommandation.

## 5. Quand vendre

| Période                   | Ce qu'on fait                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Novembre et décembre 2026 | Prospecter pour un démarrage au **2e trimestre** : paramétrage et import pendant les congés de fin d'année, formation la première semaine de janvier. Arguments : relances de la tranche suivante, bulletins du 2e trimestre. Viser 2 à 3 écoles pilotes. |
| Janvier à mars 2027       | Faire réussir les pilotes, récolter les chiffres et les témoignages.                                                                                                                                                                                      |
| Avril à juin 2027         | **Grande saison de vente** pour la rentrée 2027-2028 : les budgets se décident, il y a le temps de préparer. Éviter les semaines de conseils de classe et d'examens officiels.                                                                            |
| Juillet et août 2027      | Mises en route : inscriptions et réinscriptions faites directement dans l'application (assistant de rentrée).                                                                                                                                             |
| Septembre 2027            | Assistance renforcée pendant la rentrée.                                                                                                                                                                                                                  |

## 6. Les prix (à valider)

L'application sait facturer de deux façons : **par élève inscrit et par an**, ou **par module activé et par an**. Les montants ci-dessous sont des propositions de départ ; les deux premiers reprennent les offres du jeu de démonstration (`apps/api/src/seed.ts`).

| Offre (proposition) | Contenu                                                                                                  | Prix proposé                                |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Essentiel           | Élèves, appel et discipline, notes et bulletins, scolarité et caisse, portail des parents, communication | 1 500 FCFA par élève et par an              |
| Complet             | Essentiel, plus emploi du temps, examens et documents administratifs                                     | 2 500 FCFA par élève et par an              |
| Modules spécialisés | Comptabilité, RH et paie, transport, bibliothèque et stock                                               | Prix annuel par module                      |
| À la carte          | Pour une petite école ou un besoin partiel                                                               | 60 000 à 150 000 FCFA par module et par an  |
| Minimum annuel      | Pour que les petites écoles restent rentables                                                            | Par exemple 300 000 FCFA                    |
| Mise en route       | Paramétrage, import, formation sur place                                                                 | Forfait, offert pour un engagement de 2 ans |

Avant de fixer les prix :

- **Faire une étude rapide de la concurrence** : prix de 4 ou 5 logiciels de gestion scolaire vendus au Cameroun et de ce que paient les écoles pour leurs reçus et bulletins imprimés.
- **Compter le coût des SMS**, c'est le principal coût variable. Exemple pour 600 élèves, par an : codes de connexion (environ 3 600), SMS d'absence (environ 1 000), relances à J+5, J+15 et J+30 (environ 2 000), publication des bulletins (1 800), annonces (6 000 pour 10 annonces). Total : environ 15 000 SMS. Avec un prix hypothétique de 20 FCFA le SMS, cela fait 300 000 FCFA, soit un tiers d'un abonnement à 1 500 FCFA par élève. Obtenir le vrai tarif de l'agrégateur, envoyer les annonces par e-mail ou sur le portail quand c'est possible (réglage « Canal des notifications aux familles »), et prévoir un quota de SMS inclus puis des recharges.
- **Caler le paiement de l'abonnement sur les tranches de scolarité** (par exemple en trois fois) : l'école paie quand elle encaisse. L'application ne coupe jamais l'accès automatiquement en cas de retard (comportement actuel du module de facturation), ce qui rassure le client mais impose un suivi des relances.
- **Décider qui paie les frais Mobile Money** : l'école ou le parent.

**Calcul de retour sur investissement** à refaire avec chaque école : 600 élèves à 100 000 FCFA de scolarité, c'est 60 millions de FCFA à encaisser. Un abonnement de 900 000 FCFA (600 × 1 500) représente 1,5 % de cette somme : il est remboursé dès que les relances font gagner 1,5 point de recouvrement, sans compter le temps gagné sur les bulletins.

## 7. Réponses aux objections

| Objection                                        | Réponse                                                                                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| « C'est cher. »                                  | Refaire le calcul avec ses chiffres : quelques points d'impayés récupérés paient l'abonnement. Proposer le paiement en plusieurs fois.                                                                           |
| « Mes enseignants ne savent pas utiliser ça. »   | Ils ont tous un téléphone. Une tâche par écran, un bouton principal. Formation sur place, par petits groupes. Montrer l'appel en 20 secondes.                                                                    |
| « Internet n'est pas fiable ici. »               | L'application est légère et conçue pour la 3G. Parents et enseignants consultent les dernières données même sans réseau. Être honnête : la saisie des notes, l'appel en classe et la caisse demandent du réseau. |
| « Beaucoup de parents n'ont pas de smartphone. » | Ils reçoivent les SMS : absences, relances, publication du bulletin. Le portail est un plus, pas une obligation.                                                                                                 |
| « Et si votre entreprise disparaît ? »           | Les données appartiennent à l'école et lui sont restituées ; sauvegardes quotidiennes ; clause de réversibilité au contrat. Pour un réseau, proposer un dépôt du code source chez un tiers.                      |
| « Nos données sont sensibles. »                  | Cloisonnement par école jusque dans la base de données, fiches santé chiffrées, double authentification, journal d'audit. Remettre la fiche « Sécurité et données personnelles ».                                |
| « Nous avons déjà Excel ou un autre logiciel. »  | Import des listes d'élèves depuis Excel. Montrer ce qu'Excel ne fait pas : relances automatiques, portail des parents, contrôle de la caisse, documents vérifiables par QR code.                                 |
| « Nos règles de passage sont particulières. »    | La direction règle les seuils de passage, de tableau d'honneur, d'encouragements, de félicitations et d'exclusion ; le conseil garde toujours le dernier mot.                                                    |
| « On verra à la rentrée prochaine. »             | Proposer un pilote au prochain trimestre, à prix réduit, pour arriver à la rentrée avec une équipe déjà formée.                                                                                                  |

## 8. Ce qu'il ne faut pas promettre

Promettre ce qui n'existe pas fait perdre l'école et sa recommandation. État au 1er novembre 2026 :

- **Interface en anglais** : seule la page de connexion des parents est bilingue, et l'en-tête du bulletin. Pour une école anglophone, ne pas vendre avant la traduction de l'interface.
- **Saisie hors connexion** : hors réseau, les notes et l'appel en classe se consultent mais ne se saisissent pas. Seul l'appel du car fonctionne entièrement sans réseau.
- **Application sur le Play Store** : c'est une application web installable sur l'écran d'accueil, pas une application native.
- **WhatsApp** : les notifications partent par SMS ou e-mail ; WhatsApp n'est pas encore disponible.
- **Virements des salaires** : le module de paie produit l'état des virements, mais n'envoie aucun virement.
- **Paiement Mobile Money en ligne** : seulement quand le point de la section 1 est réglé.
- **Paie et comptabilité** : seulement après la vérification du barème et des comptes par un expert-comptable.
- **Format de bulletin imposé** : le modèle actuel est le modèle bilingue national ; un autre format demande un développement.

La plaquette prend quatre engagements à tenir : formation sur place, assistance par téléphone et WhatsApp, sauvegarde chaque nuit conservée 30 jours, hébergement et mises à jour compris dans l'abonnement.

## 9. Indicateurs à suivre

- **Prospection** : rendez-vous par semaine, démonstrations, taux démonstration → pilote, taux pilote → contrat, délai moyen de signature.
- **Chiffre d'affaires** : nombre d'élèves sous contrat, prix moyen par élève, taux de renouvellement, retards de paiement des abonnements.
- **Réussite des clients** (à montrer dans les témoignages) : part des parents connectés au portail, taux de recouvrement avant et après, délai entre la fin du trimestre et la publication des bulletins, nombre de grilles de notes saisies par les enseignants eux-mêmes.

## 10. Les 30 prochains jours

1. **Semaine 1** : trancher le nom commercial et le point Mobile Money ; lancer la passerelle SMS et les dossiers marchands ; compléter le contact de la plaquette ; fixer la grille tarifaire.
2. **Semaine 2** : rédiger la fiche tarifaire, le scénario de démonstration, le questionnaire et la proposition type ; générer les échantillons imprimés ; consulter un avocat pour le contrat et l'annexe données personnelles.
3. **Semaines 3 et 4** : 15 visites, 5 démonstrations, 2 à 3 conventions de pilote signées pour un démarrage en janvier 2027.

Imprimer la plaquette en couleur sur papier couché 170 g, de préférence recto verso sur une feuille A3 pliée en deux (quatre pages A4).
