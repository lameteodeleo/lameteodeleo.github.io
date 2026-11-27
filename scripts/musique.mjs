// Musique originale des Reels, fabriquée par le robot (aucun droit d'auteur : rien n'est copié, tout est calculé)
// Une ambiance par temps : soleil (douce et lumineuse), vent (rythmée), pluie (calme), froid (cristalline), alerte (sobre).
// Usage : node scripts/musique.mjs <ambiance> <durée en s> <sortie.wav>
import { writeFileSync } from "node:fs";

const SR = 44100;
const note = n => 440 * Math.pow(2, (n - 69) / 12);          // numéro MIDI -> fréquence
const AMB = {
  soleil: { bpm: 96, accords: [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65]], basse: [48, 45, 41, 43], arpege: true, batt: 0.5, eclat: 1 },
  vent:   { bpm: 112, accords: [[57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 67], [52, 55, 59, 64]], basse: [45, 41, 43, 40], arpege: true, batt: 1, eclat: 0.8 },
  pluie:  { bpm: 76, accords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], basse: [45, 41, 36, 43], arpege: true, batt: 0, eclat: 0.6 },
  froid:  { bpm: 84, accords: [[64, 67, 71, 74], [60, 64, 67, 71], [62, 65, 69, 72], [59, 62, 67, 71]], basse: [52, 48, 50, 47], arpege: true, batt: 0, eclat: 1.2 },
  alerte: { bpm: 70, accords: [[57, 60, 64], [57, 60, 64], [53, 57, 60], [52, 55, 59]], basse: [45, 45, 41, 40], arpege: false, batt: 0, eclat: 0.3 },
};

export function musique(nom = "soleil", duree = 16) {
  const A = AMB[nom] || AMB.soleil, N = Math.ceil(duree * SR), L = new Float32Array(N), R = new Float32Array(N);
  const temps = 60 / A.bpm, mesure = temps * 4;
  const add = (t0, d, f, vol, timbre, pan = 0) => {          // une note avec enveloppe douce
    const i0 = Math.floor(t0 * SR), n = Math.floor(d * SR);
    for (let i = 0; i < n && i0 + i < N; i++) {
      const t = i / SR, att = Math.min(1, t / (timbre === "nappe" ? 0.25 : 0.008)), rel = Math.exp(-t * (timbre === "nappe" ? 0.6 : timbre === "basse" ? 2.2 : 4.5));
      const ph = 2 * Math.PI * f * t;
      const v = timbre === "nappe" ? (Math.sin(ph) + 0.35 * Math.sin(2 * ph + 0.3) + 0.12 * Math.sin(3 * ph)) * (0.85 + 0.15 * Math.sin(2 * Math.PI * 0.3 * t))
        : timbre === "basse" ? Math.sin(ph) + 0.2 * Math.sin(2 * ph)
        : (Math.sin(ph) + 0.5 * Math.sin(2 * ph) * Math.exp(-t * 6) + 0.25 * Math.sin(4 * ph) * Math.exp(-t * 9) * A.eclat);   // petite cloche / piano
      const s = v * vol * att * rel, g = (1 - pan) / 2, d2 = (1 + pan) / 2;
      L[i0 + i] += s * (0.5 + g * 0.5); R[i0 + i] += s * (0.5 + d2 * 0.5);
    }
  };
  for (let m = 0; m * mesure < duree; m++) {
    const k = m % A.accords.length, ac = A.accords[k], t0 = m * mesure;
    ac.forEach((n, j) => add(t0, mesure * 1.15, note(n), 0.045, "nappe", j % 2 ? 0.3 : -0.3));          // nappe d'accord
    add(t0, mesure, note(A.basse[k]), 0.11, "basse");                                                    // basse
    if (A.arpege) for (let b = 0; b < 8; b++) {                                                          // arpège en croches
      const n = ac[[0, 2, 1, 3, 2, 1, 3, 2][b] % ac.length] + 12;
      add(t0 + b * temps / 2, temps * 1.6, note(n), b % 2 ? 0.035 : 0.05, "pluck", b % 2 ? 0.5 : -0.5);
    }
    if (A.batt) for (let b = 0; b < 8; b++) {                                                            // petite percussion douce (bruit filtré)
      const i0 = Math.floor((t0 + b * temps / 2) * SR), fort = b % 4 === 0 ? 1 : b % 2 ? 0.35 : 0.6;
      let y = 0; for (let i = 0; i < SR * 0.06 && i0 + i < N; i++) { y = 0.7 * y + 0.3 * (Math.random() * 2 - 1); const s = y * 0.05 * A.batt * fort * Math.exp(-i / SR * 60); L[i0 + i] += s; R[i0 + i] += s; }
    }
  }
  // fondu d'entrée et de sortie, puis normalisation douce
  const fi = SR * 0.6, fo = SR * 1.5; let max = 0;
  for (let i = 0; i < N; i++) { const g = Math.min(1, i / fi, (N - i) / fo); L[i] *= g; R[i] *= g; max = Math.max(max, Math.abs(L[i]), Math.abs(R[i])); }
  const k = max > 0 ? 0.6 / max : 1;
  const buf = Buffer.alloc(44 + N * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
  for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(Math.tanh(L[i] * k) * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(Math.tanh(R[i] * k) * 32767), 46 + i * 4); }
  return buf;
}
// L'ambiance selon l'accroche du Reel
export const ambianceDe = (accroche, niveau) => niveau ? "alerte" : ({ vent: "vent", pluie: "pluie", froid: "froid" })[accroche] || "soleil";

if (process.argv[1] && process.argv[1].endsWith("musique.mjs") && process.argv[2]) {
  writeFileSync(process.argv[4] || "musique.wav", musique(process.argv[2], +(process.argv[3] || 16)));
}
