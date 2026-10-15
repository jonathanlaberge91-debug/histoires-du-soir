"""Les grandes aventures commandées à Claude depuis l'app (cadre ✨ de la table de chevet), encore en attente.

  python serveur/commandes.py            -> la liste
  python serveur/commandes.py HID        -> la commande complète (choix, durée, prompt de l'app) en JSON

Une fois l'aventure écrite : python serveur/super-histoire.py aventure.json --commande HID
(la commande est remplacée sur le serveur, même identifiant ; l'app la met à jour toute seule).
"""
import json, os, subprocess, sys
sys.stdout.reconfigure(encoding='utf-8')
SSH = ['ssh', '-i', os.path.expanduser('~/.ssh/whc_vps'), '-p', '2222', 'ubuntu@51.161.11.88']
DB = '/opt/pocketbase-maison/pb_data/data.db'

def sql(q):
    r = subprocess.run(SSH + [f'sudo -n sqlite3 -readonly -json {DB}'], input=q.encode('utf-8'), capture_output=True)
    if r.returncode: sys.exit(r.stderr.decode('utf-8', 'replace'))
    return json.loads(r.stdout.decode('utf-8') or '[]')

if len(sys.argv) > 1:
    hid = sys.argv[1].replace("'", '')
    l = sql(f"select donnees from histoires where hid = '{hid}';")
    if not l: sys.exit('aucune commande ' + hid)
    print(json.dumps(json.loads(l[0]['donnees']), ensure_ascii=False, indent=1))
else:
    l = sql("select hid, titre, created from histoires where json_extract(donnees, '$.attente') = 1 order by created;")
    if not l: print('Aucune commande en attente.')
    for x in l: print(f"{x['hid']}  {x['created'][:16]}  {x['titre']}")
