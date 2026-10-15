/* Histoires du soir — LA FABRIQUE (serveur de Jonathan, 95.groupelaberge.ca)
 *
 * Fabrique une histoire du début à la fin SUR LE SERVEUR : le texte (Gemini), les images (Gemini) et la voix
 * (Google, sinon Microsoft). Le téléphone n'envoie que la « recette » (la consigne déjà écrite par l'app et
 * les réglages), puis vient chercher le résultat. Écran éteint ou app fermée : la fabrication continue, et
 * une notification « Ton histoire est prête » part à la fin. Demandé par Jonathan le 2026-10-14.
 *
 * Node 22, AUCUNE dépendance. Écoute 127.0.0.1:8121 ; Caddy y envoie /histoires/fabrique/*.
 *   POST   /histoires/fabrique/travaux             recette → { id }
 *   GET    /histoires/fabrique/travaux             mes travaux (id, fini, titre)
 *   GET    /histoires/fabrique/travaux/<id>        état, pourcentages, résultat
 *   GET    /histoires/fabrique/travaux/<id>/f/<n>  un fichier (image-<clé>, audio, noeud-<chemin>)
 *   DELETE /histoires/fabrique/travaux/<id>        l'app a tout récupéré
 *   GET    /histoires/fabrique/vapid               clé publique des notifications
 *   POST   /histoires/fabrique/abonnement          { endpoint, keys } : où envoyer la notification
 * Accès : la session de l'app Maison (jeton PocketBase, vérifié auprès de Maison), comme le relais.
 *
 * La logique (plan des images, voix Google en paliers, une voix par personnage…) est la MÊME que dans
 * index.html : en changer une, c'est changer l'autre. Les clés Google viennent de /etc/secrets/histoires-tts.env.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';

const PORT = +process.env.PORT || 8121;
const DOSSIER = process.env.STATE_DIRECTORY || '/var/lib/histoires-fabrique';
const TRAVAUX = path.join(DOSSIER, 'travaux');
const MAISON = process.env.MAISON_URL || 'http://127.0.0.1:8094';
const RELAIS = process.env.RELAIS_URL || 'http://127.0.0.1:8120';            // voix Microsoft (relais Python)
const RELAIS_CLE = process.env.RELAIS_CLE || '';
const GOOGLE = process.env.GOOGLE_URL || 'https://generativelanguage.googleapis.com';
const GOOGLE_TTS = process.env.GOOGLE_TTS_URL || 'https://texttospeech.googleapis.com';
const CLE_GEMINI = process.env.GOOGLE_GEMINI_KEY || '';
const CLE_TTS = process.env.GOOGLE_TTS_KEY || '';
const ORIGINE = 'https://95.groupelaberge.ca';
const RECETTE_MAX = 25 * 1024 * 1024;     // la recette peut porter le dessin et des images de référence
const GARDER_MS = 3 * 86400000;           // un travail pas récupéré est effacé après 3 jours
const EN_MEME_TEMPS = 2;                  // travaux fabriqués en même temps

const sleep = ms => new Promise(ok => setTimeout(ok, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ==================== petits outils de texte (copies d'index.html) ==================== */
const paras = t => t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
const stripTags = t => t.replace(/\[[^\]\n]{1,40}\]\s*/g, '');
/* v63 : les voix Google lisent le texte TEL QUEL (sons étirés, majuscules = onomatopées bien jouées) ; Microsoft garde le nettoyage */
function pourVoixGoogle(t) { return t.replace(/([bcdfghjklmnpqrstvwxzçBCDFGHJKLMNPQRSTVWXZ])\1{2,}/g, '$1$1'); }   // v64 : « grrrr » → « grr » (les voyelles étirées restent)
function pourVoixMicrosoft(t) {
  return t
    .replace(/(\p{L})\1{2,}/gu, '$1')
    .replace(/(?<!\p{L})\p{Lu}{3,}(?!\p{L})/gu, (mot, pos, tout) => {
      const avant = tout.slice(0, pos).trimEnd();
      const bas = mot.toLowerCase();
      return !avant || /[.!?…«»—\n]$/.test(avant) ? bas[0].toUpperCase() + bas.slice(1) : bas;
    });
}
const pourVoixSimple = t => pourVoixMicrosoft(stripTags(t));
function chunk(text, max = 2500) {
  const parts = [];
  let cur = '';
  const push = s => { if (s.trim()) parts.push(s.trim()); };
  const couper = s => {
    if (s.length <= max) return [s];
    const out = []; let c = '';
    for (const m of s.split(/(?<=[,;:])\s+|\s+/)) {
      if ((c + ' ' + m).length > max && c) { out.push(c); c = m; } else c = c ? c + ' ' + m : m;
    }
    if (c) out.push(c);
    return out.flatMap(x => x.length > max ? x.match(new RegExp('.{1,' + max + '}', 'g')) : [x]);
  };
  for (const para of text.split(/\n\s*\n/)) {
    const phrases = para.length > max ? (para.match(/[^.!?…]*[.!?…]+[»"]?\s*|[^.!?…]+$/g) || [para]).flatMap(couper) : [para];
    phrases.forEach((ph, i) => {
      const sep = i === 0 ? '\n\n' : ' ';
      if (cur && (cur + sep + ph).length > max) { push(cur); cur = ph; }
      else cur = cur ? cur + sep + ph : ph;
    });
  }
  push(cur);
  return parts;
}

/* ==================== Google ==================== */
async function errTexte(r) {
  try { const j = await r.json(); return j.error?.message || JSON.stringify(j); } catch { return 'HTTP ' + r.status; }
}
async function avecEssais(fn) {             // coupure réseau, 429 et 5xx : nouveaux essais
  for (let i = 1; ; i++) {
    let r;
    try { r = await fn(); } catch (e) { if (i > 3) throw e; await sleep(3000 * i); continue; }
    if (r.ok || i > 2 || !(r.status === 429 || r.status >= 500)) return r;
    await sleep(2000 * 2 ** (i - 1));
  }
}
/* Texte JSON par Gemini, EN FLUX : on compte les caractères reçus pour un vrai pourcentage */
async function geminiJson({ system, user, images = [], schema, temperature = 1, modeles, attendu = 0, onAvance }) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }, ...images.map(im => ({ inlineData: { mimeType: im.type, data: im.b64 } }))] }],
    generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema }
  });
  let derniere = '';
  for (const model of modeles?.length ? modeles : ['gemini-flash-latest']) {
    const r = await avecEssais(() => fetch(`${GOOGLE}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': CLE_GEMINI }, body
    }));
    if (!r.ok) {
      derniere = await errTexte(r);
      if (r.status === 404 || r.status === 429 || r.status >= 500) continue;
      throw new Error('Gemini : ' + derniere);
    }
    let txt = '', tampon = '', fin = '';
    const dec = new TextDecoder();
    for await (const morceau of r.body) {
      tampon += dec.decode(morceau, { stream: true });
      let k;
      while ((k = tampon.indexOf('\n')) >= 0) {
        const ligne = tampon.slice(0, k).trim(); tampon = tampon.slice(k + 1);
        if (!ligne.startsWith('data:')) continue;
        try {
          const d = JSON.parse(ligne.slice(5));
          txt += (d.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
          fin = d.candidates?.[0]?.finishReason || d.promptFeedback?.blockReason || fin;
        } catch {}
      }
      if (attendu) onAvance?.(Math.min(.97, txt.length / attendu));
    }
    if (!txt) throw new Error('Gemini n\'a rien renvoyé (' + (fin || 'inconnu') + ').');
    return JSON.parse(txt.replace(/^```(json)?|```$/g, '').trim());
  }
  throw new Error('Gemini : ' + (derniere || 'aucun modèle disponible'));
}

/* ==================== 1. L'histoire ==================== */
/* Pourcentage qui monte avec le temps vers un plafond (pour les attentes où Google ne dit rien) */
const versPlafond = (t0, attendu, plafond) => plafond * (1 - Math.exp(-(Date.now() - t0) / attendu));
async function ecrire(t) {
  const R = t.recette;
  // Gemini RÉFLÉCHIT d'abord (20 à 30 s, rien n'arrive) : on avance avec le temps jusqu'à 60 % au plus ;
  // dès que le texte arrive en flux, on compte les vrais caractères pour le reste (essai réel du 2026-10-14).
  const t0 = Date.now(); let depart = null;
  const minuterie = setInterval(() => { if (depart === null) avance(t, 'histoire', { pct: 2 + versPlafond(t0, R.type === 'arbre' ? 35000 : 22000, 58), det: 'Gemini imagine l’histoire…' }); }, 1000);
  let j;
  try {
    j = await geminiJson({ system: R.texte.system, user: R.texte.user, images: R.texte.images || [], schema: R.texte.schema, modeles: R.texte.modeles, attendu: R.texte.attendu,
      onAvance: f => { if (depart === null) depart = t.phases.histoire?.pct || 2; avance(t, 'histoire', { pct: depart + (98 - depart) * f, det: 'Gemini écrit…' }); } });
  } finally { clearInterval(minuterie); }
  const net = x => String(x || '').replace(/\\n/g, '\n').trim();
  if (R.type === 'arbre') {             // même découpage qu'index.html (genererArbre)
    const arbre = { '': { texte: net(j.debut?.texte), choixA: j.debut?.choixA, choixB: j.debut?.choixB } };
    for (const c of ['A', 'B']) {
      const su = j['suite' + c] || {};
      arbre[c] = { texte: net(su.texte), choixA: su.choixA, choixB: su.choixB };
      arbre[c + 'A'] = { texte: net(su.finA?.texte) };
      arbre[c + 'B'] = { texte: net(su.finB?.texte) };
    }
    if (Object.values(arbre).some(n => !n.texte)) throw new Error('Gemini a oublié une branche de l\'histoire : touche « Une autre ».');
    return { titre: String(j.titre || '').trim(), histoire: arbre[''].texte, choixA: arbre[''].choixA, choixB: arbre[''].choixB, arbre };
  }
  if (!j.histoire) throw new Error('Gemini n\'a pas écrit d\'histoire.');
  return { titre: String(j.titre || '').trim(), histoire: net(j.histoire) };
}

/* ==================== 2. Les images (planifierImages + dessinerGemini d'index.html) ==================== */
const SCHEMA_ILLUS = { type: 'OBJECT', properties: {
  fiche: { type: 'STRING' },
  scenes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { ou: { type: 'STRING' }, description: { type: 'STRING' } }, required: ['ou', 'description'] } }
}, required: ['fiche', 'scenes'] };
const STYLES_GEMINI = {
  aquarelle: 'soft watercolor children\'s picture book style, gentle pastel colors, warm light',
  crayons: 'colored pencil children\'s picture book style, textured paper, warm colors',
  anime: 'cute cartoon animation style, bright cheerful colors, rounded shapes',
  papier: 'cut paper collage children\'s picture book style, layered paper, soft shadows',
  cire: 'wax crayon children\'s drawing style, thick waxy strokes, bright simple colors, childlike',
  pate: 'claymation plasticine style, modeling clay characters, soft rounded shapes, stop-motion look',
  vitrail: 'stained glass picture book style, bold black outlines, glowing colored glass panels',
  bd: 'comic book style for children, clean ink outlines, flat bright colors, friendly cartoon'
};
async function planifier(t, s) {
  const I = t.recette.images, nb = I.nb;
  const morceaux = s.arbre ? Object.entries(s.arbre).map(([c, n]) => `[${c || 'debut'}] ${stripTags(n.texte)}`).join('\n\n')
    : paras(stripTags(s.histoire)).map((x, i) => `[${i}] ${x}`).join('\n\n');
  const nbParas = s.arbre ? 0 : paras(s.histoire).length;
  const n = Math.max(1, Math.min(nb, nbParas || 1));
  const cibles = Array.from({ length: n }, (_, k) => Math.round(k * nbParas / n));
  const morceauxImg = ['debut', 'A', 'B', 'AA', 'BB', 'AB', 'BA'].slice(0, Math.min(7, nb));
  const combien = s.arbre ? (nb === 1 ? 'UNE seule scène, pour [debut]' : `UNE scène pour CHACUN de ces morceaux, et seulement eux : ${morceauxImg.map(m => '[' + m + ']').join(', ')} ; « ou » = l'étiquette du morceau sans crochets`)
    : (nb === 1 ? 'UNE seule scène, pour la couverture, avec « ou » = "0"' : `EXACTEMENT ${cibles.length} scènes, une près de CHACUN de ces paragraphes : ${cibles.map(c => '[' + c + ']').join(', ')} (la première, « ou » = "0", c'est la couverture) ; « ou » = le numéro du paragraphe choisi, à 1 ou 2 paragraphes près de sa cible au plus ; jamais deux scènes au même paragraphe`);
  const user = [
    'Tu prépares les illustrations d\'un livre d\'histoire pour enfants. Écris EN ANGLAIS (pour le dessinateur).',
    `- « fiche » : la description visuelle FIXE de CHAQUE personnage qui apparaît dans une scène (5 au plus), comme des personnages de DESSIN ANIMÉ, FIDÈLE à ce que l'histoire en dit. Pour un ENFANT ou un adulte : nom, coiffure, vêtements, accessoires et leurs COULEURS exactes ; JAMAIS d'âge, de corps ni de peau. Pour un ANIMAL, une CRÉATURE ou un MÉCHANT : commence par son ESPÈCE et sa FORME telles que l'histoire les décrit (ex. une araignée = huit pattes, un corps rond, des yeux ; un dragon = ailes, queue, écailles ; un loup = museau, oreilles pointues, queue), puis ses couleurs et ses détails ; ne le change JAMAIS en autre chose (pas de boule de poils, pas de nuage, pas de vague silhouette). Une courte phrase par personnage (25 mots au plus), très concrète. Exemple : "Abby: cartoon kid with curly red hair, yellow raincoat, red boots. Biscuit: small light brown cartoon puppy with a blue collar. Grumble: a big round purple cartoon spider with eight thin legs, six shiny eyes and a tiny green hat."`,
    `- Les personnages et les choses gardent EXACTEMENT ce que l'histoire en dit (espèce, nombre de pattes, couleurs, taille, objets qu'ils portent) dans la fiche ET dans chaque scène ; si l'histoire donne un détail, il doit se voir.`,
    (t.recette.info?.meta?.mechant || '') ? `- Le méchant de cette histoire est : ${(t.recette.info?.meta?.mechant || '')}. Il doit être reconnaissable au premier coup d'œil dans la fiche et dans chaque scène où il est (sa vraie espèce, sa vraie forme), ${{ mignon: 'dessiné drôle et mignon, jamais effrayant', fidele: 'dessiné comme l\'histoire le décrit, un peu impressionnant mais pas effrayant', effrayant: 'dessiné impressionnant et sombre (yeux brillants, ombre), jamais horrible ni sanglant' }[I.mechantLook] || 'drôle et mignon'}.` : '',
    I.ficheAvant ? `- Ces personnages ont déjà été dessinés dans les chapitres précédents : reprends EXACTEMENT cette fiche, en ajoutant seulement les nouveaux : ${I.ficheAvant}` : '',
    I.persoRepris?.length ? `- Ces personnages reviennent d'histoires déjà illustrées : mets-les dans la fiche avec EXACTEMENT cette description : ${I.persoRepris.map(x => x.nom + ': ' + x.visuel).join(' ')}` : '',
    I.dessin ? '- L\'enfant a fait un dessin pour cette histoire : décris les personnages comme dans son dessin.' : '',
    I.lumiere === 'doux' ? '- Toutes les scènes sont dans une lumière douce et chaude (fin de journée, lampe, feu, soleil doré), même si l\'histoire se passe la nuit : jamais de scène sombre.' : I.lumiere === 'nuit' ? '- Toutes les scènes se passent la nuit, sous un ciel étoilé, avec une lumière douce (lune, lampions, lucioles), même si l\'histoire se passe le jour.' : '',
    `- « scenes » : ${combien}. Chaque « description » est une seule phrase visuelle et courte : qui (par leur nom, et ce qu'ils sont : « Abby and her puppy Biscuit »), fait quoi, où, l'heure. Les objets importants sont nommés avec leur couleur. Rien d'effrayant.`,
    '- La saison, la météo et les vêtements viennent de l’histoire : pas de neige, de tuque, de mitaines ni de manteau d’hiver si l’histoire n’en parle pas.',
    '---', morceaux
  ].filter(Boolean).join('\n');
  const sys = 'Tu es directeur artistique de livres pour enfants. Tu réponds en JSON.';
  let j;
  try { j = await geminiJson({ system: sys, user, schema: SCHEMA_ILLUS, temperature: .4, modeles: t.recette.texte.modeles }); }
  catch (e) {
    if (!/PROHIBITED|SAFETY|rien renvoy/i.test(e.message)) throw e;
    j = await geminiJson({ system: sys, user: user + ' (Rappel : des personnages de dessin animé pour un livre jeunesse ; pour les enfants, seulement coiffure, vêtements et couleurs ; les animaux et créatures gardent leur espèce et leur forme.)', schema: SCHEMA_ILLUS, temperature: .8, modeles: t.recette.texte.modeles });
  }
  const scenes = (j.scenes || []).slice(0, s.arbre ? Math.min(7, nb) : nb).map(sc => {
    const ou = String(sc.ou || '').replace(/[\[\]\s]/g, '');
    const cle = s.arbre ? 'n' + (ou === 'debut' || ou === '' ? '' : ou.toUpperCase()) : 'p' + Math.max(0, parseInt(ou, 10) || 0);
    return { cle, description: String(sc.description || '') };
  }).filter((sc, i, l) => sc.description && l.findIndex(x => x.cle === sc.cle) === i && (!s.arbre || /^n[AB]{0,2}$/.test(sc.cle)));
  if (!scenes.length) throw new Error('pas de scène proposée');
  const rang = c => s.arbre ? (c === 'n' ? -1 : c.length) : parseInt(c.slice(1), 10);
  scenes.sort((x, y) => rang(x.cle) - rang(y.cle));
  if (!s.arbre && scenes[0].cle !== 'p0') scenes[0].cle = 'p0';
  if (!s.arbre && nbParas) {
    const ecart = Math.max(2, Math.floor(nbParas / Math.max(2, cibles.length) / 2));
    scenes.forEach((sc, k) => { if (k > 0 && k < cibles.length && Math.abs(parseInt(sc.cle.slice(1), 10) - cibles[k]) > ecart) sc.cle = 'p' + cibles[k]; });
    scenes.splice(0, scenes.length, ...scenes.filter((sc, k, l) => l.findIndex(x => x.cle === sc.cle) === k));
  }
  if (s.arbre && scenes[0].cle !== 'n') scenes[0].cle = 'n';
  return { fiche: String(j.fiche || ''), style: I.style || 'aquarelle', lumiere: I.lumiere || 'histoire', mechantLook: I.mechantLook || 'mignon', scenes };
}
async function dessinerGemini(illus, sc, refs, modeles) {
  const texte = [
    `Illustrate this scene for a children's picture book, in a ${STYLES_GEMINI[illus.style] || STYLES_GEMINI.aquarelle}, landscape format: ${sc.description}`,
    `Characters: ${illus.fiche}`,
    refs.length ? 'Keep the characters EXACTLY as in the reference image: same faces, hair, clothes, colors and art style. Only the scene, pose and setting change.' : '',
    `Draw EVERY character exactly as described above: same species, same body shape (count the legs, wings, tails), same colors and outfits. A creature or villain must stay clearly recognizable as what it is (a spider is a spider with eight legs, never a fluffy ball) — ${{ mignon: 'just drawn cute and friendly', fidele: 'drawn as the story describes it, a little impressive but not scary', effrayant: 'drawn impressive and dark (glowing eyes, deep shadows), never gory or horrific' }[illus.mechantLook] || 'cute and friendly'}.`,
    illus.mechantLook === 'effrayant' ? 'A storybook mood with some thrill, but nothing gory. No text, no letters, no speech bubbles.' : 'Gentle and reassuring, nothing scary. No text, no letters, no speech bubbles.'
  ].filter(Boolean).join('\n');
  const parts = [{ text: texte }, ...refs.map(r => ({ inlineData: { mimeType: r.type || 'image/jpeg', data: r.b64 } }))];
  let derniere = '';
  for (const model of modeles?.length ? modeles : ['gemini-2.5-flash-image']) {
    for (let essai = 1; essai <= 3; essai++) {
      let r;
      try {
        r = await fetch(`${GOOGLE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': CLE_GEMINI },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } })
        });
      } catch (e) { derniere = e.message; await sleep(4000 * essai); continue; }
      if (r.ok) {
        const d = await r.json();
        const im = (d.candidates?.[0]?.content?.parts || []).find(x => x.inlineData?.data);
        if (im) return { b64: im.inlineData.data, type: im.inlineData.mimeType || 'image/png' };
        derniere = 'pas d\'image renvoyée (' + (d.candidates?.[0]?.finishReason || d.promptFeedback?.blockReason || '?') + ')';
        break;
      }
      derniere = await errTexte(r);
      if ((r.status === 429 && !/limit: 0|billing|free tier/i.test(derniere)) || r.status >= 500) { await sleep(4000 * essai); continue; }
      break;
    }
    if (/limit: 0|billing|free tier|not available|permission|PERMISSION_DENIED/i.test(derniere)) throw new Error('facturation Gemini non active pour les images');
  }
  throw new Error(derniere || 'aucun modèle d\'images Gemini');
}
async function illustrer(t, s) {
  const I = t.recette.images;
  avance(t, 'images', { etat: 'actif', pct: 1, det: 'Gemini choisit les scènes…' });
  const illus = await planifier(t, s);
  t.resultat.illus = illus; t.resultat.images = [];
  const total = illus.scenes.length, enCours = new Map();
  const pct = () => 10 + 90 * (t.resultat.images.length + [...enCours.values()].reduce((a, d) => a + Math.min(.9, (Date.now() - d) / 15000), 0)) / total;
  const minuterie = setInterval(() => avance(t, 'images', { pct: pct() }), 1000);
  const ranger = async (sc, im) => {
    await fs.writeFile(path.join(t.dossier, 'image-' + sc.cle), Buffer.from(im.b64, 'base64'));
    t.resultat.images.push({ cle: sc.cle, type: im.type });
    if (sc === illus.scenes[0]) t.couverture = im;
    avance(t, 'images', { pct: pct(), det: `${t.resultat.images.length} / ${total} images` });
  };
  try {
    avance(t, 'images', { pct: 10, det: `0 / ${total} images` });
    const premiere = illus.scenes[0];
    enCours.set(premiere.cle, Date.now());
    const refsCouv = I.dessin && I.refs?.length ? I.refs.slice(0, 1) : I.memeLook === false ? [] : (I.refs || []).slice(0, 2);
    await ranger(premiere, await dessinerGemini(illus, premiere, refsCouv, I.modeles));
    enCours.delete(premiere.cle);
    const modele = () => (I.dessin && I.refs?.length) ? I.refs[0] : I.memeLook === false ? null : t.couverture;
    let k = 1;
    const travailleur = async () => {
      while (k < total) {
        const sc = illus.scenes[k++];
        enCours.set(sc.cle, Date.now());
        try { await ranger(sc, await dessinerGemini(illus, sc, modele() ? [modele()] : [], I.modeles)); } finally { enCours.delete(sc.cle); }
      }
    };
    await Promise.all([travailleur(), travailleur(), travailleur()]);
    avance(t, 'images', { etat: 'fini', pct: 100, det: `${total} image${total > 1 ? 's' : ''}` });
  } finally { clearInterval(minuterie); }
}

/* ==================== 3. La voix ==================== */
/* Voix Microsoft : par le relais Python (edge-tts), avec la clé du relais */
async function edgeMorceau(texte, voix, vitesse, hauteur = 0) {
  const r = await avecEssais(() => fetch(`${RELAIS}/histoires/tts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relais': RELAIS_CLE },
    body: JSON.stringify({ texte, voix, vitesse, hauteur })
  }));
  if (!r.ok) throw new Error('Voix Microsoft : ' + await errTexte(r));
  return Buffer.from(await r.arrayBuffer());
}
const SYS_VOIX = `Tu prépares un livre audio à plusieurs voix. Tu ne réécris JAMAIS le texte : tu le recopies mot pour mot, dans l'ordre, en morceaux.`;
const SCHEMA_VOIX = {
  type: 'OBJECT',
  properties: {
    personnages: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      nom: { type: 'STRING' }, genre: { type: 'STRING', enum: ['f', 'm'] }, age: { type: 'STRING', enum: ['enfant', 'adulte', 'vieux'] } },
      required: ['nom', 'genre', 'age'] } },
    segments: { type: 'ARRAY', items: { type: 'OBJECT', properties: { qui: { type: 'STRING' }, texte: { type: 'STRING' } }, required: ['qui', 'texte'] } }
  },
  required: ['personnages', 'segments']
};
async function distribuerRoles(texte, modeles, google) {
  const propre = paras(google ? stripTags(texte) : pourVoixSimple(texte)).join('\n\n');
  const user = [
    'Voici une histoire pour enfants. Découpe-la en morceaux pour une lecture à plusieurs voix.',
    '- Recopie TOUT le texte, mot pour mot, sans rien ajouter, enlever ni corriger, dans l\'ordre.',
    '- Un morceau est soit de la narration (qui = "narrateur"), soit les paroles d\'un personnage : seulement les mots entre guillemets « » qu\'il prononce, sans les guillemets. L\'incise (« dit le renard », « murmura Abby ») reste au narrateur.',
    '- Dans « personnages », donne chaque personnage qui parle, avec exactement le même nom que dans « qui », son genre (f ou m) et son âge (enfant, adulte, vieux). Un animal ou une créature : choisis selon son caractère (un gros ours = m adulte, une petite souris = enfant).',
    '---', propre
  ].join('\n');
  const j = await geminiJson({ system: SYS_VOIX, user, schema: SCHEMA_VOIX, temperature: .2, modeles });
  const norme = x => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const dansTexte = norme(propre);
  if (Array.isArray(j.segments)) j.segments = j.segments.filter(x => { const n = norme(x.texte); return !n || dansTexte.includes(n.slice(0, 60)); });
  const total = (j.segments || []).reduce((n, x) => n + (x.texte || '').length, 0);
  const attendu = propre.replace(/[«»]/g, '').length;
  if (!j.segments?.length || total < attendu * .85 || total > attendu * 1.15) throw new Error('découpage des voix incomplet');
  return j;
}
const MS_HOMMES = ['fr-CA-JeanNeural', 'fr-CA-AntoineNeural', 'fr-CA-ThierryNeural'];
function attribuerVoixMs(personnages, narr) {
  const hommes = MS_HOMMES.filter(v => v !== narr), roles = {};
  let iH = 0, iF = 0;
  for (const p of personnages) {
    let voix, hauteur = 0, vitesse = 0;
    if (p.genre === 'm') { voix = hommes[iH % hommes.length]; hauteur = -8 * Math.floor(iH / hommes.length); iH++; }
    else { voix = 'fr-CA-SylvieNeural'; hauteur = (narr === 'fr-CA-SylvieNeural' ? 12 : 0) + 8 * iF; iF++; }
    if (p.age === 'enfant') { hauteur += 22; vitesse += 6; } else if (p.age === 'vieux') { hauteur -= 12; vitesse -= 12; }
    roles[p.nom] = { voix, hauteur: Math.max(-40, Math.min(40, hauteur)), vitesse };
  }
  return roles;
}
function regrouper(segments, roles, max, sepNarr) {     // morceaux voisins de la même voix : réunis
  const segs = [];
  for (const x of segments) {
    const qui = roles[x.qui] ? x.qui : 'narrateur';
    for (const m of chunk((x.texte || '').trim(), max)) {
      const der = segs[segs.length - 1];
      if (der && der.qui === qui && der.t.length + m.length < max) der.t += (qui === 'narrateur' ? sepNarr : ' ') + m;
      else segs.push({ qui, t: m });
    }
  }
  return segs;
}
async function enParallele(n, total, faire) {
  const out = new Array(total); let k = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (k < total) { const i = k++; out[i] = await faire(i); } }));
  return out;
}
const court = v => v.replace(/^fr-(CA|FR)-(Chirp3-HD-|Neural2-|Studio-)?/, '').replace(/Neural$/, '');
async function voixMicrosoft(texte, V, prog, etape = () => {}) {
  const base = V.neutre ? -10 : (parseInt(V.msRate, 10) || 0);
  if (V.multivoix) {
    try {
      etape('roles');
      const j = await distribuerRoles(texte, V.modeles).finally(() => etape('voix'));
      const roles = attribuerVoixMs(j.personnages || [], V.msVoix);
      const segs = regrouper(j.segments, roles, 2400, '\n');
      let fait = 0;
      const out = await enParallele(3, segs.length, async i => {
        const r = roles[segs[i].qui] || { voix: V.msVoix, hauteur: 0, vitesse: 0 };
        const b = await edgeMorceau(segs[i].t, r.voix, base + r.vitesse, r.hauteur);
        prog(++fait / segs.length); return b;
      });
      V.multiFait = true;
      return Buffer.concat(out);
    } catch (e) { if (/injoignable|HTTP 5/.test(e.message)) throw e; log('une voix par personnage impossible :', e.message); }
  }
  const morceaux = chunk(pourVoixSimple(texte), 2500), out = [];
  for (let i = 0; i < morceaux.length; i++) { out.push(await edgeMorceau(morceaux[i], V.msVoix, base)); prog((i + 1) / morceaux.length); }
  return Buffer.concat(out);
}
/* Voix Google : paliers Chirp 3 HD → Neural2 → Studio, compteurs du mois tenus PAR LE SERVEUR */
const PALIERS = [{ id: 'chirp', nom: 'Chirp 3 HD', test: n => /Chirp3-HD/.test(n) }, { id: 'neural', nom: 'Neural2', test: n => /Neural2/.test(n) }, { id: 'studio', nom: 'Studio', test: n => /Studio/.test(n) }];
const FICHIER_COMPTEURS = path.join(DOSSIER, 'compteurs-google.json');
let compteurs = {};
try { compteurs = JSON.parse(fss.readFileSync(FICHIER_COMPTEURS, 'utf8')); } catch {}
const moisP = id => id + ':' + new Date().toISOString().slice(0, 7);
const utilise = id => compteurs[moisP(id)] || 0;
async function compter(id, n) { compteurs[moisP(id)] = utilise(id) + n; await fs.writeFile(FICHIER_COMPTEURS, JSON.stringify(compteurs)); }
const GC_JEU = {
  whispers: { r: 96, p: -1, v: 'soft' }, softly: { r: 97, v: 'soft' }, sleepy: { r: 93, p: -1, v: 'soft' },
  tenderly: { r: 97, v: 'soft' }, warmly: {}, relieved: { r: 97 },
  excited: { r: 108, p: 2 }, happy: { r: 104, p: 1 }, playfully: { r: 104, p: 1 }, mischievously: { r: 103, p: 1 },
  proud: { p: 1 }, amazed: { p: 2 }, surprised: { r: 105, p: 2 }, curious: { p: 1 }, quickly: { r: 112 },
  sad: { r: 95, p: -2, v: 'soft' }, nervous: { r: 105, p: 1 }, scared: { r: 106, p: 2, v: 'soft' }, grumpy: { p: -2 },
  slowly: { r: 92 }, mysteriously: { r: 95, p: -1, v: 'soft' }, dramatically: { r: 96, p: -1 }, shouting: { r: 104, p: 2, v: 'loud' },
  'deep voice': { r: 97, p: -5 }, 'booming voice': { r: 97, p: -4, v: 'loud' }, 'old voice': { r: 94, p: -3 },
  'squeaky voice': { r: 106, p: 5 }, 'tiny voice': { r: 104, p: 6, v: 'soft' }
};
const xmlEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function gcProsodie(x, j, studio, brut) {
  const a = [];
  if (j?.r && j.r !== 100) a.push(`rate="${j.r}%"`);
  if (j?.p && !studio) a.push(`pitch="${j.p > 0 ? '+' : ''}${j.p}st"`);
  if (j?.v) a.push(`volume="${j.v}"`);
  const c = brut ? x : xmlEsc(x);
  return a.length ? `<prosody ${a.join(' ')}>${c}</prosody>` : c;
}
function gcParaSsml(p, studio) {
  const m = p.split(/\[([^\]\n]{1,40})\]\s*/);
  let out = xmlEsc(m[0]), jeu = null;
  for (let i = 1; i < m.length; i += 2) {
    const tag = m[i].trim().toLowerCase(), suite = m[i + 1] || '';
    if (/^pause/.test(tag)) { out += '<break time="600ms"/>' + xmlEsc(suite); jeu = null; continue; }
    const j = GC_JEU[tag];
    if (j) jeu = { ...(jeu || {}), ...j };
    if (!suite.trim()) continue;
    if (!jeu) { out += xmlEsc(suite); continue; }
    const portee = (/^\s*«[^»]*»/.exec(suite) || /^[^.!?…]*[.!?…]+[»"]?/.exec(suite) || [suite])[0];
    out += gcProsodie(portee, jeu, studio) + xmlEsc(suite.slice(portee.length));
    jeu = null;
  }
  return out;
}
function gcEntree(texte, pl, base) {
  if (pl.id === 'chirp') return { markup: paras(texte).map(p => stripTags(p.replace(/\[\s*pause[^\]]*\]/gi, '\u0001')).replace(/\u0001/g, '[pause long] ')).join(' [pause] ') };
  const studio = pl.id === 'studio';
  const corps = paras(texte).map(p => `<p>${gcParaSsml(p, studio)}</p>`).join('');
  return { ssml: `<speak>${base ? gcProsodie(corps, base, studio, true) : corps}</speak>` };
}
async function gcMorceau(texte, pl, voix, vitesse, base) {
  let entree = gcEntree(texte, pl, base), rate = vitesse;
  for (let essai = 0; essai < 3; essai++) {
    const corps = JSON.stringify({ input: entree, voice: { languageCode: voix.slice(0, 5), name: voix }, audioConfig: { audioEncoding: 'MP3', ...(rate ? { speakingRate: rate } : {}) } });
    const r = await avecEssais(() => fetch(`${GOOGLE_TTS}/v1/text:synthesize`, { method: 'POST', headers: { 'x-goog-api-key': CLE_TTS, 'Content-Type': 'application/json' }, body: corps }));
    if (r.ok) { await compter(pl.id, (entree.ssml || entree.markup || entree.text).length); return Buffer.from((await r.json()).audioContent, 'base64'); }
    const m = await errTexte(r);
    if (r.status === 400 && rate && /rate|speaking/i.test(m)) { rate = 0; continue; }
    if (r.status === 400 && !entree.text) { entree = { text: stripTags(texte) }; continue; }
    const e = new Error('Google : ' + m); e.quota = r.status === 429 || /quota/i.test(m); e.palier = true; throw e;
  }
  throw new Error('Google : lecture refusée');
}
let listesGoogle = null;
async function listeGoogle(pl, lang) {
  if (!listesGoogle) {
    const r = await avecEssais(() => fetch(`${GOOGLE_TTS}/v1/voices?languageCode=fr`, { headers: { 'x-goog-api-key': CLE_TTS } }));
    if (!r.ok) throw new Error('liste des voix Google : ' + await errTexte(r));
    listesGoogle = (await r.json()).voices || [];
  }
  return listesGoogle.filter(v => pl.test(v.name) && v.languageCodes.includes(lang)).map(v => ({ n: v.name, g: v.ssmlGender }));
}
const gcEstime = x => Math.round(pourVoixSimple(x).length * 1.3);
async function voixGoogle(texte, V, prog, enPanne, etape = () => {}) {
  const pl = PALIERS.find(p => V.gcVoix?.[p.id] && !enPanne.has(p.id) && utilise(p.id) + gcEstime(texte) <= (V.plafond || 995000));
  if (!pl) { const e = new Error('les paliers de voix Google sont pleins ce mois-ci ou indisponibles'); e.quota = true; throw e; }
  const narr = V.gcVoix[pl.id];
  const vitesse = (V.neutre ? .9 : (parseFloat(V.gcRate) || .9)) + (pl.id !== 'chirp' ? .1 : 0);
  try {
    if (V.multivoix) {
      try {
        etape('roles');
        const j = await distribuerRoles(texte, V.modeles, true).finally(() => etape('voix'));
        const liste = await listeGoogle(pl, narr.slice(0, 5));
        const pool = g => liste.filter(v => v.g === g && v.n !== narr).map(v => v.n);
        const F = pool('FEMALE'), M = pool('MALE'), roles = {};
        let iF = 0, iM = 0;
        for (const p of j.personnages || []) {
          const l = p.genre === 'm' ? M : F; if (!l.length) continue;
          const i = p.genre === 'm' ? iM++ : iF++;
          const base = { r: 100, p: (p.genre === 'm' ? -3 : 3) * Math.floor(i / l.length) };
          if (p.age === 'enfant') { base.r = 106; base.p += 3; } else if (p.age === 'vieux') { base.r = 95; base.p -= 3; }
          roles[p.nom] = { voix: l[i % l.length], base };
        }
        const segs = regrouper(j.segments, roles, 1000, '\n\n');
        let fait = 0;
        const out = await enParallele(3, segs.length, async i => {
          const r = roles[segs[i].qui];
          const vit = vitesse * (r && pl.id === 'chirp' ? r.base.r / 100 : 1);
          const b = await gcMorceau(segs[i].t, pl, r ? r.voix : narr, vit, r && pl.id !== 'chirp' ? r.base : null);
          prog(++fait / segs.length); return b;
        });
        return { buf: Buffer.concat(out), palier: pl, narr, multi: true };
      } catch (e) { if (e.palier) throw e; log('une voix Google par personnage impossible :', e.message); }
    }
    const morceaux = chunk(pourVoixGoogle(texte), pl.id === 'chirp' ? 1500 : 1100), out = [];
    for (let i = 0; i < morceaux.length; i++) { out.push(await gcMorceau(morceaux[i], pl, narr, vitesse)); prog((i + 1) / morceaux.length); }
    return { buf: Buffer.concat(out), palier: pl, narr, multi: false };
  } catch (e) {
    if (e.palier && !e.quota) { enPanne.add(pl.id); return voixGoogle(texte, V, prog, enPanne, etape); }   // ce palier refuse : le suivant
    throw e;
  }
}
/* Un texte → MP3 : Google d'abord (mode auto ou Google), puis Microsoft */
async function enregistrer(texte, V, prog, etape) {
  if (V.moteur !== 'edge' && CLE_TTS && V.gcVoix && Object.values(V.gcVoix).some(Boolean)) {
    try {
      const r = await voixGoogle(texte, V, prog, new Set(), etape);
      // nom et clé comme ceux de l'app (v50, plusieurs voix par histoire)
      return { buf: r.buf, moteur: 'gcloud', nom: `Google ${r.palier.nom} · ${court(r.narr)}${r.multi ? ' · une voix par personnage' : ''}`, cle: ['gcloud', r.palier.id, r.narr, r.multi ? 'multi' : ''].join(':') };
    }
    catch (e) { log('voix Google impossible, Microsoft prend le relais :', e.message); }
  }
  V.multiFait = false;
  const buf = await voixMicrosoft(texte, V, prog, etape);
  return { buf, moteur: 'edge', nom: `Microsoft · ${court(V.msVoix)}${V.multiFait ? ' · une voix par personnage' : ''}`, cle: ['edge', '', V.msVoix, V.multiFait ? 'multi' : ''].join(':') };
}
async function raconter(t, s) {
  const V = t.recette.voix;
  avance(t, 'voix', { etat: 'actif', pct: 1, det: 'la voix se prépare…' });
  if (s.arbre) {
    const ordre = Object.keys(s.arbre).sort((a, b) => a.length - b.length || a.localeCompare(b));
    t.resultat.noeuds = []; t.resultat.vitNoeuds = {};
    for (let k = 0; k < ordre.length; k++) {
      const c = ordre[k];
      const r = await enregistrer(s.arbre[c].texte, V, f => avance(t, 'voix', { pct: (k + f) / ordre.length * 100 }));
      await fs.writeFile(path.join(t.dossier, 'noeud-' + (c || 'debut')), r.buf);
      t.resultat.noeuds.push(c); t.resultat.vitNoeuds[c] = { m: r.moteur, n: V.neutre };
      if (c === '') { t.resultat.vitMoteur = r.moteur; t.resultat.vitNeutre = V.neutre; t.resultat.voixNom = r.nom; t.resultat.voixCle = r.cle; }
      avance(t, 'voix', { pct: (k + 1) / ordre.length * 100, det: `${r.nom} · ${k + 1} / ${ordre.length} morceaux` });
    }
    avance(t, 'voix', { etat: 'fini', pct: 100, det: `${ordre.length} morceaux` });
    return;
  }
  // Une voix par personnage : Gemini répartit d'abord les rôles (jusqu'à ~45 s, rien à compter) → 0-25 % avec le temps
  let roles = null, base = 0;
  const minuterie = setInterval(() => { if (roles) avance(t, 'voix', { pct: versPlafond(roles, 25000, 25) }); }, 1000);
  const etape = e => {
    if (e === 'roles') { roles = Date.now(); avance(t, 'voix', { det: 'Gemini distribue les rôles…' }); }
    else { base = roles ? (t.phases.voix?.pct || 0) : 0; roles = null; avance(t, 'voix', { det: 'la voix enregistre…' }); }
  };
  let r;
  try { r = await enregistrer(s.histoire, V, f => avance(t, 'voix', { pct: base + (100 - base) * f, det: 'la voix enregistre…' }), etape); }
  finally { clearInterval(minuterie); }
  await fs.writeFile(path.join(t.dossier, 'audio'), r.buf);
  t.resultat.audio = true; t.resultat.vitMoteur = r.moteur; t.resultat.vitNeutre = V.neutre; t.resultat.voixNom = r.nom; t.resultat.voixCle = r.cle;
  avance(t, 'voix', { etat: 'fini', pct: 100, det: r.nom });
}

/* ==================== les travaux ==================== */
const travaux = new Map();                 // id → travail (en mémoire ; l'état est aussi sur disque)
function vue(t) { return { id: t.id, cree: t.cree, fini: t.fini, erreur: t.erreur || '', phases: t.phases, resultat: t.resultat }; }
let ecritureEnAttente = new Map();
function sauverEtat(t) {                    // écritures groupées : l'état change plusieurs fois par seconde
  if (ecritureEnAttente.has(t.id)) return;
  ecritureEnAttente.set(t.id, setTimeout(async () => {
    ecritureEnAttente.delete(t.id);
    try { await fs.writeFile(path.join(t.dossier, 'etat.json'), JSON.stringify({ ...vue(t), user: t.user })); } catch {}
  }, 500));
}
function avance(t, ph, o) {
  const av = t.phases[ph] || {};
  if (o.pct != null && av.etat === 'actif' && (o.etat || 'actif') === 'actif') o = { ...o, pct: Math.max(av.pct || 0, o.pct) };   // jamais en arrière
  t.phases[ph] = { ...av, ...o }; sauverEtat(t);
}
let actifs = 0;
const file = [];
function lancer() {
  while (actifs < EN_MEME_TEMPS && file.length) {
    const t = file.shift(); actifs++;
    fabriquer(t).catch(e => log('fabrication', t.id, e)).finally(() => { actifs--; lancer(); });
  }
}
async function fabriquer(t) {
  const R = t.recette;
  log('début', t.id, R.type, 'images', R.images?.nb || 0);
  try {
    avance(t, 'histoire', { etat: 'actif', pct: 2, det: 'Gemini écrit…' });
    if (R.avecDessin && R.texte.images?.[0]) {             // le dessin de l'enfant : il devient la couverture
      await fs.writeFile(path.join(t.dossier, 'dessin'), Buffer.from(R.texte.images[0].b64, 'base64'));
      t.resultat.dessin = R.texte.images[0].type || 'image/jpeg';
    }
    const s = await ecrire(t);
    Object.assign(t.resultat, s);
    avance(t, 'histoire', { etat: 'fini', pct: 100, det: `écrite en ${Math.round((Date.now() - t.cree) / 1000)} s` });
    const parties = [
      R.images?.nb ? illustrer(t, s).catch(e => avance(t, 'images', { etat: 'err', det: e.message.slice(0, 120) })) : null,
      R.voix?.moteur !== 'phone' ? raconter(t, s).catch(e => avance(t, 'voix', { etat: 'err', det: e.message.slice(0, 120) })) : null
    ].filter(Boolean);
    await Promise.all(parties);
  } catch (e) {
    t.erreur = e.message; avance(t, 'histoire', { etat: 'err', det: e.message.slice(0, 120) });
    for (const ph of ['images', 'voix']) if (t.phases[ph]?.etat === 'attente') avance(t, ph, { etat: 'err', det: 'l\'histoire n\'a pas pu s\'écrire' });
  }
  t.fini = true; sauverEtat(t);
  delete t.recette;                         // la recette (et ses images) n'est plus utile
  await fs.rm(path.join(t.dossier, 'recette.json'), { force: true });
  log('fin', t.id, t.erreur || 'ok', JSON.stringify(Object.fromEntries(Object.entries(t.phases).map(([k, v]) => [k, v.etat]))));
  notifier(t).catch(e => log('notification', e.message));
}
async function relireTravaux() {             // au démarrage : les travaux finis restent à récupérer ; les autres ont été coupés
  await fs.mkdir(TRAVAUX, { recursive: true });
  for (const id of await fs.readdir(TRAVAUX)) {
    const d = path.join(TRAVAUX, id);
    try {
      const e = JSON.parse(await fs.readFile(path.join(d, 'etat.json'), 'utf8'));
      if (Date.now() - e.cree > GARDER_MS) { await fs.rm(d, { recursive: true, force: true }); continue; }
      const t = { ...e, dossier: d };
      if (!t.fini) {
        t.fini = true; t.erreur = t.erreur || 'le serveur a redémarré pendant la fabrication : touche « Une autre »';
        for (const [k, v] of Object.entries(t.phases || {})) if (v.etat !== 'fini') t.phases[k] = { ...v, etat: 'err', det: 'interrompu (redémarrage du serveur)' };
        sauverEtat(t);
      }
      travaux.set(id, t);
    } catch { await fs.rm(d, { recursive: true, force: true }).catch(() => {}); }
  }
}
setInterval(async () => {                     // ménage : travaux jamais récupérés
  for (const [id, t] of travaux) if (t.fini && Date.now() - t.cree > GARDER_MS) { travaux.delete(id); await fs.rm(t.dossier, { recursive: true, force: true }).catch(() => {}); }
}, 3600000);

/* ==================== notifications (Web Push, sans contenu : rien à chiffrer) ==================== */
const FICHIER_VAPID = path.join(DOSSIER, 'vapid.json');
const FICHIER_ABOS = path.join(DOSSIER, 'abonnements.json');
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let vapid;
async function cleVapid() {
  if (vapid) return vapid;
  try { vapid = JSON.parse(await fs.readFile(FICHIER_VAPID, 'utf8')); }
  catch {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    vapid = { prive: privateKey.export({ format: 'pem', type: 'pkcs8' }), public: b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])) };
    await fs.writeFile(FICHIER_VAPID, JSON.stringify(vapid), { mode: 0o600 });
  }
  return vapid;
}
let abonnements = {};
try { abonnements = JSON.parse(fss.readFileSync(FICHIER_ABOS, 'utf8')); } catch {}
async function notifier(t) {
  const abos = abonnements[t.user] || [];
  if (!abos.length) return;
  const v = await cleVapid();
  for (const a of [...abos]) {
    const aud = new URL(a.endpoint).origin;
    const tete = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const corps = b64url(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: ORIGINE + '/histoires/' }));
    const sig = crypto.sign('sha256', Buffer.from(tete + '.' + corps), { key: v.prive, dsaEncoding: 'ieee-p1363' });
    const r = await fetch(a.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'normal', Authorization: `vapid t=${tete}.${corps}.${b64url(sig)}, k=${v.public}` } }).catch(e => ({ status: 0, e }));
    if (r.status === 404 || r.status === 410) {                // abonnement mort : on l'oublie
      abonnements[t.user] = (abonnements[t.user] || []).filter(x => x.endpoint !== a.endpoint);
      await fs.writeFile(FICHIER_ABOS, JSON.stringify(abonnements));
    } else if (!(r.status >= 200 && r.status < 300)) log('notification refusée', r.status);
  }
}

/* ==================== accès : la session de l'app Maison ==================== */
const jetonsOk = new Map();              // empreinte → { user, jusqua }
async function qui(req) {
  const jeton = String(req.headers.authorization || '').trim();
  if (!jeton || jeton.length > 2000) return null;
  const cle = crypto.createHash('sha256').update(jeton).digest('hex');
  const c = jetonsOk.get(cle);
  if (c && c.jusqua > Date.now()) return c.user;
  let user = null;
  try { user = JSON.parse(Buffer.from(jeton.split('.')[1], 'base64url').toString()).id || null; } catch {}
  if (!user) return null;
  try {
    const r = await fetch(`${MAISON}/api/collections/users/records?perPage=1&fields=id`, { headers: { Authorization: jeton }, signal: AbortSignal.timeout(8000) });
    if (!(r.status === 200 && (await r.json()).totalItems >= 1)) return null;
  } catch { return null; }
  jetonsOk.set(cle, { user, jusqua: Date.now() + 600000 });
  return user;
}

/* ==================== HTTP ==================== */
function json(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); }
async function lireCorps(req, max) {
  const morceaux = []; let n = 0;
  for await (const m of req) { n += m.length; if (n > max) throw Object.assign(new Error('recette trop grosse'), { code: 413 }); morceaux.push(m); }
  return JSON.parse(Buffer.concat(morceaux).toString() || '{}');
}
const ID_OK = /^[a-z0-9]{6,40}$/;
const FICHIER_OK = /^(image-(p\d{1,3}|n[AB]{0,2})|audio|dessin|noeud-(debut|[AB]{1,2}))$/;
const serveur = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const m = u.pathname.replace(/^\/histoires\/fabrique/, '').split('/').filter(Boolean);
    if (req.method === 'GET' && m[0] === 'vapid') return json(res, 200, { cle: (await cleVapid()).public });
    if (req.method === 'GET' && m[0] === 'sante') return json(res, 200, { ok: true, actifs, file: file.length });
    if (req.headers.origin && req.headers.origin !== ORIGINE) return json(res, 403, { erreur: 'origine refusée' });
    const user = await qui(req);
    if (!user) return json(res, 401, { erreur: 'connecte-toi à l\'app Maison (95.groupelaberge.ca) puis reviens dans Histoires' });

    if (req.method === 'POST' && m[0] === 'abonnement') {
      const a = await lireCorps(req, 8000);
      if (!/^https:\/\//.test(a.endpoint || '')) return json(res, 400, { erreur: 'abonnement illisible' });
      abonnements[user] = [...(abonnements[user] || []).filter(x => x.endpoint !== a.endpoint), { endpoint: a.endpoint }].slice(-6);
      await fs.writeFile(FICHIER_ABOS, JSON.stringify(abonnements));
      return json(res, 200, { ok: true });
    }
    if (m[0] !== 'travaux') return json(res, 404, { erreur: 'inconnu' });
    if (req.method === 'POST' && m.length === 1) {
      if ([...travaux.values()].filter(t => t.user === user && !t.fini).length >= 3) return json(res, 429, { erreur: 'déjà 3 histoires en fabrication : attends qu\'une finisse' });
      const recette = await lireCorps(req, RECETTE_MAX);
      if (!recette.texte?.user || !recette.texte?.system || !recette.texte?.schema) return json(res, 400, { erreur: 'recette incomplète' });
      const id = crypto.randomBytes(9).toString('hex').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
      const dossier = path.join(TRAVAUX, id);
      await fs.mkdir(dossier, { recursive: true });
      await fs.writeFile(path.join(dossier, 'recette.json'), JSON.stringify(recette));
      // « info » : ce que l'app doit savoir pour ranger l'histoire (prénoms, chapitre…), renvoyé tel quel :
      // n'importe quel appareil connecté peut alors récupérer l'histoire.
      const info = recette.info && JSON.stringify(recette.info).length < 20000 ? recette.info : {};
      const t = { id, user, cree: Date.now(), fini: false, dossier, recette, resultat: { info },
        phases: { histoire: { etat: 'attente', pct: 0, det: 'en file d\'attente' },
          ...(recette.images?.nb ? { images: { etat: 'attente', pct: 0, det: 'dès que l\'histoire est écrite' } } : {}),
          ...(recette.voix?.moteur !== 'phone' ? { voix: { etat: 'attente', pct: 0, det: 'dès que l\'histoire est écrite' } } : {}) } };
      travaux.set(id, t); sauverEtat(t);
      file.push(t); lancer();
      return json(res, 200, { id });
    }
    if (req.method === 'GET' && m.length === 1) {
      return json(res, 200, { travaux: [...travaux.values()].filter(t => t.user === user).map(t => ({ id: t.id, cree: t.cree, fini: t.fini, titre: t.resultat?.titre || '' })) });
    }
    const t = ID_OK.test(m[1] || '') && travaux.get(m[1]);
    if (!t || t.user !== user) return json(res, 404, { erreur: 'ce travail n\'existe plus' });
    if (req.method === 'GET' && m.length === 2) return json(res, 200, vue(t));
    if (req.method === 'GET' && m[2] === 'f' && FICHIER_OK.test(m[3] || '')) {
      const f = path.join(t.dossier, m[3]);
      let st; try { st = await fs.stat(f); } catch { return json(res, 404, { erreur: 'pas encore là' }); }
      const type = m[3] === 'dessin' ? t.resultat.dessin : m[3].startsWith('image-') ? (t.resultat.images?.find(x => 'image-' + x.cle === m[3])?.type || 'image/png') : 'audio/mpeg';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      return fss.createReadStream(f).pipe(res);
    }
    if (req.method === 'DELETE' && m.length === 2) {
      travaux.delete(t.id); await fs.rm(t.dossier, { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { erreur: 'inconnu' });
  } catch (e) {
    log('erreur', req.method, req.url, e.message);
    if (!res.headersSent) json(res, e.code === 413 ? 413 : 500, { erreur: e.code === 413 ? e.message : 'erreur du serveur' });
  }
});
await relireTravaux();
await cleVapid();
serveur.requestTimeout = 120000;
serveur.listen(PORT, '127.0.0.1', () => log('fabrique prête sur', PORT));
