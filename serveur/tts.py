"""Relais des voix québécoises Microsoft (lecture à voix haute d'Edge) pour l'app Histoires du soir.

POST /histoires/tts        {"texte": "...", "voix": "fr-CA-SylvieNeural", "vitesse": -10}  -> audio/mpeg
GET  /histoires/tts/voix   -> liste des voix permises

Gratuit et sans compte, mais NON OFFICIEL (même service que le bouton « Lire à voix haute » d'Edge) :
s'il cesse de répondre, l'app passe toute seule à la voix suivante.
Protections : origines permises, texte limité, 2 enregistrements à la fois, limite par adresse IP.
"""
import asyncio
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
ORIGINES = {"https://95.groupelaberge.ca", "https://jonathanlaberge91-debug.github.io"}
TEXTE_MAX = 6000
PAR_IP = 80            # requêtes par fenêtre de 10 minutes
FENETRE = 600

file_ip = defaultdict(deque)
en_cours = asyncio.Semaphore(2)


def cors(req, rep):
    o = req.headers.get("Origin", "")
    if o in ORIGINES:
        rep.headers["Access-Control-Allow-Origin"] = o
        rep.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
        rep.headers["Access-Control-Allow-Headers"] = "Content-Type"
        rep.headers["Access-Control-Max-Age"] = "86400"
        rep.headers["Vary"] = "Origin"
    return rep


def refuse(req, code, msg):
    return cors(req, web.json_response({"ok": False, "erreur": msg}, status=code))


async def options(req):
    return cors(req, web.Response(status=204))


async def voix(req):
    return cors(req, web.json_response({"ok": True, "voix": [{"id": k, "nom": v} for k, v in VOIX.items()]}))


async def tts(req):
    o = req.headers.get("Origin")
    if o and o not in ORIGINES:
        return refuse(req, 403, "origine refusée")
    ip = req.headers.get("X-Forwarded-For", req.remote or "?").split(",")[0].strip()
    q, now = file_ip[ip], time.time()
    while q and now - q[0] > FENETRE:
        q.popleft()
    if len(q) >= PAR_IP:
        return refuse(req, 429, "trop de demandes, réessaie dans quelques minutes")
    q.append(now)
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
    async with en_cours:
        try:
            com = edge_tts.Communicate(texte, v, rate=f"{vit:+d}%")
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


app = web.Application(client_max_size=256 * 1024)
app.router.add_route("OPTIONS", "/histoires/tts", options)
app.router.add_route("OPTIONS", "/histoires/tts/voix", options)
app.router.add_post("/histoires/tts", tts)
app.router.add_get("/histoires/tts/voix", voix)

if __name__ == "__main__":
    web.run_app(app, host="127.0.0.1", port=PORT, access_log=None)
