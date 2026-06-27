#!/usr/bin/env bash
# Diagnostica problema cambio modalità AI in produzione
# Uso: bash diagnose-prod.sh

set +e

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
err()   { echo -e "${RED}[ERR]${NC}   $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
hr()    { echo -e "\n${YELLOW}=== $* ===${NC}"; }

hr "1. Container attivi"
docker ps 2>/dev/null | grep -E "avatar-kiosk|CONTAINER" || err "Nessun container avatar-kiosk trovato"

CONTAINER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E "^avatar-kiosk$" | head -1)
if [ -z "$CONTAINER" ]; then
  CONTAINER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep avatar-kiosk | head -1)
fi

if [ -z "$CONTAINER" ]; then
  err "Impossibile trovare il container. Uscita."
  exit 1
fi
ok "Container trovato: $CONTAINER"

hr "2. Path DB dentro il container"
docker exec "$CONTAINER" ls -la /app/data/ 2>&1
echo "---"
docker exec "$CONTAINER" ls -la /app/avatars.db 2>&1

hr "3. Cosa legge db.js"
docker exec "$CONTAINER" sh -c "head -10 /app/db.js"

hr "4. Avatar nel DB (data/avatars.db)"
docker exec "$CONTAINER" sh -c "which sqlite3 || apk add --no-cache sqlite3 2>&1 | tail -2"
DB_PATH="/app/data/avatars.db"
docker exec "$CONTAINER" sh -c "test -f $DB_PATH && sqlite3 $DB_PATH 'SELECT id, name, avatar_mode, mcp_url FROM avatars LIMIT 10'" 2>&1

hr "5. Avatar nel DB (root avatars.db, se esiste)"
docker exec "$CONTAINER" sh -c "test -f /app/avatars.db && sqlite3 /app/avatars.db 'SELECT id, name, avatar_mode FROM avatars LIMIT 10'" 2>&1

hr "6. Processi Node"
docker exec "$CONTAINER" ps aux 2>/dev/null | grep -E "node|PID" | head -10

hr "7. Test API /api/avatar/:id (richiede ID)"
# Prendi il primo avatar pubblicato
AVATAR_ID=$(docker exec "$CONTAINER" sqlite3 /app/data/avatars.db "SELECT id FROM avatars WHERE published=1 LIMIT 1" 2>/dev/null)
if [ -n "$AVATAR_ID" ]; then
  echo "Test con avatar: $AVATAR_ID"
  docker exec "$CONTAINER" sh -c "wget -qO- http://localhost:3000/api/avatar/$AVATAR_ID 2>/dev/null | head -c 800" 2>&1
  echo ""
else
  warn "Nessun avatar pubblicato per il test"
fi

hr "8. Log del server (ultimi 30)"
docker logs --tail 30 "$CONTAINER" 2>&1

hr "9. Volume mounts del container"
docker inspect "$CONTAINER" --format '{{json .Mounts}}' 2>/dev/null | python3 -m json.tool 2>&1 | head -40

hr "FINE DIAGNOSI"
echo ""
echo "COSA FARE CON I RISULTATI:"
echo "- Se 4 mostra avatar ma 5 ne mostra altri/diversi: due DB separati (problema noto)"
echo "- Se 6 mostra più processi node: riavvia il container"
echo "- Se 7 restituisce 'Avatar non trovato': kiosk non riesce a leggere"
echo "- Se 9 NON monta ./data: il container non vede i dati persistenti"
echo "- Se 9 monta ./data ma 4 è vuoto: i dati sono andati persi"
