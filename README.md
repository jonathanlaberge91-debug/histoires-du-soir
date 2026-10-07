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
