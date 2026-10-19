"""Histoires du soir — ALIGNEUR (v97, 2026-10-19).

Le texte suivait la voix en devinant le début des paragraphes d'après les silences du son. Mesuré sur les
histoires de Jonathan : souvent juste, mais jusqu'à 5 à 10 s d'avance quand les personnages parlent plus vite
ou plus lentement que le narrateur (« Le robot qui faisait bip », « La pizza qui fait gling »).

Ici, on ÉCOUTE le son avec Whisper (faster-whisper, modèle small, sur le processeur) : on obtient chaque mot
prononcé avec son heure, on retrouve les mots du texte dedans, et on renvoie l'heure exacte du début de chaque
paragraphe. Le résultat est gardé (même son + même texte = réponse immédiate).

Écoute seulement 127.0.0.1:8126 ; le relais (tts.py, route /histoires/tts/aligner) vérifie la clé et transmet.
POST /aligner {audio: base64, paragraphes: [texte, ...]} → {ok, debuts: [secondes, ...], couverture: 0..1}
"""
import base64
import hashlib
import json
import os
import re
import tempfile
import threading
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8126
CACHE = os.path.join(os.environ.get("STATE_DIRECTORY", "/var/lib/histoires-aligner"), "cache")
MAX_AUDIO = 40 * 1024 * 1024
os.makedirs(CACHE, exist_ok=True)

_modele = None
_verrou = threading.Lock()            # une écoute à la fois (le processeur est partagé avec le reste du serveur)
_attente = threading.BoundedSemaphore(6)


def modele():
    global _modele
    if _modele is None:
        from faster_whisper import WhisperModel
        _modele = WhisperModel("small", device="cpu", compute_type="int8", cpu_threads=4)
    return _modele


def norm(w):
    w = unicodedata.normalize("NFD", w.lower())
    w = "".join(c for c in w if unicodedata.category(c) != "Mn")
    w = re.sub(r"[^a-z0-9]", "", w)
    return re.sub(r"(.)\1{2,}", r"\1", w)          # « vrooooom » = « vroom » = « vrom »… à peu près


def mots_du_texte(paragraphes):
    mots, para, rang = [], [], []
    for i, p in enumerate(paragraphes):
        r = 0
        for w in re.sub(r"\[[^\]\n]{1,40}\]\s*", "", p).replace("’", "'").replace("'", " ").replace("-", " ").split():
            n = norm(w)
            if n:
                mots.append(n); para.append(i); rang.append(r); r += 1
    return mots, para, rang


def aligner(mots_t, mots_w):
    """Correspondances mot du texte → mot entendu (distance d'édition, mots égaux seulement)."""
    A, B = len(mots_t), len(mots_w)
    prec = list(range(B + 1))
    traces = []
    for a in range(1, A + 1):
        cur = [a] + [0] * B
        ta = mots_t[a - 1]
        tr = bytearray(B + 1)
        tr[0] = 1
        for b in range(1, B + 1):
            diag = prec[b - 1] + (0 if ta == mots_w[b - 1] else 1)
            haut = prec[b] + 1
            gauche = cur[b - 1] + 1
            if diag <= haut and diag <= gauche:
                cur[b] = diag; tr[b] = 0
            elif haut <= gauche:
                cur[b] = haut; tr[b] = 1
            else:
                cur[b] = gauche; tr[b] = 2
        traces.append(tr)
        prec = cur
    corr = {}
    a, b = A, B
    while a > 0 and b > 0:
        t = traces[a - 1][b]
        if t == 0:
            if mots_t[a - 1] == mots_w[b - 1]:
                corr[a - 1] = b - 1
            a -= 1; b -= 1
        elif t == 1:
            a -= 1
        else:
            b -= 1
    return corr


def debuts_paragraphes(paragraphes, mots):
    mots_t, para, rang = mots_du_texte(paragraphes)
    mots_w = [norm(m.word) for m in mots]
    corr = aligner(mots_t, mots_w)
    N = len(paragraphes)
    debuts = [None] * N
    fin_prec = 0.0
    for i in range(N):
        idx = [k for k in range(len(mots_t)) if para[k] == i]
        trouves = [k for k in idx if k in corr]
        if trouves:
            k = trouves[0]
            w = mots[corr[k]]
            # mots du début du paragraphe pas reconnus (onomatopée…) : on recule d'environ 0,3 s par mot
            t = w.start - rang[k] * 0.3
            debuts[i] = max(t, fin_prec)
            fin_prec = mots[corr[trouves[-1]]].end
    # paragraphes sans aucun mot reconnu : entre leurs voisins, au prorata des lettres
    longueurs = [len(re.sub(r"\[[^\]\n]{1,40}\]\s*", "", p)) + 8 for p in paragraphes]
    duree = mots[-1].end if mots else 0
    i = 0
    while i < N:
        if debuts[i] is not None:
            i += 1; continue
        j = i
        while j < N and debuts[j] is None:
            j += 1
        t0 = debuts[i - 1] if i > 0 else 0.0
        t1 = debuts[j] if j < N else duree
        l0 = longueurs[i - 1] if i > 0 else 0
        tot = l0 + sum(longueurs[i:j])
        acc = l0
        for k in range(i, j):
            debuts[k] = t0 + (t1 - t0) * acc / max(tot, 1)
            acc += longueurs[k]
        i = j
    sortie, dernier = [], 0.0
    for t in debuts:
        t = max(dernier, t - 0.12)            # on éclaire un poil avant que la voix commence
        sortie.append(round(t, 2)); dernier = t
    sortie[0] = 0.0 if sortie[0] < 1.0 else sortie[0]
    couverture = len(corr) / max(len(mots_t), 1)
    return sortie, couverture


class Gestion(BaseHTTPRequestHandler):
    def repondre(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass

    def do_POST(self):
        if self.path != "/aligner":
            return self.repondre(404, {"ok": False})
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= MAX_AUDIO * 1.4:
            return self.repondre(413, {"ok": False, "erreur": "trop gros"})
        try:
            b = json.loads(self.rfile.read(n))
            audio = base64.b64decode(b["audio"])
            paragraphes = [str(p) for p in b["paragraphes"]][:400]
        except Exception:
            return self.repondre(400, {"ok": False, "erreur": "requête illisible"})
        if not paragraphes or not audio:
            return self.repondre(400, {"ok": False, "erreur": "vide"})
        cle = hashlib.sha256(audio + json.dumps(paragraphes).encode()).hexdigest()
        fichier = os.path.join(CACHE, cle + ".json")
        if os.path.exists(fichier):
            with open(fichier) as f:
                return self.repondre(200, json.load(f))
        if not _attente.acquire(blocking=False):
            return self.repondre(503, {"ok": False, "erreur": "occupé"})
        try:
            with _verrou:
                if os.path.exists(fichier):
                    with open(fichier) as f:
                        return self.repondre(200, json.load(f))
                with tempfile.NamedTemporaryFile(suffix=".audio") as t:
                    t.write(audio); t.flush()
                    segs, _ = modele().transcribe(t.name, language="fr", word_timestamps=True, beam_size=1,
                                                  condition_on_previous_text=False)
                    mots = [w for s in segs for w in (s.words or [])]
                debuts, couverture = debuts_paragraphes(paragraphes, mots)
                rep = {"ok": couverture >= 0.5, "debuts": debuts, "couverture": round(couverture, 3)}
                if not rep["ok"]:
                    rep["erreur"] = "trop peu de mots reconnus"
                with open(fichier + ".tmp", "w") as f:
                    json.dump(rep, f)
                os.replace(fichier + ".tmp", fichier)
                return self.repondre(200, rep)
        except Exception as e:
            return self.repondre(500, {"ok": False, "erreur": str(e)[:200]})
        finally:
            _attente.release()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Gestion).serve_forever()
