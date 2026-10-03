#!/usr/bin/env bash
#
# PUNTEA NU MAI CADE LA O CLIPA DE DNS (3 octombrie 2026).
#
# Ce s-a intamplat, de doua ori in trei zile (jurnalul nginx, citit de Dan in consola):
#   Oct 01 06:58:43  [emerg] host not found in upstream "api.worldota.net" ... test failed
#   Oct 03 06:05:51  Stopping nginx.service -> [emerg] host not found ... Failed to start
# Ceva reporneste nginx dimineata; la pornire, nginx cauta in DNS numele RateHawk scris in
# regula (`proxy_pass https://api.worldota.net;`). Daca in clipa aia DNS-ul nu raspunde,
# nginx REFUZA sa porneasca si ramane jos pana apasa cineva un buton: 9 ore si jumatate pe
# 1 octombrie, 7 ore pe 3 octombrie.
#
# Doua reparatii, amandoua in acelasi script:
#   1. numele RateHawk se cauta in DNS LA CERERE, nu la pornire (`resolver` + variabila), deci
#      nginx porneste si fara DNS si incearca din nou singur, din 5 in 5 minute;
#   2. daca nginx tot pica la pornire, systemd il reporneste singur la 20 s, la nesfarsit
#      (`Restart=on-failure`, fara limita de incercari).
#
# Se ruleaza ca root, fara argumente — pastreaza secretul deja scris in regula:
#   bash scripts/nginx-rezista-la-dns.sh
# Se poate rula de cate ori vrei.

set -euo pipefail

SNIP=/etc/nginx/snippets/ratehawk-proxy.conf
OVR_DIR=/etc/systemd/system/nginx.service.d
OVR=$OVR_DIR/rezista-la-dns.conf

if [ ! -f "$SNIP" ]; then
  echo "EROARE: nu gasesc $SNIP — puntea nu e instalata (bash scripts/ratehawk-proxy.sh SECRET)."
  exit 1
fi

echo "0. Ce s-a intamplat la ultimele doua caderi (ce servicii au fost oprite in jurul lor)"
echo "   --- pornirea anterioara (cea cu caderea de pe 3 oct) ---"
journalctl -b -1 -g "Stopping" --no-pager -n 25 2>/dev/null || true
echo "   --- cu doua porniri in urma (cea cu caderea de pe 1 oct) ---"
journalctl -b -2 -g "Stopping" --no-pager -n 25 2>/dev/null || true

mkdir -p /root/nginx-copii
BACKUP="/root/nginx-copii/ratehawk-proxy.conf-$(date +%Y%m%d-%H%M%S)"
cp -a "$SNIP" "$BACKUP"
echo "1. Copie de siguranta a regulii: $BACKUP"

if grep -q 'set \$ratehawk_upstream' "$SNIP"; then
  echo "2. Regula e deja in forma care rezista la DNS — nu o schimb."
else
  echo "2. Rescriu linia proxy_pass: numele se cauta la cerere, nu la pornire"
  # 127.0.0.53 = systemd-resolved (DNS-ul local); 185.12.64.1/2 = DNS-ul Hetzner, de rezerva.
  # valid=300s: raspunsul se tine minte 5 minute, apoi se intreaba iar — asa prindem si o
  # schimbare de IP la ei, fara repornire.
  awk '
    /^[[:space:]]*proxy_pass[[:space:]]+https:\/\/api\.worldota\.net;/ {
      print "    # 3 oct 2026: numele se cauta in DNS LA CERERE. Cu numele scris direct in proxy_pass,"
      print "    # nginx il cauta la pornire si, daca DNS-ul nu raspunde in clipa aia, refuza sa porneasca."
      print "    resolver                127.0.0.53 185.12.64.1 185.12.64.2 valid=300s ipv6=off;"
      print "    set $ratehawk_upstream  https://api.worldota.net;"
      print "    proxy_pass              $ratehawk_upstream;"
      next
    }
    { print }
  ' "$BACKUP" > "$SNIP"
  if ! grep -q 'proxy_pass              \$ratehawk_upstream;' "$SNIP"; then
    echo "EROARE: nu am gasit linia proxy_pass de rescris. Pun regula la loc, nu schimb nimic."
    cp -a "$BACKUP" "$SNIP"
    exit 1
  fi
fi

echo "3. Verific configuratia INAINTE sa ating nginx"
if ! nginx -t; then
  echo "CONFIGURATIE GRESITA — pun la loc copia de siguranta, nginx ramane cum era."
  cp -a "$BACKUP" "$SNIP"
  nginx -t || true
  exit 1
fi

echo "4. systemd: daca nginx pica la pornire, il reporneste singur la 20 s, oricate ori"
mkdir -p "$OVR_DIR"
cat > "$OVR" <<'UNIT'
# 3 oct 2026 — nginx a stat jos 9h30 si 7h pentru ca a picat O data la pornire si nimeni nu l-a
# mai pornit. De aici incolo systemd incearca din nou la 20 de secunde, fara limita.
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=on-failure
RestartSec=20s
UNIT
systemctl daemon-reload

echo "5. Reincarc nginx cu regula noua (fara intrerupere)"
systemctl reload nginx
sleep 1
systemctl is-active nginx

echo "6. Probe"
echo "   systemd: $(systemctl show nginx -p Restart -p RestartUSec --value | tr '\n' ' ')"
COD=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 https://claude.luxuriatravel.ro/api/b2b/v3/hotel/prebook/ || echo "000")
echo "   fara antet, asteptam 403: $COD"

if [ "$COD" = "403" ]; then
  echo
  echo "GATA. Puntea merge si de acum porneste si fara DNS; daca tot pica, se reporneste singura."
else
  echo
  echo "ATENTIE: asteptam 403, am primit $COD. Copia regulii vechi: $BACKUP"
fi
