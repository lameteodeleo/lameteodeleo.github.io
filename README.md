# La météo de Léo

Des prévisions sérieuses, racontées avec le sourire : la météo des Bouches-du-Rhône, commune par commune.

## Comment ça marche

- `index.html` : l'app (une seule page, sans installation).
- `scripts/update.mjs` : toutes les 2 heures, récupère la liste officielle des communes (geo.api.gouv.fr), les prévisions d'Open-Meteo et les vigilances de Météo-France, contrôle la qualité des données, puis prépare le site.
- `.github/workflows/meteo.yml` : lance le programme toutes les 2 heures et met le site en ligne sur GitHub Pages.
- `manifest.webmanifest` et `icons/` : l'icône et le nom de l'app sur l'écran d'accueil.

## Réglage à faire une seule fois

Settings → Pages → Build and deployment → Source : **GitHub Actions**.

## Vigilances Météo-France

La clé de l'API « Données Publiques Vigilance » est rangée dans le secret `MF_VIGILANCE_KEY` (Settings → Secrets and variables → Actions). Sans elle, le site est publié sans vigilances.

## Lancer une mise à jour à la main

Onglet Actions → « Mise à jour météo » → Run workflow.

## Données

Prévisions : [Open-Meteo](https://open-meteo.com) (licence CC BY 4.0) : modèles AROME et ARPEGE de Météo-France, complétés par le modèle global. Usage non commercial pour l'offre gratuite.
