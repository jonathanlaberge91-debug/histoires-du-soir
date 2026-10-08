# 🌙 Histoires du soir

App web (PWA) pour créer des histoires pour enfants :
- **Gemini** écrit l'histoire avec des balises d'émotion ElevenLabs v3 (`[whispers]`, `[excited]`, `[giggles]`…)
- **ElevenLabs** la raconte avec les bonnes intonations

**App en ligne :** https://jonathanlaberge91-debug.github.io/histoires-du-soir/

## Utilisation
1. Ouvrir l'app dans Chrome (Android) → ⋮ → *Ajouter à l'écran d'accueil*
2. ⚙️ Réglages : clé Gemini (aistudio.google.com/apikey) + clé ElevenLabs (permissions *Text to Speech* et *Voices read*)
3. ✨ Créer → 🔊 Raconter

Les clés et les histoires (avec l'audio) restent **uniquement sur l'appareil** (localStorage / IndexedDB). Aucune clé n'est dans ce dépôt — ne jamais en ajouter.

Astuce : `…/#gemini=CLÉ&eleven=CLÉ&voice=VOICE_ID` enregistre les clés en un clic (elles sont retirées de l'adresse aussitôt).

## Notes techniques
- Fichier unique `index.html` (HTML/CSS/JS, sans dépendances) + `manifest.json`, `sw.js`, icônes
- Le prompt Gemini (`SYSTEM_PROMPT`, `MOODS`, `LANGS`) est dans `index.html`
- Modèles Gemini : `gemini-flash-latest` par défaut, repli automatique (`FALLBACK_MODELS`) si surcharge (503/429) ou modèle retiré (404)
- ElevenLabs : modèle `eleven_v3` (balises audio), texte découpé en morceaux ≤ 2500 caractères puis MP3 concaténés
- Compte ElevenLabs gratuit : 10 000 caractères/mois, voix de base seulement — les voix de la bibliothèque (dont les québécoises) exigent un forfait payant
- Après une modification, incrémenter `CACHE` dans `sw.js` pour forcer la mise à jour sur le téléphone

## Options (v6, 2026-10-07)
- **Qui raconte** (⚙️) : Automatique (ElevenLabs, puis voix Gemini quand les crédits sont épuisés), ElevenLabs, voix Gemini
  (`gemini-2.5-flash-preview-tts`, PCM 24 kHz → WAV, découpé en morceaux de 1400 caractères, attente auto sur la limite par minute),
  ou voix du téléphone (`speechSynthesis`, en direct, rien d'enregistré).
- **Crédits ElevenLabs** : `GET /v1/user/subscription` (permission « User (read) ») ; sinon compte local par mois (`el:AAAA-MM`).
- **Créer** : autres héros, 7 nouvelles ambiances, « petit souci à apprivoiser » (`SOUCIS`), format « l'enfant choisit la suite »
  (3 parties, 2 choix ; `parts[]`, audio par partie `partAudio[]`), bouton **La suite** (chapitre suivant, `serie`/`chap`).
- **Pendant l'écoute** : musique douce (boîte à musique générée en JS), texte qui suit la lecture (au prorata des caractères),
  mode nuit (écran noir, gros texte, écran gardé allumé), « Après l'histoire » : bruit doux / pluie / vagues / grave
  générés en JS, en boucle, avec minuterie et fondu.
- **Image de couverture** : modèles d'images Gemini (`IMAGE_MODELS`), réduite à 900 px JPEG ; facultative (pas dispo avec toutes les clés gratuites).
- **Bibliothèque** : recherche, favoris ⭐, filtre « avec audio », vignettes.

## Sauvegarde Google Drive (v8)
- Service Google Apps Script dans `drive/` (projet `1YSy2ygl…`, déployé en application web « exécuter en tant que moi,
  accès : tout le monde »). Mise à jour : `cd drive && clasp push -f && clasp update-deployment <id du déploiement>`.
- Rangement : Drive → `Histoires du soir/<prénom>/<AAAA-MM-JJ> — <titre>/` (Google Doc, audio, `couverture.jpg`, `infos.json`)
  + raccourcis dans `⭐ Favoris/`.
- Clé secrète créée par le script à sa première ouverture (propriétés du script) et écrite seulement dans le document
  « ⚙️ Configurer l'app » du Drive, dont le lien (`#drive=…&driveKey=…`) configure l'app. Jamais dans le dépôt.
- App : envoi automatique (création, image, audio, choix, favori) ; « Tout envoyer » ; « Récupérer mes histoires du Drive ».
  Supprimer une histoire dans l'app ne la supprime PAS du Drive.

## Voix québécoise Google (v9)
- Google Cloud Text-to-Speech (`texttospeech.googleapis.com/v1/text:synthesize`, voix `fr-CA-*`, Chirp3-HD en premier),
  clé API dans Réglages (restreinte au site + à l'API). Texte sans balises, morceaux de 1500 caractères, MP3.
- Compteur local par mois (`gc:AAAA-MM`) et plafond réglable (900 000 par défaut) : au-delà, l'app passe à la voix suivante.
- Ordre en mode Automatique : ElevenLabs → Google québécois → Gemini → téléphone.

## Sur le serveur + voix québécoise Microsoft (v10)
- Copie de l'app sur le VPS : **https://95.groupelaberge.ca/histoires/** (`/var/www/histoires`, Caddy, bloc `95.groupelaberge.ca`) —
  publier avec `bash serveur/deployer-vps.sh` (GitHub Pages reste à jour par le push). Bouton « Histoires » dans l'app Maison.
- Relais `serveur/tts.py` (edge-tts, port 8120, service `histoires-tts`, venv `/opt/histoires-tts/venv`) : voix fr-CA
  Sylvie / Antoine / Jean / Thierry, gratuites et sans compte mais NON OFFICIELLES. Origines permises : le VPS et GitHub Pages ;
  6000 caractères max, 2 à la fois, 80 demandes / 10 min par IP.
- Ordre automatique : ElevenLabs (s'il reste des crédits) → Microsoft québécois → Google (si clé) → Gemini → téléphone.
- « 📲 Ouvrir la version du serveur avec mes réglages » (sur GitHub Pages) : envoie tout au Drive, puis copie les réglages
  dans l'adresse (`#cfg=…`, jamais transmis au serveur) ; l'autre côté récupère les histoires du Drive.

## v11 (2026-10-07)
- **Une voix par personnage** (voix Microsoft) : Gemini découpe le texte en narration / répliques (`distribuerRoles`,
  recopie mot pour mot, contrôle de longueur ±15 %), `attribuerVoix` donne Jean/Antoine/Thierry aux hommes, Sylvie aux
  femmes, hauteur selon l'âge ; 3 morceaux enregistrés à la fois ; repli sur une seule voix si le découpage échoue.
- **Dessin** : photo réduite à 900 px envoyée à Gemini avec la consigne ; devient la couverture.
- **Sa journée** : vrais moments du jour transformés en aventure. **Dictée** 🎤 (Web Speech, fr-CA) sur les champs texte.
- **Partager** : `POST /histoires/partage` sur le relais → page `https://95.groupelaberge.ca/histoires/ecouter/<id>`
  (couverture, lecteur, texte) ; partages gardés dans `/var/lib/histoires-tts/partages`, plafond 3 Go (les plus vieux partent).
- **Haut-parleur** : Remote Playback (`audio.remote.prompt()`) sur l'adresse publique de l'audio partagé ; plan B Google Home.
- **Livre (PDF)** : mise en page d'impression (`@media print`, couverture + texte + « Fin ») puis `window.print()`.

## v12 — trois thèmes (2026-10-07)
- `html[data-look]` = veilleuse | livre | doudou (jetons CSS), choisi dans Réglages → Apparence, gardé dans `set:theme` et posé avant l'affichage.
- Les groupes de pastilles deviennent des choix qui s'ouvrent (`.picker`) : menu sous la ligne (Veilleuse), tuiles + grille (Livre), volet du bas (Doudou).
- Réglages en sections repliables, cartes « Qui raconte ? » (le `<select id=engine>` caché reste la source), seuls les réglages de la voix choisie s'affichent, enregistrement automatique.

## v13 — écrire pour la voix qui raconte (2026-10-07)
- `preparerEcriture()` estime la voix AVANT d'écrire (`choisirMoteur` + longueur estimée) : tout sauf ElevenLabs v3 → `CONSIGNE_VOIX_SIMPLE` (pas de balises, sons étirés, majuscules ; onomatopées simples ; émotions par les mots). `s.ecriture` = simple | eleven (les parties d'une histoire à choix gardent la même).
- `pourVoixSimple()` : filet de sécurité à la lecture pour toutes les voix sauf v3 (« Ouuuuh » → « Ouh », majuscules → minuscules).

## v14 (2026-10-08)
- **Une seule version** : l'adresse GitHub envoie ses histoires au Drive puis déménage vers https://95.groupelaberge.ca/histoires/ avec ses réglages (`demenager()`).
- **Clé du relais** (`X-Relais`) obligatoire pour les voix Microsoft et le partage ; donnée par le lien du document « ⚙️ Configurer l'app » (`&relais=`). Sur le VPS : `/etc/systemd/system/histoires-tts.service.d/cle.conf` (root 600). Pages d'écoute toujours publiques.
- **Changement de clé Drive** : `POST {a:"rotation", k, relais}` → nouvelle clé (l'ancienne valable 14 jours), nouveau document de configuration.
- **Retirer un partage** (jeton gardé par l'app). **Bibliothèque** gardée en mémoire. **Voix Gemini en MP3** (lamejs 1.2.0, cdnjs). **Polices** gardées hors ligne. **Modèles Gemini** lus chez Google (24 h). `navigator.storage.persist()`.
