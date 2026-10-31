# Module RH et paie simplifiée

Module activable par école (`hr` dans les modules de l'abonnement).

## Permissions

| Permission            | Rôles                   | Usage                                                         |
| --------------------- | ----------------------- | ------------------------------------------------------------- |
| `hr.read`             | Direction, Comptabilité | Dossiers, heures, paies, bulletins PDF, récapitulatif mensuel |
| `hr.write`            | Direction, Comptabilité | Dossiers, contrats, heures de cours                           |
| `hr.payroll.prepare`  | Direction, Comptabilité | Calcul et saisie de la paie, soumission, avances, virements   |
| `hr.payroll.validate` | Direction               | Validation ou renvoi de la paie, accord des avances, barèmes  |

La validation d'une paie (et l'accord d'une avance) doit venir d'une autre personne que celle qui
l'a préparée (calcul ou soumission) : la règle est vérifiée par l'API, même pour la direction.
La direction peut valider une paie qui contient son propre bulletin : il est calculé à partir du
contrat par la comptabilité, et la personne qui a préparé la paie ou modifié un bulletin ne peut pas
la valider. Le journal d'audit le signale (`includesValidatorPayslip` sur `hr.payroll_validated`).

## Circuit de la paie

1. **Calcul** (comptabilité) : un bulletin par dossier ayant un contrat couvrant le mois. Le
   barème en vigueur pour le mois est copié dans la paie. Recalcul possible tant que la paie est
   en préparation ; les primes, indemnités, rappels et jours d'absence saisis sont conservés.
2. **Soumission** (comptabilité) : la direction est prévenue par la table d'envoi.
3. **Validation** (direction, autre personne) ou **renvoi** motivé.
4. Après validation, la paie est **figée** (déclencheurs PostgreSQL sur `PayrollRun` et
   `Payslip`) : bulletins numérotés `PAIE-AAAA-MM-0001`, remboursements d'avances enregistrés en
   ajout seul, heures du mois verrouillées. Une correction passe par un **rappel** (élément
   `RECALL`, éventuellement négatif) sur la paie du mois suivant.
5. Bulletins PDF et **état des virements** (CSV ou Excel) disponibles seulement après validation.
   Ecole n'envoie **aucun virement** : l'état est à exécuter manuellement.

Chaque étape, chaque consultation des données sensibles, chaque impression et chaque export est
journalisé. Le récapitulatif d'une paie validée (`GET /hr/payroll/:mois/summary`, ou
`PayrollService.validatedSummary` exporté par `HrModule`) donne les totaux par organisme pour la
comptabilité générale ; le module RH n'écrit aucune écriture comptable.

## Calcul (packages/shared/src/payroll.ts)

Montants en FCFA entiers, taux en points de base (420 = 4,2 %), arrondi au franc le plus proche
(demi vers le haut).

- Salarié (CDI, CDD) : salaire de base au prorata des jours de contrat dans le mois ; retenue des
  cours manqués sans justification au prorata des heures prévues, plus 1/30 par journée
  d'absence saisie ; heures supplémentaires au taux du contrat.
- Vacataire : taux horaire × heures de cours marquées faites (heures supplémentaires au taux du
  contrat, sinon au taux horaire).
- Brut taxable = base + heures supplémentaires − absences + éléments imposables ; les indemnités
  non imposables sont versées en net.
- CNPS salarié sur le brut taxable plafonné ; crédit foncier sur le brut taxable.
- IRPP : (70 % du brut taxable × 12 − CNPS salariale × 12 − abattement annuel) au barème annuel,
  divisé par 12 ; exonéré sous le seuil mensuel. CAC = 10 % de l'IRPP.
- Redevance audiovisuelle selon le brut taxable, taxe communale selon le salaire de base.
- Avances : mensualité convenue, retenue sur le net sans jamais le rendre négatif ; le reste est
  reporté.

## Taux préremplis à faire vérifier par un comptable

Le barème par défaut (`DEFAULT_PAYROLL_SCALE`) reprend les valeurs camerounaises connues lors du
développement. **Chaque taux est marqué « à vérifier par un comptable »** et s'affiche comme tel
dans l'application et sur les bulletins tant qu'une version vérifiée n'a pas été enregistrée.

| Élément                               | Valeur préremplie                                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CNPS pension vieillesse salarié       | 4,2 %, plafond 750 000 FCFA/mois                                                                                                                                 |
| CNPS pension vieillesse employeur     | 4,2 %, même plafond                                                                                                                                              |
| CNPS prestations familiales employeur | 3,7 % (enseignement privé ; 7 % régime général)                                                                                                                  |
| CNPS risques professionnels employeur | 1,75 % (groupe A), sans plafond                                                                                                                                  |
| Crédit foncier                        | 1 % salarié, 1,5 % employeur                                                                                                                                     |
| Fonds national de l'emploi            | 1 % employeur                                                                                                                                                    |
| IRPP                                  | abattement 30 %, abattement annuel 500 000, exonération sous 62 000 FCFA brut/mois ; 10 % jusqu'à 2 M, 15 % jusqu'à 3 M, 25 % jusqu'à 5 M, 35 % au-delà (annuel) |
| Centimes additionnels communaux       | 10 % de l'IRPP                                                                                                                                                   |
| Redevance audiovisuelle               | 0 à 13 000 FCFA/mois selon 12 tranches                                                                                                                           |
| Taxe communale (développement local)  | 0 à 2 500 FCFA/mois selon 10 tranches                                                                                                                            |

Pour corriger un taux, la direction enregistre une nouvelle version datée dans **Paie →
Barèmes** : les versions sont en ajout seul et chaque paie conserve la version appliquée.
