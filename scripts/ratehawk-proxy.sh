#!/usr/bin/env bash
#
# Puntea RateHawk cu IP fix (Dan, 23 septembrie 2026).
#
# RateHawk cere o listă albă de IP-uri, iar Vercel nu are IP fix. Serverul ăsta are: 167.233.91.200.
# Scriptul pune în nginx o regulă care trimite mai departe, la RateHawk, doar cererile care vin cu
# antetul nostru secret. Fără antet, răspunde 403 — altfel puntea ar fi deschisă oricui o găsește.
#
# Cheia RateHawk NU trece pe aici: aplicația o trimite în antetul `Authorization`, nginx doar o
# duce mai departe.
#
# Se rulează:   bash scripts/ratehawk-proxy.sh SECRETUL
# Se poate rula de câte ori vrei — a doua oară doar rescrie regula, nu o dublează.

set -euo pipefail

SECRET="${1:-}"
if [ -z "$SECRET" ]; then
  echo "EROARE: lipseste secretul. Foloseste: bash scripts/ratehawk-proxy.sh SECRETUL"
  exit 1
fi

SITE=/etc/nginx/sites-enabled/claude.luxuriatravel.ro
SNIP=/etc/nginx/snippets/ratehawk-proxy.conf

if [ ! -f "$SITE" ]; then
  echo "EROARE: nu gasesc $SITE"
  exit 1
fi

echo "1. Scriu regula in $SNIP"
mkdir -p /etc/nginx/snippets
cat > "$SNIP" <<EOF
# Puntea RateHawk — generata de scripts/ratehawk-proxy.sh, NU se editeaza de mana.
location ~ ^/api/(b2b|content)/ {
    # Poarta: fara antetul nostru, nu trece nimeni.
    if (\$http_x_luxuria_proxy != "$SECRET") { return 403; }

    proxy_pass              https://api.worldota.net;
    proxy_ssl_server_name   on;
    proxy_set_header        Host api.worldota.net;
    proxy_http_version      1.1;
    proxy_set_header        Connection "";

    # Rezervarea poate tine pana la 180 de secunde (limita RateHawk). Lasam marja.
    proxy_connect_timeout   15s;
    proxy_send_timeout      200s;
    proxy_read_timeout      200s;

    client_max_body_size    4m;
    proxy_buffering         off;
}
EOF

# ATENTIE: copia NU se face in sites-enabled — nginx citeste TOT ce e acolo si ar vedea-o ca
# pe un al doilea site („duplicate listen options"). Pataita pe 23 sept 2026.
mkdir -p /root/nginx-copii
BACKUP="/root/nginx-copii/claude.luxuriatravel.ro-$(date +%Y%m%d-%H%M%S)"
cp -a "$SITE" "$BACKUP"
echo "2. Copie de siguranta: $BACKUP"

echo "3. Leg regula la inceputul primului bloc server (cel cu 443)"
# De ce la inceput, si nu dupa server_name: Certbot adauga liniile `listen 443` la SFARSITUL
# blocului, dupa location-uri. Cautand `server_name` dupa `listen 443` nimeream in blocul de
# pe portul 80 — si regula nu se vedea pe https. Patit pe 23 sept 2026.
# Locatia noastra e o expresie regulata, deci bate `location /` care trimite la aplicatia Node.
awk '
  BEGIN { pus = 0 }
  /ratehawk-proxy.conf/ { next }
  { print }
  pus == 0 && $0 ~ /^[[:space:]]*server[[:space:]]*\{/ {
    print "    include /etc/nginx/snippets/ratehawk-proxy.conf;"
    pus = 1
  }
  END { if (pus == 0) exit 3 }
' "$SITE" > "$SITE.nou" || {
  echo "EROARE: nu am gasit niciun bloc server. Nu am schimbat nimic."
  rm -f "$SITE.nou"
  exit 1
}
mv "$SITE.nou" "$SITE"

echo "4. Verific configuratia INAINTE de repornire"
if ! nginx -t; then
  echo "CONFIGURATIE GRESITA — pun la loc copia de siguranta, nginx ramane cum era."
  cp -a "$BACKUP" "$SITE"
  rm -f "$SNIP"
  exit 1
fi

echo "5. Repornesc nginx"
systemctl reload nginx

echo "6. Proba: fara antet trebuie sa dea 403"
COD=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 https://claude.luxuriatravel.ro/api/b2b/v3/hotel/prebook/ || echo "000")
echo "   cod primit: $COD"

if [ "$COD" = "403" ]; then
  echo ""
  echo "GATA. Puntea merge. IP-ul de dat la RateHawk: 167.233.91.200"
else
  echo ""
  echo "ATENTIE: asteptam 403, am primit $COD. Verifica mai sus ce a iesit."
fi
