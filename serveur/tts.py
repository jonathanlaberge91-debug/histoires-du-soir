"""Relais de l'app Histoires du soir, sur le serveur de Jonathan (95.groupelaberge.ca).

Voix québécoises Microsoft (lecture à voix haute d'Edge) :
  POST /histoires/tts            {"texte", "voix", "vitesse" (%), "hauteur" (Hz)}  -> audio/mpeg
  GET  /histoires/tts/voix       -> liste des voix permises
Partage d'une histoire (lien pour la famille, et adresse que le haut-parleur Google peut lire) :
  POST /histoires/partage        {"titre", "texte", "prenom", "audio": {b64, type}, "image": {b64, type}, "images": [{avant, b64, type}],
                                  "reperes": [début de chaque paragraphe, en s], "vitesse"}  -> {id, url, audio}
  GET  /histoires/ecouter/<id>   -> page d'écoute : le texte suit la voix, la dernière image reste en haut, mode télé plein écran, vitesse
  GET  /histoires/partage/<id>/audio | /image

Voix : gratuites et sans compte, mais NON OFFICIELLES (même service que « Lire à voix haute » d'Edge) :
s'il cesse de répondre, l'app passe toute seule à la voix suivante.
Protections : origines permises, tailles limitées, enregistrements 3 à la fois, limites par adresse IP,
espace total des partages plafonné.
"""
import asyncio
import base64
import hashlib
import html
import json
import os
import re
from urllib.parse import urlsplit
import secrets
import shutil
import time
from collections import defaultdict, deque

import edge_tts
from aiohttp import ClientSession, ClientTimeout, web

PORT = 8120
VOIX = {
    "fr-CA-SylvieNeural": "Sylvie — femme",
    "fr-CA-AntoineNeural": "Antoine — homme",
    "fr-CA-JeanNeural": "Jean — homme",
    "fr-CA-ThierryNeural": "Thierry — homme",
}
ORIGINES = {"https://95.groupelaberge.ca"}
# Qui a droit aux voix et au partage (les pages d'écoute restent publiques, c'est leur but) :
#  - depuis le 2026-10-13 : quiconque est connecté à l'app Maison (même adresse, même session
#    PocketBase). L'app envoie son jeton ; on demande à PocketBase Maison s'il est valide.
#  - encore accepté : l'ancienne clé du relais (X-Relais), pour les appareils pas encore passés.
#    Elle vient de l'environnement du service (/etc/secrets/histoires-tts.env, root 600).
CLE = os.environ.get("RELAIS_CLE", "")
MAISON = "http://127.0.0.1:8094"
jetons_ok = {}               # empreinte du jeton -> valide jusqu'à (on ne redemande pas à chaque morceau)
PUBLIC = "https://95.groupelaberge.ca"
TEXTE_MAX = 6000
PAR_IP = 400                 # voix : requêtes par 10 minutes (une voix par personnage = beaucoup de petits morceaux)
PARTAGES_PAR_JOUR = 40
FENETRE = 600
DOSSIER = os.environ.get("STATE_DIRECTORY", "/var/lib/histoires-tts")
PARTAGES = os.path.join(DOSSIER, "partages")
PARTAGES_MAX_OCTETS = 3 * 1024 ** 3   # 3 Go au total
AUDIO_MAX = 40 * 1024 * 1024
IMAGE_MAX = 4 * 1024 * 1024
TYPES_AUDIO = {"audio/mpeg": "mp3", "audio/wav": "wav"}
TYPES_IMAGE = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}

# Clés Google (Gemini : texte, images, voix Gemini ; Cloud Text-to-Speech : voix Google), gardées SEULEMENT ici :
# /etc/secrets/histoires-tts.env (root 600, EnvironmentFile=), jamais envoyées aux appareils.
GOOGLE_CLES = {
    "generativelanguage.googleapis.com": os.environ.get("GOOGLE_GEMINI_KEY", ""),
    "texttospeech.googleapis.com": os.environ.get("GOOGLE_TTS_KEY", ""),
}
# Seules les adresses dont l'app a besoin
GOOGLE_CHEMINS = re.compile(
    r"^(/v1beta/models(\?pageSize=\d+)?"
    r"|/v1beta/models/[\w.\-]+:generateContent"
    r"|/v1/voices(\?languageCode=[\w-]+)?"
    r"|/v1/text:synthesize)$")
GOOGLE_PAR_IP = 900          # appels par 10 minutes (une voix par personnage = beaucoup de petits morceaux)
file_google = defaultdict(deque)

os.makedirs(PARTAGES, exist_ok=True)
file_ip = defaultdict(deque)
file_partage = defaultdict(deque)
en_cours = asyncio.Semaphore(3)


def cors(req, rep):
    o = req.headers.get("Origin", "")
    if o in ORIGINES:
        rep.headers["Access-Control-Allow-Origin"] = o
        rep.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
        rep.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Relais, Authorization"
        rep.headers["Access-Control-Max-Age"] = "86400"
        rep.headers["Vary"] = "Origin"
    return rep


async def cle_ok(req):
    k = req.headers.get("X-Relais", "")
    if CLE and len(k) == len(CLE) and secrets.compare_digest(k, CLE):
        return True
    jeton = req.headers.get("Authorization", "").strip()
    if not jeton or len(jeton) > 2000:
        return False
    cle = hashlib.sha256(jeton.encode()).hexdigest()
    now = time.time()
    if jetons_ok.get(cle, 0) > now:
        return True
    try:
        async with ClientSession(timeout=ClientTimeout(total=8)) as s:
            async with s.get(f"{MAISON}/api/collections/users/records?perPage=1&fields=id",
                             headers={"Authorization": jeton}) as r:
                # Liste des comptes : refusée (403/401) sans session valide. Une session valide
                # voit au moins son propre compte.
                ok = r.status == 200 and (await r.json()).get("totalItems", 0) >= 1
    except Exception:
        return False
    if ok:
        if len(jetons_ok) > 500:
            for c in [c for c, t in jetons_ok.items() if t < now]:
                del jetons_ok[c]
        jetons_ok[cle] = now + 600
    return ok


def refuse(req, code, msg):
    return cors(req, web.json_response({"ok": False, "erreur": msg}, status=code))


def ip_de(req):
    # La DERNIÈRE adresse est celle ajoutée par Caddy (la première peut être inventée par le client).
    return req.headers.get("X-Forwarded-For", req.remote or "?").split(",")[-1].strip()


def trop(files, ip, limite, fenetre):
    if len(files) > 5000:                        # ménage : la mémoire des adresses ne grossit pas sans fin
        for k in [k for k, q in files.items() if not q or time.time() - q[-1] > fenetre]:
            del files[k]
    q, now = files[ip], time.time()
    while q and now - q[0] > fenetre:
        q.popleft()
    if len(q) >= limite:
        return True
    q.append(now)
    return False


async def options(req):
    return cors(req, web.Response(status=204))


async def google(req):
    """Passe un appel à Google pour l'app, avec la clé gardée sur le serveur."""
    o = req.headers.get("Origin")
    if o and o not in ORIGINES:
        return refuse(req, 403, "origine refusée")
    if not await cle_ok(req):
        return refuse(req, 401, "connecte-toi à l'app Maison (95.groupelaberge.ca) puis reviens dans Histoires")
    if trop(file_google, ip_de(req), GOOGLE_PAR_IP, FENETRE):
        return refuse(req, 429, "trop de demandes, réessaie dans quelques minutes")
    try:
        b = await req.json()
    except Exception:
        return refuse(req, 400, "requête illisible")
    u = urlsplit(str(b.get("u", "")))
    chemin = u.path + ("?" + u.query if u.query else "")
    if u.scheme != "https" or u.netloc not in GOOGLE_CLES or not GOOGLE_CHEMINS.match(chemin):
        return refuse(req, 400, "adresse Google non permise")
    cle = GOOGLE_CLES[u.netloc]
    if not cle:
        return refuse(req, 503, "clé Google absente du serveur")
    methode = "POST" if b.get("m") == "POST" else "GET"
    try:
        async with ClientSession(timeout=ClientTimeout(total=300)) as s:
            async with s.request(methode, f"https://{u.netloc}{chemin}", headers={"x-goog-api-key": cle},
                                 json=b.get("b") if methode == "POST" else None) as r:
                corps = await r.read()
                return cors(req, web.Response(body=corps, status=r.status, content_type="application/json"))
    except asyncio.TimeoutError:
        return refuse(req, 504, "Google n'a pas répondu à temps")
    except Exception as e:
        return refuse(req, 502, f"Google injoignable ({type(e).__name__})")


async def voix(req):
    return cors(req, web.json_response({"ok": True, "voix": [{"id": k, "nom": v} for k, v in VOIX.items()]}))


async def tts(req):
    o = req.headers.get("Origin")
    if o and o not in ORIGINES:
        return refuse(req, 403, "origine refusée")
    if not await cle_ok(req):
        return refuse(req, 401, "connecte-toi à l'app Maison (95.groupelaberge.ca) puis reviens dans Histoires")
    if trop(file_ip, ip_de(req), PAR_IP, FENETRE):
        return refuse(req, 429, "trop de demandes, réessaie dans quelques minutes")
    try:
        b = await req.json()
    except Exception:
        return refuse(req, 400, "requête illisible")
    texte = str(b.get("texte", "")).strip()
    v = str(b.get("voix", "fr-CA-SylvieNeural"))
    if not texte:
        return refuse(req, 400, "texte vide")
    if len(texte) > TEXTE_MAX:
        return refuse(req, 400, f"texte trop long ({len(texte)} > {TEXTE_MAX})")
    if v not in VOIX:
        return refuse(req, 400, "voix inconnue")
    try:
        vit = max(-40, min(30, int(b.get("vitesse", -10))))
    except Exception:
        vit = -10
    try:
        hauteur = max(-40, min(40, int(b.get("hauteur", 0))))
    except Exception:
        hauteur = 0
    async with en_cours:
        # Microsoft refuse parfois une connexion quand plusieurs voix partent en même temps
        # (vu à l'audit du 2026-10-13 : 6 refus pour une histoire à plusieurs voix). On
        # réessaie ici, avec une petite pause, avant de répondre une erreur à l'app.
        morceaux, erreur = [], None
        for essai in range(3):
            try:
                com = edge_tts.Communicate(texte, v, rate=f"{vit:+d}%", pitch=f"{hauteur:+d}Hz")
                morceaux = []
                async for m in com.stream():
                    if m["type"] == "audio":
                        morceaux.append(m["data"])
                if morceaux:
                    break
            except Exception as e:
                erreur = e
            await asyncio.sleep(0.8 * (essai + 1))
        if not morceaux and erreur:
            print(f"voix Microsoft : échec après 3 essais ({type(erreur).__name__})", flush=True)
            return refuse(req, 502, f"service de voix Microsoft indisponible ({type(erreur).__name__})")
    if not morceaux:
        return refuse(req, 502, "aucun son reçu du service Microsoft")
    rep = web.Response(body=b"".join(morceaux), content_type="audio/mpeg")
    rep.headers["Cache-Control"] = "no-store"
    return cors(req, rep)


# ───────────────────────── partage ─────────────────────────

def taille_dossier(d):
    n = 0
    for racine, _, fichiers in os.walk(d):
        for f in fichiers:
            try:
                n += os.path.getsize(os.path.join(racine, f))
            except OSError:
                pass
    return n


def faire_place(besoin):
    """Plafond total : on retire les plus vieux partages s'il le faut."""
    dossiers = sorted((os.path.join(PARTAGES, d) for d in os.listdir(PARTAGES)), key=os.path.getmtime)
    total = taille_dossier(PARTAGES)
    while dossiers and total + besoin > PARTAGES_MAX_OCTETS:
        d = dossiers.pop(0)
        total -= taille_dossier(d)
        shutil.rmtree(d, ignore_errors=True)


def decode(obj, types, maxi):
    if not isinstance(obj, dict) or not obj.get("b64"):
        return None, None
    t = str(obj.get("type", "")).split(";")[0]
    if t not in types:
        raise ValueError(f"type de fichier refusé ({t})")
    data = base64.b64decode(obj["b64"], validate=False)
    if len(data) > maxi:
        raise ValueError("fichier trop gros")
    return data, types[t]


async def partager(req):
    o = req.headers.get("Origin")
    if o not in ORIGINES:
        return refuse(req, 403, "origine refusée")
    if not await cle_ok(req):
        return refuse(req, 401, "connecte-toi à l'app Maison (95.groupelaberge.ca) puis reviens dans Histoires")
    if trop(file_partage, ip_de(req), PARTAGES_PAR_JOUR, 86400):
        return refuse(req, 429, "trop de partages aujourd'hui")
    try:
        b = await req.json()
        audio, ext_a = decode(b.get("audio"), TYPES_AUDIO, AUDIO_MAX)
        image, ext_i = decode(b.get("image"), TYPES_IMAGE, IMAGE_MAX)
        illus = []                        # illustrations : [(avant quel paragraphe, octets)]
        for im in (b.get("images") or [])[:8]:
            data, _ = decode(im, TYPES_IMAGE, IMAGE_MAX)
            if data:
                illus.append((max(0, int(im.get("avant", 0))), data))
    except ValueError as e:
        return refuse(req, 400, str(e))
    except Exception:
        return refuse(req, 400, "requête illisible")
    titre = str(b.get("titre", "")).strip()[:200] or "Une histoire du soir"
    texte = str(b.get("texte", "")).strip()[:30000]
    # repères : le début de chaque paragraphe dans le son (calculés par l'app en écoutant le son) ; sinon la page fait au prorata
    reperes = b.get("reperes")
    if isinstance(reperes, list) and len(reperes) <= 600 and all(isinstance(x, (int, float)) and 0 <= x < 36000 for x in reperes):
        reperes = [round(float(x), 2) for x in reperes]
    else:
        reperes = None
    try:
        vitesse = min(2.0, max(0.5, float(b.get("vitesse", 0.9))))
    except (TypeError, ValueError):
        vitesse = 0.9
    jeton = secrets.token_urlsafe(18)       # pour retirer le partage plus tard (gardé par l'app)
    infos = {"titre": titre, "texte": texte, "prenom": str(b.get("prenom", "")).strip()[:60], "cree": int(time.time()),
             "retrait": jeton,
             "audio": ext_a, "image": ext_i, "illus": [a for a, _ in illus], "reperes": reperes, "vitesse": vitesse}
    faire_place((len(audio) if audio else 0) + (len(image) if image else 0) + sum(len(x) for _, x in illus) + len(texte) * 2)
    pid = secrets.token_urlsafe(9)
    d = os.path.join(PARTAGES, pid)
    os.makedirs(d)
    if audio:
        with open(os.path.join(d, "audio." + ext_a), "wb") as f:
            f.write(audio)
    for k, (_, data) in enumerate(illus):
        with open(os.path.join(d, f"illus{k}.jpg"), "wb") as f:
            f.write(data)
    if image:
        with open(os.path.join(d, "image." + ext_i), "wb") as f:
            f.write(image)
    with open(os.path.join(d, "infos.json"), "w", encoding="utf-8") as f:
        json.dump(infos, f, ensure_ascii=False)
    return cors(req, web.json_response({
        "ok": True, "id": pid, "jeton": jeton,
        "url": f"{PUBLIC}/histoires/ecouter/{pid}",
        "audio": f"{PUBLIC}/histoires/partage/{pid}/audio" if audio else None,
    }))


def lire_partage(pid):
    if not pid or not all(c.isalnum() or c in "-_" for c in pid):
        return None, None
    d = os.path.join(PARTAGES, pid)
    try:
        with open(os.path.join(d, "infos.json"), encoding="utf-8") as f:
            return d, json.load(f)
    except Exception:
        return None, None


async def illus_partage(req):
    d, infos = lire_partage(req.match_info["id"])
    k = int(req.match_info["k"])
    if not infos or k >= len(infos.get("illus") or []):
        raise web.HTTPNotFound()
    rep = web.FileResponse(os.path.join(d, f"illus{k}.jpg"))
    rep.content_type = "image/jpeg"
    rep.headers["Cache-Control"] = "public, max-age=86400"
    return rep


async def fichier_partage(req):
    d, infos = lire_partage(req.match_info["id"])
    quoi = req.match_info["quoi"]
    if not infos or not infos.get(quoi):
        raise web.HTTPNotFound()
    ext = infos[quoi]
    types = {**{v: k for k, v in TYPES_AUDIO.items()}, **{v: k for k, v in TYPES_IMAGE.items()}}
    rep = web.FileResponse(os.path.join(d, f"{quoi}.{ext}"))
    rep.content_type = types.get(ext, "application/octet-stream")
    rep.headers["Cache-Control"] = "public, max-age=86400"
    rep.headers["Access-Control-Allow-Origin"] = "*"      # le haut-parleur Google (Chromecast) lit l'audio d'ici
    return rep


PAGE = """<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>__TITRE__</title>
<meta property="og:title" content="__TITRE__"><meta property="og:description" content="Une histoire du soir__POUR__">
__OG_IMAGE__
<style>
:root{--fond:#0f0d2e;--txt:#f5f3ff;--doux:#a5a1d6;--accent:#f2c46d;--surface:#1a1740}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--fond);color:var(--txt);font:18px/1.7 system-ui,sans-serif}
main{max-width:680px;margin:auto;padding:0 18px 70px}
/* l'image du moment, figée en haut (la dernière dessinée avant le paragraphe lu) */
#ecran{position:sticky;top:0;z-index:3;margin:0 -18px;background:var(--fond);padding:8px 10px 10px}
#ecran .cadre{position:relative;height:34vh;max-height:340px;min-height:160px;border-radius:16px;overflow:hidden;background:#000;box-shadow:0 10px 24px rgba(0,0,0,.5)}
#ecran img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transition:opacity .6s}
#ecran img.flou{object-fit:cover;filter:blur(22px) brightness(.55);transform:scale(1.15)}
#ecran img.bas{opacity:0}
#ecran.vide{display:none}
h1{font-size:1.5rem;line-height:1.3;margin:14px 0 2px} .pour{color:var(--doux);font-size:.95rem}
audio{width:100%;margin:14px 0 6px}
.barre{display:flex;flex-direction:column;gap:10px;margin:0 0 16px}
.barre .vit{display:flex;gap:5px;align-items:center;color:var(--doux);font-size:.85rem;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
.barre .vit::-webkit-scrollbar{display:none}
.barre .vit button{flex:none;padding:6px 10px}
.barre button{border:1px solid rgba(242,196,109,.35);background:var(--surface);color:var(--txt);border-radius:999px;padding:7px 11px;font:700 .85rem system-ui,sans-serif;cursor:pointer}
.barre button.on{background:var(--accent);color:#2a1d00;border-color:var(--accent)}
.barre #btn-tele{padding:11px;font-size:.95rem}
.texte p{margin:0 0 .9em;padding:4px 8px;border-radius:10px;transition:background .3s,color .3s}
body.suit .texte p{color:#8f8bb5}
body.suit .texte p.lit{color:var(--txt);background:rgba(242,196,109,.14)}
.texte img{width:100%;border-radius:16px;margin:4px 0 12px}
.pied{color:var(--doux);font-size:.85rem;margin-top:30px;text-align:center}
/* ───── mode télé (plein écran) ───── */
#tele{position:fixed;inset:0;z-index:50;background:#000;display:none;color:#fff;font-family:system-ui,sans-serif}
#tele.on{display:grid;grid-template-rows:1fr auto auto;grid-template-columns:minmax(0,1fr)}
#tele .scene{position:relative;overflow:hidden;background:#000}
#tele .scene img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transition:opacity .6s}
#tele .scene img.flou{object-fit:cover;filter:blur(28px) brightness(.45);transform:scale(1.15)}
#tele .scene img.bas{opacity:0}
#tele .sous{min-width:0;overflow-wrap:anywhere;padding:12px 24px;font-size:clamp(18px,2.6vw,30px);line-height:1.45;text-align:center;text-shadow:0 2px 6px #000;min-height:3.2em;display:flex;align-items:center;justify-content:center}
#tele .sous.vide{opacity:.5}
#tele .ctrl{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;min-width:0;padding:8px 16px calc(12px + env(safe-area-inset-bottom));background:rgba(0,0,0,.6)}
#tele .ctrl button{border:0;background:rgba(255,255,255,.12);color:#fff;border-radius:999px;height:40px;min-width:40px;padding:0 12px;font:700 .9rem system-ui,sans-serif;cursor:pointer}
#tele .ctrl button.on{background:var(--accent);color:#2a1d00}
#tele .ctrl .piste{flex:1;height:8px;border-radius:4px;background:rgba(255,255,255,.2);position:relative;cursor:pointer}
#tele .ctrl .piste i{position:absolute;left:0;top:0;bottom:0;border-radius:4px;background:var(--accent);width:0}
#tele .ctrl small{color:#ccc;font-size:.8rem;min-width:70px;text-align:center}
#tele .ctrl .vit{display:flex;gap:4px;flex-basis:100%;justify-content:center;order:2}
#tele .ctrl .vit button{height:32px;min-width:0;padding:0 9px;font-size:.78rem}
@media (orientation:landscape){
  #tele.on{grid-template-columns:58% minmax(0,1fr);grid-template-rows:1fr auto}
  #tele .scene{grid-row:1;grid-column:1}
  #tele .sous{grid-row:1;grid-column:2;font-size:clamp(18px,2.4vw,34px);padding:16px 28px;overflow:auto;text-align:left}
  #tele .ctrl{grid-row:2;grid-column:1/3}
}
</style></head><body>
<main>
<div id="ecran" class="vide"><div class="cadre"><img class="flou" alt=""><img class="haut" alt=""><img class="bas" alt=""></div></div>
<h1>🌙 __TITRE__</h1><div class="pour">Une histoire du soir__POUR__</div>
__AUDIO__
<div class="barre" id="barre" hidden>
  <div class="vit" id="vitesses">Vitesse</div>
  <button type="button" id="btn-tele">📺 Plein écran</button>
</div>
<div class="texte" id="texte"></div>
<div class="pied">Histoires du soir · Groupe Laberge</div>
</main>
<div id="tele"><div class="scene"><img class="flou" alt=""><img class="haut" alt=""><img class="bas" alt=""></div>
  <div class="sous vide" id="t-sous"></div>
  <div class="ctrl"><button type="button" id="t-jouer">▶️</button><div class="piste" id="t-piste"><i></i></div><small id="t-temps"></small><div class="vit" id="t-vitesses"></div><button type="button" id="t-x">✕</button></div>
</div>
<script>
const D = __DATA__;
const $ = id => document.getElementById(id);
const N = D.paras.length, VITESSES = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
const esc = t => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// le texte, avec les illustrations à leur place (devant le paragraphe « avant »)
$('texte').innerHTML = D.paras.map((p, i) => D.illus.map((a, k) => a === i ? `<img src="${D.base}/illus/${k}" alt="" loading="lazy">` : '').join('') + `<p data-i="${i}">${esc(p)}</p>`).join('');
// ───── l'image du moment : la dernière illustration placée avant le paragraphe, sinon la couverture
function imagePour(i) { let k = -1, n0 = -1; D.illus.forEach((a, j) => { if (a <= i && a > n0) { n0 = a; k = j; } }); return k >= 0 ? `${D.base}/illus/${k}` : D.image ? `${D.base}/image` : null; }
function montrer(cont, u) {
  if (!u) return; if (cont.dataset.u === u) return; cont.dataset.u = u;
  const haut = cont.querySelector('img.haut'), bas = cont.querySelector('img.bas');
  bas.src = u; cont.querySelector('img.flou').src = u;
  bas.classList.replace('bas', 'haut'); haut.classList.replace('haut', 'bas');
}
function majImages(i) { const u = imagePour(i); if (u) { $('ecran').classList.remove('vide'); montrer($('ecran').querySelector('.cadre'), u); montrer($('tele').querySelector('.scene'), u); } }
majImages(0);
// ───── la voix : le texte suit (repères calculés par l'app, sinon au prorata des lettres), vitesse, mode télé
const a = document.querySelector('audio');
if (a) {
  $('barre').hidden = false;
  let vit = parseFloat(localStorage.getItem('histoires-vitesse')) || D.vitesse || 0.9;
  const boutonsVit = (cont, cls) => { cont.insertAdjacentHTML('beforeend', VITESSES.map(v => `<button type="button" data-v="${v}" class="${v === vit ? 'on' : ''}">${String(v).replace('.', ',')}×</button>`).join('')); cont.onclick = e => { const b = e.target.closest('[data-v]'); if (b) poserVitesse(+b.dataset.v); }; };
  function poserVitesse(v) { vit = v; a.playbackRate = v; try { localStorage.setItem('histoires-vitesse', v); } catch {} document.querySelectorAll('[data-v]').forEach(b => b.classList.toggle('on', +b.dataset.v === v)); }
  boutonsVit($('vitesses')); boutonsVit($('t-vitesses')); a.playbackRate = vit;
  a.addEventListener('play', () => { a.playbackRate = vit; });
  // repères : début de chaque paragraphe (s)
  let reperes = Array.isArray(D.reperes) && D.reperes.length === N ? D.reperes : null;
  const longueurs = D.paras.map(p => p.length + 8), total = longueurs.reduce((x, y) => x + y, 0);
  function debuts() {
    if (reperes) return reperes;
    if (!a.duration || !isFinite(a.duration)) return null;
    const out = []; let acc = 0; for (const l of longueurs) { out.push(acc / total * a.duration); acc += l; } return out;
  }
  let lit = -1, suspendu = 0;
  addEventListener('wheel', () => { suspendu = Date.now(); }, { passive: true });
  addEventListener('touchmove', () => { suspendu = Date.now(); }, { passive: true });
  function eclairer(i) {
    if (i === lit) return; lit = i;
    document.querySelectorAll('.texte p.lit').forEach(p => p.classList.remove('lit'));
    const p = document.querySelector(`.texte p[data-i="${i}"]`);
    if (p) { p.classList.add('lit'); if (Date.now() - suspendu > 6000 && !$('tele').classList.contains('on')) p.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    $('t-sous').textContent = i >= 0 ? D.paras[i] : D.titre; $('t-sous').classList.toggle('vide', i < 0);
    majImages(Math.max(0, i));
  }
  function suivre() {
    const d = debuts(); if (!d) return;
    let i = 0; for (let k = 0; k < N; k++) if (a.currentTime >= d[k]) i = k;
    eclairer(i);
    $('t-piste').querySelector('i').style.width = (a.duration ? a.currentTime / a.duration * 100 : 0) + '%';
    const f = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
    $('t-temps').textContent = a.duration ? f(a.currentTime) + ' / ' + f(a.duration) : '';
  }
  a.addEventListener('timeupdate', suivre);
  a.addEventListener('play', () => { document.body.classList.add('suit'); suivre(); $('t-jouer').textContent = '⏸️'; });
  a.addEventListener('pause', () => { $('t-jouer').textContent = '▶️'; });
  a.addEventListener('ended', () => { document.body.classList.remove('suit'); eclairer(-1); $('t-jouer').textContent = '▶️'; });
  $('t-sous').textContent = D.titre;
  // mode télé : plein écran, paysage si possible
  $('btn-tele').onclick = async () => {
    $('tele').classList.add('on');
    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch {}
    try { await screen.orientation.lock('landscape'); } catch {}
    if (a.paused) a.play().catch(() => {});
  };
  async function quitterTele() { $('tele').classList.remove('on'); try { await screen.orientation.unlock(); } catch {} if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} } }
  $('t-x').onclick = quitterTele;
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) $('tele').classList.remove('on'); });
  $('t-jouer').onclick = () => { a.paused ? a.play() : a.pause(); };
  $('t-piste').onclick = e => { const r = $('t-piste').getBoundingClientRect(); if (a.duration) a.currentTime = (e.clientX - r.left) / r.width * a.duration; };
  document.querySelector('.scene').onclick = () => $('t-jouer').click();
}
</script></body></html>"""


async def ecouter(req):
    pid = req.match_info["id"]
    d, infos = lire_partage(pid)
    if not infos:
        return web.Response(text="Cette histoire n'existe plus.", status=404, content_type="text/plain")
    t = html.escape(infos["titre"])
    pour = f" pour {html.escape(infos['prenom'])}" if infos.get("prenom") else ""
    base = f"{PUBLIC}/histoires/partage/{pid}"
    paras = [x.strip() for x in infos.get("texte", "").split("\n\n") if x.strip()]
    data = {"titre": infos["titre"], "base": base, "paras": paras, "illus": infos.get("illus") or [], "image": bool(infos.get("image")),
            "reperes": infos.get("reperes"), "vitesse": infos.get("vitesse") or 0.9}
    corps = (PAGE.replace("__TITRE__", t).replace("__POUR__", pour)
             .replace("__OG_IMAGE__", f'<meta property="og:image" content="{base}/image">' if infos.get("image") else "")
             .replace("__AUDIO__", f'<audio controls preload="metadata" src="{base}/audio"></audio>' if infos.get("audio") else "")
             .replace("__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/")))
    return web.Response(text=corps, content_type="text/html", headers={"Cache-Control": "no-cache"})


async def retirer(req):
    if req.headers.get("Origin") not in ORIGINES or not await cle_ok(req):
        return refuse(req, 403, "refusé")
    d, infos = lire_partage(req.match_info["id"])
    if not infos:
        return cors(req, web.json_response({"ok": True, "deja": True}))
    try:
        b = await req.json()
    except Exception:
        b = {}
    j = str(b.get("jeton", ""))
    if not infos.get("retrait") or not secrets.compare_digest(j, infos["retrait"]):
        return refuse(req, 403, "jeton de retrait invalide")
    shutil.rmtree(d, ignore_errors=True)
    return cors(req, web.json_response({"ok": True}))


app = web.Application(client_max_size=64 * 1024 * 1024)
app.router.add_route("OPTIONS", "/histoires/tts", options)
app.router.add_route("OPTIONS", "/histoires/tts/voix", options)
app.router.add_route("OPTIONS", "/histoires/partage", options)
app.router.add_post("/histoires/tts", tts)
app.router.add_route("OPTIONS", "/histoires/tts/google", options)
app.router.add_post("/histoires/tts/google", google)
app.router.add_get("/histoires/tts/voix", voix)
app.router.add_post("/histoires/partage", partager)
app.router.add_route("OPTIONS", "/histoires/partage/{id}/retirer", options)
app.router.add_post("/histoires/partage/{id}/retirer", retirer)
app.router.add_get("/histoires/partage/{id}/{quoi:audio|image}", fichier_partage)
app.router.add_get("/histoires/partage/{id}/illus/{k:\\d+}", illus_partage)
app.router.add_get("/histoires/ecouter/{id}", ecouter)

if __name__ == "__main__":
    web.run_app(app, host="127.0.0.1", port=PORT, access_log=None)
