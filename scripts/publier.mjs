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
//        "controle-reel", "controle-story" (vérifier en fin de créneau, et alerter par e-mail si rien n'est paru).
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
    await page.evaluate(async J => { studioOuvert = true; route(); postJour = J; postJourChoisi = Date.now(); await buildSlides(); }, J);
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
  if (!type) { log("Hors des créneaux de publication (story 6 h 45 – 10 h 30, Reel 17 h – 21 h) : rien à faire."); return; }

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

  const nomType = type === "reel" ? "Reel" : "story";
  const aFaire = [];
  for (const r of RESEAUX) {
    const deja = await dejaPublie(type, r, IG);
    log(`${r} : ${deja === true ? `${nomType} déjà publié aujourd'hui` : deja === false ? `pas encore de ${nomType} aujourd'hui` : "état inconnu"}`);
    if (deja !== true) aFaire.push(r);
  }

  if (MODE.startsWith("controle")) {
    if (aFaire.length) throw new Error(`ALERTE : pas de ${nomType} publié aujourd'hui sur ${aFaire.join(" et ")}. Publie-le à la main depuis l'espace créateur.`);
    log(`Tout est publié ✔`); return;
  }
  if (!aFaire.length && MODE !== "test") { log("Rien à publier."); return; }

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
}

principal().catch(e => { console.error("ÉCHEC : " + masque(e.message)); process.exit(1); });
