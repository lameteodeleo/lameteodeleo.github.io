// La météo de Léo : programme de mise à jour automatique.
// GitHub le lance toutes les 2 heures. Il récupère la liste officielle des communes,
// demande les prévisions à Open-Meteo, puis prépare le site dans le dossier « site ».
// Seule clé utilisée : MF_VIGILANCE_KEY (secret GitHub, facultatif) pour les vigilances de Météo-France. Node 20 ou plus récent.

import { mkdir, writeFile, cp, readdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

// Secteurs de l'app. Une commune du 13 absente de ces listes est rattachée au secteur le plus proche.
const SECTEURS = {"mc": ["Marseille","Allauch","Plan-de-Cuques","Aubagne","La Penne-sur-Huveaune","Carnoux-en-Provence","Cassis","Ceyreste","La Ciotat","Roquefort-la-Bédoule","Gémenos","Cuges-les-Pins","Roquevaire","Auriol","La Destrousse","Peypin","Belcodène","La Bouilladisse","Cadolive","Saint-Savournin","Septèmes-les-Vallons","Le Rove","Ensuès-la-Redonne","Carry-le-Rouet","Sausset-les-Pins"],"aix": ["Aix-en-Provence","Éguilles","Venelles","Le Tholonet","Saint-Marc-Jaumegarde","Vauvenargues","Beaurecueil","Châteauneuf-le-Rouge","Rousset","Peynier","Trets","Puyloubier","Fuveau","Gréasque","Mimet","Gardanne","Meyreuil","Bouc-Bel-Air","Simiane-Collongue","Cabriès","Les Pennes-Mirabeau","Ventabren","Saint-Cannat","Rognes","Le Puy-Sainte-Réparade","Meyrargues","Peyrolles-en-Provence","Jouques","Saint-Paul-lès-Durance","Saint-Estève-Janson","Saint-Antonin-sur-Bayon","La Roque-d'Anthéron"],"berre": ["Martigues","Châteauneuf-les-Martigues","Gignac-la-Nerthe","Marignane","Saint-Victoret","Vitrolles","Rognac","Berre-l'Étang","Velaux","Coudoux","La Fare-les-Oliviers","Saint-Chamas","Istres","Fos-sur-Mer","Port-de-Bouc","Saint-Mitre-les-Remparts","Port-Saint-Louis-du-Rhône","Miramas","Cornillon-Confoux"],"salon": ["Salon-de-Provence","Pélissanne","Lançon-Provence","Grans","Lambesc","Alleins","Aurons","Vernègues","Lamanon","Eyguières","Sénas","Mallemort","Charleval","Orgon","Plan-d'Orgon","Cabannes","Saint-Andiol","Verquières","Mollégès","Noves","Eyragues","Châteaurenard","Rognonas","Barbentane","Graveson","Maillane","Saint-Rémy-de-Provence","Eygalières","Aureille","Mouriès","Maussane-les-Alpilles","Paradou","Les Baux-de-Provence","Mas-Blanc-des-Alpilles"],"arles": ["Arles","Saintes-Maries-de-la-Mer","Saint-Martin-de-Crau","Tarascon","Boulbon","Saint-Étienne-du-Grès","Saint-Pierre-de-Mézoargues","Fontvieille"]};
// Communes voisines (hors Bouches-du-Rhône) : nom et numéro de département.
const VOISINS = [["Pertuis", "84"], ["Cadenet", "84"], ["Lauris", "84"], ["La Tour-d'Aigues", "84"], ["Saint-Maximin-la-Sainte-Baume", "83"], ["Avignon", "84"]];

const UA = { "User-Agent": "lameteodeleo (GitHub Actions)" };
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
    const prec = await lireJSON("https://lameteodeleo.github.io/data/meteo.json?t=" + Date.now());
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
  hourly: "temperature_2m,weather_code,precipitation_probability,wind_gusts_10m,wind_direction_10m,uv_index",
  daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,wind_gusts_10m_max,wind_direction_10m_dominant,precipitation_sum,precipitation_probability_max,uv_index_max",
  timezone: "Europe/Paris", forecast_days: "7", wind_speed_unit: "kmh"
});
// Modèles de Météo-France (AROME 1,3 à 2,5 km pour aujourd'hui et demain, puis ARPEGE) : plus précis pour le mistral,
// les orages et le relief. Ils remplacent les valeurs ci-dessus sur les 3 premiers jours quand ils sont disponibles.
// Le risque de pluie, l'indice UV et les jours 4 à 7 restent ceux du modèle global (Open-Meteo « best match »).
const PARAMS_MF = new URLSearchParams({
  models: "meteofrance_seamless",
  current: "temperature_2m,apparent_temperature,weather_code,wind_gusts_10m,wind_direction_10m",
  hourly: "temperature_2m,weather_code,wind_gusts_10m,wind_direction_10m",
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
      const maj = (t, cible, iT, iC, iR, iD) => {
        const k = pos[t]; if (k == null || !vu(h.temperature_2m[k])) return;
        cible[iT] = r1(h.temperature_2m[k]);
        if (vu(h.weather_code[k])) cible[iC] = h.weather_code[k];
        if (vu(h.wind_gusts_10m[k])) cible[iR] = Math.round(h.wind_gusts_10m[k]);
        if (vu(h.wind_direction_10m[k])) cible[iD] = h.wind_direction_10m[k];
      };
      for (const e of x.n24) maj(e[0], e, 1, 2, 4, 5);
      x.d.forEach((J, k) => { if (k < JOURS_MF) HEURES.forEach((hh, i) => { const e = x.h[k][i]; if (e && e.length > 1) maj(J[0] + "T" + String(hh).padStart(2, "0") + ":00", e, 0, 1, 3, 4); }); });
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
        return [t, r1(h.temperature_2m[i]), h.weather_code[i], h.precipitation_probability[i], Math.round(h.wind_gusts_10m[i] ?? 0), h.wind_direction_10m[i]];
      });
      x.h = d.time.map(date => HEURES.map(hh => {
        const k = pos[date + "T" + String(hh).padStart(2, "0") + ":00"];
        return k == null ? [null] : [r1(h.temperature_2m[k]), h.weather_code[k], h.precipitation_probability[k], Math.round(h.wind_gusts_10m[k] ?? 0), h.wind_direction_10m[k]];
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
async function fichierObs(dep, annee) {
  const nom = `Q_${dep}_latest-${annee - 1}-${annee}_RR-T-Vent.csv.gz`;
  try { return await lireTexte("https://object.files.data.gouv.fr/meteofrance/data/synchro_ftp/BASE/QUOT/" + nom); }
  catch (e) {
    // Nom de fichier changé : on cherche le bon lien dans le catalogue de data.gouv.fr
    const cat = await lireJSON(`https://www.data.gouv.fr/api/2/datasets/${DATASET_QUOT}/resources/?page_size=50&q=Q_${dep}_latest`, 2);
    const res = (cat.data || []).find(r => /latest/.test(r.url) && /RR-T-Vent/.test(r.url) && r.url.includes(`Q_${dep}_`));
    if (!res) throw new Error(`fichier des mesures du ${dep} introuvable`);
    return await lireTexte(res.url);
  }
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
async function verifier(ok) {
  let prec = null;
  try { prec = await lireJSON("https://lameteodeleo.github.io/data/verif.json?t=" + Date.now(), 3); } catch (e) { console.warn("Historique de vérification introuvable (" + e.message + ") : on repart de zéro."); }
  const V = { prev: (prec && prec.prev) || {}, jours: (prec && prec.jours) || [] };
  const auj = dateParis(0);
  // Garde la prévision de demain (écrasée à chaque mise à jour jusqu'à minuit)
  const dem = {}; let dDem = null;
  for (const x of ok) { const J = x.d && x.d[1]; if (!J) continue; dDem = J[0]; dem[x.n] = [J[2], J[3], J[6], J[4], x.lat, x.lon]; }
  if (dDem && dDem > auj) V.prev[dDem] = dem;
  // Juge les jours passés qui ont une prévision et pas encore de score
  const faits = new Set(V.jours.map(j => j.date));
  const aJuger = Object.keys(V.prev).filter(d => d < auj && !faits.has(d)).sort();
  // Premier lancement : on vérifie tout de suite que les mesures des stations sont bien lisibles
  if (!prec || !prec.test5) { try { const tous = await catalogue(); const r13 = tous.find(r => /Q_13_latest.*RR-T-Vent/.test(r.url)); console.log("Catalogue : lien " + r13.url); const txt = await lireTexte(r13.url); const ls = txt.split("\n"); const ds = ls.slice(1).map(l => l.split(";")[5]).filter(Boolean); const mois = {}; ds.forEach(d => mois[d.slice(0, 6)] = (mois[d.slice(0, 6)] || 0) + 1); console.log(`Catalogue : ${ls.length} lignes, ${txt.length} caractères, par mois ${JSON.stringify(mois)}, fin ${ls.slice(-3).join(" || ").slice(0, 400)}`); } catch (e) { console.warn("Catalogue illisible : " + e.message); } }
  if (!prec || !prec.test2) { try { const txt = await fichierObs("13", +auj.slice(0, 4)); const ds = [...new Set(txt.split("\n").slice(1).map(l => l.split(";")[5]).filter(Boolean))].sort(); const der = ds[ds.length - 1]; const { out } = lireCSV(txt, new Set([der])); console.log(`Test des mesures : dernier jour publié ${der} (${out.length} stations du 13, ${out.filter(o => o.tx != null).length} avec TX) ; exemple ${JSON.stringify(out.find(o => o.tx != null))}`); } catch (e) { console.warn("Test des mesures impossible : " + e.message); } }
  if (aJuger.length) {
    const dates = new Set(aJuger.map(d => d.replace(/-/g, "")));
    const mesures = [];
    for (const dep of ["13", "84", "83", "30"]) {
      try { const { tete, out } = lireCSV(await fichierObs(dep, +auj.slice(0, 4)), dates); mesures.push(...out); if (dep === "13") console.log("Mesures : colonnes " + tete.slice(0, 14).join(";") + "… ; " + out.length + " lignes du 13 pour " + [...dates].join(", ")); }
      catch (e) { console.warn(`Mesures du ${dep} indisponibles : ${e.message}`); }
    }
    for (const d of aJuger) {
      const P = V.prev[d], M = mesures.filter(m => m.jour === d.replace(/-/g, "") && m.lat != null && m.tx != null && m.tn != null);
      if (M.length < 5) { console.log(`Vérification du ${d} : mesures pas encore publiées (${M.length} stations), on réessaiera.`); continue; }
      const res = { date: d, stations: 0, tx: [0, 0, 0], tn: [0, 0, 0], pluie: [0, 0], vent: [0, 0, 0], pires: [] };
      for (const m of M) {
        let best = null, bd = 6;
        for (const [n, p] of Object.entries(P)) { const k = distKm(m.lat, m.lon, p[4], p[5]); if (k < bd) { bd = k; best = n; } }
        if (!best) continue;
        const p = P[best]; res.stations++;
        const ex = p[0] - m.tx, en = p[1] - m.tn;
        res.tx[0]++; res.tx[1] += Math.abs(ex) <= 2 ? 1 : 0; res.tx[2] += Math.abs(ex);
        res.tn[0]++; res.tn[1] += Math.abs(en) <= 2 ? 1 : 0; res.tn[2] += Math.abs(en);
        if (m.rr != null) { res.pluie[0]++; res.pluie[1] += ((p[2] >= 1) === (m.rr >= 1)) ? 1 : 0; }
        if (m.fxi != null) { const kmh = m.fxi * 3.6; res.vent[0]++; res.vent[1] += Math.abs(p[3] - kmh) <= 15 ? 1 : 0; res.vent[2] += Math.abs(p[3] - kmh); }
        res.pires.push({ n: best, st: m.nom, ex: Math.round(ex * 10) / 10, en: Math.round(en * 10) / 10, rrP: p[2], rrM: m.rr, vP: p[3], vM: m.fxi == null ? null : Math.round(m.fxi * 3.6) });
      }
      if (res.stations < 5) { console.log(`Vérification du ${d} : trop peu de stations proches d'une commune (${res.stations}).`); continue; }
      res.pires = res.pires.sort((a, b) => Math.max(Math.abs(b.ex), Math.abs(b.en)) - Math.max(Math.abs(a.ex), Math.abs(a.en))).slice(0, 3);
      for (const k of ["tx", "tn", "vent"]) if (res[k][0]) res[k][2] = Math.round(res[k][2] / res[k][0] * 10) / 10;
      V.jours.push(res);
      console.log(`Vérification du ${d} : ${res.stations} stations ; max justes à 2° près ${res.tx[1]}/${res.tx[0]} (écart moyen ${res.tx[2]}°) ; min ${res.tn[1]}/${res.tn[0]} (${res.tn[2]}°) ; pluie oui/non ${res.pluie[1]}/${res.pluie[0]} ; rafales à 15 km/h près ${res.vent[1]}/${res.vent[0]}`);
    }
  }
  // On garde 10 jours de prévisions en attente et 60 jours de scores
  for (const d of Object.keys(V.prev).sort().slice(0, -10)) delete V.prev[d];
  for (const d of Object.keys(V.prev)) if (d < dateParis(-9)) delete V.prev[d];
  V.jours = V.jours.sort((a, b) => a.date < b.date ? -1 : 1).slice(-60);
  await writeFile("site/data/verif.json", JSON.stringify({ maj: new Date().toISOString(), test2: 1, test3: 1, test4: 1, test5: 1, ...V }));
  return V.jours.slice(-14).map(({ pires, ...r }) => ({ ...r, pires }));
}

// 5. Construction du site
const liste = await communes();
await previsions(liste);
// Communes restées sans prévisions : on reprend celles de la mise à jour précédente si elle a moins de 5 heures,
// plutôt que de faire disparaître la commune de l'app. Le contrôle qualité les vérifie comme les autres.
let reprises = 0;
if (liste.some(x => !x.d)) {
  try {
    const prec = await lireJSON("https://lameteodeleo.github.io/data/meteo.json?t=" + Date.now(), 2);
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
const fiabilite = await bonus("Vérification", () => verifier(ok));
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
console.log(`Site prêt : ${ok.length} communes, mis à jour le ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`);
