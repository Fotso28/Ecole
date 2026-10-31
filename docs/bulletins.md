# Bulletins : règles de calcul et décisions du conseil

Ce document décrit exactement ce que calcule l'application. Il sert de base à la validation par le censeur de l'établissement. Le code correspondant se trouve dans `packages/shared/src/grades.ts` et `packages/shared/src/results.ts`.

## Notes et arrondis

- Les notes et les moyennes sont tenues en centièmes de point, sans virgule flottante : 13,42 / 20 est enregistré 1342.
- Une note sur un autre barème est ramenée sur 20 : 27 / 40 donne 13,50.
- Chaque moyenne est arrondie au centième le plus proche, le demi centième vers le haut : 12,665 donne 12,67.
- Les moyennes de matières sont arrondies avant le calcul de la moyenne générale, comme sur le bulletin imprimé. Le total « M × C » du bulletin redonne donc exactement la moyenne générale.

## Moyennes

| Moyenne                   | Calcul                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------- |
| Matière, sur une séquence | Moyenne pondérée des évaluations de la séquence (poids de chaque évaluation).      |
| Matière, sur un trimestre | Moyenne simple des séquences du trimestre qui ont une moyenne.                     |
| Générale du trimestre     | Σ (moyenne de la matière × coefficient) ÷ Σ coefficients, sur les matières notées. |
| Matière, sur l'année      | Moyenne simple des moyennes trimestrielles de la matière.                          |
| Générale de l'année       | Moyenne arithmétique des moyennes générales des trimestres : (T1 + T2 + T3) ÷ 3.   |

Cas particuliers :

- **Absence justifiée.** Elle se saisit « abs » et n'est pas comptée. Une absence non justifiée se saisit 0, selon le règlement intérieur.
- **Dispense.** Elle se saisit « disp » et n'est pas comptée. Si l'élève est dispensé de la matière tout le trimestre, la matière et son coefficient sortent de sa moyenne générale.
- **Note manquante.** Elle bloque la soumission de la grille par l'enseignant. À la préparation des bulletins, toute saisie manquante est listée. La publication exige alors un motif, qui est journalisé.
- **Trimestre sans moyenne.** C'est le cas d'un élève arrivé en cours d'année. Ce trimestre est signalé sur le bulletin annuel, et la moyenne annuelle porte sur les trimestres disponibles.

## Rangs

- Le classement se fait par moyenne décroissante, au centième près, avec ex æquo : deux élèves à 15,50 sont tous deux « 3e ex », et l'élève suivant est 5e.
- Un élève sans moyenne n'est pas classé (« Non classé »). Le rang s'affiche sur le nombre d'élèves classés.
- Le même principe s'applique aux rangs par matière, au rang trimestriel et au rang annuel.

## Décisions du conseil de classe

L'application propose une décision pour chaque élève. Le conseil garde toujours le dernier mot : chaque proposition se modifie sur la fiche « Décision » de l'élève.

### Distinction trimestrielle

Elle est proposée d'après la moyenne générale du trimestre, à confirmer selon la conduite :

| Moyenne du trimestre | Proposition       |
| -------------------- | ----------------- |
| À partir de 16,00    | Félicitations     |
| À partir de 14,00    | Encouragements    |
| À partir de 12,00    | Tableau d'honneur |
| En dessous           | Aucune mention    |

L'avertissement et le blâme ne sont jamais proposés automatiquement : ils relèvent du seul conseil.

### Décision de fin d'année

Elle se prend au conseil du dernier trimestre :

| Situation                                                            | Proposition                                                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Moyenne annuelle d'au moins 10,00                                    | Admis en classe supérieure                                                               |
| Moyenne annuelle sous le seuil d'exclusion de l'école, s'il est fixé | Exclu pour insuffisance de travail                                                       |
| Redoublant cette année, moyenne annuelle inférieure à 10,00          | Exclu pour insuffisance de travail (un second redoublement de la classe n'est pas admis) |
| Autre élève, moyenne annuelle inférieure à 10,00                     | Redouble                                                                                 |

Ces décisions restent toujours au choix du conseil :

- le rachat (« Admis par décision du conseil ») ;
- l'exclusion pour indiscipline ;
- toute dérogation.

Dans les classes d'examen, le passage dépend aussi du résultat à l'examen officiel, et la fiche le rappelle. Ces classes sont la 3e (BEPC), la 1re (Probatoire) et la Terminale (Baccalauréat), ainsi que la Form 5 et l'Upper Sixth.

L'assistant de rentrée reprend la décision de fin d'année :

- admis : classe supérieure ;
- redouble : même niveau ;
- exclu : élève sortant.

## Réglages propres à l'école

La direction règle les propositions dans **Paramètres → Conseil de classe**. Chaque modification est journalisée.

| Réglage                                                         | Valeur par défaut |
| --------------------------------------------------------------- | ----------------- |
| Moyenne annuelle de passage                                     | 10,00             |
| Seuil du tableau d'honneur                                      | 12,00             |
| Seuil des encouragements                                        | 14,00             |
| Seuil des félicitations                                         | 16,00             |
| Proposer l'exclusion d'un redoublant sous la moyenne de passage | Oui               |
| Seuil d'exclusion sur la moyenne annuelle seule                 | Aucun             |

Les seuils doivent croître dans l'ordre suivant : tableau d'honneur, encouragements, félicitations. Le seuil d'exclusion doit rester inférieur à la moyenne de passage.

## Cycle de vie d'un bulletin

1. Les enseignants soumettent leurs grilles. Le censeur peut corriger une note soumise.
2. Le censeur prépare les bulletins : les brouillons sont calculés et chaque saisie manquante est signalée.
3. Le conseil saisit les décisions. Une décision modifiée après la préparation rend les brouillons périmés. Un bandeau le signale, et la publication reste bloquée jusqu'à une nouvelle préparation.
4. La direction publie. Les notes sont verrouillées, le bulletin est figé et les parents reçoivent un SMS. Toute correction ultérieure passe par une réouverture motivée et produit une nouvelle version numérotée.
5. Le bulletin publié porte un code et un QR de vérification publique.

## Validation effectuée

La validation a porté sur une année complète de notes d'une classe de 30 élèves en 4e, saisies par les enseignants dans l'application. Les données contenaient plusieurs cas pièges :

- un élève à 10,00 pile et un autre à 9,99 ;
- deux élèves ex æquo ;
- une absence justifiée et une dispense d'EPS ;
- une arrivée en janvier ;
- une redoublante en échec ;
- des devoirs notés sur 40.

Les résultats :

- **Calculs.** Un programme indépendant, sans le code de l'application, a recalculé à partir des notes brutes toutes les moyennes de matière, les moyennes générales, les rangs trimestriels et annuels et les moyennes annuelles par matière. Il trouve 0 écart sur les 90 bulletins (3 trimestres × 30 élèves).
- **Décisions.** Les 30 décisions saisies au conseil suivent les règles ci-dessus. On compte 20 admis, 9 redoublants et 1 exclusion proposée (la redoublante en échec), ainsi que 2 félicitations, 4 encouragements et 8 tableaux d'honneur.

Les choix propres à chaque établissement restent à confirmer par son censeur : seuils, traitement des redoublants, absences non justifiées notées 0. Les réglages ci-dessus permettent de les adapter sans modifier l'application.
