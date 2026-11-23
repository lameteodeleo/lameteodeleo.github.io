// La météo de Léo : programme de mise à jour automatique.
// GitHub le lance toutes les 2 heures. Il récupère la liste officielle des communes,
// demande les prévisions à Open-Meteo, puis prépare le site dans le dossier « site ».
// Seule clé utilisée : MF_VIGILANCE_KEY (secret GitHub, facultatif) pour les vigilances de Météo-France. Node 20 ou plus récent.

import { mkdir, writeFile, cp, readdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { noterJour, cleUTC, lireHoraire, stationsAir, lireAir, noterAir } from "./verif.mjs";

// Secteurs de l'app. Une commune du 13 absente de ces listes est rattachée au secteur le plus proche.
const SECTEURS = {"mc": ["Marseille","Allauch","Plan-de-Cuques","Aubagne","La Penne-sur-Huveaune","Carnoux-en-Provence","Cassis","Ceyreste","La Ciotat","Roquefort-la-Bédoule","Gémenos","Cuges-les-Pins","Roquevaire","Auriol","La Destrousse","Peypin","Belcodène","La Bouilladisse","Cadolive","Saint-Savournin","Septèmes-les-Vallons","Le Rove","Ensuès-la-Redonne","Carry-le-Rouet","Sausset-les-Pins"],"aix": ["Aix-en-Provence","Éguilles","Venelles","Le Tholonet","Saint-Marc-Jaumegarde","Vauvenargues","Beaurecueil","Châteauneuf-le-Rouge","Rousset","Peynier","Trets","Puyloubier","Fuveau","Gréasque","Mimet","Gardanne","Meyreuil","Bouc-Bel-Air","Simiane-Collongue","Cabriès","Les Pennes-Mirabeau","Ventabren","Saint-Cannat","Rognes","Le Puy-Sainte-Réparade","Meyrargues","Peyrolles-en-Provence","Jouques","Saint-Paul-lès-Durance","Saint-Estève-Janson","Saint-Antonin-sur-Bayon","La Roque-d'Anthéron"],"berre": ["Martigues","Châteauneuf-les-Martigues","Gignac-la-Nerthe","Marignane","Saint-Victoret","Vitrolles","Rognac","Berre-l'Étang","Velaux","Coudoux","La Fare-les-Oliviers","Saint-Chamas","Istres","Fos-sur-Mer","Port-de-Bouc","Saint-Mitre-les-Remparts","Port-Saint-Louis-du-Rhône","Miramas","Cornillon-Confoux"],"salon": ["Salon-de-Provence","Pélissanne","Lançon-Provence","Grans","Lambesc","Alleins","Aurons","Vernègues","Lamanon","Eyguières","Sénas","Mallemort","Charleval","Orgon","Plan-d'Orgon","Cabannes","Saint-Andiol","Verquières","Mollégès","Noves","Eyragues","Châteaurenard","Rognonas","Barbentane","Graveson","Maillane","Saint-Rémy-de-Provence","Eygalières","Aureille","Mouriès","Maussane-les-Alpilles","Paradou","Les Baux-de-Provence","Mas-Blanc-des-Alpilles"],"arles": ["Arles","Saintes-Maries-de-la-Mer","Saint-Martin-de-Crau","Tarascon","Boulbon","Saint-Étienne-du-Grès","Saint-Pierre-de-Mézoargues","Fontvieille"]};
// Communes voisines (hors Bouches-du-Rhône) : nom et numéro de département.
const VOISINS = [["Pertuis", "84"], ["Cadenet", "84"], ["Lauris", "84"], ["La Tour-d'Aigues", "84"], ["Saint-Maximin-la-Sainte-Baume", "83"], ["Avignon", "84"]];

const UA = { "User-Agent": "lameteodeleo (GitHub Actions)" };
// Les fichiers déjà publiés (prévisions précédentes, historique de fiabilité) : nouveau domaine d'abord, puis l'ancienne adresse
const ADRESSES = ["https://lameteodeleo.fr", "https://lameteodeleo.github.io", "http://lameteodeleo.fr"];
async function lireSite(chemin, essais) {
  let err = null;
  for (const base of ADRESSES) { try { return await lireJSON(base + chemin + "?t=" + Date.now(), essais); } catch (e) { err = e; } }
  throw err;
}
const norm = t => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['’\-]/g, " ").replace(/\s+/g, " ").trim();
const pause = ms => new Promise(r => setTimeout(r, ms));

async function lireJSON(url, essais = 4) {
  for (let i = 1; i <= essais; i++) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 30000);
      const r = await fetch(url, { headers: UA, signal: ctl.signal }); clearTimeout(to);
      if (!r.ok) { const err = new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 200)); err.status = r.status; throw err; }
      return await r.json();
    } catch (e) {
      console.warn(`Essai ${i}/${essais} échoué pour ${url.slice(0, 90)}… : ${e.message}`);
      if (i === essais) throw e;
      // Trop de demandes en une minute (429) : on attend que le compteur d'Open-Meteo se remette à zéro
      await pause(e.status === 429 ? 65000 : 4000 * i);
    }
  }
}

// 1. Liste officielle des communes (geo.api.gouv.fr, service public)
// Si ce service ne répond pas, on reprend la liste du site déjà en ligne : la mise à jour n'est pas bloquée.
async function communes() {
  try { return await communesOfficielles(); }
  catch (e) {
    console.warn("Liste officielle des communes indisponible (" + e.message + ") : reprise de la liste du site en ligne.");
    const prec = await lireSite("/data/meteo.json");
    return prec.communes.map(c => ({ n: c.n, s: c.s, lat: c.lat, lon: c.lon, dep: c.dep }));
  }
}
async function communesOfficielles() {
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
  hourly: "temperature_2m,weather_code,precipitation_probability,wind_gusts_10m,wind_direction_10m,uv_index,precipitation",
  daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,wind_gusts_10m_max,wind_direction_10m_dominant,precipitation_sum,precipitation_probability_max,uv_index_max",
  timezone: "Europe/Paris", forecast_days: "7", wind_speed_unit: "kmh"
});
// Modèles de Météo-France (AROME 1,3 à 2,5 km pour aujourd'hui et demain, puis ARPEGE) : plus précis pour le mistral,
// les orages et le relief. Ils remplacent les valeurs ci-dessus sur les 3 premiers jours quand ils sont disponibles.
// Le risque de pluie, l'indice UV et les jours 4 à 7 restent ceux du modèle global (Open-Meteo « best match »).
const PARAMS_MF = new URLSearchParams({
  models: "meteofrance_seamless",
  current: "temperature_2m,apparent_temperature,weather_code,wind_gusts_10m,wind_direction_10m",
  hourly: "temperature_2m,weather_code,wind_gusts_10m,wind_direction_10m,precipitation",
  daily: "weather_code,temperature_2m_max,temperature_2m_min,wind_gusts_10m_max,precipitation_sum",
  timezone: "Europe/Paris", forecast_days: "3", wind_speed_unit: "kmh"
});
const JOURS_MF = 3;
const HEURES = [7, 9, 11, 13, 15, 17, 19, 21];
const r1 = v => v == null ? null : Math.round(v * 10) / 10;

// Maximale et minimale d'une journée, à la manière de Météo-France : la maximale se cherche de 7 h à 6 h le lendemain,
// la minimale de 19 h la veille à 19 h. Une douceur à minuit, juste avant un coup de mistral, n'est donc plus comptée
// comme « maximale » d'une journée froide. Renvoie null s'il manque trop d'heures.
function extremes(h, date) {
  if (!h || !h.time || !h.temperature_2m) return null;
  const jour = new Date(date + "T00:00:00Z"), cle = (d, hh) => new Date(jour.getTime() + d * 864e5).toISOString().slice(0, 10) + "T" + String(hh).padStart(2, "0") + ":00";
  const pos = {}; h.time.forEach((t, k) => { pos[t] = k; });
  const lire = t => { const k = pos[t]; return k == null || h.temperature_2m[k] == null || Number.isNaN(h.temperature_2m[k]) ? null : h.temperature_2m[k]; };
  const hautes = [], basses = [];
  for (let hh = 7; hh <= 23; hh++) hautes.push(lire(cle(0, hh)));
  for (let hh = 0; hh <= 6; hh++) hautes.push(lire(cle(1, hh)));
  for (let hh = 19; hh <= 23; hh++) basses.push(lire(cle(-1, hh)));
  for (let hh = 0; hh <= 19; hh++) basses.push(lire(cle(0, hh)));
  const H = hautes.filter(v => v != null), B = basses.filter(v => v != null);
  if (H.length < 12 || B.length < 12) return null;
  return { max: Math.max(...H), min: Math.min(...B) };
}

// Remplace par les valeurs Météo-France quand elles existent (une valeur absente garde celle du modèle global)
const vu = v => v != null && !Number.isNaN(v);
function appliquerMF(x, p) {
  try {
    const c = p.current, d = p.daily, h = p.hourly;
    if (c && vu(c.temperature_2m) && vu(c.weather_code)) {
      x.cur = [r1(c.temperature_2m), vu(c.apparent_temperature) ? r1(c.apparent_temperature) : x.cur[1], c.weather_code,
        vu(c.wind_gusts_10m) ? Math.round(c.wind_gusts_10m) : x.cur[3], vu(c.wind_direction_10m) ? c.wind_direction_10m : x.cur[4]];
    }
    if (d && d.time) d.time.forEach((date, k) => {
      if (k >= JOURS_MF) return;
      const J = x.d.find(j => j[0] === date); if (!J) return;
      if (!vu(d.temperature_2m_max[k]) || !vu(d.temperature_2m_min[k])) return;
      const ex = extremes(h, date) || { max: d.temperature_2m_max[k], min: d.temperature_2m_min[k] };
      // Garde-fou : un écart énorme avec le modèle global signale une donnée incomplète
      if (Math.abs(ex.max - J[2]) > 8 || Math.abs(ex.min - J[3]) > 8) return;
      J[2] = r1(ex.max); J[3] = r1(ex.min);
      if (vu(d.weather_code[k])) J[1] = d.weather_code[k];
      if (vu(d.wind_gusts_10m_max[k])) J[4] = Math.round(d.wind_gusts_10m_max[k]);
      if (vu(d.precipitation_sum[k])) J[6] = r1(d.precipitation_sum[k]);
    });
    if (h && h.time) {
      const pos = {}; h.time.forEach((t, k) => { pos[t] = k; });
      // La quantité de pluie de l'heure vient du même modèle que le temps affiché, pour que l'icône et les millimètres concordent
      const maj = (t, cible, iT, iC, iR, iD, iP) => {
        const k = pos[t]; if (k == null || !vu(h.temperature_2m[k])) return;
        cible[iT] = r1(h.temperature_2m[k]);
        if (vu(h.weather_code[k])) cible[iC] = h.weather_code[k];
        if (vu(h.wind_gusts_10m[k])) cible[iR] = Math.round(h.wind_gusts_10m[k]);
        if (vu(h.wind_direction_10m[k])) cible[iD] = h.wind_direction_10m[k];
        if (h.precipitation && vu(h.precipitation[k])) cible[iP] = r1(h.precipitation[k]);
      };
      for (const e of x.n24) maj(e[0], e, 1, 2, 4, 5, 6);
      x.d.forEach((J, k) => { if (k < JOURS_MF) HEURES.forEach((hh, i) => { const e = x.h[k][i]; if (e && e.length > 1) maj(J[0] + "T" + String(hh).padStart(2, "0") + ":00", e, 0, 1, 3, 4, 5); }); });
    }
    x.mf = 1;
  } catch (e) { console.warn("Météo-France ignoré pour " + x.n + " : " + e.message); }
}

async function previsions(liste) {
  const rates = [];
  for (let i = 0; i < liste.length; i += 25) {
    const lot = liste.slice(i, i + 25);
    if (i > 0) await pause(6000); // on étale les demandes pour rester sous la limite par minute d'Open-Meteo
    try { await traiterLot(lot); }
    catch (e) { console.warn(`Lot ${i / 25 + 1} sans prévisions : ${e.message}`); rates.push([i / 25 + 1, lot]); }
    await pause(1200);
  }
  // Deuxième chance pour les lots en échec (coupure passagère du réseau ou du service)
  for (const [n, lot] of rates) {
    await pause(30000);
    try { await traiterLot(lot); console.log(`Lot ${n} récupéré au second passage`); }
    catch (e) { console.warn(`Lot ${n} toujours sans prévisions : ${e.message}`); }
  }
}
async function traiterLot(lot) {
  {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lot.map(x => x.lat.toFixed(4)).join(",") +
      "&longitude=" + lot.map(x => x.lon.toFixed(4)).join(",") + "&" + PARAMS.toString();
    let rep = await lireJSON(url);
    if (!Array.isArray(rep)) rep = [rep];
    // Météo-France : un bonus, si la demande échoue on garde le modèle global
    let mf = null;
    try {
      const urlMF = "https://api.open-meteo.com/v1/forecast?latitude=" + lot.map(x => x.lat.toFixed(4)).join(",") +
        "&longitude=" + lot.map(x => x.lon.toFixed(4)).join(",") + "&" + PARAMS_MF.toString();
      await pause(3000);
      mf = await lireJSON(urlMF, 2); if (!Array.isArray(mf)) mf = [mf];
    } catch (e) { console.warn("Modèles Météo-France indisponibles pour ce lot : " + e.message); }
    rep.forEach((p, j) => {
      const x = lot[j], d = p.daily, h = p.hourly, c = p.current;
      x.cur = [r1(c.temperature_2m), r1(c.apparent_temperature), c.weather_code, Math.round(c.wind_gusts_10m), c.wind_direction_10m];
      x.d = d.time.map((date, k) => { const ex = extremes(h, date); return [date, d.weather_code[k], r1(ex ? ex.max : d.temperature_2m_max[k]), r1(ex ? ex.min : d.temperature_2m_min[k]),
        Math.round(d.wind_gusts_10m_max[k] ?? 0), d.wind_direction_10m_dominant[k], r1(d.precipitation_sum[k] ?? 0),
        d.precipitation_probability_max[k], r1(d.uv_index_max[k]), r1(d.apparent_temperature_max[k])]; });
      const pos = {}; h.time.forEach((t, k) => { pos[t] = k; });
      // Pour chaque jour : première et dernière heure où l'indice UV atteint 3 (protection conseillée)
      x.d.forEach((jour, k) => {
        const heures = [];
        for (let hh = 6; hh <= 20; hh++) { const i = pos[jour[0] + "T" + String(hh).padStart(2, "0") + ":00"]; if (i != null && (h.uv_index[i] ?? 0) >= 3) heures.push(hh); }
        jour.push(heures.length ? heures[0] : null, heures.length ? heures[heures.length - 1] + 1 : null);
      });
      // Les 24 prochaines heures, à partir de l'heure en cours
      const debut = pos[(c.time || "").slice(0, 13) + ":00"];
      x.n24 = debut == null ? [] : h.time.slice(debut, debut + 24).map((t, k) => {
        const i = debut + k;
        return [t, r1(h.temperature_2m[i]), h.weather_code[i], h.precipitation_probability[i], Math.round(h.wind_gusts_10m[i] ?? 0), h.wind_direction_10m[i], r1(h.precipitation[i] ?? 0)];
      });
      x.h = d.time.map(date => HEURES.map(hh => {
        const k = pos[date + "T" + String(hh).padStart(2, "0") + ":00"];
        return k == null ? [null] : [r1(h.temperature_2m[k]), h.weather_code[k], h.precipitation_probability[k], Math.round(h.wind_gusts_10m[k] ?? 0), h.wind_direction_10m[k], r1(h.precipitation[k] ?? 0)];
      }));
      if (mf && mf[j]) appliquerMF(x, mf[j]);
    });
  }
}

// 3. Qualité de l'air et pollens, un point par secteur (Open-Meteo Air Quality, données CAMS)
const POLLENS = ["alder_pollen", "birch_pollen", "grass_pollen", "mugwort_pollen", "olive_pollen", "ragweed_pollen"];
async function air(liste) {
  const secteurs = [...new Set(liste.map(x => x.s))];
  const pts = secteurs.map(s => { const c = liste.filter(x => x.s === s); return [c.reduce((a, x) => a + x.lat, 0) / c.length, c.reduce((a, x) => a + x.lon, 0) / c.length]; });
  const url = "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + pts.map(p => p[0].toFixed(3)).join(",") + "&longitude=" + pts.map(p => p[1].toFixed(3)).join(",") +
    "&hourly=european_aqi,ozone,pm2_5," + POLLENS.join(",") + "&timezone=Europe%2FParis&forecast_days=5";
  let rep = await lireJSON(url); if (!Array.isArray(rep)) rep = [rep];
  const res = {};
  rep.forEach((p, j) => {
    const h = p.hourly, jours = {};
    h.time.forEach((t, i) => {
      const date = t.slice(0, 10), hh = +t.slice(11, 13);
      if (hh < 8 || hh > 20) return;
      const J = jours[date] ||= { aqi: 0, o3: 0, pm: 0, pol: {} };
      J.aqi = Math.max(J.aqi, h.european_aqi[i] ?? 0); J.o3 = Math.max(J.o3, h.ozone[i] ?? 0); J.pm = Math.max(J.pm, h.pm2_5[i] ?? 0);
      for (const k of POLLENS) J.pol[k.replace("_pollen", "")] = Math.max(J.pol[k.replace("_pollen", "")] || 0, h[k]?.[i] ?? 0);
    });
    res[secteurs[j]] = Object.entries(jours).map(([date, J]) => [date, Math.round(J.aqi), Math.round(J.o3), Math.round(J.pm), Object.fromEntries(Object.entries(J.pol).map(([k, v]) => [k, Math.round(v)]))]);
  });
  return res;
}

// 4. La mer : un point au large pour chaque zone de côte (Open-Meteo Marine)
const MER = {
  "rade de Marseille": { pt: [43.27, 5.31], communes: ["Marseille"] },
  "Cassis": { pt: [43.195, 5.535], communes: ["Cassis", "Roquefort-la-Bédoule"] },
  "La Ciotat": { pt: [43.16, 5.61], communes: ["La Ciotat", "Ceyreste"] },
  "Côte Bleue": { pt: [43.31, 5.17], communes: ["Le Rove", "Ensuès-la-Redonne", "Carry-le-Rouet", "Sausset-les-Pins"] },
  "Carro": { pt: [43.315, 5.03], communes: ["Martigues", "Saint-Mitre-les-Remparts"] },
  "golfe de Fos": { pt: [43.37, 4.93], communes: ["Fos-sur-Mer", "Port-de-Bouc"] },
  "Port-Saint-Louis": { pt: [43.34, 4.86], communes: ["Port-Saint-Louis-du-Rhône"] },
  "Saintes-Maries": { pt: [43.42, 4.43], communes: ["Saintes-Maries-de-la-Mer"] }
};
async function mer() {
  const zones = Object.keys(MER);
  const url = "https://marine-api.open-meteo.com/v1/marine?latitude=" + zones.map(z => MER[z].pt[0]).join(",") + "&longitude=" + zones.map(z => MER[z].pt[1]).join(",") +
    "&daily=wave_height_max&hourly=sea_surface_temperature&timezone=Europe%2FParis&forecast_days=7";
  let rep = await lireJSON(url); if (!Array.isArray(rep)) rep = [rep];
  const res = {}, communes = {};
  rep.forEach((p, j) => {
    const z = zones[j], h = p.hourly, pos = {}; h.time.forEach((t, i) => { pos[t] = i; });
    res[z] = p.daily.time.map((date, k) => { const i = pos[date + "T14:00"]; return [date, i == null ? null : r1(h.sea_surface_temperature[i]), r1(p.daily.wave_height_max[k])]; });
    MER[z].communes.forEach(c => { communes[c] = z; });
  });
  return { zones: res, communes };
}
// 4 bis. Contrôle qualité : aucune donnée douteuse n'est publiée
// Chaque commune est vérifiée à chaque mise à jour ; une commune qui échoue est écartée, et si trop échouent rien n'est publié.
/* CONTROLE-DEBUT */
const CODES_OK = new Set([0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);
const nombre = v => typeof v === "number" && Number.isFinite(v);
function controler(liste, aujourdhui) {
  const rejets = []; let corrections = 0;
  const mediane = t => { const a = t.slice().sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  // 1. Chaque commune, seule
  for (const x of liste) {
    const pb = [];
    if (!x.d || x.d.length < 7) pb.push("moins de 7 jours");
    else {
      if (x.d[0][0] !== aujourdhui) pb.push("premier jour " + x.d[0][0] + " au lieu de " + aujourdhui);
      x.d.forEach((J, k) => {
        const [date, code, max, min, raf, , pl, prob, uv] = J;
        if (!nombre(max) || !nombre(min)) { pb.push(date + " : température absente"); return; }
        if (min > max) pb.push(date + " : minimale " + min + " au-dessus de la maximale " + max);
        if (max < -15 || max > 46 || min < -20 || min > 35) pb.push(date + " : température hors limites (" + min + " / " + max + ")");
        if (!CODES_OK.has(code)) pb.push(date + " : code météo inconnu " + code);
        if (!nombre(raf) || raf < 0 || raf > 220) pb.push(date + " : rafales " + raf);
        if (!nombre(pl) || pl < 0 || pl > 500) pb.push(date + " : pluie " + pl);
        if (prob != null && (prob < 0 || prob > 100)) pb.push(date + " : probabilité " + prob);
        if (uv != null && (uv < 0 || uv > 16)) pb.push(date + " : UV " + uv);
        // Cohérence : la maximale ne peut pas être sous une température prévue entre 7 h et minuit,
        // ni la minimale au-dessus d'une température prévue entre minuit et 19 h (mêmes règles que le calcul)
        const hautes = [], basses = [];
        if (x.h && x.h[k]) x.h[k].forEach((e, i) => { if (e && nombre(e[0])) { hautes.push(e[0]); if (i <= 6) basses.push(e[0]); } });
        if (x.n24) for (const e of x.n24) if (e[0].slice(0, 10) === date && nombre(e[1])) { const hh = +e[0].slice(11, 13); if (hh >= 7) hautes.push(e[1]); if (hh <= 19) basses.push(e[1]); }
        if (hautes.length && basses.length) {
          const hMax = Math.max(...hautes), hMin = Math.min(...basses);
          if (hMax - max > 6 || min - hMin > 6) pb.push(date + " : heures et journée incohérentes (" + hMin + " à " + hMax + " contre " + min + " à " + max + ")");
          else { if (hMax > max) { J[2] = hMax; corrections++; } if (hMin < min) { J[3] = hMin; corrections++; } }
        }
        // Rafales : la rafale maximale du jour ne peut pas être plus faible qu'une rafale prévue heure par heure
        const rafH = [];
        if (x.h && x.h[k]) for (const e of x.h[k]) if (e && nombre(e[3])) rafH.push(e[3]);
        if (x.n24) for (const e of x.n24) if (e[0].slice(0, 10) === date && nombre(e[4])) rafH.push(e[4]);
        if (rafH.length && Math.max(...rafH) > raf) { J[4] = Math.max(...rafH); corrections++; }
      });
      if (!x.n24 || x.n24.length < 12) pb.push("moins de 12 heures à venir");
    }
    if (pb.length) rejets.push({ n: x.n, pb: pb.slice(0, 3) });
  }
  // 2. Chaque commune, comparée à ses voisines du même secteur
  const bonnes = liste.filter(x => !rejets.some(r => r.n === x.n));
  for (const s of new Set(bonnes.map(x => x.s))) {
    const groupe = bonnes.filter(x => x.s === s); if (groupe.length < 4) continue;
    for (let k = 0; k < 3; k++) {
      const mMax = mediane(groupe.map(x => x.d[k][2])), mMin = mediane(groupe.map(x => x.d[k][3]));
      for (const x of groupe) if (Math.abs(x.d[k][2] - mMax) > 8 || Math.abs(x.d[k][3] - mMin) > 9) {
        if (!rejets.some(r => r.n === x.n)) rejets.push({ n: x.n, pb: [x.d[k][0] + " : " + x.d[k][3] + " / " + x.d[k][2] + " trop loin des communes voisines (" + mMin + " / " + mMax + ")"] });
      }
    }
  }
  return { valides: liste.filter(x => !rejets.some(r => r.n === x.n)), rejets, corrections };
}
/* CONTROLE-FIN */
// 4 ter. Vigilances officielles de Météo-France (API « Données Publiques Vigilance »)
// On garde, pour aujourd'hui (J) et demain (J1), la couleur de chaque département suivi et ses phénomènes, avec leurs horaires.
const PHENOMENES = { 1: "vent violent", 2: "pluie-inondation", 3: "orages", 4: "crues", 5: "neige-verglas", 6: "canicule", 7: "grand froid", 8: "avalanches", 9: "vagues-submersion" };
async function vigilance(deps) {
  const cle = (process.env.MF_VIGILANCE_KEY || "").trim().replace(/^Bearer\s+/i, "");
  if (!cle) { console.log("Vigilance : pas de clé MF_VIGILANCE_KEY, étape ignorée."); return null; }
  let rep = null;
  for (let i = 1; i <= 4 && !rep; i++) {
    try {
      const r = await fetch("https://public-api.meteofrance.fr/public/DPVigilance/v1/cartevigilance/encours", { headers: { accept: "application/json", apikey: cle } });
      if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 150));
      rep = await r.json();
      if (!rep || !rep.product || !Array.isArray(rep.product.periods)) { rep = null; throw new Error("réponse vide"); }
    } catch (e) { console.warn(`Vigilance, essai ${i}/4 : ${e.message}`); if (i < 4) await pause(5000 * i); }
  }
  if (!rep) throw new Error("bulletin de vigilance illisible");
  const p = rep.product, res = { maj: p.update_time || null, version: p.version_vigilance || null };
  for (const ech of ["J", "J1"]) {
    const per = p.periods.find(x => String(x.echeance) === ech);
    if (!per) { console.warn("Vigilance : période " + ech + " absente"); continue; }
    const dom = ((per.timelaps || {}).domain_ids) || [];
    const parDep = {};
    const lire = d => (d.phenomenon_items || []).map(it => {
      const c = +it.phenomenon_max_color_id || 1;
      const cren = (it.timelaps_items || []).filter(t => +t.color_id === c);
      return { id: +it.phenomenon_id, nom: PHENOMENES[+it.phenomenon_id] || null, c,
        de: cren.length ? cren.map(t => t.begin_time).sort()[0] : null, a: cren.length ? cren.map(t => t.end_time).sort().slice(-1)[0] : null };
    }).filter(x => x.c >= 2 && x.nom).sort((a, b) => b.c - a.c || a.id - b.id);
    for (const code of deps) {
      const d = dom.find(x => String(x.domain_id) === code);
      if (!d) { console.warn(`Vigilance ${ech} : département ${code} absent du bulletin`); continue; }
      parDep[code] = { c: +d.max_color_id || 1, phen: lire(d) };
      // Le littoral a sa propre zone (code du département + « 10 ») : c'est là que figure « vagues-submersion »
      const lit = dom.find(x => String(x.domain_id) === code + "10");
      if (lit) parDep[code].cote = { c: +lit.max_color_id || 1, phen: lire(lit) };
    }
    res[ech] = { debut: per.begin_validity_time || null, fin: per.end_validity_time || null, deps: parDep };
  }
  if (!res.J) throw new Error("période du jour absente");
  const resume = deps.map(d => d + " : " + ["?", "vert", "jaune", "orange", "rouge"][(res.J.deps[d] || {}).c || 0]).join(", ");
  console.log("Vigilance aujourd'hui → " + resume);
  for (const k of ["J", "J1"]) if (res[k]) console.log(`Vigilance ${k} : du ${res[k].debut} au ${res[k].fin} · 13 : ${JSON.stringify((res[k].deps["13"] || {}).phen || [])} · littoral du 13 : ${JSON.stringify(((res[k].deps["13"] || {}).cote || {}).phen || "absent")}`);
  return res;
}
// Ces données sont un bonus : si elles manquent, le site est quand même publié
async function bonus(nom, f) { try { return await f(); } catch (e) { console.warn(`${nom} indisponible : ${e.message}`); return null; } }


// 6. Vérification de la fiabilité : on compare la prévision faite la veille avec ce qu'ont mesuré
// les stations de Météo-France (données publiques, Licence Ouverte Etalab, data.gouv.fr).
// La prévision de demain est gardée à chaque mise à jour ; la dernière de la journée est celle qu'on juge.
const DATASET_QUOT = "6569b51ae64326786e4e8e1a";
async function lireTexte(url) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 60000);
  const r = await fetch(url, { headers: UA, signal: ctl.signal }); clearTimeout(to);
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  const buf = Buffer.from(await r.arrayBuffer());
  return (url.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
}
async function catalogue() {
  const tous = [];
  for (let page = 1; page <= 20; page++) {
    const cat = await lireJSON(`https://www.data.gouv.fr/api/2/datasets/${DATASET_QUOT}/resources/?page_size=100&page=${page}`, 2);
    tous.push(...(cat.data || []));
    if (!cat.data || cat.data.length < 100) break;
  }
  return tous;
}
// Le lien du fichier « latest » de chaque département est pris dans le catalogue de data.gouv.fr (il peut changer)
let CATALOGUE = null;
async function fichierObs(dep) {
  if (!CATALOGUE) CATALOGUE = await catalogue();
  const res = CATALOGUE.find(r => new RegExp(`Q_${dep}_latest-\\d+-\\d+_RR-T-Vent`).test(r.url));
  if (!res) throw new Error(`fichier des mesures du ${dep} introuvable dans le catalogue`);
  return await lireTexte(res.url);
}
function lireCSV(txt, dates) {
  const lignes = txt.split(/\r?\n/); const tete = lignes[0].split(";").map(t => t.trim());
  const col = n => tete.indexOf(n), iD = col("AAAAMMJJ");
  const out = [];
  for (let i = 1; i < lignes.length; i++) {
    const v = lignes[i].split(";"); if (v.length < tete.length - 2) continue;
    const jour = v[iD]; if (!dates.has(jour)) continue;
    const nb = n => { const k = col(n); if (k < 0 || v[k] === undefined || v[k].trim() === "") return null; const x = parseFloat(v[k].replace(",", ".")); return isNaN(x) ? null : x; };
    out.push({ poste: v[col("NUM_POSTE")], nom: (v[col("NOM_USUEL")] || "").trim(), lat: nb("LAT"), lon: nb("LON"), jour, tx: nb("TX"), tn: nb("TN"), rr: nb("RR"), fxi: nb("FXI") });
  }
  return { tete, out };
}
const distKm = (a, b, c, d) => { const R = 6371, x = (d - b) * Math.PI / 180 * Math.cos((a + c) / 2 * Math.PI / 180), y = (c - a) * Math.PI / 180; return R * Math.hypot(x, y); };
const dateParis = (dec = 0) => new Date(Date.now() + dec * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
// Les mesures heure par heure (température, pluie de l'heure, rafales et leur direction) viennent d'un second jeu de données
let CAT_H = null;
async function urlHoraire(dep) {
  if (!CAT_H) { const ds = await lireJSON("https://www.data.gouv.fr/api/1/datasets/donnees-climatologiques-de-base-horaires/", 2); CAT_H = ds.resources || []; }
  const tous = CAT_H.filter(r => new RegExp(`H_${dep}_`).test(r.url || ""));
  const res = tous.find(r => new RegExp(`H_${dep}_latest[^/]*\\.csv(\\.gz)?$`).test(r.url)) || tous.find(r => /latest/.test(r.url));
  if (!res) throw new Error(`fichier horaire du ${dep} introuvable (${tous.map(r => r.url.split("/").pop()).slice(0, 6).join(", ") || "aucun fichier"})`);
  return res.url;
}
async function verifier(ok, qa) {
  let prec = null;
  try { prec = await lireSite("/data/verif.json", 3); } catch (e) { console.warn("Historique de vérification introuvable (" + e.message + ") : on repart de zéro."); }
  const V = { prev: (prec && prec.prev) || {}, jours: (prec && prec.jours) || [], prevAir: (prec && prec.prevAir) || {}, coordsAir: (prec && prec.coordsAir) || null };
  if (process.env.TEST_MESURES) for (const j of V.jours) console.log(`HIST ${j.date} st=${j.stations} tx=${JSON.stringify(j.tx)} tn=${JSON.stringify(j.tn)} pluie=${JSON.stringify(j.pluie)} icone=${JSON.stringify(j.icone)} hIcone=${JSON.stringify(j.hIcone)} cal=${JSON.stringify(j.cal)} pires=${JSON.stringify((j.pires || []).filter(x => x.rrM != null && (x.rrM >= 0.2 || x.rrP >= 0.5)).map(x => [x.n, x.rrP, x.rrM]))}`);
  const auj = dateParis(0);
  // Garde la prévision de demain (écrasée à chaque mise à jour jusqu'à minuit) : le jour et ses heures
  const dem = {}; let dDem = null;
  for (const x of ok) {
    const J = x.d && x.d[1]; if (!J) continue; dDem = J[0];
    const H = x.h && x.h[1] ? x.h[1].map(e => e && e.length > 1 ? [e[0], e[1], e[2], e[3], e[4], e[5] ?? null] : null) : null;
    dem[x.n] = [J[2], J[3], J[6], J[4], x.lat, x.lon, J[1], J[7], H, x.s, J[9]];
  }
  if (dDem && dDem > auj) V.prev[dDem] = dem;
  // Et la qualité de l'air prévue pour demain, secteur par secteur : [indice, ozone, particules fines]
  if (dDem && dDem > auj && qa) { const A = {}; for (const [sec, L] of Object.entries(qa)) { const e = L.find(x => x[0] === dDem); if (e) A[sec] = [e[1], e[2], e[3]]; } if (Object.keys(A).length) V.prevAir[dDem] = A; }
  // Juge les jours passés qui ont une prévision et pas encore de score
  const faits = new Set(V.jours.map(j => j.date));
  const aJuger = Object.keys(V.prev).filter(d => d < auj && !faits.has(d)).sort();
  if (aJuger.length) {
    const dates = new Set(aJuger.map(d => d.replace(/-/g, "")));
    const mesures = [];
    for (const dep of ["13", "84", "83", "30"]) {
      try { const { tete, out } = lireCSV(await fichierObs(dep), dates); mesures.push(...out); if (dep === "13") console.log("Mesures : colonnes " + tete.slice(0, 14).join(";") + "… ; " + out.length + " lignes du 13 pour " + [...dates].join(", ")); }
      catch (e) { console.warn(`Mesures du ${dep} indisponibles : ${e.message}`); }
    }
    // Mesures horaires : de 0 h à 24 h, heure de Paris, pour chaque jour à juger
    const cles = new Set(); for (const d of aJuger) for (let k = 0; k <= 24; k++) cles.add(cleUTC(d, k));
    const horaires = [];
    for (const dep of ["13", "84"]) {
      try {
        const url = await urlHoraire(dep); const r = await lireHoraire(url, cles, UA); horaires.push(...r.postes);
        console.log(`Mesures horaires du ${dep} : ${url.split("/").pop()} ; ${r.lignes} lignes lues, ${r.gardees} gardées, ${r.postes.length} stations ; colonnes ${r.tete.slice(0, 10).join(";")}…`);
      } catch (e) { console.warn(`Mesures horaires du ${dep} indisponibles : ${e.message}`); }
    }
    for (const d of aJuger) {
      const P = V.prev[d], M = mesures.filter(m => m.jour === d.replace(/-/g, "") && m.lat != null && m.tx != null && m.tn != null);
      if (M.length < 5) { console.log(`Vérification du ${d} : mesures pas encore publiées (${M.length} stations), on réessaiera.`); continue; }
      // Une station compte quand sa journée est presque complète (au moins 20 heures sur 25, de 0 h à 24 h heure de Paris)
      const cd = []; for (let k = 0; k <= 24; k++) cd.push(cleUTC(d, k));
      const Hd = horaires.filter(p => cd.filter(k => p.h[k]).length >= 20);
      // Météo-France publie la journée complète avec 1 à 2 jours de retard : on l'attend jusqu'à 4 jours
      if (Hd.length < 5 && d >= dateParis(-4)) { console.log(`Vérification du ${d} : mesures horaires pas encore publiées (${Hd.length} stations), on réessaiera.`); continue; }
      const res = noterJour(d, P, M, Hd, ciel, HEURES);
      // Qualité de l'air : le fichier du jour des stations AtmoSud (un raté ici n'empêche pas le reste de la vérification)
      if (V.prevAir[d]) await bonus("Air mesuré du " + d, async () => {
        if (!V.coordsAir || !V.coordsAir.date || V.coordsAir.date < dateParis(-30)) {
          const ds = await lireJSON("https://www.data.gouv.fr/api/1/datasets/5b98b648634f415309d52a50/", 2);
          const meta = (ds.resources || []).find(r => /\.xml$/.test(r.url || "") && /Dataset D/i.test(r.title || ""));
          if (meta) { V.coordsAir = { date: auj, st: stationsAir(await lireTexte(meta.url)) }; console.log(`Stations de qualité de l'air : ${Object.keys(V.coordsAir.st).length} positions lues`); }
        }
        const csv = await lireTexte(`https://files.data.gouv.fr/ineris/lcsqa/concentrations-de-polluants-atmospheriques-reglementes/temps-reel/${d.slice(0, 4)}/FR_E2_${d}.csv`);
        const air = noterAir(V.prevAir[d], P, lireAir(csv), (V.coordsAir && V.coordsAir.st) || {});
        if (air) { res.air = air; console.log(`Air du ${d} : niveau juste ${air.niveau[1]}/${air.niveau[0]} secteurs (à un niveau près ${air.niveau[2]}) ; ozone ${air.o3[1]}/${air.o3[0]} (biais ${air.o3[3]}) ; particules ${air.pm[1]}/${air.pm[0]} (biais ${air.pm[3]}) ; ${air.stations} stations`); }
      });
      if (res.stations < 5) { console.log(`Vérification du ${d} : trop peu de stations proches d'une commune (${res.stations}).`); continue; }
      V.jours.push(res);
      console.log(`Vérification du ${d} : ${res.stations} stations (${res.src.q} quotidiennes, ${res.src.h} horaires) ; max ${res.tx[1]}/${res.tx[0]} (écart ${res.tx[2]}°, biais ${res.tx[3]}°) ; min ${res.tn[1]}/${res.tn[0]} (biais ${res.tn[3]}°) ; ` +
        `heures ${res.hT[1]}/${res.hT[0]} (biais ${res.hT[3]}°) ; icône pluie jour ${res.icone[1]}/${res.icone[0]} heures ${res.hIcone[1]}/${res.hIcone[0]} (fausses alertes ${res.hIcone[2]}, oublis ${res.hIcone[3]}) ; ` +
        `rafales ${res.vent[1]}/${res.vent[0]} heures ${res.hRaf[1]}/${res.hRaf[0]} ; mistral prévu ${res.mistral[1]} observé ${res.mistral[2]} commun ${res.mistral[3]} ; calibration ${JSON.stringify(res.cal)}`);
    }
  }
  // On garde 10 jours de prévisions en attente et 90 jours de scores
  for (const d of Object.keys(V.prev).sort().slice(0, -10)) delete V.prev[d];
  for (const d of Object.keys(V.prev)) if (d < dateParis(-9)) delete V.prev[d];
  for (const d of Object.keys(V.prevAir)) if (d < dateParis(-9) || !V.prev[d] && d <= auj) delete V.prevAir[d];
  V.jours = V.jours.sort((a, b) => a.date < b.date ? -1 : 1).slice(-90);
  await writeFile("site/data/verif.json", JSON.stringify({ maj: new Date().toISOString(), ...V }));
  return V.jours.slice(-30);
}


// 7. Une page par commune, lisible par Google (« météo Trets », « météo Cassis »...), plus une page qui les liste toutes.
// Les pages sont refaites à chaque mise à jour ; le bouton ouvre l'app directement sur la commune.
const SITE = "https://lameteodeleo.fr";
const NOMS_SECTEURS = { mc: "Marseille & alentours", aix: "Pays d'Aix", berre: "Étang de Berre", salon: "Salon & Alpilles", arles: "Arles & Camargue", voisins: "Voisins du 13" };
const slug = n => norm(n).replace(/ /g, "-");
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Même règle que l'app : la pluie n'est annoncée que si elle est probable (50 % et plus) et mesurable
function ciel(code, prob, pl) {
  const precip = (code >= 51 && code <= 67) || (code >= 71 && code <= 86) || code >= 95;
  const fort = [63, 65, 67, 73, 75, 81, 82, 95, 96, 99].includes(code) || pl >= 5;
  // Même règle que l'app : pluie dès 50 % et 0,5 mm, pluie faible dès 60 % et 0,1 mm, sinon nuageux
  if (precip && !fort && ((prob != null && prob < 50) || pl < 0.5)) {
    if (prob != null && prob >= 60 && pl >= 0.1) return (code >= 71 && code <= 86) ? "Neige" : "Pluie faible";
    code = 3;
  } else if (!precip && code !== 45 && code !== 48 && prob != null && prob >= 50 && pl >= 0.5) return pl >= 15 ? "Forte pluie" : "Pluie";
  else if (!precip && prob != null && prob >= 60 && pl >= 0.1) return "Pluie faible";
  if (code <= 1) return "Ensoleillé"; if (code === 2) return "Éclaircies"; if (code === 3) return "Nuageux";
  if (code === 45 || code === 48) return "Brouillard"; if (code >= 95) return "Orages";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "Neige";
  if ([56, 57, 66, 67].includes(code)) return "Pluie verglaçante";
  if (pl >= 15 || [65, 82].includes(code)) return "Forte pluie";
  if (code >= 80) return "Averses"; if (code <= 55) return "Pluie faible"; return "Pluie";
}
// ===== Ciel du jour et des heures : copie exacte des règles de l'app (index.html), pour que les pages communes
// affichent toujours le même mot et la même icône que l'app. Toute modification de ces règles dans l'app doit être reportée ici.
const PRECIPC = k => (k >= 51 && k <= 67) || (k >= 71 && k <= 77) || (k >= 80 && k <= 86) || k >= 95;
const NEIGEC = k => (k >= 71 && k <= 77) || k === 85 || k === 86;
function codeFiable(code, prob, pl) {
  const q = pl == null ? null : pl, p = prob == null ? null : prob;
  if (PRECIPC(code) && ([63, 65, 67, 73, 75, 81, 82, 95, 96, 99].includes(code) || (q != null && q >= 5))) return code;
  if (PRECIPC(code) && (p == null || p >= 50) && (q == null || q >= 0.5)) return code;
  if (!PRECIPC(code) && code !== 45 && code !== 48 && p != null && p >= 50 && q != null && q >= 0.5) return 61;
  if (p != null && p >= 60 && (q != null ? q >= 0.1 : PRECIPC(code))) return NEIGEC(code) ? 71 : [56, 57, 66, 67].includes(code) ? 56 : 51;
  return PRECIPC(code) ? 3 : code;
}
function classer(code, raf, dirDeg, tmax, tmin) {
  let t = code <= 1 ? "soleil" : code <= 3 ? "nuageux" : (code === 45 || code === 48) ? "brouillard" : (code >= 71 && code <= 77) || code === 85 || code === 86 ? "neige" : code >= 95 ? "orage" : (code >= 51 && code <= 67) || (code >= 80 && code <= 82) ? "pluie" : "nuageux";
  if (t === "soleil" || t === "nuageux") {
    const nord = dirDeg != null && (dirDeg >= 290 || dirDeg <= 20);
    if (raf >= 40 && nord) t = "mistral"; else if (raf >= 55) t = "vent";
    else if (tmax >= 33) t = "chaleur"; else if (tmin <= 0) t = "gel";
  }
  return t;
}
function variante(code, type, nuit) {
  if ((type === "nuageux" || type === "nuitNuageux") && code === 3) return "couvert";
  if (type !== "pluie") return type;
  if ([56, 57, 66, 67].includes(code)) return "verglas";
  if ([63, 65, 82].includes(code)) return "pluieForte";
  if (code >= 80 && code <= 81) return nuit ? "pluie" : "averses";
  if (code >= 51 && code <= 55) return "bruine";
  return "pluie";
}
const versNuit = t => t === "soleil" ? "lune" : t === "nuageux" ? "nuitNuageux" : t;
const LIB_APP = { lune: "Nuit claire", nuitNuageux: "Nuit nuageuse", soleil: "Ensoleillé", nuageux: "Éclaircies", mistral: "Mistral", vent: "Vent fort", pluie: "Pluie", gel: "Gelée matinale", brouillard: "Brouillard", neige: "Neige", chaleur: "Très chaud", orage: "Orages", couvert: "Couvert", averses: "Averses", pluieForte: "Forte pluie", bruine: "Pluie faible", verglas: "Pluie verglaçante" };
// Le jour, comme reel() dans l'app : D = [date, code, max, min, raf, dir, pl, prob, …], H = heures de 7 h à 21 h
function jourApp(D, H) {
  const [, code, max, min, raf, dir, pl, prob] = D;
  let codeOK = codeFiable(code, prob, pl == null ? 0 : pl);
  const PRECIP = k => (k >= 51 && k <= 67) || (k >= 71 && k <= 86) || k >= 95; let plNuit = false;
  if (PRECIP(codeOK) && H) { const jj = H.slice(0, 7).filter(e => e && e[1] != null);
    if (jj.length >= 5 && !jj.some(e => PRECIP(codeFiable(e[1], e[2], e[5]))) && Math.max(...jj.map(e => e[2] || 0)) < 50) {
      const v = H.slice(1, 6).filter(e => e && e[1] != null).map(e => e[1]), nb = c => c <= 1 ? 0 : c === 2 ? .5 : 1, mo = v.length ? v.reduce((a, c) => a + nb(c), 0) / v.length : 1;
      codeOK = mo <= .65 ? 2 : 3; plNuit = true; } }
  const type = classer(codeOK, raf, dir, max, min); let ico = type;
  if (type === "nuageux") { const jj = H ? H.slice(0, 7).filter(e => e && e[1] != null) : [];
    if (jj.length >= 5 && jj.filter(e => e[1] === 3).length >= Math.ceil(jj.length * .7)) ico = "couvert"; }
  else if (type === "pluie") ico = pl >= 15 ? "pluieForte" : variante(codeOK === 63 || codeOK === 65 ? 61 : codeOK, type, false);
  return { type, ico, lib: LIB_APP[ico], plNuit };
}
// Une heure, comme prochainesHeures() dans l'app
function heureApp(code, prob, mm, raf, dir, temp, nuit) {
  const cf = codeFiable(code, prob, mm); let type = classer(cf, raf, dir, temp, temp); if (nuit) type = versNuit(type);
  return variante(cf, type, nuit);
}
// Icônes météo des pages communes (même code couleur que l'app)
const SOLEIL = `<circle cx="24" cy="24" r="9" fill="#FFC21A"/><g stroke="#FFC21A" stroke-width="3.2" stroke-linecap="round"><path d="M24 5v5M24 38v5M5 24h5M38 24h5M10.6 10.6l3.5 3.5M33.9 33.9l3.5 3.5M10.6 37.4l3.5-3.5M33.9 14.1l3.5-3.5"/></g>`;
const NUAGE = (c = "#E6E2FA") => `<path d="M15 40h20a8.5 8.5 0 0 0 1.2-16.9A11 11 0 0 0 15.4 26 7 7 0 0 0 15 40z" fill="${c}" stroke="#B9B0EA" stroke-width="1.5"/>`;
const GOUTTES = (n = 3) => `<g stroke="#4DA3FF" stroke-width="3" stroke-linecap="round">${[[18, 0], [26, 1], [34, 0]].slice(0, n).map(([x, d]) => `<path d="M${x} ${43 + d * 2}l-2 5"/>`).join("")}</g>`;
const LUNE = `<path d="M30 8a15 15 0 1 0 12 22A12 12 0 0 1 30 8z" fill="#FFE08A"/>`;
// Lever et coucher du soleil (heure locale, à quelques minutes près), pour afficher la lune la nuit
function soleilJour(lat, lon, date) {
  const d = new Date(date + "T12:00:00Z"), doy = Math.round((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5), r = Math.PI / 180;
  const decl = 23.44 * Math.sin(2 * Math.PI * (284 + doy) / 365) * r, B = 2 * Math.PI * (doy - 81) / 364;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const tz = +new Date(date + "T12:00:00Z").toLocaleString("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }) - 12;
  const midi = 12 - lon / 15 - eot / 60 + tz, H = Math.acos(Math.max(-1, Math.min(1, (Math.sin(-0.833 * r) - Math.sin(lat * r) * Math.sin(decl)) / (Math.cos(lat * r) * Math.cos(decl))))) / r / 15;
  return [midi - H, midi + H];
}
function icone(lib, t = 40, nuit = false) {
  const l = lib.toLowerCase(); let g;
  if (l.startsWith("ensoleill")) g = nuit ? LUNE : SOLEIL;
  else if (l.startsWith("éclaircies")) g = (nuit ? `<g transform="translate(4 -4) scale(.8)">${LUNE}</g>` : `<g transform="translate(1 1) scale(.72)">${SOLEIL}</g>`) + NUAGE();
  else if (l.startsWith("brouillard")) g = `<g stroke="#B9B0EA" stroke-width="3.2" stroke-linecap="round"><path d="M9 18h30M6 25h36M9 32h30M13 39h22"/></g>`;
  else if (l.startsWith("orage")) g = `<g transform="translate(0 -8)">${NUAGE("#CFC8F2")}</g><path d="M25 32l-6 9h6l-3 8 9-11h-6l3-6z" fill="#FFC21A"/>`;
  else if (l.startsWith("neige")) g = `<g transform="translate(0 -8)">${NUAGE()}</g><g fill="#9FD0FF"><circle cx="18" cy="42" r="2.4"/><circle cx="26" cy="45" r="2.4"/><circle cx="34" cy="42" r="2.4"/></g>`;
  else if (l.includes("pluie") || l.startsWith("averses")) g = `<g transform="translate(0 -8)">${NUAGE(l.startsWith("forte") ? "#CFC8F2" : "#E6E2FA")}</g>` + GOUTTES(l.endsWith("faible") ? 2 : 3);
  else g = NUAGE();
  return `<svg class="ico" width="${t}" height="${t}" viewBox="0 0 48 52" aria-hidden="true">${g}</svg>`;
}
// Icône à partir du type de l'app (mêmes catégories que l'app : ensoleillé, éclaircies, couvert, mistral, averses…)
const VENT = `<g stroke="#B9B0EA" stroke-width="3.6" stroke-linecap="round" fill="none"><path d="M6 19h22a6 6 0 1 0-6-6M6 29h30a6 6 0 1 1-6 6M6 39h14"/></g>`;
const FLOCON = `<g stroke="#9FD0FF" stroke-width="3.2" stroke-linecap="round"><path d="M24 8v36M8.4 17l31.2 18M8.4 35l31.2-18"/></g>`;
function iconeK(k, t = 40) {
  const sol = `<g transform="translate(1 1) scale(.72)">${SOLEIL}</g>`, lun = `<g transform="translate(4 -4) scale(.8)">${LUNE}</g>`;
  const G = {
    soleil: SOLEIL, lune: LUNE, chaleur: SOLEIL, nuageux: sol + NUAGE(), nuitNuageux: lun + NUAGE(), couvert: NUAGE("#CFC8F2"),
    mistral: VENT, vent: VENT, gel: FLOCON,
    brouillard: `<g stroke="#B9B0EA" stroke-width="3.2" stroke-linecap="round"><path d="M9 18h30M6 25h36M9 32h30M13 39h22"/></g>`,
    orage: `<g transform="translate(0 -8)">${NUAGE("#CFC8F2")}</g><path d="M25 32l-6 9h6l-3 8 9-11h-6l3-6z" fill="#FFC21A"/>`,
    neige: `<g transform="translate(0 -8)">${NUAGE()}</g><g fill="#9FD0FF"><circle cx="18" cy="42" r="2.4"/><circle cx="26" cy="45" r="2.4"/><circle cx="34" cy="42" r="2.4"/></g>`,
    pluie: `<g transform="translate(0 -8)">${NUAGE()}</g>` + GOUTTES(3), bruine: `<g transform="translate(0 -8)">${NUAGE()}</g>` + GOUTTES(2),
    pluieForte: `<g transform="translate(0 -8)">${NUAGE("#CFC8F2")}</g>` + GOUTTES(3), verglas: `<g transform="translate(0 -8)">${NUAGE()}</g>` + GOUTTES(2),
    averses: `<g transform="translate(1 -6) scale(.6)">${SOLEIL}</g><g transform="translate(0 -8)">${NUAGE()}</g>` + GOUTTES(2)
  };
  return `<svg class="ico" width="${t}" height="${t}" viewBox="0 0 48 52" aria-hidden="true">${G[k] || NUAGE()}</svg>`;
}
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
const GOUTTE = `<svg viewBox="0 0 8 10" aria-hidden="true"><path d="M4 0C2.7 2.2 0 4.6 0 6.4A4 4 0 0 0 8 6.4C8 4.6 5.3 2.2 4 0z" fill="currentColor"/></svg>`;
const mistral = (raf, dir) => raf >= 40 && dir != null && (dir >= 290 || dir <= 20);
const dirTxt = d => d == null ? "" : ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"][Math.round(((d % 360) + 360) % 360 / 45) % 8];
const jourJ = (x, k) => jourApp(x.d[k], x.h && x.h[k]);
const deC = n => /^Le /.test(n) ? n.replace(/^Le /, "du ") : /^Les /.test(n) ? n.replace(/^Les /, "des ") : /^La /.test(n) ? "de " + n.replace(/^La /, "la ") : /^[AEIOUYÉÈÊÂÎÔHaeiouyéèh]/.test(n) ? "d'" + n : "de " + n;
const article = n => /^(Le|La|Les) /.test(n) ? n.replace(/^Le /, "au ").replace(/^Les /, "aux ").replace(/^La /, "à la ") : "à " + n;
const STYLE = `:root{--bg:#F4F2FB;--card:#fff;--ink:#1B1640;--muted:#655F86;--brand:#4B3BB8;--sun:#FFC21A;--line:#ECE9F8;--froid:#4DA3FF;--chaud:#FF9A3D;--auj:#F3F0FF}
@media (prefers-color-scheme:dark){:root{--bg:#100E24;--card:#1C1838;--ink:#F2F0FF;--muted:#A7A1CC;--brand:#A99FF5;--line:#2C2750;--auj:#26214A}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:20px 16px 40px}a{color:var(--brand)}
.top{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink);font-weight:800;font-size:1.1rem}.top img{width:36px;height:36px;border-radius:9px}.top em{font-style:normal;color:#E0A400}
h1{font-size:1.65rem;line-height:1.2;margin:22px 0 4px;letter-spacing:-.01em}.sub{color:var(--muted);font-size:.88rem;margin:0}
.hero{position:relative;overflow:hidden;background:radial-gradient(circle at 85% 0%,rgba(255,194,26,.28),transparent 45%),linear-gradient(140deg,#5B4BD0,#3A2C9E);color:#fff;border-radius:24px;padding:20px 20px 22px;margin:18px 0;box-shadow:0 12px 30px rgba(59,44,158,.25)}
.hero .q{font-size:.85rem;font-weight:600;opacity:.85;text-transform:uppercase;letter-spacing:.05em}
.hero .l1{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:4px}
.hero .t{font-size:4rem;font-weight:800;line-height:1;letter-spacing:-.03em}.hero .t small{font-size:1rem;font-weight:600;opacity:.8;letter-spacing:0;margin-left:6px}
.hero .ico{width:84px;height:84px;flex:none;filter:drop-shadow(0 4px 10px rgba(0,0,0,.18))}
.hero .lib{font-size:1.25rem;font-weight:800;margin:6px 0 0}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.chips span{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:5px 12px;font-size:.88rem;font-weight:600}
.btn{display:inline-block;margin-top:16px;background:var(--sun);color:#1B1640;font-weight:800;text-decoration:none;padding:13px 20px;border-radius:999px;box-shadow:0 6px 16px rgba(0,0,0,.18)}
.jours{background:var(--card);border-radius:20px;padding:4px 14px;box-shadow:0 2px 10px rgba(27,22,64,.05)}
.j{display:grid;grid-template-columns:78px 52px 50px 1fr;align-items:center;column-gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}.j:last-child{border-bottom:0}
.j.tete{padding:10px 0 8px;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);line-height:1.15}.j.tete span{text-align:center}.j.tete small{display:block;text-transform:none;letter-spacing:0;font-weight:600;font-size:.68rem;opacity:.8}
.j.auj{background:var(--auj);border-radius:14px;margin:4px -8px;padding:11px 8px;border-bottom-color:transparent}.j.auj+.j{border-top:0}
.j .d{font-weight:700;line-height:1.2}.j .d span{display:block;font-weight:400;color:var(--muted);font-size:.8rem}
.ci,.ve{display:flex;flex-direction:column;align-items:center;line-height:1.1}.ci .ico{width:34px;height:34px}.ci em,.ve em{font-style:normal;font-size:.72rem;font-weight:700}.ci em{display:flex;align-items:center;gap:2px;color:#2F86E8;margin-top:1px;white-space:nowrap}.ci em svg{width:8px;height:10px;flex:none}
.ve span{display:flex;align-items:center;gap:3px;font-weight:700;font-size:1.02rem;font-variant-numeric:tabular-nums}.ve .fl{width:12px;height:12px;color:var(--muted)}
.ve.mis span,.ve.mis .fl{color:#0E9AA7}.ve.mis em{margin-top:2px;background:rgba(14,154,167,.12);color:#0E9AA7;border-radius:999px;padding:1px 6px;font-size:.66rem;font-weight:800}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.tp{display:flex;align-items:center;gap:7px;font-variant-numeric:tabular-nums;font-size:.95rem}.tp .mn{color:var(--muted);width:2.1em;text-align:right;flex:none}.tp .mx{font-weight:800;width:2.1em;flex:none}
.bar{position:relative;flex:1;min-width:30px;height:6px;border-radius:9px;background:var(--line)}.bar i{position:absolute;top:0;bottom:0;border-radius:9px;background:linear-gradient(90deg,var(--froid),var(--chaud))}
.bar .cur{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:#fff;border:3px solid var(--brand);box-shadow:0 1px 4px rgba(0,0,0,.25)}
@media (max-width:370px){.j{grid-template-columns:70px 46px 44px 1fr;column-gap:7px}.j .d{font-size:.9rem}.jours{padding:4px 12px}.tp{gap:5px;font-size:.9rem}}
h2{font-size:1.15rem;margin:28px 0 10px}
.fil{font-size:.8rem;color:var(--muted);margin:18px 0 0}.fil a{color:var(--muted);text-decoration:none}.fil a:hover{text-decoration:underline}
.vig{display:flex;gap:12px;align-items:flex-start;border-radius:18px;padding:14px 16px;margin:16px 0 0;text-decoration:none;font-weight:600;line-height:1.35}
.vig b{display:block;font-size:1.02rem}.vig span{font-weight:500;font-size:.88rem}.vig i{font-style:normal;font-size:1.4rem;line-height:1}
.vig.c2{background:#FFF3B0;color:#3D3300}.vig.c3{background:#FF8A00;color:#2A1600}.vig.c4{background:#E0201B;color:#fff}
.deux{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.jc{background:var(--card);border-radius:18px;padding:13px 14px 12px;box-shadow:0 2px 10px rgba(27,22,64,.05);min-width:0}
.jc h3{font-size:.74rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--brand);margin:0}.jc h3 span{display:block;color:var(--muted);font-weight:600;text-transform:none;letter-spacing:0;font-size:.8rem;margin-top:1px}
.jc .jl{display:flex;align-items:center;gap:8px;margin-top:6px}.jc .jl .ico{width:42px;height:42px;flex:none}
.jc .lb{font-weight:800;line-height:1.2;min-width:0}.jc .tt{display:flex;gap:14px;margin-top:8px;font-size:.84rem;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}.jc .tt b{color:var(--ink);font-size:1.15rem;font-weight:800;margin-left:3px}
.jc ul{list-style:none;margin:10px 0 0;padding:9px 0 0;border-top:1px solid var(--line);display:grid;gap:5px;font-size:.82rem;font-weight:600}
.jc li{display:flex;align-items:center;gap:6px;line-height:1.25}.jc li svg{width:14px;height:14px;flex:none}.jc li.pl{color:#2F86E8}.jc li.vt svg{color:var(--muted)}.jc li.mis{color:#0E9AA7}.jc li.mis svg{color:#0E9AA7}
@media (max-width:370px){.jc{padding:12px 11px 11px}.jc .jl .ico{width:36px;height:36px}.jc ul{font-size:.78rem}}
.hs{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;padding:2px 2px 8px;margin:0 -2px;-webkit-overflow-scrolling:touch;scrollbar-width:thin}
.h{flex:none;scroll-snap-align:start;width:64px;background:var(--card);border-radius:16px;padding:10px 4px 9px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:3px;font-variant-numeric:tabular-nums}
.h .hh{font-size:.78rem;color:var(--muted);font-weight:600}.h .ico{width:34px;height:34px}.h b{font-size:1rem}.h .p{font-size:.72rem;color:#2F86E8;font-weight:700;min-height:1em}
.h.now{background:#4B3BB8;color:#fff}.h.now .hh{color:rgba(255,255,255,.85)}.h.now .p{color:#BFE0FF}
.app{display:flex;gap:14px;align-items:center;background:var(--card);border-radius:20px;padding:16px;margin-top:14px;border:1px solid var(--line)}
.app img{width:56px;height:56px;border-radius:14px;flex:none}.app p{margin:0;font-size:.9rem;color:var(--muted)}.app b{display:block;color:var(--ink);font-size:1rem;margin-bottom:2px}
.app a{display:inline-block;margin-top:8px;font-weight:800;text-decoration:none;color:var(--brand)}
.anec{background:var(--card);border-radius:18px;padding:14px 16px;margin:0 0 10px;border-left:4px solid var(--sun)}
.liens{display:flex;flex-wrap:wrap;gap:8px}.liens a{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 12px;text-decoration:none;font-size:.88rem}
.suivez{text-align:center;background:var(--card);border-radius:20px;padding:18px 16px;margin-top:26px;border:1px solid var(--line)}.suivez b{font-size:1.05rem;display:block;margin-bottom:12px}.suivez p{margin:4px 0 12px;color:var(--muted);font-size:.9rem}.suivez div{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}.suivez a{color:#fff;font-weight:800;text-decoration:none;padding:10px 20px;border-radius:999px}.suivez .ig{background:linear-gradient(45deg,#F58529,#DD2A7B 55%,#8134AF)}.suivez .fb{background:#1877F2}
footer{color:var(--muted);font-size:.78rem;margin-top:30px;line-height:1.5}`;
function page({ titre, desc, url, corps }) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cloud.umami.is; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://cloud.umami.is https://api-gateway.umami.dev; object-src 'none'; base-uri 'self'; form-action 'self'"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titre)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${url}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(titre)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${url}"><meta property="og:image" content="${SITE}/icons/partage-v2.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="La météo de Léo"><meta property="og:locale" content="fr_FR">
<meta name="theme-color" content="#4B3BB8"><link rel="icon" href="/icons/icon-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${STYLE}</style>
<script defer src="https://cloud.umami.is/script.js" data-website-id="a3212f59-b8e9-486f-9e0f-d7256926be65" data-domains="lameteodeleo.fr"></script>
</head><body><main><a class="top" href="/"><img src="/icons/icon-192.png" alt=""><span>La météo <em>de Léo</em></span></a>${corps}
<footer>La météo de Léo : la météo des Bouches-du-Rhône, commune par commune. Prévisions des modèles AROME et ARPEGE de Météo-France, mises à jour toutes les 2 heures. Vigilances officielles : <a href="https://vigilance.meteofrance.fr/fr">vigilance.meteofrance.fr</a>. Données météo : Open-Meteo, licence CC BY 4.0. <a href="/#apropos">À propos et mentions légales</a>.</footer>
</main><script>try{const n=new Date().toLocaleString("sv-SE",{timeZone:"Europe/Paris"}).replace(" ","T").slice(0,13);const L=[...document.querySelectorAll(".h[data-t]")];const v=L.filter(e=>e.dataset.t>=n);if(v.length&&v.length<L.length){L.forEach(e=>{if(e.dataset.t<n)e.remove()});L.forEach(e=>e.classList.remove("now"));v[0].classList.add("now");v[0].querySelector(".hh").textContent="Maint."}if(v.length){const h=v[0],mt=document.getElementById("mt"),mi=document.getElementById("mi"),ml=document.getElementById("ml");if(mt&&h.querySelector("b"))mt.textContent=h.querySelector("b").textContent;if(mi){const g=h.querySelector("svg").cloneNode(true);g.setAttribute("width","84");g.setAttribute("height","84");mi.replaceChildren(g)}if(ml&&h.dataset.l)ml.textContent=h.dataset.l}const c=document.querySelector(".bar .cur"),t=v[0]&&v[0].querySelector("b");if(c&&t){const T=parseFloat(t.textContent);c.style.left=Math.max(0,Math.min(100,(T-c.dataset.bas)/c.dataset.et*100))+"%";c.title="Maintenant "+T+"°"}}catch(e){}</script></body></html>`;
}
async function pagesCommunes(ok, vig) {
  let ANEC = {};
  try { ANEC = JSON.parse(await (await import("node:fs/promises")).readFile("scripts/anecdotes-communes.json", "utf8")); } catch (e) { console.warn("Anecdotes des communes illisibles : " + e.message); }
  const maj = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).replace(":", " h ");
  const jourTxt = d => new Date(d + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const urls = [`${SITE}/`, `${SITE}/meteo/`];
  for (const x of ok) {
    const sl = slug(x.n), url = `${SITE}/meteo/${sl}/`, J = x.d[0];
    const dep = x.dep === "13" ? "Bouches-du-Rhône" : x.dep === "84" ? "Vaucluse" : x.dep === "83" ? "Var" : "";
    const j0 = jourJ(x, 0), lib0 = j0.lib;
    const S7 = x.d.slice(0, 7), bas = Math.min(...S7.map(D => D[3])), haut = Math.max(...S7.map(D => D[2])), et = Math.max(1, haut - bas);
    const t0 = (x.n24 || []).find(e => e && e[1] != null), pos = v => Math.max(0, Math.min(100, Math.round((v - bas) / et * 100)));
    const lignes = S7.map((D, k) => { const jj = jourJ(x, k), lb = jj.lib, mis = mistral(D[4], D[5]);
      const fl = D[5] != null ? `<svg class="fl" viewBox="0 0 12 12" style="transform:rotate(${Math.round(D[5] + 180)}deg)" aria-hidden="true"><path d="M6 1l3.5 9L6 8 2.5 10z" fill="currentColor"/></svg>` : "";
      const cur = k === 0 && t0 ? `<b class="cur" data-bas="${bas}" data-et="${et}" style="left:${pos(t0[1])}%" title="Maintenant ${Math.round(t0[1])}°"></b>` : "";
      return `<div class="j${k === 0 ? " auj" : ""}"><div class="d">${k === 0 ? "Aujourd'hui" : k === 1 ? "Demain" : cap(jourTxt(D[0]).split(" ")[0])}<span>${new Date(D[0] + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</span></div>` +
        `<div class="ci" title="${lb}">${iconeK(jj.ico, 34)}<span class="sr">${lb}</span>${jj.plNuit ? `<em>${GOUTTE}la nuit</em>` : D[6] >= 0.5 ? `<em>${GOUTTE}${String(D[6]).replace(".", ",")} mm</em>` : ""}</div>` +
        `<div class="ve${mis ? " mis" : ""}"><span>${fl}${Math.round(D[4])}</span>${mis ? "<em>mistral</em>" : ""}</div>` +
        `<div class="tp"><span class="mn">${Math.round(D[3])}°</span><span class="bar"><i style="left:${pos(D[3])}%;right:${100 - pos(D[2])}%"></i>${cur}</span><span class="mx">${Math.round(D[2])}°</span></div></div>`; }).join("");
    const voisines = ok.filter(o => o.s === x.s && o.n !== x.n).sort((a, b) => Math.hypot(a.lat - x.lat, a.lon - x.lon) - Math.hypot(b.lat - x.lat, b.lon - x.lon)).slice(0, 8);
    // Vigilance Météo-France du département (et du littoral pour les communes au bord de la mer)
    let vigB = "";
    { const V = vig && vig.J && vig.J.deps ? vig.J.deps[x.dep] : null;
      if (V) { const zones = [V, x.cote && V.cote ? V.cote : null].filter(Boolean), c = Math.max(...zones.map(z => z.c || 1));
        const phen = [...new Set(zones.flatMap(z => z.phen.filter(p => p.c === c).map(p => p.nom)))];
        if (c >= 2) vigB = `<a class="vig c${c}" href="/?commune=${encodeURIComponent(x.n)}"><i>⚠️</i><div><b>Vigilance ${["", "", "jaune", "orange", "rouge"][c]}${phen.length ? " · " + phen.join(", ") : ""}</b><span>${c >= 3 ? "Suivez les consignes de sécurité. Détails et horaires dans l'app." : "Soyez attentif. Détails et horaires dans l'app."}</span></div></a>`; } }
    // Les prochaines heures (masquées automatiquement une fois passées)
    const n24 = (x.n24 || []).filter(e => e && e[1] != null);
    const sj = {}, nuitA = t => { const dj = t.slice(0, 10); sj[dj] = sj[dj] || soleilJour(x.lat, x.lon, dj); const hh = +t.slice(11, 13) + .5; return hh < sj[dj][0] || hh > sj[dj][1]; };
    const heures = n24.map((e, k) => { const ik = heureApp(e[2], e[3], e[6], e[4], e[5], e[1], nuitA(e[0]));
      return `<div class="h${k === 0 ? " now" : ""}" data-t="${e[0].slice(0, 13)}" data-l="${LIB_APP[ik] || ""}"><span class="hh">${k === 0 ? "Maint." : +e[0].slice(11, 13) + " h"}</span>${iconeK(ik, 34)}<b>${Math.round(e[1])}°</b><span class="p">${e[6] >= 0.1 ? String(e[6]).replace(".", ",") + " mm" : ""}</span></div>`; }).join("");
    // Aujourd'hui et demain : deux cartes claires (ciel, températures, pluie, vent)
    const VENTI = `<svg viewBox="0 0 48 48" aria-hidden="true"><g stroke="currentColor" stroke-width="4.5" stroke-linecap="round" fill="none"><path d="M6 18h24a6 6 0 1 0-6-6"/><path d="M6 27h32a6 6 0 1 1-6 6"/><path d="M6 36h14"/></g></svg>`;
    const GOUTTEI = `<svg viewBox="0 0 8 10" aria-hidden="true"><path d="M4 0C2.7 2.2 0 4.6 0 6.4A4 4 0 0 0 8 6.4C8 4.6 5.3 2.2 4 0z" fill="currentColor"/></svg>`;
    const carte = (D, k) => { if (!D) return ""; const jj = jourJ(x, k), mis = mistral(D[4], D[5]);
      const pl = jj.plNuit && D[6] >= 0.1 ? "Pluie la nuit" : D[6] >= 0.5 ? `Pluie ${String(D[6]).replace(".", ",")} mm` : "";
      const vt = `Rafales ${Math.round(D[4])} km/h${mis ? " · mistral" : ""}`;
      return `<section class="jc"><h3>${k === 0 ? "Aujourd'hui" : "Demain"}<span>${new Date(D[0] + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })}</span></h3>` +
        `<div class="jl">${iconeK(jj.ico, 42)}<span class="lb">${jj.lib}</span></div><div class="tt"><span>Min<b>${Math.round(D[3])}°</b></span><span>Max<b>${Math.round(D[2])}°</b></span></div>` +
        `<ul>${pl ? `<li class="pl">${GOUTTEI}${pl}</li>` : ""}<li class="vt${mis ? " mis" : ""}">${VENTI}${vt}</li></ul></section>`; };
    const D1 = x.d[1];
    const deuxJours = `<div class="deux">${carte(J, 0)}${carte(D1, 1)}</div>`;
    const fil = `<nav class="fil" aria-label="Fil d'Ariane"><a href="/">Accueil</a> › <a href="/meteo/">Météo du 13</a> › ${esc(NOMS_SECTEURS[x.s] || "")} › ${esc(x.n)}</nav>`;
    const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [["Accueil", SITE + "/"], ["Météo du 13", SITE + "/meteo/"], [x.n, url]].map(([name, item], k) => ({ "@type": "ListItem", position: k + 1, name, item })) });
    const titre = `Météo ${x.n} : prévisions heure par heure et à 7 jours`;
    const desc = `Météo ${article(x.n)} aujourd'hui : ${lib0.toLowerCase()}, ${Math.round(J[3])}° à ${Math.round(J[2])}°, rafales ${Math.round(J[4])} km/h. Prévisions Météo-France sur 7 jours, mises à jour toutes les 2 heures.`;
    const corps = `${fil}<script type="application/ld+json">${ld}</script><h1>Météo ${article(x.n)}</h1><p class="sub">${esc(dep)}${dep ? " · " : ""}${NOMS_SECTEURS[x.s] || ""} · mis à jour ${maj}</p>${vigB}
<div class="hero">${(() => { const e0 = n24[0], ik0 = e0 ? heureApp(e0[2], e0[3], e0[6], e0[4], e0[5], e0[1], nuitA(e0[0])) : j0.ico, t0 = e0 ? Math.round(e0[1]) : Math.round(J[2]);
  return `<div class="q">Maintenant · ${cap(jourTxt(J[0]))}</div><div class="l1"><div class="t" id="mt">${t0}°</div><span id="mi">${iconeK(ik0, 84)}</span></div>
<p class="lib" id="ml">${LIB_APP[ik0] || lib0}</p>`; })()}
<a class="btn" href="/?commune=${encodeURIComponent(x.n)}">Voir la météo heure par heure</a></div>
${deuxJours}
${heures ? `<h2>Les prochaines heures</h2><div class="hs">${heures}</div>` : ""}
<h2>Prévisions sur 7 jours</h2><div class="jours"><div class="j tete"><span></span><span>Ciel</span><span>Rafales<small>km/h</small></span><span>Min · max</span></div>${lignes}</div>
<div class="app"><img src="/icons/icon-192.png" alt=""><div><b>La météo ${deC(x.n)} dans votre poche</b><p>Température en direct, pluie dans les 2 prochaines heures, vigilances et sourire du jour. Gratuit, sans pub, sans inscription.</p><a href="/?commune=${encodeURIComponent(x.n)}">Ouvrir l'app →</a></div></div>
${ANEC[x.n] && ANEC[x.n].length ? `<h2>Le saviez-vous ?</h2>${ANEC[x.n].slice(0, 3).map(a => `<p class="anec">${esc(a.t)}</p>`).join("")}` : ""}
<h2>Communes voisines</h2><div class="liens">${voisines.map(o => `<a href="/meteo/${slug(o.n)}/">${esc(o.n)}</a>`).join("")}<a href="/meteo/">Toutes les communes</a></div>
<div class="suivez"><b>Suivez La météo de Léo</b><div><a class="ig" href="https://www.instagram.com/lameteodeleo/" rel="noopener">Instagram</a><a class="fb" href="https://www.facebook.com/share/1HXwwwERuf/" rel="noopener">Facebook</a></div></div>`;
    await mkdir(`site/meteo/${sl}`, { recursive: true });
    await writeFile(`site/meteo/${sl}/index.html`, page({ titre, desc, url, corps }));
    urls.push(url);
  }
  const groupes = Object.entries(NOMS_SECTEURS).map(([k, nom]) => { const L = ok.filter(o => o.s === k).sort((a, b) => a.n.localeCompare(b.n, "fr")); return L.length ? `<h2>${nom}</h2><div class="liens">${L.map(o => `<a href="/meteo/${slug(o.n)}/">${esc(o.n)}</a>`).join("")}</div>` : ""; }).join("");
  await mkdir("site/meteo", { recursive: true });
  await writeFile("site/meteo/index.html", page({ titre: "Météo des Bouches-du-Rhône : toutes les communes", desc: `La météo de ${ok.length} communes des Bouches-du-Rhône et des environs, heure par heure et sur 7 jours, d'après les modèles de Météo-France.`, url: `${SITE}/meteo/`, corps: `<h1>Météo des Bouches-du-Rhône, commune par commune</h1><p class="sub">${ok.length} communes · mis à jour ${maj}</p>${groupes}` }));
  const jour = new Date().toISOString().slice(0, 10);
  await writeFile("site/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${u}</loc><lastmod>${jour}</lastmod><changefreq>hourly</changefreq></url>`).join("\n")}\n</urlset>\n`);
  return urls.length;
}

// 5. Construction du site
const liste = await communes();
await previsions(liste);
// Communes restées sans prévisions : on reprend celles de la mise à jour précédente si elle a moins de 5 heures,
// plutôt que de faire disparaître la commune de l'app. Le contrôle qualité les vérifie comme les autres.
let reprises = 0;
if (liste.some(x => !x.d)) {
  try {
    const prec = await lireSite("/data/meteo.json", 2);
    if (Date.now() - new Date(prec.maj).getTime() < 5 * 3600e3) {
      for (const x of liste) if (!x.d) {
        const a = prec.communes.find(c => c.n === x.n);
        if (a && a.d) { x.cur = a.cur; x.d = a.d; x.h = a.h; x.n24 = a.n24; x.mf = 1; reprises++; }
      }
    }
    console.log(`${reprises} commune(s) reprise(s) de la mise à jour précédente`);
  } catch (e) { console.warn("Reprise de la mise à jour précédente impossible : " + e.message); }
}
const recues = liste.filter(x => x.d);
// Journal de contrôle : les trois plus fortes rafales d'aujourd'hui et de demain, pour repérer une valeur isolée
for (const k of [0, 1]) {
  const top = recues.filter(x => x.d[k]).sort((a, b) => b.d[k][4] - a.d[k][4]).slice(0, 3);
  console.log(`Rafales les plus fortes le ${top[0] ? top[0].d[k][0] : "?"} : ` + top.map(x => `${x.n} ${x.d[k][4]} km/h (heures : ${(x.h[k] || []).map(e => e && e[3] != null ? e[3] : "-").join(" ")})`).join(" ; "));
}
// Journal de contrôle : quelques communes témoins, pour comparer la journée et ses heures
for (const n of ["Marseille", "Aix-en-Provence", "Arles"]) {
  const x = liste.find(y => y.n === n); if (!x || !x.d) continue;
  for (const k of [0, 1]) console.log(`Témoin ${n} ${x.d[k][0]} : code ${x.d[k][1]}, ${x.d[k][3]}° à ${x.d[k][2]}°, rafales ${x.d[k][4]} km/h, pluie ${x.d[k][6]} mm · heures 7→21 h : ` +
    (x.h[k] || []).map(e => e && e[0] != null ? `${e[0]}°/${e[1]}/${e[3]}` : "-").join(" "));
}
// Ciel de la journée calculé sur les heures de jour (9 h à 17 h), comme les applis pro.
// Le code du jour fourni par les modèles retient le moment le plus couvert : un seul passage nuageux suffisait à afficher « Nuageux »
// sur une journée surtout ensoleillée. La pluie, l'orage et la neige gardent leurs règles (probabilité et quantité), inchangées.
function cielDesHeures(H) {
  const v = H.slice(1, 6).filter(e => e && e[1] != null).map(e => e[1]);
  if (v.length < 4) return null;
  const nuage = c => c <= 1 ? 0 : c === 2 ? 0.5 : 1;
  const m = v.reduce((a, c) => a + nuage(c), 0) / v.length;
  // « Ensoleillé » seulement sans aucune heure couverte ; le brouillard du matin (7 h à 11 h) reste annoncé
  return { code: m <= 0.25 && !v.some(c => c >= 3) ? 1 : m <= 0.65 ? 2 : 3, brume: H.slice(0, 3).filter(e => e && (e[1] === 45 || e[1] === 48)).length };
}
let cielsAjustes = 0; const passages = {}, exemple = [];
for (const x of liste) if (x.d && x.h) x.d.forEach((D, k) => {
  const H = x.h[k]; if (!H) return;
  const lib = ciel(D[1], D[7], D[6]), SEC = ["Ensoleillé", "Éclaircies", "Nuageux", "Brouillard"];
  if (!SEC.includes(lib)) return;
  const r = cielDesHeures(H); if (!r) return;
  if (lib === "Brouillard" && r.brume >= 1) return;
  // Une pluie écartée (peu probable) laisse au moins des nuages : jamais « Ensoleillé » ce jour-là
  if (((D[1] >= 51 && D[1] <= 67) || (D[1] >= 71 && D[1] <= 86) || D[1] >= 95) && r.code < 2) r.code = 2;
  // Seul le ciel change : si le nouveau code donnait une autre conclusion sur la pluie, on garde l'ancien
  if (r.code !== D[1] && ["Ensoleillé", "Éclaircies", "Nuageux"].includes(ciel(r.code, D[7], D[6]))) { const t = lib + " → " + ciel(r.code, D[7], D[6]); passages[t] = (passages[t] || 0) + 1; if (norm(x.n) === norm("Le Puy-Sainte-Réparade")) exemple.push(`${D[0]} ${t} (heures ${H.slice(1, 6).map(e => e && e[1]).join(",")})`); D[1] = r.code; cielsAjustes++; }
});
console.log(`Ciel du jour recalculé sur les heures de jour : ${cielsAjustes} journée(s) ajustée(s) · ${JSON.stringify(passages)} · Le Puy : ${exemple.join(" ; ") || "aucun changement"}`);
const aujourdhui = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const bilan = controler(recues, aujourdhui), ok = bilan.valides;
console.log(`Contrôle qualité : ${ok.length}/${liste.length} communes validées, ${bilan.corrections} valeur(s) ajustée(s), ${bilan.rejets.length} commune(s) écartée(s)`);
for (const r of bilan.rejets) console.warn(`  écartée : ${r.n} (${r.pb.join(" ; ")})`);
console.log(`Météo-France appliqué à ${ok.filter(x => x.mf).length}/${ok.length} communes`);
if (liste.length - ok.length > 12) throw new Error(`Contrôle qualité : ${ok.length} communes validées sur ${liste.length} (${bilan.rejets.length} écartées, ${liste.length - recues.length} sans prévisions). Rien n'est publié, la version précédente reste en ligne.`);
const qualiteAir = await bonus("Qualité de l'air", () => air(ok));
const laMer = await bonus("Mer", mer);
// Département de chaque commune (code INSEE), pour lui associer la bonne vigilance
for (const x of ok) x.dep = x.dep || (x.code ? String(x.code).slice(0, 2) : x.s !== "voisins" ? "13" : ((VOISINS.find(v => norm(v[0]) === norm(x.n)) || [])[1] || "84"));
// Communes au bord de la mer : elles reçoivent aussi la vigilance du littoral
const BORD_DE_MER = ["Marseille", "Cassis", "La Ciotat", "Le Rove", "Ensuès-la-Redonne", "Carry-le-Rouet", "Sausset-les-Pins", "Martigues", "Port-de-Bouc", "Fos-sur-Mer", "Port-Saint-Louis-du-Rhône", "Arles", "Saintes-Maries-de-la-Mer"].map(norm);
for (const x of ok) if (BORD_DE_MER.includes(norm(x.n))) x.cote = 1;
const vig = await bonus("Vigilance", () => vigilance([...new Set(ok.map(x => x.dep))]));
await mkdir("site/data", { recursive: true });
// Test à la demande : lit les mesures horaires d'hier et affiche ce qu'on en tire, sans rien enregistrer
if (process.env.TEST_MESURES === "true") await bonus("Test des mesures", async () => {
  // Le plan du site tel que Google le reçoit
  for (const u of ["https://lameteodeleo.fr/sitemap.xml", "https://lameteodeleo.fr/robots.txt"]) {
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" } }); const t = await r.text();
    console.log(`Plan ${u} : HTTP ${r.status}, type ${r.headers.get("content-type")}, ${t.length} caractères, ${(t.match(/<loc>/g) || []).length} adresses ; début : ${t.slice(0, 160).replace(/\n/g, " ")} ; fin : ${t.slice(-60).replace(/\n/g, " ")}`);
  }
  const d = dateParis(-1), cles = new Set(); for (let k = 0; k <= 24; k++) cles.add(cleUTC(d, k));
  for (const dep of ["13", "84"]) {
    const url = await urlHoraire(dep), r = await lireHoraire(url, cles, UA);
    console.log(`Test ${dep} : ${url.split("/").pop()} ; ${r.lignes} lignes, ${r.gardees} gardées, ${r.postes.length} stations ; colonnes ${r.tete.join(";").slice(0, 400)}`);
    for (const p of r.postes.slice(0, 3)) console.log(`  ${p.nom} (${p.lat}, ${p.lon}) : ` + Object.entries(p.h).slice(6, 10).map(([k, m]) => `${k} T=${m.t} RR1=${m.rr} FXI=${m.fxi} DXI=${m.dxi} U=${m.u} FF=${m.ff} GLO=${m.glo}`).join(" | "));
    console.log(`  Colonnes après T : ${r.tete.slice(r.tete.indexOf("T")).join(";")}`);
  }
  // Qualité de l'air : stations de fond AtmoSud lues hier, avec leur position
  {
    const ds = await lireJSON("https://www.data.gouv.fr/api/1/datasets/5b98b648634f415309d52a50/", 2);
    const meta = (ds.resources || []).find(r => /\.xml$/.test(r.url || "") && /Dataset D/i.test(r.title || ""));
    const co = stationsAir(await lireTexte(meta.url)); const d = dateParis(-1);
    const m = lireAir(await lireTexte(`https://files.data.gouv.fr/ineris/lcsqa/concentrations-de-polluants-atmospheriques-reglementes/temps-reel/${d.slice(0, 4)}/FR_E2_${d}.csv`));
    console.log(`Test air ${d} : ${Object.keys(co).length} positions ; ` + Object.entries(m).map(([k, s]) => `${s.nom} ${co[k] ? co[k].join(",") : "sans position"} indice ${Math.round(s.indice)} ${JSON.stringify(s.max)}`).join(" | "));
  }
});
const fiabilite = await bonus("Vérification", () => verifier(ok, qualiteAir));
await writeFile("site/data/meteo.json", JSON.stringify({
  maj: new Date().toISOString(),
  source: "Open-Meteo (CC BY 4.0) : modèles Météo-France AROME et ARPEGE, complétés par le modèle global",
  mf: ok.filter(x => x.mf).length,
  qualite: { validees: ok.length, total: liste.length, ajustees: bilan.corrections, reprises, ecartees: bilan.rejets.map(r => r.n) },
  alertes: null,
  vigilance: vig,
  air: qualiteAir,
  mer: laMer,
  fiabilite,
  communes: ok.map(({ n, s, dep, cote, lat, lon, cur, d, h, n24 }) => ({ n, s, dep, cote, lat: r1x(lat), lon: r1x(lon), cur, d, h, n24 }))
}));
function r1x(v) { return Math.round(v * 1000) / 1000; }
// Copie tous les fichiers de l'app (tout sauf les outils et le dossier « site » lui-même)
const EXCLUS = new Set([".git", ".github", "scripts", "site", "node_modules", "README.md"]);
for (const f of await readdir(".")) if (!EXCLUS.has(f)) await cp(f, "site/" + f, { recursive: true });
const nbPages = await bonus("Pages des communes", () => pagesCommunes(ok, vig));
if (nbPages) console.log(`Pages pour Google : ${nbPages} adresses dans le plan du site`);
console.log(`Site prêt : ${ok.length} communes, mis à jour le ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`);
