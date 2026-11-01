# Documents commerciaux

| Fichier                            | Usage                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| [plaquette.pdf](plaquette.pdf)     | Plaquette de 4 pages A4 à remettre au chef d'établissement (impression ou envoi par WhatsApp).    |
| [plaquette.html](plaquette.html)   | Source de la plaquette. Les coordonnées du commercial sont dans le bloc « contact » de la page 4. |
| [kit-de-vente.md](kit-de-vente.md) | Guide interne : prérequis, documents à préparer, parcours de vente, prix, objections, calendrier. |
| `images/`                          | Captures d'écran réelles de l'application sur le jeu de démonstration (« Collège Démo »).         |

## Régénérer le PDF après une modification

Depuis la racine du dépôt (accès à Google Fonts nécessaire) :

```bash
node docs/commercial/generer-pdf.cjs
```

Le script signale un contenu qui dépasserait le bas d'une page. Ajouter un dossier en argument pour obtenir aussi un aperçu PNG de chaque page.

## Refaire les captures d'écran

Démarrer l'API et le site sur le jeu de démonstration (voir le `README.md` à la racine), puis capturer sur téléphone (390 × 844, échelle 3) et sur ordinateur (1366 × 860, échelle 2) avec les comptes de démonstration. Les captures montrent des élèves fictifs : ne jamais utiliser de données d'une vraie école.
