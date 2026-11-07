# Météo en rire

Des prévisions sérieuses, racontées avec le sourire : la météo des Bouches-du-Rhône, commune par commune.

## Comment ça marche

- `index.html` : l'app (une seule page, sans installation).
- `scripts/update.mjs` : toutes les heures, récupère la liste officielle des communes (geo.api.gouv.fr) et les prévisions d'Open-Meteo, puis prépare le site.
- `.github/workflows/meteo.yml` : lance le programme chaque heure et met le site en ligne sur GitHub Pages.
- `manifest.webmanifest` et `icons/` : l'icône et le nom de l'app sur l'écran d'accueil.

## Réglage à faire une seule fois

Settings → Pages → Build and deployment → Source : **GitHub Actions**.

## Lancer une mise à jour à la main

Onglet Actions → « Mise à jour météo » → Run workflow.

## Données

Prévisions : [Open-Meteo](https://open-meteo.com) (licence CC BY 4.0), dont les modèles de Météo-France. Usage non commercial pour l'offre gratuite.
