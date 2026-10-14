#!/bin/bash
# Installe / met à jour la fabrique sur le serveur de Jonathan (95.groupelaberge.ca).
# 1re fois : crée le service et ajoute /histoires/fabrique dans Caddy (vérifié avant rechargement).
set -e
cd "$(dirname "$0")"
SSH=(-i ~/.ssh/whc_vps -p 2222 ubuntu@51.161.11.88)
node --check fabrique.mjs
scp -i ~/.ssh/whc_vps -P 2222 -q fabrique.mjs histoires-fabrique.service ubuntu@51.161.11.88:/tmp/
ssh "${SSH[@]}" 'set -e
  sudo install -d -m 755 /opt/histoires-fabrique
  sudo install -m 644 /tmp/fabrique.mjs /opt/histoires-fabrique/fabrique.mjs
  sudo install -m 644 /tmp/histoires-fabrique.service /etc/systemd/system/histoires-fabrique.service
  rm -f /tmp/fabrique.mjs /tmp/histoires-fabrique.service
  sudo systemctl daemon-reload
  sudo systemctl enable -q histoires-fabrique
  sudo systemctl restart histoires-fabrique
  # Caddy : /histoires/fabrique → 127.0.0.1:8121 (une seule fois), AVANT les fichiers de l app
  if ! grep -q "histoires/fabrique" /etc/caddy/Caddyfile; then
    sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.avant-fabrique
    sudo python3 - <<PY
p = "/etc/caddy/Caddyfile"
s = open(p).read()
a = "\tredir /histoires /histoires/\n"
assert s.count(a) == 1
bloc = "\t# Histoires du soir : la fabrique (histoires fabriquees sur le serveur, port 8121). flush : reponses tout de suite.\n\t@histfab path /histoires/fabrique /histoires/fabrique/*\n\thandle @histfab {\n\t\treverse_proxy 127.0.0.1:8121 {\n\t\t\tflush_interval -1\n\t\t}\n\t}\n"
open(p, "w").write(s.replace(a, bloc + a))
PY
    if sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then sudo systemctl reload caddy; echo "Caddy : route ajoutée"
    else sudo cp /etc/caddy/Caddyfile.avant-fabrique /etc/caddy/Caddyfile; echo "Caddy : configuration refusée, remise comme avant"; exit 1; fi
  fi
  sleep 1; systemctl is-active histoires-fabrique'
curl -s https://95.groupelaberge.ca/histoires/fabrique/sante; echo
