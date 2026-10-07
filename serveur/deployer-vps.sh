#!/bin/bash
# Publie l'app sur le serveur de Jonathan : https://95.groupelaberge.ca/histoires/
# (GitHub Pages se met à jour tout seul au push ; ceci est la copie du VPS.)
set -e
cd "$(dirname "$0")/.."
SSH=(-i ~/.ssh/whc_vps -p 2222)
scp "${SSH[@]/-p/-P}" -q index.html sw.js manifest.json icon.svg icon-192.png icon-512.png ubuntu@51.161.11.88:/tmp/histoires-depot/ 2>/dev/null || {
  ssh "${SSH[@]}" ubuntu@51.161.11.88 'mkdir -p /tmp/histoires-depot'
  scp -i ~/.ssh/whc_vps -P 2222 -q index.html sw.js manifest.json icon.svg icon-192.png icon-512.png ubuntu@51.161.11.88:/tmp/histoires-depot/
}
ssh "${SSH[@]}" ubuntu@51.161.11.88 'sudo install -m 644 /tmp/histoires-depot/* /var/www/histoires/ && rm -rf /tmp/histoires-depot && ls /var/www/histoires'
curl -s "https://95.groupelaberge.ca/histoires/sw.js?x=$RANDOM" | grep -o "histoires-v[0-9]*"
