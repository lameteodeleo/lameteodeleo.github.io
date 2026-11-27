// Musique originale des Reels, composée par le robot (aucun droit d'auteur : rien n'est copié, tout est calculé)
// 4 ambiances bien distinctes, chacune avec son tempo, son rythme et ses instruments :
//   soleil : pop légère et dansante · vent : électro qui avance · pluie : lo-fi feutrée avec la pluie · froid : nappe aérienne et lente
// Usage : node scripts/musique.mjs <ambiance> <durée en s> <sortie.wav>
import { writeFileSync } from "node:fs";

const SR = 44100, TAU = 2 * Math.PI;
const hz = n => 440 * Math.pow(2, (n - 69) / 12);
let graine = 7; const alea = () => (graine = (graine * 16807) % 2147483647) / 2147483647 * 2 - 1;   // hasard reproductible

function piste(duree) {
  const N = Math.ceil(duree * SR), L = new Float32Array(N), R = new Float32Array(N);
  const mix = (i0, buf, vol, pan = 0) => { const g = vol * (1 - pan) / 2 + vol / 2 * 0, gl = vol * Math.min(1, 1 - pan), gr = vol * Math.min(1, 1 + pan);
    for (let i = 0; i < buf.length && i0 + i < N; i++) if (i0 + i >= 0) { L[i0 + i] += buf[i] * gl; R[i0 + i] += buf[i] * gr; } };
  return { N, L, R, mix };
}
// ---- Instruments ----
const env = (t, a, d) => Math.min(1, t / a) * Math.exp(-t / d);
function rhodes(f, dur, brillance = 1) {           // piano électrique (synthèse FM), chaud et rond
  const n = Math.floor(dur * SR), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR, idx = 1.6 * brillance * Math.exp(-t * 3.5);
    b[i] = Math.sin(TAU * f * t + idx * Math.sin(TAU * f * t)) * env(t, 0.004, dur * 0.55) + 0.15 * Math.sin(TAU * f * 2 * t) * Math.exp(-t * 8); }
  return b;
}
function nappe(f, dur, clair = 0.5) {               // nappe : 3 dents de scie désaccordées, filtrées
  const n = Math.floor(dur * SR), b = new Float32Array(n); let y = 0; const det = [0.996, 1, 1.004], ph = [0, 0.33, 0.66];
  for (let i = 0; i < n; i++) { const t = i / SR; let s = 0; for (let k = 0; k < 3; k++) { const p = (ph[k] + f * det[k] * t) % 1; s += 2 * p - 1; }
    const c = 0.02 + 0.12 * clair * (0.6 + 0.4 * Math.sin(TAU * 0.25 * t)); y += c * (s / 3 - y);
    b[i] = y * Math.min(1, t / 0.4, (dur - t) / 0.5); }
  return b;
}
function basse(f, dur, type = "ronde") {            // basse : ronde (sinus) ou synthé (dent de scie filtrée)
  const n = Math.floor(dur * SR), b = new Float32Array(n); let y = 0;
  for (let i = 0; i < n; i++) { const t = i / SR, e = env(t, 0.005, type === "synthe" ? 0.18 : dur * 0.6);
    if (type === "synthe") { const s = 2 * ((f * t) % 1) - 1; y += (0.05 + 0.25 * Math.exp(-t * 12)) * (s - y); b[i] = y * e; }
    else b[i] = (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t)) * e; }
  return b;
}
function grosseCaisse(doux = 1) { const n = Math.floor(0.35 * SR), b = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR, f = 48 + 90 * Math.exp(-t * 28); ph += f / SR; b[i] = Math.sin(TAU * ph) * Math.exp(-t * 9) * doux; } return b; }
function claque(couleur = 0.5) { const n = Math.floor(0.22 * SR), b = new Float32Array(n); let y = 0, z = 0;
  for (let i = 0; i < n; i++) { const t = i / SR, x = alea(); y += 0.5 * (x - y); z = x - y;                          // bruit « médium »
    const multi = t < 0.03 ? (Math.floor(t / 0.01) % 2 ? 0.6 : 1) : 1;
    b[i] = (z * couleur + y * (1 - couleur)) * Math.exp(-t * 18) * multi + Math.sin(TAU * 190 * t) * Math.exp(-t * 30) * 0.3; } return b; }
function charleston(long = 0.05) { const n = Math.floor(long * SR * 2), b = new Float32Array(n); let y = 0;
  for (let i = 0; i < n; i++) { const t = i / SR, x = alea(); y += 0.6 * (x - y); b[i] = (x - y) * Math.exp(-t / long * 3); } return b; }
function souffle(dur, vitesse = 0.2, fort = 1) {     // vent : bruit filtré qui monte et descend
  const n = Math.floor(dur * SR), b = new Float32Array(n); let y = 0;
  for (let i = 0; i < n; i++) { const t = i / SR, c = 0.004 + 0.03 * (0.5 + 0.5 * Math.sin(TAU * vitesse * t - 1.5)); y += c * (alea() - y); b[i] = y * 6 * fort; }
  return b;
}
function pluieFond(dur) {                              // pluie fine et crépitement de vinyle
  const n = Math.floor(dur * SR), b = new Float32Array(n); let y = 0;
  for (let i = 0; i < n; i++) { const x = alea(); y += 0.35 * (x - y); b[i] = y * 0.5 + (Math.random() < 0.0004 ? alea() * 0.8 : 0); }
  return b;
}

// ---- Compositions ----
const COMPO = {
  soleil: { bpm: 112, accords: [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65]], basses: [36, 33, 29, 31] },
  vent:   { bpm: 124, accords: [[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59]], basses: [33, 29, 31, 28] },
  pluie:  { bpm: 78,  accords: [[57, 60, 64, 67], [50, 53, 57, 60], [55, 59, 62, 65], [52, 55, 59, 62]], basses: [33, 26, 31, 28] },
  froid:  { bpm: 88,  accords: [[64, 67, 71, 74], [60, 64, 67, 71], [62, 66, 69, 73], [59, 62, 66, 69]], basses: [40, 36, 38, 35] },
  alerte: { bpm: 70,  accords: [[57, 60, 64], [57, 60, 64], [53, 57, 60], [52, 55, 59]], basses: [33, 33, 29, 28] },
};

export function musique(nom = "soleil", duree = 16) {
  graine = 7 + nom.length; const C = COMPO[nom] || COMPO.soleil, P = piste(duree), b = 60 / C.bpm, M = b * 4, at = t => Math.floor(t * SR);
  if (nom === "pluie") P.mix(0, pluieFond(duree), 0.022);
  if (nom === "vent") P.mix(0, souffle(duree, 0.12, 1), 0.05);
  if (nom === "froid") P.mix(0, souffle(duree, 0.06, 0.5), 0.03);
  for (let m = 0; m * M < duree; m++) {
    const k = m % 4, ac = C.accords[k], t0 = m * M, ba = hz(C.basses[k]);
    if (nom === "soleil") {                         // pop légère : piano en contretemps, basse qui bondit, grosse caisse douce
      for (let q = 0; q < 4; q++) P.mix(at(t0 + q * b), grosseCaisse(0.8), 0.32);
      for (const q of [1, 3]) P.mix(at(t0 + q * b), claque(0.6), 0.10);
      for (let e = 0; e < 8; e++) if (e % 2) P.mix(at(t0 + e * b / 2), charleston(0.04), 0.035, 0.3);
      for (const e of [1, 3, 4, 6]) ac.forEach((n, j) => P.mix(at(t0 + e * b / 2), rhodes(hz(n + 12), b * 0.9, 1.2), 0.035, j % 2 ? 0.3 : -0.3));
      [0, 1.5, 2, 3].forEach((p, j) => P.mix(at(t0 + p * b), basse(ba * (j === 2 ? 1.5 : 1), b * 0.9), 0.20));
    } else if (nom === "vent") {                    // électro qui avance : basse synthé en croches, accords brefs, souffle
      for (let q = 0; q < 4; q++) P.mix(at(t0 + q * b), grosseCaisse(1), 0.30);
      for (const q of [1, 3]) P.mix(at(t0 + q * b), claque(0.8), 0.12);
      for (let s = 0; s < 16; s++) P.mix(at(t0 + s * b / 4), charleston(s % 4 === 2 ? 0.08 : 0.025), s % 4 === 2 ? 0.045 : 0.02, s % 2 ? 0.4 : -0.4);
      for (let e = 0; e < 8; e++) P.mix(at(t0 + e * b / 2), basse(ba * (e === 7 ? 2 : 1), b * 0.45, "synthe"), 0.16);
      for (const e of [0, 3, 6]) ac.forEach((n, j) => P.mix(at(t0 + e * b / 2), nappe(hz(n + 12), b * 0.4, 1), 0.05, j % 2 ? 0.35 : -0.35));
    } else if (nom === "pluie") {                   // lo-fi feutrée : rythme balancé, piano électrique doux, pluie en fond
      const sw = b * 0.16;
      for (const p of [0, 1.75, 2.5]) P.mix(at(t0 + p * b), grosseCaisse(0.9), 0.30);
      for (const q of [1, 3]) P.mix(at(t0 + q * b), claque(0.3), 0.09);
      for (let e = 0; e < 8; e++) P.mix(at(t0 + e * b / 2 + (e % 2 ? sw : 0)), charleston(0.03), 0.03);
      ac.forEach((n, j) => P.mix(at(t0 + j * 0.03), rhodes(hz(n), M * 0.95, 0.7), 0.05, j % 2 ? 0.25 : -0.25));
      P.mix(at(t0 + 2.5 * b), rhodes(hz(ac[ac.length - 1] + 12), b * 1.4, 0.8), 0.04, 0.4);
      P.mix(at(t0), basse(ba, M * 0.9), 0.20);
    } else if (nom === "froid") {                   // aérien et lent : grande nappe claire, quelques notes cristallines, pas de batterie lourde
      ac.forEach((n, j) => P.mix(at(t0), nappe(hz(n), M * 1.1, 0.35), 0.06, j % 2 ? 0.5 : -0.5));
      P.mix(at(t0), basse(ba, M, "ronde"), 0.14);
      for (const p of [0, 1.5, 3]) P.mix(at(t0 + p * b), rhodes(hz(ac[(p * 2) % ac.length | 0] + 24), b * 2, 0.4), 0.025, p === 1.5 ? 0.5 : -0.5);
      for (let q = 0; q < 4; q++) P.mix(at(t0 + q * b + b / 2), charleston(0.02), 0.025);
    } else {                                        // alerte : sobre, juste une nappe grave et une pulsation lente
      ac.forEach(n => P.mix(at(t0), nappe(hz(n - 12), M * 1.05, 0.2), 0.06));
      P.mix(at(t0), grosseCaisse(0.5), 0.2);
    }
  }
  // fondus, compression douce, normalisation
  const { N, L, R } = P, fi = SR * 0.4, fo = SR * 1.5; let max = 0;
  for (let i = 0; i < N; i++) { const g = Math.min(1, i / fi, (N - i) / fo); L[i] = Math.tanh(L[i] * 1.4) * g; R[i] = Math.tanh(R[i] * 1.4) * g; max = Math.max(max, Math.abs(L[i]), Math.abs(R[i])); }
  const k = max > 0 ? 0.7 / max : 1, buf = Buffer.alloc(44 + N * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
  for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * k * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * k * 32767), 46 + i * 4); }
  return buf;
}
// L'ambiance selon l'accroche du Reel
export const ambianceDe = (accroche, niveau) => niveau ? "alerte" : ({ vent: "vent", pluie: "pluie", froid: "froid" })[accroche] || "soleil";

if (process.argv[1] && process.argv[1].endsWith("musique.mjs") && process.argv[2]) {
  writeFileSync(process.argv[4] || "musique.wav", musique(process.argv[2], +(process.argv[3] || 16)));
}
