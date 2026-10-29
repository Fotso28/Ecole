# Proposition UI/UX

Maquettes interactives : https://claude.ai/artifact/Efakhub7NCyMYe14QyDzAy (privées tant qu'elles ne sont pas partagées depuis le menu Partager).

## 1. Direction visuelle « Vert kola »

Un outil de travail calme : fond papier chaud, vert profond pour l'action, safran réservé à ce qui demande l'attention. Pas de dégradés, pas d'images décoratives (connexions lentes).

### Couleurs (tokens du thème shadcn/ui)

| Token | Valeur | Usage |
|---|---|---|
| `--primary` | `#0B6447` | Action principale, lien, sélection (7,2:1 sur blanc) |
| `--primary-soft` | `#E3F0EA` | Fond des états « succès », éléments sélectionnés |
| `--sidebar` | `#0E2A20` | Barre latérale, en-têtes de documents |
| `--accent` | `#E8A317` | Élément actif, badge de compteur. Jamais en texte |
| `--foreground` | `#14201A` | Texte principal |
| `--muted-foreground` | `#55615A` | Texte secondaire (5,9:1 sur le fond) |
| `--background` | `#F6F5F0` | Fond d'application ; surfaces en `#FFFFFF` |
| `--border` | `#E4E2DA` | Bordures des cartes ; `#D5D3CA` pour les champs |
| `--warning` / `--warning-soft` | `#8A5A00` / `#FDF3DC` | Partiel, retard, seuil atteint |
| `--destructive` / `--destructive-soft` | `#B3261E` / `#FBE9E7` | Impayé, absence, erreur |
| `--info` / `--info-soft` | `#1F5FBF` / `#E7EEFA` | Justifié, transféré, en attente |

Tous les couples texte/fond dépassent 4,5:1. Un statut n'est jamais porté par la couleur seule : il a toujours un libellé.

### Typographie

- Titres d'écran : **Bricolage Grotesque** 700, 30/36 (titres de page uniquement).
- Interface : **Plus Jakarta Sans** 400 à 700 ; corps 14/22 sur bureau, 16/24 sur mobile.
- Libellés de colonnes : 12 px, 600, capitales espacées.
- Chiffres : toujours `font-variant-numeric: tabular-nums`, alignés à droite dans les tableaux.

### Formats

- Montants : entiers, espace fine insécable comme séparateur, suffixe `FCFA` (`125 000 FCFA`).
- Notes : sur 20, virgule décimale, deux décimales pour les moyennes (`13,42`).
- Dates : `jeudi 29 octobre`, `12/03/2012` dans les tableaux.
- Interface en français et en anglais (sélecteur visible dès l'écran de connexion).

### Dimensions

- Boutons et champs : 40 px sur bureau, 48 px sur mobile. Un seul bouton principal par écran.
- Rayons : 10 px (champs, boutons), 14 px (cartes), 999 px (badges).
- Cibles tactiles : 44 px minimum.

## 2. Principes d'expérience

1. **Une tâche, un écran.** Chaque rôle arrive sur ses actions du jour : l'enseignant sur l'appel, le caissier sur l'encaissement, le parent sur ce qu'il doit payer.
2. **Rapide en 3G.** Rendu serveur, squelettes de chargement, listes virtualisées au-delà de 100 lignes.
3. **Des chiffres irréprochables.** Chaque moyenne affiche son calcul au survol ; la saisie refuse une note hors barème avant l'enregistrement.
4. **L'irréversible se confirme.** Publication de bulletin, encaissement, clôture de caisse : écran récapitulatif puis validation. Un paiement validé ne se modifie pas, il se corrige par une écriture tracée.
5. **Le téléphone d'abord pour les familles.** Connexion par code SMS, menu en bas d'écran, trois tâches principales : consulter, justifier, payer.

## 3. Architecture et navigation

- **Bureau** : barre latérale (sélecteur d'établissement, groupes Vie scolaire, Pédagogie, Finances, École) et barre du haut (recherche globale `Ctrl K`, année et trimestre, notifications).
- **Tablette** : écrans plein cadre pour l'appel et le conseil de classe.
- **Téléphone** : menu inférieur à cinq entrées.
  - Parent : Accueil, Notes, Absences, Paiements, Messages.
  - Enseignant : Aujourd'hui, Appel, Notes, Cahier de texte, Messages.

Règles transverses :

- Le menu est calculé à partir des permissions : ce qui n'est pas autorisé est masqué, pas grisé.
- Cumul de rôles : menu « Agir en tant que » plutôt que deux comptes.
- Parents multi-écoles : un seul compte, tous les enfants sur le même accueil.
- Année close : affichée en lecture seule.
- Fiche santé : ouverture sur motif, consultation journalisée.
- Module non souscrit : absent du menu, visible dans Paramètres › Modules.

## 4. Inventaire des écrans maquettés

| Écran | Rôle | Points clés |
|---|---|---|
| Tableau de bord | Direction | Indicateurs, encaissements par semaine (bascule graphique/tableau), liste « À traiter », classes les moins à jour, activité récente liée au journal d'audit |
| Élèves | Secrétariat | Filtres par statut, sélection multiple et actions groupées, import CSV/Excel |
| Fiche élève | Tous (selon droits) | Situation financière, résultats, assiduité, parents, parcours, pièces du dossier, accès restreint à la fiche santé |
| Admission | Secrétariat | Assistant en 5 étapes, détection de doublon à la saisie (nom, date et lieu de naissance) |
| Saisie des notes | Enseignant, censeur | Grille type tableur, moyennes, rangs avec ex aequo et appréciations calculés en direct, validation 0–20, soumission bloquée tant qu'une note manque |
| Bulletin | Direction | Modèle A4 bilingue, groupes de matières, bilan, décision du conseil, QR de vérification et numéro de version |
| Appel | Enseignant (tablette) | Boutons P/A/R de 48 px, compteurs en direct, « Tous présents », SMS automatique aux parents à 10:00 |
| Emploi du temps | Censeur | Grille par classe, enseignant ou salle, conflits signalés immédiatement avec correction proposée, contrôle de la charge horaire |
| Caisse | Comptable | Choix des échéances, espèces avec monnaie à rendre, Mobile Money, banque, récapitulatif avant validation, reçu |
| Connexion parent | Parent | Numéro +237, code SMS à 6 chiffres (`autocomplete="one-time-code"`), repli par appel vocal, FR/EN |
| Accueil parent | Parent | Changement d'enfant (plusieurs écoles), reste à payer, absence à justifier, dernières notes, annonce |
| Paiement Mobile Money | Parent | Montant (échéance, solde, autre), opérateur, attente de validation, confirmation et nouveau solde |
| Notes sur mobile | Enseignant | Un élève par ligne, clavier numérique, bouton « Abs », progression 44/46 |

## 5. Règles d'interaction

- **Saisie des notes** : `Tab` passe à la cellule suivante, `Entrée` et les flèches changent d'élève, `abs` marque un absent (exclu du calcul), `disp` un dispensé. Le brouillon est enregistré en continu et n'est visible que de l'enseignant jusqu'à la soumission.
- **Tableaux** : complets sur bureau ; défilement horizontal dans un cadre sur petit écran, ou cartes empilées pour les listes consultées sur mobile.
- **Graphiques** : une seule échelle, étiquettes directes sur les valeurs importantes, info-bulle au survol et vue tableau équivalente.
- **Paiement Mobile Money** : le reçu n'est émis qu'après la confirmation de l'opérateur ; la page d'attente peut être quittée sans perdre le paiement.
- **Alertes** : en ligne dans la page (pas de fenêtre modale) sauf pour une confirmation d'action irréversible.

## 6. Accessibilité

- Contrôles réels (`button`, `a`, `input` avec `label`), `aria-label` sur les boutons icône.
- Contraste minimal 4,5:1, y compris pour les textes secondaires de 12 px.
- États communiqués par libellé et forme, pas seulement par la couleur.
- Champs numériques avec `inputmode` adapté (`numeric`, `decimal`, `tel`).

## 7. Questions ouvertes côté UI

- Format du bulletin imposé par le ministère ou libre : le modèle est prévu configurable (en-tête, groupes de matières, mentions).
- Mode hors ligne : la saisie mobile annonce « Enregistré sur l'appareil » ; à confirmer selon la décision sur l'application offline-first.
- Canal de notification principal (SMS ou WhatsApp) : impacte les libellés des écrans de paiement et d'absence.
