// Musique originale des Reels, composée chaque jour par le robot (aucun droit d'auteur : rien n'est copié, tout est calculé)
// Le style suit le temps de l'accroche (soleil, vent, pluie, froid, alerte) et chaque jour donne un morceau différent :
// tonalité, suite d'accords, tempo, rythme et petite mélodie changent selon la date, l'intensité règle l'énergie.
// Usage : node scripts/musique.mjs <ambiance> <durée en s> <sortie.wav> [date AAAA-MM-JJ] [intensité 0-1]
import { writeFileSync } from "node:fs";

const SR = 44100, TAU = 2 * Math.PI;
const hz = n => 440 * Math.pow(2, (n - 69) / 12);
let graine = 7; const alea = () => (graine = (graine * 16807) % 2147483647) / 2147483647 * 2 - 1;
const choix = L => L[Math.floor((alea() + 1) / 2 * L.length) % L.length];

function piste(duree) {
  const N = Math.ceil(duree * SR), L = new Float32Array(N), R = new Float32Array(N);
  const mix = (i0, buf, vol, pan = 0) => { const gl = vol * Math.min(1, 1 - pan), gr = vol * Math.min(1, 1 + pan);
    for (let i = 0; i < buf.length && i0 + i < N; i++) if (i0 + i >= 0) { L[i0 + i] += buf[i] * gl; R[i0 + i] += buf[i] * gr; } };
  return { N, L, R, mix };
}
// ---- Instruments ----
const env = (t, a, d) => Math.min(1, t / a) * Math.exp(-t / d);
function rhodes(f, dur, brillance = 1) {
  const n = Math.floor(dur * SR), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR, idx = 1.6 * brillance * Math.exp(-t * 3.5);
    b[i] = Math.sin(TAU * f * t + idx * Math.sin(TAU * f * t)) * env(t, 0.004, dur * 0.55) + 0.15 * Math.sin(TAU * f * 2 * t) * Math.exp(-t * 8); }
  return b;
}
function nappe(f, dur, clair = 0.5) {
  const n = Math.floor(dur * SR), b = new Float32Array(n); let y = 0; const det = [0.996, 1, 1.004], ph = [0, 0.33, 0.66];
  for (let i = 0; i < n; i++) { const t = i / SR; let s = 0; for (let k = 0; k < 3; k++) { const p = (ph[k] + f * det[k] * t) % 1; s += 2 * p - 1; }
    const c = 0.02 + 0.12 * clair * (0.6 + 0.4 * Math.sin(TAU * 0.25 * t)); y += c * (s / 3 - y);
    b[i] = y * Math.min(1, t / 0.4, (dur - t) / 0.5); }
  return b;
}
function basse(f, dur, type = "ronde") {
  const n = Math.floor(dur * SR), b = new Float32Array(n); let y = 0;
  for (let i = 0; i < n; i++) { const t = i / SR, e = env(t, 0.005, type === "synthe" ? 0.18 : dur * 0.6);
    if (type === "synthe") { const s = 2 * ((f * t) % 1) - 1; y += (0.05 + 0.25 * Math.exp(-t * 12)) * (s - y); b[i] = y * e; }
    else b[i] = (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t)) * e; }
  return b;
}
function grosseCaisse(doux = 1) { const n = Math.floor(0.35 * SR), b = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR, f = 48 + 90 * Math.exp(-t * 28); ph += f / SR; b[i] = Math.sin(TAU * ph) * Math.exp(-t * 9) * doux; } return b; }
function claque(couleur = 0.5) { const n = Math.floor(0.22 * SR), b = new Float32Array(n); let y = 0;
  for (let i = 0; i < n; i++) { const t = i / SR, x = alea(); y += 0.5 * (x - y); const z = x - y;
    const multi = t < 0.03 ? (Math.floor(t / 0.01) % 2 ? 0.6 : 1) : 1;
    b[i] = (z * couleur + y * (1 - couleur)) * Math.exp(-t * 18) * multi + Math.sin(TAU * 190 * t) * Math.exp(-t * 30) * 0.3; } return b; }
function charleston(long = 0.05) { const n = Math.floor(long * SR * 2), b = new Float32Array(n); let y = 0;
  for (let i = 0; i < n; i++) { const t = i / SR, x = alea(); y += 0.6 * (x - y); b[i] = (x - y) * Math.exp(-t / long * 3); } return b; }
function souffle(dur, vitesse = 0.2, fort = 1) {
  const n = Math.floor(dur * SR), b = new Float32Array(n); let y = 0;
  for (let i = 0; i < n; i++) { const t = i / SR, c = 0.004 + 0.03 * (0.5 + 0.5 * Math.sin(TAU * vitesse * t - 1.5)); y += c * (alea() - y); b[i] = y * 6 * fort; }
  return b;
}
function pluieFond(dur) {
  const n = Math.floor(dur * SR), b = new Float32Array(n); let y = 0;
  for (let i = 0; i < n; i++) { const x = alea(); y += 0.35 * (x - y); b[i] = y * 0.5 + ((alea() + 1) / 2 < 0.0004 ? alea() * 0.8 : 0); }
  return b;
}

// ---- Les styles : plusieurs suites d'accords possibles (degrés en demi-tons depuis la tonique), tempo de base ----
const MAJ = [0, 2, 4, 5, 7, 9, 11], MIN = [0, 2, 3, 5, 7, 8, 10];
const accord = (gamme, deg, n = 4) => Array.from({ length: n }, (_, k) => { const d = deg + 2 * k; return gamme[d % 7] + 12 * Math.floor(d / 7); });
const STYLES = {
  soleil: { gamme: MAJ, bpm: [104, 118], suites: [[0, 5, 3, 4], [0, 4, 5, 3], [3, 0, 4, 5], [0, 3, 5, 4]], toniques: [60, 62, 65, 67, 57] },
  vent:   { gamme: MIN, bpm: [118, 132], suites: [[0, 5, 6, 4], [0, 3, 6, 5], [0, 6, 5, 6], [5, 6, 0, 0]], toniques: [57, 52, 55, 50, 53] },
  pluie:  { gamme: MIN, bpm: [72, 84],   suites: [[0, 3, 6, 2], [5, 3, 0, 4], [0, 5, 3, 4], [3, 4, 0, 0]], toniques: [57, 55, 52, 50, 60] },
  froid:  { gamme: MAJ, bpm: [80, 92],   suites: [[0, 4, 5, 3], [3, 0, 4, 1], [0, 5, 1, 4], [5, 3, 0, 4]], toniques: [64, 62, 60, 67, 59] },
  alerte: { gamme: MIN, bpm: [66, 72],   suites: [[0, 0, 5, 4], [0, 5, 0, 6]], toniques: [57, 55] },
};

/** musique({ ambiance, duree, date, intensite }) -> fichier WAV (Buffer)
 *  ambiance : soleil | vent | pluie | froid | alerte ; date : rend le morceau unique chaque jour ; intensite 0-1 : plus de vent, de pluie, d'énergie */
export function musique({ ambiance = "soleil", duree = 16, date = "", intensite = 0.5 } = {}) {
  const nom = STYLES[ambiance] ? ambiance : "soleil", S = STYLES[nom], I = Math.max(0, Math.min(1, intensite));
  graine = 1; for (const ch of nom + "|" + date) graine = (graine * 31 + ch.charCodeAt(0)) % 2147483647; if (graine <= 0) graine += 2147483646; for (let i = 0; i < 5; i++) alea();
  const ton = choix(S.toniques), suite = choix(S.suites), varRythme = Math.floor((alea() + 1) * 1.5) % 3;
  const bpm = Math.round(S.bpm[0] + (S.bpm[1] - S.bpm[0]) * (nom === "vent" ? I : (alea() + 1) / 2));
  const motif = Array.from({ length: 8 }, () => choix([0, 2, 4, 4, 7, 9, 7, 12, -1]));     // petite mélodie du jour (pentatonique, -1 = silence)
  const P = piste(duree), b = 60 / bpm, M = b * 4, at = t => Math.floor(t * SR);
  if (nom === "pluie") P.mix(0, pluieFond(duree), 0.012 + 0.025 * I);
  if (nom === "vent") P.mix(0, souffle(duree, 0.08 + 0.1 * I, 1), 0.02 + 0.05 * I);
  if (nom === "froid") P.mix(0, souffle(duree, 0.05, 0.5), 0.02);
  for (let m = 0; m * M < duree; m++) {
    const k = m % 4, ac = accord(S.gamme, suite[k], nom === "pluie" || nom === "froid" ? 4 : 3).map(n => n + ton), t0 = m * M, ba = hz(ac[0] - 24);
    const mel = (q, vol, oct = 12, br = 1) => motif.forEach((d, e) => { if (d >= 0 && (e % 2 === 0 || q)) P.mix(at(t0 + e * b / 2), rhodes(hz(ton + d + oct + (S.gamme === MIN && (d === 4 || d === 9) ? -1 : 0)), b * 0.8, br), vol, e % 2 ? 0.4 : -0.4); });
    if (nom === "soleil") {
      for (let q = 0; q < 4; q++) P.mix(at(t0 + q * b), grosseCaisse(0.8), 0.30);
      for (const q of [1, 3]) P.mix(at(t0 + q * b), claque(0.6), 0.10);
      for (let e = 0; e < 8; e++) if (e % 2 || varRythme === 2) P.mix(at(t0 + e * b / 2), charleston(0.04), e % 2 ? 0.035 : 0.02, 0.3);
      const stabs = [[1, 3, 4, 6], [0, 3, 6], [1, 2, 5, 7]][varRythme];
      for (const e of stabs) ac.forEach((n, j) => P.mix(at(t0 + e * b / 2), rhodes(hz(n), b * 0.9, 1.2), 0.035, j % 2 ? 0.3 : -0.3));
      [0, 1.5, 2, 3].forEach((p, j) => P.mix(at(t0 + p * b), basse(ba * (j === 2 ? 1.5 : 1), b * 0.9), 0.20));
      if (m % 2 === 1) mel(false, 0.03, 24, 0.9);
    } else if (nom === "vent") {
      for (let q = 0; q < 4; q++) P.mix(at(t0 + q * b), grosseCaisse(1), 0.28 + 0.06 * I);
      for (const q of [1, 3]) P.mix(at(t0 + q * b), claque(0.8), 0.12);
      for (let s = 0; s < 16; s++) if (I > 0.3 || s % 2 === 0) P.mix(at(t0 + s * b / 4), charleston(s % 4 === 2 ? 0.08 : 0.025), s % 4 === 2 ? 0.045 : 0.02, s % 2 ? 0.4 : -0.4);
      const motBasse = [[0, 0, 0, 1, 0, 0, 2, 0], [0, 1, 0, 0, 0, 1, 0, 2], [0, 0, 2, 0, 0, 0, 1, 2]][varRythme];
      motBasse.forEach((x, e) => P.mix(at(t0 + e * b / 2), basse(ba * [1, 2, 1.5][x], b * 0.45, "synthe"), 0.16));
      for (const e of [[0, 3, 6], [0, 2, 5], [1, 4, 6]][varRythme]) ac.forEach((n, j) => P.mix(at(t0 + e * b / 2), nappe(hz(n), b * 0.4, 1), 0.05, j % 2 ? 0.35 : -0.35));
    } else if (nom === "pluie") {
      const sw = b * 0.16;
      for (const p of [[0, 1.75, 2.5], [0, 2.5], [0, 0.75, 2.5]][varRythme]) P.mix(at(t0 + p * b), grosseCaisse(0.9), 0.30);
      for (const q of [1, 3]) P.mix(at(t0 + q * b), claque(0.3), 0.09);
      for (let e = 0; e < 8; e++) P.mix(at(t0 + e * b / 2 + (e % 2 ? sw : 0)), charleston(0.03), 0.03);
      ac.forEach((n, j) => P.mix(at(t0 + j * 0.03), rhodes(hz(n), M * 0.95, 0.7), 0.05, j % 2 ? 0.25 : -0.25));
      P.mix(at(t0), basse(ba, M * 0.9), 0.20);
      if (m % 2 === 0) mel(false, 0.035, 12, 0.7);
    } else if (nom === "froid") {
      ac.forEach((n, j) => P.mix(at(t0), nappe(hz(n), M * 1.1, 0.35), 0.06, j % 2 ? 0.5 : -0.5));
      P.mix(at(t0), basse(ba, M, "ronde"), 0.14);
      mel(false, 0.022, 24, 0.4);
      for (let q = 0; q < 4; q++) P.mix(at(t0 + q * b + b / 2), charleston(0.02), 0.022);
    } else {
      ac.forEach(n => P.mix(at(t0), nappe(hz(n - 12), M * 1.05, 0.2), 0.06));
      P.mix(at(t0), grosseCaisse(0.5), 0.2);
    }
  }
  const { N, L, R } = P, fi = SR * 0.4, fo = SR * 1.5; let max = 0;
  for (let i = 0; i < N; i++) { const g = Math.min(1, i / fi, (N - i) / fo); L[i] = Math.tanh(L[i] * 1.4) * g; R[i] = Math.tanh(R[i] * 1.4) * g; max = Math.max(max, Math.abs(L[i]), Math.abs(R[i])); }
  const k = max > 0 ? 0.7 / max : 1, buf = Buffer.alloc(44 + N * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
  for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * k * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * k * 32767), 46 + i * 4); }
  return { wav: buf, resume: `${nom}, ${bpm} bpm, tonique ${ton}, suite ${suite.join("-")}, rythme ${varRythme + 1}` };
}
// L'ambiance et l'intensité selon l'accroche du Reel (type, valeur, niveau de vigilance)
export function ambianceDe(accroche) {
  const t = accroche && accroche.t, n = accroche && +accroche.n;
  if (accroche && accroche.niveau) return { ambiance: "alerte", intensite: 0.5 };
  if (t === "vent") return { ambiance: "vent", intensite: Math.min(1, Math.max(0, (n - 40) / 60)) };
  if (t === "pluie") return { ambiance: "pluie", intensite: Math.min(1, n / 30) };
  if (t === "froid") return { ambiance: "froid", intensite: 0.5 };
  return { ambiance: "soleil", intensite: 0.5 };
}

if (process.argv[1] && process.argv[1].endsWith("musique.mjs") && process.argv[2]) {
  const r = musique({ ambiance: process.argv[2], duree: +(process.argv[3] || 16), date: process.argv[5] || "", intensite: process.argv[6] != null ? +process.argv[6] : 0.5 });
  writeFileSync(process.argv[4] || "musique.wav", r.wav); console.log(r.resume);
}
