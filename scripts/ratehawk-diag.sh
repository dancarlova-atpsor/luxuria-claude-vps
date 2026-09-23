#!/usr/bin/env bash
# Diagnostic pentru puntea RateHawk — NU schimba nimic, doar arata.
# Consola web Hetzner nu ma lasa sa scriu `|`, deci filtrarea se face aici, in fisier.

echo "=== 1. Continutul regulii ==="
cat /etc/nginx/snippets/ratehawk-proxy.conf 2>/dev/null || echo "(fisierul NU exista)"

echo
echo "=== 2. Unde e legata, in fisierul de site ==="
grep -n "ratehawk" /etc/nginx/sites-enabled/claude.luxuriatravel.ro || echo "(nu e legata nicaieri)"

echo
echo "=== 3. Primele 30 de linii ale fisierului de site ==="
head -30 /etc/nginx/sites-enabled/claude.luxuriatravel.ro

echo
echo "=== 4. A incarcat-o nginx? (din configuratia efectiva) ==="
nginx -T 2>/dev/null > /tmp/nginx-efectiv.txt
grep -n "ratehawk" /tmp/nginx-efectiv.txt || echo "(NU apare in configuratia incarcata)"

echo
echo "=== 5. Toate location-urile incarcate pentru acest site ==="
grep -n "location" /tmp/nginx-efectiv.txt

echo
echo "=== 6. Proba locala, direct pe nginx ==="
curl -s -o /dev/null -w "   fara antet: %{http_code}\n" --max-time 15 https://claude.luxuriatravel.ro/api/b2b/v3/hotel/prebook/
curl -s -o /dev/null -w "   cu antet:   %{http_code}\n" --max-time 15 -H "X-Luxuria-Proxy: $1" https://claude.luxuriatravel.ro/api/b2b/v3/hotel/prebook/
