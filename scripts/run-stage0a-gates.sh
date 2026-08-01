#!/usr/bin/env bash
#
# Gates de MIKA5: las suites de `npm test` más las que necesitan Electron.
#
# Por qué existe: filtrar la salida con `| grep` devuelve el código de salida de
# `grep`, no el del proceso real, así que una suite podía fallar y el comando
# completo terminar en 0. Aquí cada gate corre sin tubería y su código se
# comprueba explícitamente.
#
#   npm run test:all
#
set -uo pipefail
cd "$(dirname "$0")/.."

LOGDIR="${MIKA5_GATE_LOGS:-.gate-logs}"
mkdir -p "$LOGDIR"

NAMES=(
  "npm-test"
  "db"
  "knowledge-scope"
)
CMDS=(
  "npm test"
  "npx electron test/db.test.js"
  "npx electron test/knowledge-scope.test.js"
)

FAILED=0
for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  cmd="${CMDS[$i]}"
  log="$LOGDIR/$name.log"
  $cmd > "$log" 2>&1
  code=$?
  if [ $code -eq 0 ]; then
    printf 'PASS  exit=%-3s %-32s %s\n' "$code" "$name" "$cmd"
  else
    printf 'FAIL  exit=%-3s %-32s %s\n' "$code" "$name" "$cmd"
    FAILED=1
    echo "  --- últimas líneas de $log ---"
    tail -20 "$log" | sed 's/^/  /'
  fi
done

echo
if [ $FAILED -eq 0 ]; then
  echo "TODOS LOS GATES EN VERDE (código de salida real de cada proceso)"
else
  echo "HAY GATES EN ROJO — logs completos en $LOGDIR/"
fi
exit $FAILED
