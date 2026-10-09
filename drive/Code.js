/**
 * Histoires du soir — sauvegarde dans le Google Drive de Jonathan.
 *
 * L'app (https://95.groupelaberge.ca/histoires/) envoie ici chaque histoire ; ce script, qui s'exécute avec le compte
 * de Jonathan, la range dans son Drive :
 *
 *   Histoires du soir/
 *     Léa/
 *       2026-10-07 — Le dragon qui avait peur du noir/
 *         Le dragon qui avait peur du noir   (Google Doc lisible, sans balises)
 *         Le dragon qui avait peur du noir.mp3
 *         couverture.jpg
 *         infos.json                         (tout, pour remettre l'histoire dans l'app)
 *         morceau-A.mp3 …                    (histoire à choix : le son de chaque morceau)
 *     index.json                             (où se trouve chaque histoire)
 *     ⭐ Favoris/                             (raccourcis vers les dossiers des histoires favorites)
 *
 * Sécurité : une clé secrète, créée ici à la première ouverture (après l'autorisation de Jonathan) et
 * gardée dans les propriétés du script. Elle n'est écrite que dans un document de SON Drive
 * (« ⚙️ Configurer l'app »), dont le lien configure l'app. Jamais dans le code ni dans le dépôt.
 */
const RACINE = 'Histoires du soir';
const FAVORIS = '⭐ Favoris';
const NOM_CONFIG = '⚙️ Configurer l\'app';
const APP = 'https://95.groupelaberge.ca/histoires/';
const URL_SERVICE = 'https://script.google.com/macros/s/AKfycbz-LK0_7QoHanU7WHdIQZCeG2VBEX8gNqlU72WnMJmSAfzHhM9zwuQUo3MWdttbxM-I/exec';

const P = () => PropertiesService.getScriptProperties();

/* Clé de sauvegarde : la clé actuelle, ou l'ancienne pendant 14 jours après un changement de clé
   (le temps que chaque appareil reçoive la nouvelle par le lien du document). */
function cleOk(k) {
  if (!k) return false;
  const pr = P();
  if (k === pr.getProperty('SECRET')) return true;
  return k === pr.getProperty('SECRET_ANCIEN') && Date.now() < Number(pr.getProperty('SECRET_ANCIEN_FIN') || 0);
}
const nouveauSecret = () => Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');

function racine() {
  const id = P().getProperty('RACINE_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  const it = DriveApp.getFoldersByName(RACINE);
  const f = it.hasNext() ? it.next() : DriveApp.createFolder(RACINE);
  P().setProperty('RACINE_ID', f.getId());
  return f;
}
function sousDossier(parent, nom) {
  const it = parent.getFoldersByName(nom);
  return it.hasNext() ? it.next() : parent.createFolder(nom);
}
function fichier(id) {
  if (!id) return null;
  try { const f = DriveApp.getFileById(id); return f.isTrashed() ? null : f; } catch (e) { return null; }
}
function dossier(id) {
  if (!id) return null;
  try { const f = DriveApp.getFolderById(id); return f.isTrashed() ? null : f; } catch (e) { return null; }
}
const propre = s => String(s || '').replace(/[\\/:*?"<>|#\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
const sansBalises = t => String(t || '').replace(/\[[^\]\n]{1,40}\]\s*/g, '');
const jour = ms => Utilities.formatDate(new Date(ms || Date.now()), 'America/Montreal', 'yyyy-MM-dd');

function sortie(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function page(t) {
  return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width"><div style="font:18px system-ui;padding:24px;line-height:1.5">' + t + '</div>')
    .setTitle('Histoires du soir');
}

/* ───────── Index des histoires : UN fichier « index.json » dans le dossier racine ─────────
   (Avant : 6 à 8 propriétés du script par histoire ; Google limite les propriétés à 500 Ko au total,
   soit environ 500 à 900 histoires. Le fichier n'a pas cette limite.)
   Une fiche par histoire : { h: dossier, d: doc, j: infos.json, a: audio, i: couverture, f: raccourci favori,
   il: [illustrations], n: { chemin: fichier audio du morceau }, s: résumé pour la liste }. */
let INDEX = null;
function indexFichier() {
  const pr = P();
  let f = fichier(pr.getProperty('INDEX_ID'));
  if (f) return f;
  // Première fois : on reprend les anciennes propriétés, après en avoir gardé une copie dans le Drive.
  const all = pr.getProperties(), idx = {};
  Object.keys(all).forEach(k => {
    const m = /^(h|d|j|a|i|f|il|s):(.+)$/.exec(k);
    if (!m) return;
    const rec = idx[m[2]] = idx[m[2]] || {};
    if (m[1] === 'il' || m[1] === 's') { try { rec[m[1]] = JSON.parse(all[k]); } catch (e) {} }
    else rec[m[1]] = all[k];
  });
  const r = racine();
  const anciennes = Object.keys(all).filter(k => /^(h|d|j|a|i|f|il|s):/.test(k));
  if (anciennes.length) {
    const copie = {}; anciennes.forEach(k => copie[k] = all[k]);
    r.createFile('copie-proprietes-' + jour() + '.json', JSON.stringify(copie), MimeType.PLAIN_TEXT);
  }
  f = r.createFile('index.json', JSON.stringify(idx), MimeType.PLAIN_TEXT);
  pr.setProperty('INDEX_ID', f.getId());
  anciennes.forEach(k => pr.deleteProperty(k));
  return f;
}
function index() {
  if (!INDEX) { try { INDEX = JSON.parse(indexFichier().getBlob().getDataAsString('UTF-8')) || {}; } catch (e) { INDEX = {}; } }
  return INDEX;
}
function indexSauver() { indexFichier().setContent(JSON.stringify(INDEX || {})); }
const fiche = id => (index()[id] = index()[id] || {});

/* ───────── GET : première ouverture (configuration) ; liste et chargement gardés pour les vieux appareils ───────── */
function doGet(e) {
  const p = (e && e.parameter) || {};
  let secret = P().getProperty('SECRET');
  if (!secret) {
    // Première ouverture, par Jonathan, juste après son autorisation.
    secret = nouveauSecret();
    P().setProperty('SECRET', secret);
    creerDocConfig(secret);
    return page('✅ <b>Sauvegarde prête !</b><br><br>Ouvre ton <b>Google Drive</b> → dossier <b>« ' + RACINE + ' »</b> → document <b>« ' + NOM_CONFIG + ' »</b>, puis touche le lien dedans.');
  }
  if (!cleOk(p.k)) return page('Service de sauvegarde des Histoires du soir.');
  if (p.a === 'liste') return sortie({ ok: true, histoires: liste() });
  if (p.a === 'charger') return sortie(charger(p.id));
  return sortie({ ok: true });
}

/* ───────── POST : tout le reste (la clé voyage dans le corps, jamais dans l'adresse) ───────── */
function doPost(e) {
  let b;
  try { b = JSON.parse(e.postData.contents); } catch (x) { return sortie({ ok: false, erreur: 'requête illisible' }); }
  if (!cleOk(b.k)) return sortie({ ok: false, erreur: 'clé de sauvegarde invalide (touche le lien du document « Configurer l’app » du Drive)' });
  const verrou = LockService.getScriptLock();
  try {
    if (!verrou.tryLock(30000)) return sortie({ ok: false, erreur: 'Drive occupé, nouvel essai plus tard' });
    if (b.a === 'liste') return sortie({ ok: true, histoires: liste() });
    if (b.a === 'charger') return sortie(charger(b.id));
    if (b.a === 'sauver') return sortie(sauver(b));
    if (b.a === 'supprimer') return sortie(supprimer(b.id));
    if (b.a === 'cle') {
      // Une clé de plus dans le lien du document (ex. la clé des voix Google), sans changer la clé de sauvegarde.
      if (b.nom !== 'gcloud' || typeof b.valeur !== 'string' || !/^[\w-]{20,60}$/.test(b.valeur)) return sortie({ ok: false, erreur: 'clé refusée' });
      P().setProperty('GCLOUD', b.valeur);
      creerDocConfig(P().getProperty('SECRET'));
      return sortie({ ok: true });
    }
    if (b.a === 'rotation') {
      // Nouvelle clé (l'ancienne reste valable 14 jours) + clé du relais des voix, puis nouveau document de configuration.
      // La nouvelle clé n'est renvoyée à personne : elle n'existe que dans le document du Drive.
      const pr = P(), ancien = pr.getProperty('SECRET');
      if (b.k !== ancien) return sortie({ ok: false, erreur: 'seule la clé actuelle peut changer la clé' });
      const nouveau = nouveauSecret();
      pr.setProperties({ SECRET: nouveau, SECRET_ANCIEN: ancien, SECRET_ANCIEN_FIN: String(Date.now() + 14 * 86400000) });
      if (typeof b.relais === 'string' && /^[\w-]{20,100}$/.test(b.relais)) pr.setProperty('RELAIS', b.relais);
      creerDocConfig(nouveau);
      return sortie({ ok: true });
    }
    return sortie({ ok: false, erreur: 'action inconnue' });
  } catch (x) {
    return sortie({ ok: false, erreur: String((x && x.message) || x) });
  } finally { try { verrou.releaseLock(); } catch (x) {} }
}

function sauver(b) {
  const s = b.story || {};
  if (!/^[a-z0-9]{4,20}$/.test(s.id || '')) return { ok: false, erreur: 'histoire sans identifiant' };
  const id = s.id, rec = fiche(id);
  const r = racine();
  const prenom = propre(s.meta && s.meta.name) || 'Sans prénom';
  const enfant = sousDossier(r, prenom);
  const titre = propre(s.titre) || 'Sans titre';
  const nomDossier = jour(s.createdAt) + ' — ' + titre + (s.chap > 1 ? ' (chapitre ' + s.chap + ')' : '');

  // Dossier de l'histoire (renommé / déplacé si le titre ou le prénom a changé)
  let d = dossier(rec.h);
  if (!d) { d = enfant.createFolder(nomDossier); rec.h = d.getId(); }
  else {
    if (d.getName() !== nomDossier) d.setName(nomDossier);
    const parents = d.getParents();
    if (parents.hasNext() && parents.next().getId() !== enfant.getId()) d.moveTo(enfant);
  }

  // Illustrations (envoyées seulement quand elles changent) ; avant = -1 : morceau d'une histoire à choix hors du texte
  if (Array.isArray(b.images) && b.images.length) {
    (rec.il || []).forEach(v => { const f = fichier(v.id); if (f) f.setTrashed(true); });
    rec.il = b.images.slice(0, 12).map((im, k) => {
      const f = d.createFile(Utilities.newBlob(Utilities.base64Decode(im.b64), im.type || 'image/jpeg', 'illustration-' + (k + 1) + '.jpg'));
      return { avant: Number(im.avant), cle: String(im.cle || ''), id: f.getId() };
    });
  }
  const illus = rec.il || [];

  // Google Doc lisible (réécrit à chaque sauvegarde : une histoire à choix s'allonge, etc.)
  let doc;
  if (fichier(rec.d)) doc = DocumentApp.openById(rec.d);
  else { doc = DocumentApp.create(titre); DriveApp.getFileById(doc.getId()).moveTo(d); rec.d = doc.getId(); }
  doc.setName(titre);
  const body = doc.getBody();
  body.clear();
  body.appendParagraph(s.titre || 'Sans titre').setHeading(DocumentApp.ParagraphHeading.TITLE);
  const m = s.meta || {};
  const details = [m.name ? 'Pour ' + m.name : '', m.friends ? 'avec ' + m.friends : '',
    s.chap > 1 ? 'chapitre ' + s.chap : '', s.interactive || s.arbre ? 'histoire à choix' : '',
    Utilities.formatDate(new Date(s.createdAt || Date.now()), 'America/Montreal', 'd MMMM yyyy')].filter(String).join(' · ');
  body.appendParagraph(details).setItalic(true);
  sansBalises(s.histoire).split(/\n\s*\n/).filter(t => t.trim()).forEach((t, i) => {
    illus.filter(x => x.avant === i).forEach(x => {
      const f = fichier(x.id);
      if (!f) return;
      try {
        const im = body.appendImage(f.getBlob());
        const k = 440 / im.getWidth(); im.setWidth(440).setHeight(Math.round(im.getHeight() * k));
      } catch (e) {}
    });
    body.appendParagraph(t.trim()).setItalic(false);
  });
  doc.saveAndClose();

  // infos.json : tout, pour remettre l'histoire dans l'app sur un autre appareil
  const infos = JSON.stringify(s, null, 1);
  const fj = fichier(rec.j);
  if (fj) fj.setContent(infos);
  else rec.j = d.createFile('infos.json', infos, MimeType.PLAIN_TEXT).getId();

  // Audio (remplacé s'il est renvoyé)
  if (b.audio && b.audio.b64) {
    const vieux = fichier(rec.a); if (vieux) vieux.setTrashed(true);
    const ext = b.audio.type === 'audio/wav' ? '.wav' : '.mp3';
    rec.a = d.createFile(Utilities.newBlob(Utilities.base64Decode(b.audio.b64), b.audio.type || 'audio/mpeg', titre + ext)).getId();
  }
  // Sons des morceaux d'une histoire à choix (pour ne pas les réenregistrer sur un autre appareil)
  if (Array.isArray(b.noeuds) && b.noeuds.length) {
    const n = rec.n || {};
    b.noeuds.slice(0, 7).forEach(x => {
      const c = String(x.c || '');
      if (!/^[AB]{0,2}$/.test(c) || !x.b64) return;
      const vieux = fichier(n[c]); if (vieux) vieux.setTrashed(true);
      n[c] = d.createFile(Utilities.newBlob(Utilities.base64Decode(x.b64), x.type || 'audio/mpeg', 'morceau-' + (c || 'debut') + '.mp3')).getId();
    });
    rec.n = n;
  }
  // Image de couverture
  if (b.image && b.image.b64) {
    const vieux = fichier(rec.i); if (vieux) vieux.setTrashed(true);
    rec.i = d.createFile(Utilities.newBlob(Utilities.base64Decode(b.image.b64), b.image.type || 'image/jpeg', 'couverture.jpg')).getId();
  }
  // Favori : un raccourci dans « ⭐ Favoris »
  const raccourci = fichier(rec.f);
  if (s.fav && !raccourci) {
    const sc = DriveApp.createShortcut(d.getId());
    sc.moveTo(sousDossier(r, FAVORIS));
    sc.setName(nomDossier);
    rec.f = sc.getId();
  } else if (!s.fav && raccourci) { raccourci.setTrashed(true); delete rec.f; }
  else if (raccourci && raccourci.getName() !== nomDossier) raccourci.setName(nomDossier);

  // Résumé pour la liste (restauration sur un autre appareil)
  const aAudio = !!fichier(rec.a), aImage = !!fichier(rec.i);
  rec.s = { id: id, titre: s.titre, createdAt: s.createdAt, name: m.name || '', audio: aAudio, image: aImage, fav: !!s.fav };
  indexSauver();
  return { ok: true, dossier: d.getUrl(), audio: aAudio, image: aImage };
}

/* Supprimer : le dossier de l'histoire va à la corbeille du Drive (récupérable 30 jours), et son favori aussi */
function supprimer(id) {
  if (!/^[a-z0-9]{4,20}$/.test(id || '')) return { ok: false, erreur: 'identifiant invalide' };
  const rec = index()[id];
  if (!rec) return { ok: true, absente: true };
  const d = dossier(rec.h); if (d) d.setTrashed(true);
  const f = fichier(rec.f); if (f) f.setTrashed(true);
  delete INDEX[id];
  indexSauver();
  return { ok: true };
}

function liste() {
  const idx = index();
  return Object.keys(idx).map(id => idx[id]).filter(rec => rec.s && dossier(rec.h)).map(rec => rec.s);
}

function charger(id) {
  const rec = index()[id] || {};
  const fj = fichier(rec.j);
  if (!fj) return { ok: false, erreur: 'histoire introuvable dans le Drive' };
  const out = { ok: true, story: JSON.parse(fj.getBlob().getDataAsString('UTF-8')) };
  const fa = fichier(rec.a);
  if (fa) out.audio = { b64: Utilities.base64Encode(fa.getBlob().getBytes()), type: fa.getMimeType() };
  const fi = fichier(rec.i);
  if (fi) out.image = { b64: Utilities.base64Encode(fi.getBlob().getBytes()), type: fi.getMimeType() };
  out.images = (rec.il || []).map(x => ({ x, f: fichier(x.id) })).filter(o => o.f)
    .map(o => ({ cle: o.x.cle, avant: o.x.avant, b64: Utilities.base64Encode(o.f.getBlob().getBytes()), type: 'image/jpeg' }));
  out.noeuds = Object.keys(rec.n || {}).map(c => ({ c, f: fichier(rec.n[c]) })).filter(o => o.f)
    .map(o => ({ c: o.c, b64: Utilities.base64Encode(o.f.getBlob().getBytes()), type: o.f.getMimeType() }));
  return out;
}

function creerDocConfig(secret) {
  const r = racine();
  const it = r.getFilesByName(NOM_CONFIG);
  while (it.hasNext()) it.next().setTrashed(true);
  const relais = P().getProperty('RELAIS');
  const gcloud = P().getProperty('GCLOUD');
  const lien = APP + '#drive=' + encodeURIComponent(URL_SERVICE) + '&driveKey=' + secret + (relais ? '&relais=' + relais : '') + (gcloud ? '&gcloud=' + gcloud : '');
  const doc = DocumentApp.create(NOM_CONFIG);
  const b = doc.getBody();
  b.appendParagraph('Activer la sauvegarde Drive de l\'app Histoires du soir').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  b.appendParagraph('Sur ton téléphone, touche le lien ci-dessous : il ouvre l\'app et active la sauvegarde automatique de tes histoires dans ce dossier. À refaire sur chaque appareil.');
  b.appendParagraph('👉 Activer la sauvegarde Drive').setLinkUrl(lien).setFontSize(20).setBold(true);
  b.appendParagraph('Ne partage pas ce document : le lien contient la clé de ta sauvegarde.').setItalic(true);
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(r);
}

/** Plan B pour l'autorisation : dans l'éditeur Apps Script, choisir « autoriser » puis ▶ Exécuter. */
function autoriser() {
  racine();
  Logger.log('Autorisé. Ouvre maintenant l\'adresse du service : ' + URL_SERVICE);
}
