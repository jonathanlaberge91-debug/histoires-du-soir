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

## Sauvegarde sur le serveur (v41, 2026-10-13) — remplace Google Drive

- Collection `histoires` (id `pbc_1791700100`) du PocketBase de l'app **Maison** (port 8094, même adresse
  95.groupelaberge.ca) : `hid` (id de l'histoire dans l'app), `titre`, `enfant`, `fav`, `creeLe`, `donnees`
  (l'histoire sans ses fichiers), fichiers protégés `audio`, `image`, `illus`, `noeuds`, et `cles` (numéro de
  fichier → clé d'illustration / de morceau : PocketBase met les noms en minuscules). Migrations dans `maison-pb`.
- Accès : la session de l'app Maison (`localStorage.pocketbase_auth`), renouvelée par l'app au plus 1×/h.
  Le relais `serveur/tts.py` accepte ce jeton (vérifié auprès de PocketBase Maison, 10 min en cache) ; l'ancienne
  clé `X-Relais` reste acceptée.
- Sauvegarde : le texte part dans la copie quotidienne chiffrée de Maison ; sons et images ont une copie miroir
  sur le VPS (`/opt/maison-backups/histoires-fichiers`), exclue de la copie hors site (GitHub refuse > 100 Mo).
- Les anciennes histoires restent dans le Drive ; le service Apps Script (`drive/`) n'est plus appelé.

## Sauvegarde Google Drive (v8) — PLUS UTILISÉE depuis v41
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

## v15 — histoire à choix écrite d'un coup (2026-10-08)
- `genererArbre()` : un seul appel Gemini écrit les 7 morceaux (début, suites A/B, fins AA/AB/BA/BB) → `s.arbre`, chemin courant `s.chemin`.
- `enregistrerArbre()` : une seule voix pour tout l'arbre (choisie sur la longueur totale) ; le morceau à l'écran d'abord, les autres en file pendant l'écoute (`s.audioNoeuds`). Choisir = aucune attente de Gemini ; si la branche n'est pas finie, on attend seulement elle.
- « 🔀 Recommencer et choisir autrement » à la fin. Les anciennes histoires à choix (sans arbre) gardent l'ancien fonctionnement.

## v17 — illustrations (2026-10-08)
- Plan par Gemini (`planifierImages`) : fiche des personnages (anglais, courte, reprise par les chapitres) + 3 à 5 scènes (une par morceau pour une histoire à choix). Clés `p<n>` / `n<chemin>`.
- Dessins : Pollinations SANS compte (`image.pollinations.ai`, seul le vieux modèle est gratuit), file d'attente une image à la fois, réessais sur 402/429 (en pratique 1 à 3 min par image), logo coupé (bas 8,7 %). Consigne : scène D'ABORD, puis fiche, puis style (sinon la scène est ignorée et le rendu fait « photo »).
- Les images vont dans le texte, la couverture, le livre PDF, le partage (`images[]` au relais, `/partage/<id>/illus/<k>`) et le Drive (fichiers + Google Doc, propriété `il:<id>`, restaurées par « Récupérer »).
- Les modèles qui regardent l'image précédente demandent un compte Pollinations (pollen) ou Gemini avec facturation : à brancher plus tard.

## v18 — images Gemini (2026-10-08)
- Facturation activée par Jonathan sur sa clé Gemini (même clé que le texte).
- `dessinerGemini()` : couverture d'abord (ou le dessin de l'enfant comme modèle), puis les autres images 3 à la fois avec la couverture en référence. Modèles « flash » seulement (les « pro » écartés : trop chers).
- Refus de facturation → Pollinations pendant 1 h (`img-gemini-ko`). Le chemin suivi dans une histoire à choix est dessiné en premier.

## v19 — voix Google en paliers (2026-10-08)
- Cloud Text-to-Speech avec la clé Gemini (ou k-gcloud) : Chirp 3 HD → Studio → Neural2, bascule à 995 000 caractères par palier et par mois (compteurs `gc:<palier>:AAAA-MM`, tenus par l'app). Voix fr-CA, sinon fr-FR pour le palier (Studio n'a peut-être pas de fr-CA).
- Ordre automatique : ElevenLabs (crédits) → Google (palier libre) → Microsoft → Gemini → téléphone.

## v20 (2026-10-08)
- Clé des voix Google dans **maison-app-jl** (« Histoires du soir - voix Google », référent `https://95.groupelaberge.ca/*`, API Cloud Text-to-Speech seulement), créée avec gcloud. Donnée à l'app par le lien du document « ⚙️ Configurer l'app » (`&gcloud=`, action `cle` du script Drive). Pas de voix Studio fr-CA chez Google : l'app prend Studio fr-FR (France).

## v44 — la bibliothèque de nuit (2026-10-14)
- Écran Créer = une bibliothèque (maquette « Veilleuse A » choisie par Jonathan) : une tablette de livres par question (Pour qui, Ambiance, Avec qui, Personnages d'avant, Sa journée, Petit souci, Leçon), qui glisse vers la droite quand elle déborde (flèche ›). Le dernier livre de chaque tablette, « ✏️ Choisir », sert à écrire son propre choix.
- Puis « 💡 Ton idée » (carnet : le vrai champ `#idea` et son micro y déménagent, idées à toucher) et « Sur la table de chevet » : longueur (petit, moyen, gros livre dessinés en SVG), images (cadres), l'enfant choisit (format), dessin. Bouton « Raconte-moi » collé en bas.
- **Les anciens champs restent** dans `#ancien-form` (caché) et sont toujours la source de vérité : la bibliothèque ne fait que les remplir (pastilles `mood`/`souci`/`length`/`images`/`format`, champs `friends`/`journee`/`moral`/`souci-autre`, enfants, personnages). Gemini, les voix, la sauvegarde et « La suite » n'ont pas changé.
- Enfants : toucher un livre = il écoute ce soir ou pas (`enfants[i].absent`, au moins un) ; garder le doigt (ou « Les choix de … ») = feuille avec prénom, âge et ses 7 tablettes de choix. Ambiance écrite à la main = pastille cachée `autre` + `#mood-autre`. L'ambiance est maintenant gardée (`set:mood`, `set:mood-autre`).
- Personnages d'avant : toucher = il revient ; garder le doigt = le retirer de la liste ; dernier livre = « Chercher dans mes histoires ».
- Histoires : rangées sur des tablettes par période (Cette semaine, Ce mois-ci, puis par mois) + « Mes favoris ». Réglages : tiroirs de commode. L'histoire ouverte est posée sous une tablette ; la barre du bas est une planche. Jetons de bois par thème (`--bois1`, `--meuble1`…) : bois clair pour Livre d'images et Doudou.
- Test : scratchpad `test_v44.js` (Gemini simulé par Playwright, vérifie la consigne envoyée).

## v45 — une image toujours à l'écran, la fabrication en pourcentages (2026-10-14)
- `#ecran-image` (collé en haut, `position: sticky`) montre TOUJOURS une image EN ENTIER (`object-fit: contain`, fond flou de la même image) : celle de la partie lue (`litIdx`), ou sans lecture celle du paragraphe au milieu de l'écran. Une image pas encore dessinée laisse la précédente (« 🎨 La prochaine image arrive… ») ; avant la toute première : cadre d'attente. Les `<figure class="illus">` du texte restent comme repères mais sont cachées. Fondu entre deux images (deux `<img>` qui échangent `haut`/`bas`).
- Panneau `#fabrication` (au-dessus de la barre du bas) : 📝 Histoire, 🎨 Images, 🔊 Voix avec barre et pourcentage. Histoire = ESTIMÉ (Gemini ne donne pas d'avancement) d'après la durée des fois précédentes (`duree-ecriture:<longueur>:<format>`, moyenne glissante), plafonné à 98 % jusqu'à la vraie fin. Images = finies + avancement estimé de celles en cours (15 s Gemini, 90 s Pollinations). Voix = vrais morceaux enregistrés. Se ferme 8 s après la fin ; ▾ pour le réduire ; caché en mode nuit.
- La voix s'enregistre TOUTE SEULE dès que le texte est prêt (`voixAuto`, sans jouer ; histoires à choix : `enregistrerArbre`). « Raconter » attend une voix en cours (`voixEnCours`) puis joue. Voix du téléphone : rien à enregistrer.
- Tests : scratchpad `test_v45.js` et `test_v45_arbre.js` (Gemini, images et voix Microsoft simulés avec délais).
