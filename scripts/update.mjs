// Météo en rire : programme de mise à jour automatique.
// GitHub le lance toutes les heures. Il récupère la liste officielle des communes,
// demande les prévisions à Open-Meteo, puis prépare le site dans le dossier « site ».
// Aucune clé n'est nécessaire. Node 20 ou plus récent.

import { mkdir, writeFile, cp, readdir } from "node:fs/promises";

// Secteurs de l'app. Une commune du 13 absente de ces listes est rattachée au secteur le plus proche.
const SECTEURS = {"mc": ["Marseille","Allauch","Plan-de-Cuques","Aubagne","La Penne-sur-Huveaune","Carnoux-en-Provence","Cassis","Ceyreste","La Ciotat","Roquefort-la-Bédoule","Gémenos","Cuges-les-Pins","Roquevaire","Auriol","La Destrousse","Peypin","Belcodène","La Bouilladisse","Cadolive","Saint-Savournin","Septèmes-les-Vallons","Le Rove","Ensuès-la-Redonne","Carry-le-Rouet","Sausset-les-Pins"],"aix": ["Aix-en-Provence","Éguilles","Venelles","Le Tholonet","Saint-Marc-Jaumegarde","Vauvenargues","Beaurecueil","Châteauneuf-le-Rouge","Rousset","Peynier","Trets","Puyloubier","Fuveau","Gréasque","Mimet","Gardanne","Meyreuil","Bouc-Bel-Air","Simiane-Collongue","Cabriès","Les Pennes-Mirabeau","Ventabren","Saint-Cannat","Rognes","Le Puy-Sainte-Réparade","Meyrargues","Peyrolles-en-Provence","Jouques","Saint-Paul-lès-Durance","Saint-Estève-Janson","Saint-Antonin-sur-Bayon","La Roque-d'Anthéron"],"berre": ["Martigues","Châteauneuf-les-Martigues","Gignac-la-Nerthe","Marignane","Saint-Victoret","Vitrolles","Rognac","Berre-l'Étang","Velaux","Coudoux","La Fare-les-Oliviers","Saint-Chamas","Istres","Fos-sur-Mer","Port-de-Bouc","Saint-Mitre-les-Remparts","Port-Saint-Louis-du-Rhône","Miramas","Cornillon-Confoux"],"salon": ["Salon-de-Provence","Pélissanne","Lançon-Provence","Grans","Lambesc","Alleins","Aurons","Vernègues","Lamanon","Eyguières","Sénas","Mallemort","Charleval","Orgon","Plan-d'Orgon","Cabannes","Saint-Andiol","Verquières","Mollégès","Noves","Eyragues","Châteaurenard","Rognonas","Barbentane","Graveson","Maillane","Saint-Rémy-de-Provence","Eygalières","Aureille","Mouriès","Maussane-les-Alpilles","Paradou","Les Baux-de-Provence","Mas-Blanc-des-Alpilles"],"arles": ["Arles","Saintes-Maries-de-la-Mer","Saint-Martin-de-Crau","Tarascon","Boulbon","Saint-Étienne-du-Grès","Saint-Pierre-de-Mézoargues","Fontvieille"]};
// Communes voisines (hors Bouches-du-Rhône) : nom et numéro de département.
const VOISINS = [["Pertuis", "84"], ["Cadenet", "84"], ["Lauris", "84"], ["La Tour-d'Aigues", "84"], ["Saint-Maximin-la-Sainte-Baume", "83"], ["Avignon", "84"]];

const UA = { "User-Agent": "meteo-en-rire (GitHub Actions)" };
const norm = t => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['’\-]/g, " ").replace(/\s+/g, " ").trim();
const pause = ms => new Promise(r => setTimeout(r, ms));

async function lireJSON(url, essais = 4) {
  for (let i = 1; i <= essais; i++) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 30000);
      const r = await fetch(url, { headers: UA, signal: ctl.signal }); clearTimeout(to);
      if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 200));
      return await r.json();
    } catch (e) {
      console.warn(`Essai ${i}/${essais} échoué pour ${url.slice(0, 90)}… : ${e.message}`);
      if (i === essais) throw e;
      await pause(3000 * i);
    }
  }
}

// 1. Liste officielle des communes (geo.api.gouv.fr, service public)
async function communes() {
  const liste = [];
  const dep13 = await lireJSON("https://geo.api.gouv.fr/departements/13/communes?fields=nom,code,centre&format=json");
  const index = {};
  for (const [k, noms] of Object.entries(SECTEURS)) for (const n of noms) index[norm(n)] = k;
  const sansSecteur = [];
  for (const c of dep13) {
    const [lon, lat] = c.centre.coordinates;
    const s = index[norm(c.nom)];
    const x = { n: c.nom, code: c.code, lat, lon, s };
    if (!s) sansSecteur.push(x);
    liste.push(x);
  }
  // Rattache les communes non classées au secteur dont le centre est le plus proche
  const centres = {};
  for (const k of Object.keys(SECTEURS)) {
    const pts = liste.filter(x => x.s === k);
    centres[k] = [pts.reduce((a, x) => a + x.lat, 0) / pts.length, pts.reduce((a, x) => a + x.lon, 0) / pts.length];
  }
  for (const x of sansSecteur) {
    let best = null, bd = Infinity;
    for (const [k, [la, lo]] of Object.entries(centres)) { const d = (la - x.lat) ** 2 + (lo - x.lon) ** 2; if (d < bd) { bd = d; best = k; } }
    x.s = best; console.log(`Commune ajoutée au secteur ${best} : ${x.n}`);
  }
  for (const [nom, dep] of VOISINS) {
    const r = await lireJSON(`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(nom)}&codeDepartement=${dep}&fields=nom,code,centre&format=json&limit=5`);
    const c = r.find(x => norm(x.nom) === norm(nom)) || r[0];
    if (!c) { console.warn("Commune voisine introuvable : " + nom); continue; }
    const [lon, lat] = c.centre.coordinates;
    liste.push({ n: c.nom, code: c.code, lat, lon, s: "voisins" });
  }
  console.log(`${dep13.length} communes des Bouches-du-Rhône + ${liste.length - dep13.length} voisines`);
  return liste;
}

// 2. Prévisions Open-Meteo, par paquets de 25 communes
const PARAMS = new URLSearchParams({
  current: "temperature_2m,apparent_temperature,weather_code,wind_gusts_10m,wind_direction_10m",
  hourly: "temperature_2m,weather_code,precipitation_probability,wind_gusts_10m,wind_direction_10m",
  daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,wind_gusts_10m_max,wind_direction_10m_dominant,precipitation_sum,precipitation_probability_max,uv_index_max",
  timezone: "Europe/Paris", forecast_days: "7", wind_speed_unit: "kmh"
});
const HEURES = [7, 9, 11, 13, 15, 17, 19, 21];
const r1 = v => v == null ? null : Math.round(v * 10) / 10;

async function previsions(liste) {
  for (let i = 0; i < liste.length; i += 25) {
    const lot = liste.slice(i, i + 25);
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lot.map(x => x.lat.toFixed(4)).join(",") +
      "&longitude=" + lot.map(x => x.lon.toFixed(4)).join(",") + "&" + PARAMS.toString();
    let rep = await lireJSON(url);
    if (!Array.isArray(rep)) rep = [rep];
    rep.forEach((p, j) => {
      const x = lot[j], d = p.daily, h = p.hourly, c = p.current;
      x.cur = [r1(c.temperature_2m), r1(c.apparent_temperature), c.weather_code, Math.round(c.wind_gusts_10m), c.wind_direction_10m];
      x.d = d.time.map((date, k) => [date, d.weather_code[k], r1(d.temperature_2m_max[k]), r1(d.temperature_2m_min[k]),
        Math.round(d.wind_gusts_10m_max[k] ?? 0), d.wind_direction_10m_dominant[k], r1(d.precipitation_sum[k] ?? 0),
        d.precipitation_probability_max[k], r1(d.uv_index_max[k]), r1(d.apparent_temperature_max[k])]);
      const pos = {}; h.time.forEach((t, k) => { pos[t] = k; });
      x.h = d.time.map(date => HEURES.map(hh => {
        const k = pos[date + "T" + String(hh).padStart(2, "0") + ":00"];
        return k == null ? [null] : [r1(h.temperature_2m[k]), h.weather_code[k], h.precipitation_probability[k], Math.round(h.wind_gusts_10m[k] ?? 0), h.wind_direction_10m[k]];
      }));
    });
    await pause(1200);
  }
}

// 3. Construction du site
const liste = await communes();
await previsions(liste);
const ok = liste.filter(x => x.d && x.d.length >= 7);
if (ok.length < 100) throw new Error(`Seulement ${ok.length} communes avec des prévisions : site non publié, la version précédente reste en ligne.`);
await mkdir("site/data", { recursive: true });
await writeFile("site/data/meteo.json", JSON.stringify({
  maj: new Date().toISOString(),
  source: "Open-Meteo (CC BY 4.0), dont les modèles de Météo-France",
  alertes: null,
  communes: ok.map(({ n, s, lat, lon, cur, d, h }) => ({ n, s, lat: r1x(lat), lon: r1x(lon), cur, d, h }))
}));
function r1x(v) { return Math.round(v * 1000) / 1000; }
// Copie tous les fichiers de l'app (tout sauf les outils et le dossier « site » lui-même)
const EXCLUS = new Set([".git", ".github", "scripts", "site", "node_modules", "README.md"]);
for (const f of await readdir(".")) if (!EXCLUS.has(f)) await cp(f, "site/" + f, { recursive: true });
console.log(`Site prêt : ${ok.length} communes, mis à jour le ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`);
