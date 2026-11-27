// Musique originale des Reels, composée chaque jour par le robot et jouée avec de vrais sons d'instruments
// (banque de sons libre FluidR3 GM, jouée par FluidSynth) : guitare, piano, basse, cordes, batterie douce.
// Le style suit le temps de l'accroche ; la date rend chaque morceau unique ; l'intensité règle l'énergie.
// Usage : node scripts/compose.mjs <ambiance> <durée s> <sortie.mid> [date AAAA-MM-JJ] [intensité 0-1]
import { writeFileSync } from "node:fs";

let graine = 1; const alea = () => (graine = (graine * 16807) % 2147483647) / 2147483647;
const choix = L => L[Math.floor(alea() * L.length) % L.length];
const MAJ = [0, 2, 4, 5, 7, 9, 11], MIN = [0, 2, 3, 5, 7, 8, 10];
const accord = (g, deg, n = 4) => Array.from({ length: n }, (_, k) => { const d = deg + 2 * k; return g[d % 7] + 12 * Math.floor(d / 7); });

// Instruments General MIDI : 0 piano, 4 piano électrique, 24 guitare nylon, 25 guitare folk, 32 basse acoustique, 33 basse au doigt,
// 48 cordes, 89 nappe chaude, 73 flûte ; batterie sur le canal 10
const STYLES = {
  soleil: { g: MAJ, bpm: [88, 98],  suites: [[0, 5, 3, 4], [0, 4, 5, 3], [3, 0, 4, 5], [0, 3, 5, 4]], toniques: [55, 57, 53, 52, 50], lead: 25, nappe: 48, basse: 33, batterie: "pop" },
  vent:   { g: MIN, bpm: [92, 104], suites: [[0, 5, 6, 4], [0, 3, 6, 5], [0, 6, 5, 6], [5, 6, 0, 0]], toniques: [50, 52, 53, 55, 48], lead: 24, nappe: 89, basse: 33, batterie: "avance" },
  pluie:  { g: MIN, bpm: [70, 80],  suites: [[0, 3, 6, 2], [5, 3, 0, 4], [0, 5, 3, 4], [3, 4, 0, 0]], toniques: [50, 52, 53, 48, 55], lead: 4,  nappe: 89, basse: 32, batterie: "lofi" },
  froid:  { g: MAJ, bpm: [68, 78],  suites: [[0, 4, 5, 3], [3, 0, 4, 1], [0, 5, 1, 4], [5, 3, 0, 4]], toniques: [55, 57, 53, 52, 50], lead: 0,  nappe: 48, basse: 32, batterie: "rien" },
  alerte: { g: MIN, bpm: [64, 70],  suites: [[0, 0, 5, 4], [0, 5, 0, 6]], toniques: [50, 48], lead: 0, nappe: 48, basse: 32, batterie: "rien" },
};

export function composer({ ambiance = "soleil", duree = 16, date = "", intensite = 0.5 } = {}) {
  const nom = STYLES[ambiance] ? ambiance : "soleil", S = STYLES[nom], I = Math.max(0, Math.min(1, intensite));
  graine = 7; for (const ch of nom + "|" + date) graine = (graine * 31 + ch.charCodeAt(0)) % 2147483647; if (graine <= 0) graine += 2147483646; for (let i = 0; i < 4; i++) alea();
  const ton = choix(S.toniques), suite = choix(S.suites), v = Math.floor(alea() * 3);
  const bpm = Math.round(S.bpm[0] + (S.bpm[1] - S.bpm[0]) * (nom === "vent" ? I : alea()));
  const motif = Array.from({ length: 8 }, () => choix([0, 2, 4, 7, 9, 7, 4, -1, -1]));
  const TPQ = 480, temps = 60 / bpm, mesures = Math.ceil(duree / (temps * 4)) + 1;
  const pistes = { lead: [], nappe: [], basse: [], bat: [] };
  const note = (p, beat, dur, n, vel) => p.push([Math.round(beat * TPQ), Math.round(dur * TPQ), n, vel]);
  const hum = () => (alea() - 0.5) * 0.03;                                     // léger « jeu humain »
  for (let m = 0; m < mesures; m++) {
    const k = m % 4, ac = accord(S.g, suite[k], 4).map(n => n + ton), b0 = m * 4, fin = m === mesures - 1;
    // nappe / accords tenus
    if (nom !== "soleil" || m % 2 === 0) ac.slice(0, 3).forEach(n => note(pistes.nappe, b0, nom === "soleil" ? 8 : 4, n, 38 + (nom === "alerte" ? 10 : 0)));
    // basse
    const bn = ac[0] - 12 - (ac[0] - 12 > 45 ? 12 : 0);
    if (nom === "vent") [0, 0.5, 1.5, 2, 3, 3.5].forEach((x, i) => note(pistes.basse, b0 + x, 0.45, bn + (i === 4 ? 7 : 0), 70 + 15 * I));
    else if (nom === "soleil") [[0, 2.5], [0, 1.5, 2], [0, 2, 3.5]][v].forEach((x, i) => note(pistes.basse, b0 + x, 1.2, bn + (i === 1 ? 7 : 0), 72));
    else note(pistes.basse, b0, 3.8, bn, 66);
    // instrument principal
    if (nom === "soleil" || nom === "vent") {                                   // guitare en arpège
      const ordre = [[0, 1, 2, 3, 2, 1, 2, 3], [0, 2, 1, 3, 0, 2, 1, 3], [0, 1, 2, 1, 3, 2, 1, 2]][v];
      ordre.forEach((j, e) => note(pistes.lead, b0 + e * 0.5 + hum(), 0.9, ac[j], 58 + (e % 2 ? 0 : 10)));
    } else if (nom === "pluie") {                                               // piano électrique : accord feutré + petite mélodie
      ac.forEach((n, j) => note(pistes.lead, b0 + j * 0.04, 3.5, n, 48));
      if (m % 2) motif.forEach((d, e) => { if (d >= 0 && e % 2 === 0) note(pistes.lead, b0 + e * 0.5 + hum(), 0.9, ton + 12 + (d === 4 ? 3 : d === 9 ? 8 : d), 52); });
    } else if (nom === "froid") {                                               // piano lent et clair
      [0, 1.5, 3].forEach((x, i) => note(pistes.lead, b0 + x + hum(), 2.5, ac[(i + m) % 4] + 12, 46));
    } else {
      note(pistes.lead, b0, 4, ac[0], 40);
    }
    // batterie douce (canal 10) : 36 grosse caisse, 37 baguette sur le bord, 42 charleston fermé, 70 maracas
    if (!fin && S.batterie !== "rien") {
      const B = pistes.bat;
      if (S.batterie === "pop") { [[0, 2.5], [0, 1.5, 2.5], [0, 2]][v].forEach(x => note(B, b0 + x, 0.2, 36, 70)); [1, 3].forEach(x => note(B, b0 + x, 0.2, 37, 55)); for (let e = 0; e < 8; e++) note(B, b0 + e * 0.5, 0.1, 70, e % 2 ? 40 : 28); }
      if (S.batterie === "avance") { for (let q = 0; q < 4; q++) note(B, b0 + q, 0.2, 36, 72 + 12 * I); [1, 3].forEach(x => note(B, b0 + x, 0.2, 37, 60)); for (let e = 0; e < 8; e++) note(B, b0 + e * 0.5, 0.1, 42, e % 2 ? 42 : 30); }
      if (S.batterie === "lofi") { [[0, 1.75, 2.5], [0, 2.5], [0, 0.75, 2.5]][v].forEach(x => note(B, b0 + x, 0.2, 36, 68)); [1, 3].forEach(x => note(B, b0 + x, 0.2, 37, 50)); for (let e = 0; e < 8; e++) note(B, b0 + e * 0.5 + (e % 2 ? 0.08 : 0), 0.1, 42, 26); }
    }
  }
  // ---- écriture du fichier MIDI (format 1) ----
  const vlq = n => { const o = [n & 0x7f]; while ((n >>= 7)) o.unshift((n & 0x7f) | 0x80); return o; };
  const piste = (canal, prog, vol, pan, notes, reverb = 70) => {
    const ev = [[0, [0xC0 | canal, prog]], [0, [0xB0 | canal, 7, vol]], [0, [0xB0 | canal, 10, pan]], [0, [0xB0 | canal, 91, reverb]], [0, [0xB0 | canal, 93, 20]]];
    for (const [t, d, n, vel] of notes) { const tt = Math.max(0, t); ev.push([tt, [0x90 | canal, n, Math.min(127, vel)]]); ev.push([tt + d, [0x80 | canal, n, 0]]); }
    ev.sort((a, b) => a[0] - b[0] || (a[1][0] & 0xf0) - (b[1][0] & 0xf0));
    const o = []; let last = 0; for (const [t, d] of ev) { o.push(...vlq(t - last), ...d); last = t; } o.push(0, 0xFF, 0x2F, 0);
    return Buffer.concat([Buffer.from("MTrk"), Buffer.from([o.length >>> 24, (o.length >> 16) & 255, (o.length >> 8) & 255, o.length & 255]), Buffer.from(o)]);
  };
  const us = Math.round(60e6 / bpm), tempo = Buffer.concat([Buffer.from("MTrk"), Buffer.from([0, 0, 0, 11, 0, 0xFF, 0x51, 3, us >> 16, (us >> 8) & 255, us & 255, 0, 0xFF, 0x2F, 0])]);
  const tr = [tempo, piste(0, S.lead, 100, 54, pistes.lead), piste(1, S.nappe, 72, 74, pistes.nappe, 90), piste(2, S.basse, 100, 64, pistes.basse, 30)];
  if (pistes.bat.length) tr.push(piste(9, 0, 82, 64, pistes.bat, 40));
  const head = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tr.length, TPQ >> 8, TPQ & 255]);
  return { midi: Buffer.concat([head, ...tr]), resume: `${nom}, ${bpm} bpm, tonique ${ton}, suite ${suite.join("-")}, variante ${v + 1}` };
}
// L'ambiance et l'intensité selon l'accroche du Reel
export function ambianceDe(a) {
  const t = a && a.t, n = a && +a.n;
  if (a && a.niveau) return { ambiance: "alerte", intensite: 0.5 };
  if (t === "vent") return { ambiance: "vent", intensite: Math.min(1, Math.max(0, (n - 40) / 60)) };
  if (t === "pluie") return { ambiance: "pluie", intensite: Math.min(1, n / 30) };
  if (t === "froid") return { ambiance: "froid", intensite: 0.5 };
  return { ambiance: "soleil", intensite: 0.5 };
}
if (process.argv[1] && process.argv[1].endsWith("compose.mjs") && process.argv[2]) {
  const r = composer({ ambiance: process.argv[2], duree: +(process.argv[3] || 16), date: process.argv[5] || "", intensite: process.argv[6] != null ? +process.argv[6] : 0.5 });
  writeFileSync(process.argv[4] || "musique.mid", r.midi); console.log(r.resume);
}
