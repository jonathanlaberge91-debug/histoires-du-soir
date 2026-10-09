"""Relais de l'app Histoires du soir, sur le serveur de Jonathan (95.groupelaberge.ca).

Voix québécoises Microsoft (lecture à voix haute d'Edge) :
  POST /histoires/tts            {"texte", "voix", "vitesse" (%), "hauteur" (Hz)}  -> audio/mpeg
  GET  /histoires/tts/voix       -> liste des voix permises
Partage d'une histoire (lien pour la famille, et adresse que le haut-parleur Google peut lire) :
  POST /histoires/partage        {"titre", "texte", "prenom", "audio": {b64, type}, "image": {b64, type}}  -> {id, url, audio}
  GET  /histoires/ecouter/<id>   -> page d'écoute (couverture, lecteur, texte)
  GET  /histoires/partage/<id>/audio | /image

Voix : gratuites et sans compte, mais NON OFFICIELLES (même service que « Lire à voix haute » d'Edge) :
s'il cesse de répondre, l'app passe toute seule à la voix suivante.
Protections : origines permises, tailles limitées, enregistrements 3 à la fois, limites par adresse IP,
espace total des partages plafonné.
"""
import asyncio
import base64
import html
import json
import os
import secrets
import shutil
import time
from collections import defaultdict, deque

import edge_tts
from aiohttp import web

PORT = 8120
VOIX = {
    "fr-CA-SylvieNeural": "Sylvie — femme",
    "fr-CA-AntoineNeural": "Antoine — homme",
    "fr-CA-JeanNeural": "Jean — homme",
    "fr-CA-ThierryNeural": "Thierry — homme",
}
ORIGINES = {"https://95.groupelaberge.ca"}
# Clé du relais : sans elle, ni voix ni partage (les pages d'écoute restent publiques, c'est leur but).
# Donnée par l'environnement du service (/etc/systemd/system/histoires-tts.service.d/cle.conf, root seulement),
# et à l'app par le lien du document « ⚙️ Configurer l'app » du Drive. Jamais dans le dépôt.
CLE = os.environ.get("RELAIS_CLE", "")
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

os.makedirs(PARTAGES, exist_ok=True)
file_ip = defaultdict(deque)
file_partage = defaultdict(deque)
en_cours = asyncio.Semaphore(3)


def cors(req, rep):
    o = req.headers.get("Origin", "")
    if o in ORIGINES:
        rep.headers["Access-Control-Allow-Origin"] = o
        rep.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
        rep.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Relais"
        rep.headers["Access-Control-Max-Age"] = "86400"
        rep.headers["Vary"] = "Origin"
    return rep


def cle_ok(req):
    k = req.headers.get("X-Relais", "")
    return bool(CLE) and len(k) == len(CLE) and secrets.compare_digest(k, CLE)


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


async def voix(req):
    return cors(req, web.json_response({"ok": True, "voix": [{"id": k, "nom": v} for k, v in VOIX.items()]}))


async def tts(req):
    o = req.headers.get("Origin")
    if o and o not in ORIGINES:
        return refuse(req, 403, "origine refusée")
    if not cle_ok(req):
        return refuse(req, 401, "clé du relais absente ou invalide (touche le lien du document « Configurer l'app » du Drive)")
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
        try:
            com = edge_tts.Communicate(texte, v, rate=f"{vit:+d}%", pitch=f"{hauteur:+d}Hz")
            morceaux = []
            async for m in com.stream():
                if m["type"] == "audio":
                    morceaux.append(m["data"])
        except Exception as e:
            return refuse(req, 502, f"service de voix Microsoft indisponible ({type(e).__name__})")
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
    if not cle_ok(req):
        return refuse(req, 401, "clé du relais absente ou invalide (touche le lien du document « Configurer l'app » du Drive)")
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
    jeton = secrets.token_urlsafe(18)       # pour retirer le partage plus tard (gardé par l'app)
    infos = {"titre": titre, "texte": texte, "prenom": str(b.get("prenom", "")).strip()[:60], "cree": int(time.time()),
             "retrait": jeton,
             "audio": ext_a, "image": ext_i, "illus": [a for a, _ in illus]}
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{titre}</title>
<meta property="og:title" content="{titre}"><meta property="og:description" content="Une histoire du soir{pour}">
{og_image}
<style>
body{{margin:0;background:#0f0d2e;color:#f5f3ff;font:18px/1.7 system-ui,sans-serif}}
main{{max-width:680px;margin:auto;padding:24px 18px 60px}}
h1{{font-size:1.6rem;line-height:1.3;margin:12px 0 4px}} .pour{{color:#a5a1d6;font-size:.95rem}}
img{{width:100%;border-radius:16px;margin-top:8px}} audio{{width:100%;margin:18px 0}}
p{{margin:0 0 .9em}} .pied{{color:#a5a1d6;font-size:.85rem;margin-top:30px;text-align:center}}
</style></head><body><main>
{image}
<h1>🌙 {titre}</h1><div class="pour">Une histoire du soir{pour}</div>
{audio}
{texte}
<div class="pied">Histoires du soir · Groupe Laberge</div>
</main></body></html>"""


async def ecouter(req):
    pid = req.match_info["id"]
    d, infos = lire_partage(pid)
    if not infos:
        return web.Response(text="Cette histoire n'existe plus.", status=404, content_type="text/plain")
    t = html.escape(infos["titre"])
    pour = f" pour {html.escape(infos['prenom'])}" if infos.get("prenom") else ""
    img_url = f"{PUBLIC}/histoires/partage/{pid}/image"
    corps = PAGE.format(
        titre=t, pour=pour,
        og_image=f'<meta property="og:image" content="{img_url}">' if infos.get("image") else "",
        image=f'<img src="{img_url}" alt="">' if infos.get("image") else "",
        audio=f'<audio controls preload="metadata" src="{PUBLIC}/histoires/partage/{pid}/audio"></audio>' if infos.get("audio") else "",
        texte="".join(
            "".join(f'<img src="{PUBLIC}/histoires/partage/{pid}/illus/{k}" alt="">' for k, a in enumerate(infos.get("illus") or []) if a == i)
            + f"<p>{html.escape(p.strip())}</p>"
            for i, p in enumerate(x for x in infos.get("texte", "").split("\n\n") if x.strip())),
    )
    return web.Response(text=corps, content_type="text/html", headers={"Cache-Control": "no-cache"})


async def retirer(req):
    if req.headers.get("Origin") not in ORIGINES or not cle_ok(req):
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
app.router.add_get("/histoires/tts/voix", voix)
app.router.add_post("/histoires/partage", partager)
app.router.add_route("OPTIONS", "/histoires/partage/{id}/retirer", options)
app.router.add_post("/histoires/partage/{id}/retirer", retirer)
app.router.add_get("/histoires/partage/{id}/{quoi:audio|image}", fichier_partage)
app.router.add_get("/histoires/partage/{id}/illus/{k:\\d+}", illus_partage)
app.router.add_get("/histoires/ecouter/{id}", ecouter)

if __name__ == "__main__":
    web.run_app(app, host="127.0.0.1", port=PORT, access_log=None)
