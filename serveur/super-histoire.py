"""Dépose une « Super histoire » (écrite par Claude dans Claude Code, sans API) sur le serveur Maison.
L'app la récupère toute seule (srvRecuperer) et la range dans la tablette « ✨ Super histoires », tout en bas de Histoires.
Pas d'audio ni d'image : la voix s'enregistre au premier « Raconter », les images avec « 🎨 Illustrer ».

  python serveur/super-histoire.py histoire.json
  histoire.json = {"titre": "...", "histoire": "paragraphe\\n\\nparagraphe…", "pour": "Abby",
                   "ambiance": "Drôle", "lieu": "...", "mechant": "...", "duree": "Moyenne · 5 min", "images": 4}
"""
import json, os, secrets, subprocess, sys, time
sys.stdout.reconfigure(encoding='utf-8')

SSH = ['ssh', '-i', os.path.expanduser('~/.ssh/whc_vps'), '-p', '2222', 'ubuntu@51.161.11.88']
DB = '/opt/pocketbase-maison/pb_data/data.db'
AUTEUR = '1nowfgvyzuk1hse'          # le compte Maison de Jonathan (même auteur que ses histoires)

h = json.load(open(sys.argv[1], encoding='utf-8'))
COMMANDE = sys.argv[sys.argv.index('--commande') + 1].replace("'", '') if '--commande' in sys.argv else None   # remplacer une commande de l'app
assert h.get('titre') and h.get('histoire'), 'il faut au moins « titre » et « histoire »'
hid, maintenant = COMMANDE or secrets.token_hex(8), int(time.time() * 1000)
donnees = {
    'id': hid, 'createdAt': maintenant, 'titre': h['titre'], 'histoire': h['histoire'].strip(),
    'meta': {k: h.get(k, '') for k in ('ambiance', 'lieu', 'mechant', 'duree')} | {'name': h.get('pour', ''), 'friends': h.get('avec', '')},
    'illusNb': int(h.get('images', 4)), 'ecriture': 'simple', 'super': True, 'nouvelle': True,
}
q = lambda v: "'" + str(v).replace("'", "''") + "'"
iso = time.strftime('%Y-%m-%d %H:%M:%S.000Z', time.gmtime())
don = q(json.dumps(donnees, ensure_ascii=False))
if COMMANDE:
    sql = f"update histoires set titre = {q(h['titre'])}, donnees = {don}, updated = {q(iso)} where hid = {q(hid)};"
else:
    sql = (f"insert into histoires (hid, titre, creeLe, fav, donnees, enfant, auteur, cles, created, updated) values "
           f"({q(hid)}, {q(h['titre'])}, {maintenant}, 0, {don}, {q(h.get('pour', ''))}, {q(AUTEUR)}, '{{}}', {q(iso)}, {q(iso)});")
sql += f"select id from histoires where hid = {q(hid)};"
r = subprocess.run(SSH + [f'sudo -n sqlite3 {DB}'], input=sql.encode('utf-8'), capture_output=True)
if r.returncode: sys.exit('échec : ' + r.stderr.decode('utf-8', 'replace'))
print('déposée :', h['titre'], '->', r.stdout.decode().strip(), '(hid', hid + ')')
