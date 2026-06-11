# luxuria-claude-vps

Agent Claude pe VPS Hetzner pentru Luxuria Travel — primește bug-uri raportate de colegii lui Dan, analizează cauza la rădăcină și propune fix-uri.

## Mod ASCULTAR

NU face PR autonom. Doar:
1. Primește webhook de la Supabase la `POST /api/bug-nou`
2. Analizează bug-ul via Claude Agent SDK (cu acces read-only la clona luxuria-travel)
3. Salvează propunerea în Supabase + fișier `proposals/<bug-id>.md`
4. Trimite ntfy push cu link `/aprobare/<bug-id>`
5. Dan deschide link, vede raport 7 puncte + fix propus
6. Click DA → PR draft pe luxuria-travel · click NU → marcat rejected

## Setup pe VPS Hetzner

```bash
# 1. Clone repo
cd /var/luxuria-claude
git clone https://github.com/dancarlova-atpsor/luxuria-claude-vps.git
git clone --depth=1 https://github.com/dancarlova-atpsor/luxuria-travel.git

# 2. Env
mkdir -p /etc/luxuria-claude
cp luxuria-claude-vps/.env.example /etc/luxuria-claude/env
nano /etc/luxuria-claude/env  # completează valorile

# 3. Dependencies
cd luxuria-claude-vps
npm install --production

# 4. Systemd
cp systemd/luxuria-claude.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now luxuria-claude
journalctl -fu luxuria-claude
```

## URL public

`https://claude.luxuriatravel.ro` → nginx reverse proxy → localhost:8080

## Limitări iter 1 (12 iun 2026)

- PR-ul DRAFT conține DOAR descrierea propunerii (raport 7 puncte + fix descris). Modificările efective de cod se fac manual de Dan/dev pe baza propunerii.
- Iter 2 (viitor): „write loop" sigur care cere Claude să genereze diff strict + îl aplică pe ramură + verifică tsc + push automat.
