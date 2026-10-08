/**
 * Histoires du soir — sauvegarde dans le Google Drive de Jonathan.
 *
 * L'app (PWA sur GitHub Pages) envoie ici chaque histoire ; ce script, qui s'exécute avec le compte
 * de Jonathan, la range dans son Drive :
 *
 *   Histoires du soir/
 *     Léa/
 *       2026-10-07 — Le dragon qui avait peur du noir/
 *         Le dragon qui avait peur du noir   (Google Doc lisible, sans balises)
 *         Le dragon qui avait peur du noir.mp3
 *         couverture.jpg
 *         infos.json                         (tout, pour remettre l'histoire dans l'app)
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

/* ───────── GET : première ouverture (configuration), liste, chargement ───────── */
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

/* ───────── POST : sauvegarder une histoire (texte, audio, image, favori) ───────── */
function doPost(e) {
  let b;
  try { b = JSON.parse(e.postData.contents); } catch (x) { return sortie({ ok: false, erreur: 'requête illisible' }); }
  if (!cleOk(b.k)) return sortie({ ok: false, erreur: 'clé de sauvegarde invalide (touche le lien du document « Configurer l’app » du Drive)' });
  const verrou = LockService.getScriptLock();
  verrou.waitLock(30000);
  try {
    if (b.a === 'sauver') return sortie(sauver(b));
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
  } finally { verrou.releaseLock(); }
}

function sauver(b) {
  const s = b.story || {};
  if (!/^[a-z0-9]{4,20}$/.test(s.id || '')) return { ok: false, erreur: 'histoire sans identifiant' };
  const id = s.id, pr = P();
  const r = racine();
  const prenom = propre(s.meta && s.meta.name) || 'Sans prénom';
  const enfant = sousDossier(r, prenom);
  const titre = propre(s.titre) || 'Sans titre';
  const nomDossier = jour(s.createdAt) + ' — ' + titre + (s.chap > 1 ? ' (chapitre ' + s.chap + ')' : '');

  // Dossier de l'histoire (renommé / déplacé si le titre ou le prénom a changé)
  let d = dossier(pr.getProperty('h:' + id));
  if (!d) { d = enfant.createFolder(nomDossier); pr.setProperty('h:' + id, d.getId()); }
  else {
    if (d.getName() !== nomDossier) d.setName(nomDossier);
    const parents = d.getParents();
    if (parents.hasNext() && parents.next().getId() !== enfant.getId()) d.moveTo(enfant);
  }

  // Illustrations (envoyées seulement quand elles changent) : fichiers + place dans le texte
  if (Array.isArray(b.images) && b.images.length) {
    let vieilles = [];
    try { vieilles = JSON.parse(pr.getProperty('il:' + id) || '[]'); } catch (x) {}
    vieilles.forEach(v => { const f = fichier(v.id); if (f) f.setTrashed(true); });
    const nouvelles = b.images.slice(0, 8).map((im, k) => {
      const f = d.createFile(Utilities.newBlob(Utilities.base64Decode(im.b64), im.type || 'image/jpeg', 'illustration-' + (k + 1) + '.jpg'));
      return { avant: Number(im.avant) || 0, cle: String(im.cle || ''), id: f.getId() };
    });
    pr.setProperty('il:' + id, JSON.stringify(nouvelles));
  }
  let illus = [];
  try { illus = JSON.parse(pr.getProperty('il:' + id) || '[]'); } catch (x) {}

  // Google Doc lisible (réécrit à chaque sauvegarde : une histoire à choix s'allonge, etc.)
  let doc;
  const docId = pr.getProperty('d:' + id);
  if (fichier(docId)) doc = DocumentApp.openById(docId);
  else { doc = DocumentApp.create(titre); DriveApp.getFileById(doc.getId()).moveTo(d); pr.setProperty('d:' + id, doc.getId()); }
  doc.setName(titre);
  const body = doc.getBody();
  body.clear();
  body.appendParagraph(s.titre || 'Sans titre').setHeading(DocumentApp.ParagraphHeading.TITLE);
  const m = s.meta || {};
  const details = [m.name ? 'Pour ' + m.name : '', m.friends ? 'avec ' + m.friends : '',
    s.chap > 1 ? 'chapitre ' + s.chap : '', s.interactive ? 'histoire à choix' : '',
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
  const fj = fichier(pr.getProperty('j:' + id));
  if (fj) fj.setContent(infos);
  else pr.setProperty('j:' + id, d.createFile('infos.json', infos, MimeType.PLAIN_TEXT).getId());

  // Audio (remplacé s'il est renvoyé)
  if (b.audio && b.audio.b64) {
    const vieux = fichier(pr.getProperty('a:' + id)); if (vieux) vieux.setTrashed(true);
    const ext = b.audio.type === 'audio/wav' ? '.wav' : '.mp3';
    const f = d.createFile(Utilities.newBlob(Utilities.base64Decode(b.audio.b64), b.audio.type || 'audio/mpeg', titre + ext));
    pr.setProperty('a:' + id, f.getId());
  }
  // Image de couverture
  if (b.image && b.image.b64) {
    const vieux = fichier(pr.getProperty('i:' + id)); if (vieux) vieux.setTrashed(true);
    const f = d.createFile(Utilities.newBlob(Utilities.base64Decode(b.image.b64), b.image.type || 'image/jpeg', 'couverture.jpg'));
    pr.setProperty('i:' + id, f.getId());
  }
  // Favori : un raccourci dans « ⭐ Favoris »
  const raccourci = fichier(pr.getProperty('f:' + id));
  if (s.fav && !raccourci) {
    const sc = DriveApp.createShortcut(d.getId());
    sc.moveTo(sousDossier(r, FAVORIS));
    sc.setName(nomDossier);
    pr.setProperty('f:' + id, sc.getId());
  } else if (!s.fav && raccourci) { raccourci.setTrashed(true); pr.deleteProperty('f:' + id); }
  else if (raccourci && raccourci.getName() !== nomDossier) raccourci.setName(nomDossier);

  // Résumé pour la liste (restauration sur un autre appareil)
  const aAudio = !!fichier(pr.getProperty('a:' + id)), aImage = !!fichier(pr.getProperty('i:' + id));
  pr.setProperty('s:' + id, JSON.stringify({ id: id, titre: s.titre, createdAt: s.createdAt, name: m.name || '', audio: aAudio, image: aImage, fav: !!s.fav }));
  return { ok: true, dossier: d.getUrl(), audio: aAudio, image: aImage };
}

function liste() {
  const all = P().getProperties();
  return Object.keys(all).filter(k => k.indexOf('s:') === 0)
    .map(k => { try { return JSON.parse(all[k]); } catch (e) { return null; } })
    .filter(x => x && dossier(all['h:' + x.id]));
}

function charger(id) {
  const pr = P();
  const fj = fichier(pr.getProperty('j:' + id));
  if (!fj) return { ok: false, erreur: 'histoire introuvable dans le Drive' };
  const out = { ok: true, story: JSON.parse(fj.getBlob().getDataAsString('UTF-8')) };
  const fa = fichier(pr.getProperty('a:' + id));
  if (fa) out.audio = { b64: Utilities.base64Encode(fa.getBlob().getBytes()), type: fa.getMimeType() };
  const fi = fichier(pr.getProperty('i:' + id));
  if (fi) out.image = { b64: Utilities.base64Encode(fi.getBlob().getBytes()), type: fi.getMimeType() };
  try {
    out.images = JSON.parse(pr.getProperty('il:' + id) || '[]').map(x => ({ x, f: fichier(x.id) })).filter(o => o.f)
      .map(o => ({ cle: o.x.cle, avant: o.x.avant, b64: Utilities.base64Encode(o.f.getBlob().getBytes()), type: 'image/jpeg' }));
  } catch (e) {}
  return out;
}

function creerDocConfig(secret) {
  const r = racine();
  const it = r.getFilesByName(NOM_CONFIG);
  while (it.hasNext()) it.next().setTrashed(true);
  const relais = P().getProperty('RELAIS');
  const lien = APP + '#drive=' + encodeURIComponent(URL_SERVICE) + '&driveKey=' + secret + (relais ? '&relais=' + relais : '');
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
