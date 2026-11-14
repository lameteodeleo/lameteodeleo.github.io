// La météo de Léo : vérification de la fiabilité.
// La prévision faite la veille est comparée à ce qu'ont mesuré les stations de Météo-France
// (données publiques, Licence Ouverte Etalab, data.gouv.fr) : mesures quotidiennes et mesures heure par heure.
// Chaque paramètre affiché dans l'app a son score, son biais (trop chaud, trop froid...) et, pour la pluie,
// la calibration des pourcentages. Ces chiffres servent à régler les seuils de l'app.
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

// Heures d'avance de Paris sur le temps universel, à midi ce jour-là (1 en hiver, 2 en été)
export function decalageParis(date) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", timeZoneName: "shortOffset" })
    .formatToParts(new Date(date + "T12:00:00Z")).find(x => x.type === "timeZoneName").value;
  const m = p.match(/GMT([+-]\d+)/); return m ? +m[1] : 0;
}
// Clé AAAAMMJJHH (temps universel, comme dans les fichiers de Météo-France) de l'heure locale H du jour date
export function cleUTC(date, H) {
  const t = new Date(date + "T00:00:00Z").getTime() + (H - decalageParis(date)) * 3600e3;
  return new Date(t).toISOString().slice(0, 13).replace(/[-T]/g, "");
}

// Lecture en continu d'un fichier horaire (plusieurs centaines de milliers de lignes) : on ne garde que les heures utiles
export async function lireHoraire(url, cles, entetes) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 240000);
  try {
    const r = await fetch(url, { headers: entetes, signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    let flux = Readable.fromWeb(r.body); if (/\.gz($|\?)/.test(url)) flux = flux.pipe(createGunzip());
    const rl = createInterface({ input: flux, crlfDelay: Infinity });
    let tete = null, iD = -1, I = {}; const postes = new Map(); let lignes = 0, gardees = 0;
    for await (const ligne of rl) {
      if (!tete) {
        tete = ligne.split(";").map(t => t.trim()); iD = tete.indexOf("AAAAMMJJHH");
        for (const k of ["NUM_POSTE", "NOM_USUEL", "LAT", "LON", "T", "RR1", "FXI", "DXI", "U", "FF", "GLO"]) I[k] = tete.indexOf(k);
        if (iD < 0) throw new Error("colonne AAAAMMJJHH absente : " + tete.slice(0, 12).join(";"));
        continue;
      }
      lignes++;
      const v = ligne.split(";"); const cle = (v[iD] || "").trim(); if (!cles.has(cle)) continue;
      const nb = k => { const i = I[k]; if (i < 0 || v[i] === undefined) return null; const s = v[i].trim(); if (s === "") return null; const x = parseFloat(s.replace(",", ".")); return isNaN(x) ? null : x; };
      const id = v[I.NUM_POSTE]; let p = postes.get(id);
      if (!p) { p = { poste: id, nom: (v[I.NOM_USUEL] || "").trim(), lat: nb("LAT"), lon: nb("LON"), h: {} }; postes.set(id, p); }
      p.h[cle] = { t: nb("T"), rr: nb("RR1"), fxi: nb("FXI"), dxi: nb("DXI"), u: nb("U"), ff: nb("FF"), glo: nb("GLO") }; gardees++;
    }
    return { tete, postes: [...postes.values()], lignes, gardees };
  } finally { clearTimeout(to); }
}

// Température ressentie, exactement la formule d'Open-Meteo (Steadman) qui calcule le ressenti affiché dans l'app :
// température, humidité, vent moyen à 10 m (m/s) et, au soleil, rayonnement (W/m²)
export function ressenti(t, u, ff, rayonnement) {
  const v2 = ff * 0.75, e = u / 100 * 6.105 * Math.exp(17.27 * t / (237.7 + t));
  const Q = Math.max(0, 0.1 * ((rayonnement ?? 550) - 550));
  return t + 0.348 * e - 0.70 * v2 + 0.70 * (Q / (v2 + 10)) - 4.25;
}
const distKm = (a, b, c, d) => { const R = 6371, x = (d - b) * Math.PI / 180 * Math.cos((a + c) / 2 * Math.PI / 180), y = (c - a) * Math.PI / 180; return R * Math.hypot(x, y); };
const nord = d => d != null && (d >= 290 || d <= 20);
const r1 = v => Math.round(v * 10) / 10;
// Tranches de pourcentage pour vérifier les « risques de pluie » : quand l'app annonce 70 à 90 %, a-t-il plu 7 à 9 fois sur 10 ?
export const TRANCHES = [0, 10, 30, 50, 70, 90, 101];
const tranche = p => { for (let i = 0; i < TRANCHES.length - 1; i++) if (p < TRANCHES[i + 1]) return i; return TRANCHES.length - 2; };

// Compteurs : [nombre, justes, écart moyen, biais moyen] ; le biais > 0 veut dire « prévu trop haut »
const cpt = () => [0, 0, 0, 0];
const ajoute = (c, ecart, tol) => { c[0]++; if (Math.abs(ecart) <= tol) c[1]++; c[2] += Math.abs(ecart); c[3] += ecart; };
const finit = c => { if (c[0]) { c[2] = r1(c[2] / c[0]); c[3] = r1(c[3] / c[0]); } return c; };

// Note un jour. P = prévisions de la veille par commune ; Q = mesures quotidiennes ; H = postes horaires ; ciel = règle des icônes de l'app
// P[n] = [max, min, pluie mm, rafale max, lat, lon, code, risque %, heures, secteur, ressenti max]
// heures = [[temp, code, risque, rafale, direction, mm] pour 7 h, 9 h, ..., 21 h]
export function noterJour(d, P, Q, H, ciel, HEURES) {
  const res = { date: d, stations: 0, tx: cpt(), tn: cpt(), pluie: [0, 0], icone: [0, 0, 0, 0], vent: cpt(), ress: cpt(),
    hT: cpt(), hIcone: [0, 0, 0, 0], cal: TRANCHES.slice(0, -1).map(() => [0, 0]), hRaf: cpt(), mistral: [0, 0, 0, 0], sect: {}, pires: [], src: { q: 0, h: 0 } };
  const proche = (lat, lon) => { let best = null, bd = 6; for (const [n, p] of Object.entries(P)) { const k = distKm(lat, lon, p[4], p[5]); if (k < bd) { bd = k; best = n; } } return best; };
  const prevuPluie = (code, prob, mm) => /pluie|averses|orages|neige/i.test(ciel(code, prob, mm ?? 0));
  // Pluie du jour mesurée de 0 h à 24 h (heure de Paris), comme la prévision ; sinon le cumul quotidien de la station
  const parPoste = new Map(H.map(p => [p.poste, p]));
  const cumulJour = p => { if (!p) return null; let s = 0, n = 0; for (let k = 1; k <= 24; k++) { const m = p.h[cleUTC(d, k)]; if (m && m.rr != null) { s += m.rr; n++; } } return n >= 22 ? s : null; };
  const vus = new Set();
  for (const m of Q) {
    if (m.lat == null || m.tx == null || m.tn == null) continue;
    const n = proche(m.lat, m.lon); if (!n) continue;
    const p = P[n]; res.stations++; res.src.q++; vus.add(m.poste);
    const ex = p[0] - m.tx, en = p[1] - m.tn;
    ajoute(res.tx, ex, 2); ajoute(res.tn, en, 2);
    const s = p[9] || "?"; const S = res.sect[s] || (res.sect[s] = { tx: [0, 0], tn: [0, 0] });
    S.tx[0]++; S.tx[1] += ex; S.tn[0]++; S.tn[1] += en;
    const hp = parPoste.get(m.poste), rr = cumulJour(hp) ?? m.rr;
    if (rr != null) {
      res.pluie[0]++; res.pluie[1] += ((p[2] >= 1) === (rr >= 1)) ? 1 : 0;
      if (p[6] != null) { const a = prevuPluie(p[6], p[7], p[2]), b = rr >= 0.2; res.icone[0]++; if (a === b) res.icone[1]++; else if (a) res.icone[2]++; else res.icone[3]++; }
    }
    if (m.fxi != null) ajoute(res.vent, p[3] - m.fxi * 3.6, 15);
    res.pires.push({ n, st: m.nom, ex: r1(ex), en: r1(en), rrP: p[2], rrM: rr == null ? null : r1(rr), vP: p[3], vM: m.fxi == null ? null : Math.round(m.fxi * 3.6) });
  }
  // Heure par heure : température, icône de pluie, pourcentage, rafales, mistral
  for (const st of H) {
    if (st.lat == null) continue;
    const n = proche(st.lat, st.lon); if (!n) continue;
    const hs = P[n][8]; if (!hs) continue; let utile = false;
    HEURES.forEach((hh, i) => {
      const f = hs[i], m = st.h[cleUTC(d, hh)]; if (!f || f[0] == null || !m) return; utile = true;
      if (m.t != null) ajoute(res.hT, f[0] - m.t, 2);
      if (m.rr != null) {
        const a = prevuPluie(f[1], f[2], f[5]), b = m.rr >= 0.2; res.hIcone[0]++; if (a === b) res.hIcone[1]++; else if (a) res.hIcone[2]++; else res.hIcone[3]++;
        if (f[2] != null) { const c = res.cal[tranche(f[2])]; c[0]++; if (b) c[1]++; }
      }
      if (m.fxi != null) {
        const obs = m.fxi * 3.6; ajoute(res.hRaf, f[3] - obs, 15);
        if (m.dxi != null) { const a = f[3] >= 40 && nord(f[4]), b = obs >= 40 && nord(m.dxi); res.mistral[0]++; if (a) res.mistral[1]++; if (b) res.mistral[2]++; if (a && b) res.mistral[3]++; }
      }
    });
    // Ressenti maximal du jour, de 0 h à 24 h : recalculé à partir des mesures de la station (GLO en J/cm² par heure)
    if (P[n][10] != null) {
      let mx = null, nbh = 0;
      for (let k = 1; k <= 24; k++) { const m = st.h[cleUTC(d, k)]; if (!m || m.t == null || m.u == null || m.ff == null) continue; nbh++; const a = ressenti(m.t, m.u, m.ff, m.glo == null ? null : m.glo * 10000 / 3600); if (mx == null || a > mx) mx = a; }
      if (nbh >= 20) { ajoute(res.ress, P[n][10] - mx, 2); utile = true; }
    }
    if (utile) { res.src.h++; if (!vus.has(st.poste)) res.stations++; }
  }
  for (const k of ["tx", "tn", "vent", "hT", "hRaf", "ress"]) finit(res[k]);
  for (const S of Object.values(res.sect)) for (const k of ["tx", "tn"]) S[k] = [S[k][0], S[k][0] ? r1(S[k][1] / S[k][0]) : 0];
  res.pires = res.pires.sort((a, b) => Math.max(Math.abs(b.ex), Math.abs(b.en)) - Math.max(Math.abs(a.ex), Math.abs(a.en))).slice(0, 3);
  return res;
}
