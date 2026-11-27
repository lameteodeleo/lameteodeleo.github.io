// La météo de Léo : publication automatique du Reel (le soir, pour demain) et de la story (le matin, pour aujourd'hui)
// sur Instagram et sur la Page Facebook, au nom de la Page.
//
// Règles de fiabilité :
//  - on ne publie qu'après une mise à jour météo réussie, avec des prévisions de moins de 3 heures ;
//  - jamais de chiffres de démonstration : seulement les prévisions réelles ;
//  - jamais en double : si un Reel ou une story est déjà paru aujourd'hui sur un réseau, on n'y touche pas ;
//  - la clé (META_PAGE_TOKEN) n'est jamais affichée dans le journal.
//
// MODE : "auto" (après la mise à jour météo), "reel", "story" (forcer), "test" (tout préparer, sans publier),
//        "controle-reel", "controle-story" (vérifier en fin de créneau, et alerter par e-mail si rien n'est paru),
//        "test-alerte" (préparer une alerte vigilance simulée, sans rien publier).
//
// Alerte vigilance orange ou rouge (Bouches-du-Rhône), à chaque mise à jour en mode auto :
//  - seulement orange (3) ou rouge (4), jamais jaune ; seulement entre 7 h et 22 h (heure de Paris) ;
//  - double vérification : le bulletin brut de Météo-France publié sur le site ET l'appli doivent l'afficher ;
//  - une seule fois par épisode : jamais deux fois la même alerte (même niveau, mêmes phénomènes, même jour),
//    et au plus une alerte par 20 heures, sauf si le niveau monte (orange → rouge) ;
//  - publiée en story (Instagram et Facebook) et en publication sur la Page Facebook, sans humour.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const SITE = process.env.SITE_URL || "https://lameteodeleo.fr/";
const GV = "v27.0", G = `https://graph.facebook.com/${GV}`;
const PAGE_ID = "1389664764238207";
// La clé : une clé de Page, ou la clé d'un « utilisateur système » du portefeuille business (qui n'expire pas).
// Dans ce second cas, le robot en tire la clé de la Page au démarrage (voir cleDePage).
const CLE_SECRET = process.env.META_PAGE_TOKEN || "";
let TOKEN = CLE_SECRET;
const MODE = (process.env.MODE || "auto").trim();
const RESEAUX = (process.env.RESEAUX || "instagram,facebook").split(",").map(s => s.trim()).filter(Boolean);
const OUT = "publication";
const AGE_MAX_H = +(process.env.AGE_MAX_H || 3);

const log = (...a) => console.log(...a);
const masque = s => { let t = String(s); for (const k of [CLE_SECRET, TOKEN]) if (k) t = t.split(k).join("***"); return t; };
const dodo = ms => new Promise(r => setTimeout(r, ms));

// ---------- Heure de Paris ----------
const paris = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  return { jour: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
};
const maintenant = paris();
const jourParis = d => paris(new Date(d)).jour;
// Créneaux (heure de Paris) : la première mise à jour réussie dans le créneau déclenche la publication
const CRENEAU = { story: [6 * 60 + 45, 10 * 60 + 30], reel: [17 * 60, 21 * 60] };
const dansCreneau = t => maintenant.min >= CRENEAU[t][0] && maintenant.min < CRENEAU[t][1];

// ---------- API de Meta ----------
async function api(chemin, { methode = "GET", params = {}, corps = null, entetes = {}, url = null } = {}) {
  const u = new URL(url || G + chemin);
  if (!url) { for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); u.searchParams.set("access_token", TOKEN); }
  for (let essai = 1; ; essai++) {
    let r, txt;
    try { r = await fetch(u, { method: methode, body: corps, headers: entetes }); txt = await r.text(); }
    catch (e) { if (essai < 3) { await dodo(5000 * essai); continue; } throw new Error(`Réseau : ${e.message}`); }
    let j; try { j = JSON.parse(txt); } catch { j = { brut: txt.slice(0, 300) }; }
    if (r.ok && !j.error) return j;
    const err = j.error || {};
    const passager = r.status >= 500 || err.is_transient || [1, 2, 4, 17, 341].includes(err.code);
    if (passager && essai < 3) { await dodo(8000 * essai); continue; }
    const e = new Error(masque(`Meta ${r.status} : ${err.message || txt.slice(0, 300)} (code ${err.code || "?"}${err.error_subcode ? "/" + err.error_subcode : ""})`));
    e.code = err.code; throw e;
  }
}

// ---------- Déjà publié aujourd'hui ? ----------
async function dejaPublie(type, reseau, IG) {
  const auj = maintenant.jour;
  try {
    if (reseau === "instagram") {
      if (type === "reel") { const r = await api(`/${IG}/media`, { params: { fields: "media_product_type,timestamp", limit: "10" } }); return (r.data || []).some(m => m.media_product_type === "REELS" && jourParis(m.timestamp) === auj); }
      const r = await api(`/${IG}/stories`, { params: { fields: "timestamp", limit: "25" } }); return (r.data || []).some(m => jourParis(m.timestamp) === auj);
    }
    if (type === "reel") { const r = await api(`/${PAGE_ID}/video_reels`, { params: { fields: "created_time", limit: "10" } }); return (r.data || []).some(m => m.created_time && jourParis(m.created_time) === auj); }
    const r = await api(`/${PAGE_ID}/stories`, { params: { limit: "25" } });
    return (r.data || []).some(m => { const t = m.creation_time ? (/^\d+$/.test(String(m.creation_time)) ? +m.creation_time * 1000 : m.creation_time) : null; return t && jourParis(t) === auj; });
  } catch (e) { log(`  (vérification « déjà publié » impossible sur ${reseau} : ${e.message})`); return null; }
}

// ---------- Alerte vigilance orange ou rouge ----------
const ALERTE_H = [7 * 60, 22 * 60];
// Le bulletin brut de Météo-France, tel que publié sur le site (première vérification, indépendante de l'appli)
async function vigilanceBrute() {
  const r = await fetch(SITE + "data/meteo.json?robot=" + Date.now());
  if (!r.ok) throw new Error(`Bulletin de vigilance illisible (HTTP ${r.status}).`);
  const V = (await r.json()).vigilance;
  if (!V) return { niveau: 0, detail: "aucun bulletin" };
  let niveau = 0; const det = [];
  for (const k of ["J", "J1"]) {
    const P = V[k]; if (!P || !P.fin || new Date(P.fin) <= new Date()) continue;
    const d = (P.deps || {})["13"] || {};
    for (const p of [...(d.phen || []), ...((d.cote || {}).phen || [])]) {
      if (p.c >= 3 && !(p.a && new Date(p.a) <= new Date())) { niveau = Math.max(niveau, p.c); det.push(`${k} ${p.nom} ${["", "vert", "jaune", "orange", "rouge"][p.c]}`); }
    }
  }
  return { niveau, detail: det.join(", ") || "rien d'orange ni de rouge" };
}
// Les alertes déjà publiées sur la Page (on les reconnaît à leur première ligne « ⚠️ Vigilance … »)
async function alertesPubliees() {
  const r = await api(`/${PAGE_ID}/posts`, { params: { fields: "message,created_time", limit: "25" } });
  return (r.data || []).filter(p => /^⚠️ Vigilance (orange|rouge)/.test(p.message || "")).map(p => {
    const sig = p.message.split("\n")[0].trim();
    return { sig, niveau: /^⚠️ Vigilance rouge/.test(sig) ? 4 : 3, age: (Date.now() - new Date(p.created_time).getTime()) / 36e5 };
  });
}
async function ouvrirAppli(nav, simulee) {
  const ctx = await nav.newContext({ viewport: { width: 420, height: 900 }, locale: "fr-FR", timezoneId: "Europe/Paris", serviceWorkers: "block", bypassCSP: true });
  const page = await ctx.newPage();
  await page.route("**/cloud.umami.is/**", r => r.abort());
  await page.route("**/api-gateway.umami.dev/**", r => r.abort());
  await page.goto(SITE + "?robot=" + Date.now(), { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !document.body.classList.contains("boot") && typeof alerteRobot === "function", null, { timeout: 30000 });
  if (simulee) await page.evaluate(([niv, nom, J]) => {   // essai : une vigilance inventée, jamais publiée
    const h = 36e5, iso = t => new Date(t).toISOString(), d0 = new Date(); d0.setHours(6, 0, 0, 0);
    const ph = J => [{ id: 1, nom, c: niv, de: iso(+d0 + (J * 24 + 6) * h), a: iso(+d0 + (J * 24 + 18) * h) }];
    const per = (k, J) => ({ debut: iso(+d0 + J * 24 * h), fin: iso(+d0 + (J + 1) * 24 * h), deps: { "13": { c: k ? niv : 1, phen: k ? ph(J) : [] } } });
    DATA.vigilance = { maj: iso(Date.now()), J: per(J === 0, 0), J1: per(J === 1, 1) };
  }, simulee);
  return page;
}
async function traiterAlerte(IG) {
  const test = MODE === "test-alerte";
  if (!test && !(maintenant.min >= ALERTE_H[0] && maintenant.min < ALERTE_H[1])) { log("Alerte vigilance : hors de 7 h – 22 h, rien à faire."); return; }
  const simulee = test ? (process.env.ALERTE_SIMULEE || "3|vent violent|0").split("|").map((x, i) => i === 1 ? x : +x) : null;
  // 1re vérification : le bulletin brut
  const brut = test ? { niveau: simulee[0], detail: "vigilance simulée (essai)" } : await vigilanceBrute();
  log(`Alerte vigilance : bulletin Météo-France du 13 → ${brut.detail}`);
  if (brut.niveau < 3) return;
  await mkdir(OUT, { recursive: true });
  const nav = await chromium.launch({ ...(process.env.CHROME_CHANNEL === "aucun" ? {} : { channel: process.env.CHROME_CHANNEL || "chrome" }) });
  let a, leg, fichiers = {};
  try {
    const page = await ouvrirAppli(nav, simulee);
    // 2e vérification : l'appli elle-même, avec les vraies prévisions
    a = await page.evaluate(() => alerteRobot());
    if (!a) { log("Alerte vigilance : l'appli n'affiche aucune vigilance orange ou rouge en cours → rien n'est publié."); return; }
    if (a.niveau < 3 || a.niveau > brut.niveau) throw new Error(`Alerte vigilance : l'appli (niveau ${a.niveau}) et le bulletin (niveau ${brut.niveau}) ne concordent pas → rien n'est publié.`);
    leg = await page.evaluate(J => legendeAlerte(J), a.J);
    log(`Alerte vigilance : ${leg.sig}`);
    // Jamais deux fois : même alerte déjà parue, ou une alerte de même niveau ou plus dans les 20 dernières heures
    if (!test || TOKEN) {
      const deja = await alertesPubliees();
      const meme = deja.find(p => p.sig === leg.sig), recente = deja.find(p => p.age < 20 && p.niveau >= a.niveau);
      if (meme || recente) { log(`Alerte vigilance : déjà publiée (${(meme || recente).sig}, il y a ${(meme || recente).age.toFixed(1)} h) → rien de plus.`); if (!test) return; }
    }
    for (const f of ["instagram", "facebook", "post"]) {
      const b64 = await page.evaluate(([J, f]) => imageAlerte(J, f).toDataURL("image/jpeg", .92).split(",")[1], [a.J, f]);
      fichiers[f] = `${OUT}/alerte-${f}.jpg`; await writeFile(fichiers[f], Buffer.from(b64, "base64"));
    }
    // Dernière vérification juste avant de publier : la vigilance est-elle toujours en cours ?
    if (!test) { const re = await vigilanceBrute(); if (re.niveau < a.niveau) { log(`Alerte vigilance : levée ou abaissée entre-temps (${re.detail}) → rien n'est publié.`); return; } }
  } finally { await nav.close(); }
  const storyIG = videoDepuisImage(fichiers.instagram, `${OUT}/alerte-instagram.mp4`);
  log(`Alerte prête : ${storyIG} (${decrire(storyIG)}), ${fichiers.facebook}, ${fichiers.post}\nLégende :\n${leg.texte}\n`);
  if (test) { log("Essai d'alerte : rien n'est publié."); return; }

  const faits = [], echecs = [];
  const essayer = async (nom, f) => { try { const l = await f(); faits.push(`${nom} : ${l}`); log(`✔ Alerte publiée sur ${nom} : ${l}`); } catch (e) { echecs.push(`${nom} : ${masque(e.message)}`); log(`✘ Alerte ${nom} : ${masque(e.message)}`); } };
  await essayer("Page Facebook", () => envoyerPhotoFB(fichiers.post, leg.texte));
  if (RESEAUX.includes("facebook")) await essayer("story Facebook", () => envoyerStoryFB(fichiers.facebook));
  if (RESEAUX.includes("instagram") && IG) await essayer("story Instagram", () => envoyerIG(IG, "STORIES", storyIG, ""));
  await writeFile(`${OUT}/alerte.txt`, `${leg.sig}\n\nPublié automatiquement par le robot :\n${faits.map(x => "- " + x).join("\n") || "- rien"}\n${echecs.length ? "\nÉchecs :\n" + echecs.map(x => "- " + x).join("\n") + "\n" : ""}\nTexte publié :\n\n${leg.texte}\n`);
  if (echecs.length) throw new Error(`Alerte vigilance incomplète. ${echecs.join(" ; ")}`);
}

// ---------- Contrôle général : le site en ligne et toute l'appli, à chaque mise à jour ----------
// Mots que le dictionnaire ne connaît pas mais qui sont justes (noms de lieux, mots provençaux, mots de l'appli)
const MOTS_OK = new Set(("lameteodeleo meteo mistral cigales santons calanques pastis boulistes platanes rafales km mm ressenti appli apps app " +
  "arome arpege vigilance submersion inondation reels reel story stories hashtag hashtags insta instagram facebook tiktok " +
  "camargue alpilles luberon durance sainte victoire mirabeau frioul panier corniche baux rhône berre vaccarès crau garlaban " +
  "aixois marseillais provençal provençale provençaux etalab ok wifi app tanqués baou castellas castrum roumavage magistralis olivades boat").split(" "));
function verifierOrthographe(textes) {
  let sortie = "";
  try { sortie = execFileSync("hunspell", ["-d", "fr_FR", "-l", "-i", "UTF-8"], { input: textes.join("\n"), maxBuffer: 1 << 24 }).toString(); }
  catch (e) { return { erreur: "dictionnaire indisponible (" + e.message.split("\n")[0] + ")" }; }
  const compte = {};
  for (const m of sortie.split(/\n/).map(x => x.trim()).filter(Boolean)) {
    const w = m.replace(/^(l|d|qu|n|s|j|m|t|c|jusqu|lorsqu|puisqu)['’]/i, "").replace(/[.,;:!?»)]+$/, "");
    if (/\d|^[A-ZÉÈÀÂÎÔ]|^#|https?|\.(fr|com)$|_/.test(w) || w.length < 3 || MOTS_OK.has(w.toLowerCase())) continue;   // nombres, noms propres, liens
    compte[m] = (compte[m] || 0) + 1;
  }
  return { inconnus: Object.entries(compte).sort((a, b) => b[1] - a[1]).map(([m, n]) => n > 1 ? `${m} (×${n})` : m) };
}
async function controleGeneral(IG, complet) {
  const G = [], A = [];
  // Le site en ligne : les prévisions sont fraîches, les pages des communes et le plan du site répondent
  try {
    const r = await fetch(SITE + "data/meteo.json?robot=" + Date.now()); const d = await r.json();
    const age = (Date.now() - new Date(d.maj).getTime()) / 36e5, n = (d.communes || []).length;
    if (age > 5) G.push(`prévisions en ligne vieilles de ${age.toFixed(1)} h`); else if (age > 3.5) A.push(`prévisions en ligne vieilles de ${age.toFixed(1)} h`);
    if (n < 110) G.push(`seulement ${n} communes dans les prévisions en ligne`);
    if (!d.vigilance) A.push("bulletin de vigilance absent de la dernière mise à jour");
  } catch (e) { G.push("prévisions en ligne illisibles : " + e.message); }
  for (const u of ["meteo/aix-en-provence/", "meteo/", "sitemap.xml", "manifest.webmanifest"]) {
    try { const r = await fetch(SITE + u, { method: "GET" }); if (!r.ok) G.push(`${SITE}${u} répond ${r.status}`); } catch (e) { G.push(`${SITE}${u} injoignable`); }
  }
  // L'appli elle-même, commune par commune, sur 3 jours
  const nav = await chromium.launch({ ...(process.env.CHROME_CHANNEL === "aucun" ? {} : { channel: process.env.CHROME_CHANNEL || "chrome" }) });
  try {
    const page = await ouvrirAppli(nav, null), erreurs = [];
    page.on("pageerror", e => erreurs.push(e.message));
    const r = await page.evaluate(() => typeof controleAppli === "function" ? controleAppli() : { graves: ["contrôle absent de l'appli"], avert: [] });
    G.push(...r.graves); A.push(...r.avert);
    if (erreurs.length) G.push("erreurs dans l'appli : " + [...new Set(erreurs)].slice(0, 3).join(" | "));
    if (complet) {
      // Petit écran (320 px de large, un vieux téléphone) : rien ne doit dépasser sur le côté
      await page.setViewportSize({ width: 320, height: 740 });
      const larges = await page.evaluate(() => { const out = []; for (const n of ["Marseille", "Saint-Rémy-de-Provence", "Saintes-Maries-de-la-Mer", "Le Puy-Sainte-Réparade"]) { const i = idx(n); if (i < 0) continue; st.c = i; for (const j of [0, 1]) { st.jour = j; render(); const w = document.documentElement.scrollWidth; if (w > innerWidth + 1) out.push(`${n} (J+${j}) : ${w} px pour ${innerWidth}`) } } return out; });
      for (const l of larges) A.push("petit écran, la page dépasse sur le côté : " + l);
      // Les liens de l'appli mènent bien quelque part
      const liens = await page.evaluate(() => [...new Set([...document.querySelectorAll("a[href^='http']")].map(a => a.href.split("#")[0]))]);
      for (const u of liens.slice(0, 25)) {
        try { const r = await fetch(u, { method: "GET", redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (verification des liens)" } }); if (r.status >= 400 && ![401, 403, 429].includes(r.status)) A.push(`lien cassé (${r.status}) : ${u}`); }
        catch (e) { A.push(`lien injoignable : ${u}`); }
      }
      log(`Liens vérifiés : ${Math.min(liens.length, 25)}`);
      // Orthographe de tous les textes de l'appli (phrases du sourire, conseils, consignes, anecdotes, écrans)
      const orth = verifierOrthographe(await page.evaluate(() => textesAppli()));
      if (orth.erreur) A.push("orthographe : " + orth.erreur);
      else { log(`Orthographe : ${orth.inconnus.length} mot(s) inconnu(s) du dictionnaire`); if (orth.inconnus.length) A.push("orthographe, mots à vérifier : " + orth.inconnus.slice(0, 40).join(", ")); }
    }
  } catch (e) { G.push("l'appli ne s'ouvre pas : " + e.message); }
  finally { await nav.close(); }
  if (complet) {
    // Sécurité : aucune clé, aucune adresse privée, aucun nom d'outil dans ce qui est public (site en ligne et fichiers du dépôt)
    const MOTIFS = [[/EAA[A-Za-z0-9]{30,}/, "une clé Meta"], [/eyJ[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}/, "un jeton d'accès"], [/@orange\.fr/i, "une adresse e-mail privée"], [new RegExp(["cl", "aude|an", "thropic"].join(""), "i"), "un nom d'outil"]];
    const fouiller = (nom, txt) => { for (const [re, quoi] of MOTIFS) if (re.test(txt)) G.push(`sécurité : ${quoi} apparaît dans ${nom}`); };
    for (const u of ["", "data/meteo.json", "meteo/aix-en-provence/", "sw.js", "manifest.webmanifest"]) { try { fouiller(SITE + u, await (await fetch(SITE + u)).text()); } catch (e) {} }
    try { for (const f of execFileSync("git", ["ls-files"]).toString().split("\n").filter(f => f && !/\.(png|jpg|ico|woff2?)$/.test(f) && !f.startsWith("scripts/") && !f.startsWith(".github/"))) fouiller(f, await readFile(f, "utf8")); } catch (e) { log("Fichiers du dépôt : vérification impossible"); }
    // Le nom de domaine (payé chez OVH) et le certificat https : ne jamais les laisser expirer
    try {
      const w = execFileSync("whois", ["lameteodeleo.fr"], { timeout: 30000 }).toString(), m = w.match(/Expiry Date:\s*(\S+)/i);
      if (m) { const j = (new Date(m[1]) - Date.now()) / 864e5; log(`Nom de domaine : expire dans ${Math.round(j)} jours`); if (j < 15) G.push(`le nom de domaine expire dans ${Math.round(j)} jours : renouvelle-le chez OVH`); else if (j < 45) A.push(`le nom de domaine expire dans ${Math.round(j)} jours (vérifie le renouvellement automatique chez OVH)`); }
    } catch (e) { log("Nom de domaine : vérification impossible"); }
    try {
      const c = execFileSync("sh", ["-c", "echo | openssl s_client -servername lameteodeleo.fr -connect lameteodeleo.fr:443 2>/dev/null | openssl x509 -noout -enddate"], { timeout: 30000 }).toString(), m = c.match(/notAfter=(.+)/);
      if (m) { const j = (new Date(m[1]) - Date.now()) / 864e5; log(`Certificat https : valable encore ${Math.round(j)} jours`); if (j < 7) G.push(`le certificat https expire dans ${Math.round(j)} jours`); }
    } catch (e) { log("Certificat https : vérification impossible"); }
  }
  // Le lien de la bio Instagram et le site de la Page Facebook
  if (complet && TOKEN) {
    try { const ig = IG ? await api(`/${IG}`, { params: { fields: "website" } }) : null; if (ig && !/lameteodeleo\.fr/.test(ig.website || "")) A.push("le lien de la bio Instagram ne pointe pas vers lameteodeleo.fr"); } catch (e) { log("Lien de la bio Instagram : vérification impossible"); }
    try { const fb = await api(`/${PAGE_ID}`, { params: { fields: "website" } }); if (!/lameteodeleo\.fr/.test(fb.website || "")) A.push("le site indiqué sur la Page Facebook n'est pas lameteodeleo.fr"); } catch (e) { log("Site de la Page Facebook : vérification impossible"); }
  }
  for (const a of A) log(`⚠️ Contrôle : ${a}`);
  for (const g of G) log(`❌ Contrôle : ${g}`);
  log(`Contrôle général : ${G.length ? G.length + " défaut(s) grave(s)" : "tout est bon"}${A.length ? `, ${A.length} point(s) à surveiller` : ""}`);
  return G.length ? new Error(`Contrôle de l'appli : ${G.slice(0, 5).join(" ; ")}`) : null;
}

// ---------- Fabrication des vidéos et images, avec l'appli elle-même ----------
async function fabriquer(type) {
  await mkdir(OUT, { recursive: true });
  const nav = await chromium.launch({ ...(process.env.CHROME_CHANNEL === "aucun" ? {} : { channel: process.env.CHROME_CHANNEL || "chrome" }), args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const ctx = await nav.newContext({ viewport: { width: 420, height: 900 }, locale: "fr-FR", timezoneId: "Europe/Paris", serviceWorkers: "block", bypassCSP: true });
    const page = await ctx.newPage();
    const erreurs = []; page.on("pageerror", e => erreurs.push(e.message));
    await page.route("**/cloud.umami.is/**", r => r.abort());          // le robot ne compte pas comme un visiteur
    await page.route("**/api-gateway.umami.dev/**", r => r.abort());
    await page.goto(SITE + "?robot=" + Date.now(), { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !document.body.classList.contains("boot"), null, { timeout: 30000 });
    const etat = await page.evaluate(() => ({ reel: enReel(), maj: DATA && DATA.maj ? DATA.maj.toISOString() : null }));
    if (!etat.reel || !etat.maj) throw new Error("Les prévisions réelles ne sont pas chargées : publication annulée (jamais de chiffres de démonstration).");
    const age = (Date.now() - new Date(etat.maj).getTime()) / 36e5;
    log(`Prévisions du ${new Date(etat.maj).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} (il y a ${age.toFixed(1)} h)`);
    if (age > AGE_MAX_H) throw new Error(`Prévisions trop anciennes (${age.toFixed(1)} h, maximum ${AGE_MAX_H} h) : publication annulée.`);
    const J = type === "reel" ? (process.env.REEL_JOUR === "aujourdhui" ? 0 : 1) : 0;   // le Reel du soir est pour demain ; à la main, on peut faire celui du jour
    await page.evaluate(async J => { studioOuvert = true; route(); document.querySelectorAll("#v-studio details").forEach(d => d.open = true); postJour = J; postJourChoisi = Date.now(); await buildSlides(); }, J);
    const res = {};
    for (const reseau of RESEAUX) {
      if (type === "story") {
        const b64 = await page.evaluate(async r => { STORY_AUTO = r; try { return slideStory().toDataURL("image/jpeg", .92).split(",")[1]; } finally { STORY_AUTO = null; } }, reseau);
        const img = `${OUT}/story-${reseau}.jpg`; await writeFile(img, Buffer.from(b64, "base64"));
        res[reseau] = { image: img, legende: "" };
      } else {
        await page.click(`#reelReseau .chip[data-r="${reseau}"]`);
        const legende = await page.$eval("#caption", e => e.value);
        await page.click("#reelGo");
        await page.waitForFunction(() => document.querySelector("#reelOut video"), null, { timeout: 240000 });
        // Contrôle du Reel avant publication : un défaut grave bloque tout (et GitHub envoie un e-mail)
        const ctl = await page.evaluate(l => controleReel(l), legende);
        for (const a of ctl.avert) log(`⚠️ Reel ${reseau} : ${a}`);
        if (ctl.graves.length) throw new Error(`Reel bloqué par le contrôle (${reseau}) : ${ctl.graves.join(" ; ")}`);
        log(`Contrôle du Reel ${reseau} : ${ctl.avert.length ? ctl.avert.length + " point(s) à surveiller" : "tout est bon"} ✔`);
        const info = await page.evaluate(async () => { const v = document.querySelector("#reelOut video"); const b = await (await fetch(v.src)).blob(); const ab = new Uint8Array(await b.arrayBuffer()); let s = ""; for (let i = 0; i < ab.length; i += 32768) s += String.fromCharCode.apply(null, ab.subarray(i, i + 32768)); return { type: b.type, b64: btoa(s) }; });
        if (!/mp4/.test(info.type)) throw new Error(`La vidéo n'est pas au format MP4 (${info.type}).`);
        const brut = `${OUT}/reel-${reseau}-brut.mp4`; await writeFile(brut, Buffer.from(info.b64, "base64"));
        res[reseau] = { video: brut, legende };
      }
    }
    if (erreurs.length) log("Avertissements de la page : " + erreurs.slice(0, 3).join(" | "));
    return res;
  } finally { await nav.close(); }
}

// ---------- Mise au format exact demandé par Meta (piste son muette, index au début) ----------
function ffmpeg(args) { execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" }); }
function preparerVideo(brut, sortie) {
  ffmpeg(["-i", brut, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", sortie]);
  return sortie;
}
function videoDepuisImage(img, sortie, secondes = 7) {
  ffmpeg(["-loop", "1", "-framerate", "30", "-i", img, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(secondes), "-vf", "scale=1080:1920,format=yuv420p", "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-crf", "18", "-g", "60", "-r", "30", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", sortie]);
  return sortie;
}
const decrire = f => { try { return execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=duration,size", "-of", "compact=p=0:nk=1", f]).toString().trim().replace(/\n/g, " | "); } catch { return "?"; } };

// ---------- Publication Instagram ----------
async function envoyerIG(IG, mediaType, fichier, legende) {
  const params = { media_type: mediaType, upload_type: "resumable" };
  if (mediaType === "REELS") { params.caption = legende; params.share_to_feed = "true"; }
  const c = await api(`/${IG}/media`, { methode: "POST", params });
  const octets = await readFile(fichier);
  await api(null, { url: c.uri || `https://rupload.facebook.com/ig-api-upload/${GV}/${c.id}`, methode: "POST", corps: octets, entetes: { Authorization: `OAuth ${TOKEN}`, offset: "0", file_size: String(octets.length) } });
  for (let i = 0; i < 60; i++) {           // jusqu'à 10 minutes de traitement
    await dodo(10000);
    const s = await api(`/${c.id}`, { params: { fields: "status_code,status" } });
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`Instagram a refusé la vidéo : ${s.status || s.status_code}`);
    if (i === 59) throw new Error("Instagram met trop de temps à traiter la vidéo.");
  }
  const p = await api(`/${IG}/media_publish`, { methode: "POST", params: { creation_id: c.id } });
  let lien = ""; try { lien = (await api(`/${p.id}`, { params: { fields: "permalink" } })).permalink || ""; } catch {}
  return lien || p.id;
}

// ---------- Publication Facebook (Page) ----------
async function envoyerReelFB(fichier, legende) {
  const d = await api(`/${PAGE_ID}/video_reels`, { methode: "POST", params: { upload_phase: "start" } });
  const octets = await readFile(fichier);
  await api(null, { url: d.upload_url || `https://rupload.facebook.com/video-upload/${GV}/${d.video_id}`, methode: "POST", corps: octets, entetes: { Authorization: `OAuth ${TOKEN}`, offset: "0", file_size: String(octets.length) } });
  await api(`/${PAGE_ID}/video_reels`, { methode: "POST", params: { upload_phase: "finish", video_id: d.video_id, video_state: "PUBLISHED", description: legende } });
  for (let i = 0; i < 30; i++) {           // on attend la confirmation de Facebook (jusqu'à 5 minutes)
    await dodo(10000);
    const s = await api(`/${d.video_id}`, { params: { fields: "status" } });
    const st = s.status || {};
    if (st.video_status === "error" || (st.processing_phase && st.processing_phase.status === "error")) throw new Error(`Facebook a refusé la vidéo : ${JSON.stringify(st).slice(0, 300)}`);
    if (st.publishing_phase && st.publishing_phase.status === "complete") break;
    if (st.video_status === "ready" && (!st.publishing_phase || st.publishing_phase.status !== "in_progress")) break;
  }
  return `https://www.facebook.com/reel/${d.video_id}`;
}
async function envoyerPhotoFB(image, legende) {   // publication (image + texte) sur la Page
  const f = new FormData();
  f.set("published", "true"); f.set("message", legende); f.set("access_token", TOKEN);
  f.set("source", new Blob([await readFile(image)], { type: "image/jpeg" }), "alerte.jpg");
  const r = await fetch(`${G}/${PAGE_ID}/photos`, { method: "POST", body: f });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(masque(`Meta ${r.status} : ${(j.error && j.error.message) || "publication impossible"}`));
  return j.post_id ? `https://www.facebook.com/${j.post_id}` : j.id;
}
async function envoyerStoryFB(image) {
  const f = new FormData();
  f.set("published", "false"); f.set("access_token", TOKEN);
  f.set("source", new Blob([await readFile(image)], { type: "image/jpeg" }), "story.jpg");
  const r = await fetch(`${G}/${PAGE_ID}/photos`, { method: "POST", body: f });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(masque(`Meta ${r.status} : ${(j.error && j.error.message) || "envoi de l'image impossible"}`));
  const s = await api(`/${PAGE_ID}/photo_stories`, { methode: "POST", params: { photo_id: j.id } });
  return s.post_id || "story publiée";
}

// ---------- Programme principal ----------
async function principal() {
  if (MODE === "test-alerte" && !TOKEN) { await traiterAlerte(null); return; }   // essai sur ordinateur, sans Meta
  if (process.env.FABRIQUER_SEUL) {        // essai sur ordinateur, sans Meta
    const t = process.env.TYPE_TEST || "reel", m = await fabriquer(t);
    for (const [r, x] of Object.entries(m)) { const f = t === "reel" ? preparerVideo(x.video, `${OUT}/reel-${r}.mp4`) : r === "instagram" ? videoDepuisImage(x.image, `${OUT}/story-${r}.mp4`) : x.image; log(`${r} : ${f} (${decrire(f)})\n${x.legende}`); }
    return;
  }
  if (!TOKEN) throw new Error("La clé META_PAGE_TOKEN est absente des secrets GitHub.");
  log(`Mode ${MODE}, ${maintenant.jour} ${String(Math.floor(maintenant.min / 60)).padStart(2, "0")} h ${String(maintenant.min % 60).padStart(2, "0")} (Paris)`);

  let type = null;
  if (MODE === "reel" || MODE === "story") type = MODE;
  else if (MODE === "test") type = process.env.TYPE_TEST || "reel";
  else if (MODE === "auto") type = dansCreneau("reel") ? "reel" : dansCreneau("story") ? "story" : null;
  else if (MODE === "controle-reel") type = "reel";
  else if (MODE === "controle-story") type = "story";
  const alerte = MODE === "auto" || MODE === "test-alerte";
  if (!type && !alerte) return;

  // Qui est derrière la clé ? (le robot du portefeuille, ou directement la Page)
  try { const me = await api(`/me`, { params: { fields: "name" } }); log(`Clé utilisée : ${me.name}`); } catch (e) { log("Clé utilisée : inconnue"); }
  // Clé d'utilisateur système : on demande la clé de la Page (les publications Facebook exigent une clé de Page)
  try { const r = await api(`/${PAGE_ID}`, { params: { fields: "access_token" } }); if (r && r.access_token && r.access_token !== TOKEN) { TOKEN = r.access_token; log("Clé de la Page obtenue à partir de la clé du robot."); } }
  catch (e) { /* déjà une clé de Page : rien à faire */ }
  // La clé fonctionne-t-elle ? Quel est le compte Instagram de la Page ?
  const pg = await api(`/${PAGE_ID}`, { params: { fields: "name,instagram_business_account{id,username}" } });
  const IG = pg.instagram_business_account && pg.instagram_business_account.id;
  log(`Page : ${pg.name}${IG ? ` · Instagram : @${pg.instagram_business_account.username}` : " · aucun Instagram relié"}`);
  if (RESEAUX.includes("instagram") && !IG) throw new Error("Le compte Instagram n'est plus relié à la Page.");

  // L'alerte vigilance passe avant tout le reste ; si elle échoue, on publie quand même le reste, puis on signale l'échec
  let erreurAlerte = null;
  if (alerte) { try { await traiterAlerte(IG); } catch (e) { erreurAlerte = e; log("✘ " + masque(e.message)); } }
  // Contrôle général de l'appli et du site (n'empêche pas les publications ; signalé par e-mail s'il y a un défaut grave)
  // Contrôle complet (petit écran, liens, orthographe, bio) une fois par jour, au moment du Reel, et en mode essai
  if (MODE === "auto" || MODE === "test") { try { const e = await controleGeneral(IG, MODE === "test" || type === "reel"); if (e && !erreurAlerte) erreurAlerte = e; } catch (e) { log("Contrôle général impossible : " + masque(e.message)); } }
  if (MODE === "test-alerte") { if (erreurAlerte) throw erreurAlerte; return; }
  if (!type) { log("Hors des créneaux de publication (story 6 h 45 – 10 h 30, Reel 17 h – 21 h) : rien d'autre à faire."); if (erreurAlerte) throw erreurAlerte; return; }

  const nomType = type === "reel" ? "Reel" : "story";
  const aFaire = [];
  for (const r of RESEAUX) {
    const deja = await dejaPublie(type, r, IG);
    log(`${r} : ${deja === true ? `${nomType} déjà publié aujourd'hui` : deja === false ? `pas encore de ${nomType} aujourd'hui` : "état inconnu"}`);
    if (deja !== true || ((MODE === "reel" || MODE === "story") && process.env.FORCER === "oui")) aFaire.push(r);   // forcer : seulement à la demande, jamais en automatique
  }

  if (MODE.startsWith("controle")) {
    if (aFaire.length) throw new Error(`ALERTE : pas de ${nomType} publié aujourd'hui sur ${aFaire.join(" et ")}. Publie-le à la main depuis l'espace créateur.`);
    log(`Tout est publié ✔`); return;
  }
  if (!aFaire.length && MODE !== "test") { log("Rien à publier."); if (erreurAlerte) throw erreurAlerte; return; }

  const media = await fabriquer(type);
  const prets = {};
  for (const r of (MODE === "test" ? RESEAUX : aFaire)) {
    const m = media[r];
    prets[r] = type === "reel"
      ? { fichier: preparerVideo(m.video, `${OUT}/reel-${r}.mp4`), legende: m.legende }
      : { fichier: r === "instagram" ? videoDepuisImage(m.image, `${OUT}/story-${r}.mp4`) : m.image, legende: "" };
    log(`${r} prêt : ${prets[r].fichier} (${decrire(prets[r].fichier)})`);
    if (prets[r].legende) log(`Légende ${r} :\n${prets[r].legende}\n`);
  }
  if (MODE === "test") { log("Mode test : rien n'est publié."); return; }

  const echecs = [];
  for (const r of aFaire) {
    try {
      const p = prets[r];
      const lien = r === "instagram"
        ? await envoyerIG(IG, type === "reel" ? "REELS" : "STORIES", p.fichier, p.legende)
        : type === "reel" ? await envoyerReelFB(p.fichier, p.legende) : await envoyerStoryFB(p.fichier);
      log(`✔ ${nomType} publié sur ${r} : ${lien}`);
    } catch (e) { echecs.push(`${r} : ${masque(e.message)}`); log(`✘ ${r} : ${masque(e.message)}`); }
  }
  if (echecs.length) throw new Error(`Publication incomplète. ${echecs.join(" ; ")}`);
  if (erreurAlerte) throw erreurAlerte;
}

principal().catch(e => { console.error("ÉCHEC : " + masque(e.message)); process.exit(1); });
