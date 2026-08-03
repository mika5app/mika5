#!/usr/bin/env bash
#
# Gate canónico de MIKA5: la batería completa tras integrar Knowledge/RAG.
#
# Por qué existe: filtrar la salida con `| grep` devuelve el código de salida de
# `grep`, no el del proceso real, así que una suite podía fallar y el comando
# completo terminar en 0. Aquí cada gate corre sin tubería y su código se
# comprueba explícitamente.
#
#   npm run test:all
#
# Cobertura. `npm-test` encadena, en un solo proceso, las suites de node:
#   rag · vision · alibaba · provider-capabilities · request-context
#   provider-cancellation · cloud-consent · network-security · knowledge-cli
# Los demás necesitan Electron y corren por separado. Ninguna suite se cuenta
# dos veces como evidencia: knowledge-cli llega vía npm-test y no se repite
# como gate independiente.
#
set -uo pipefail
cd "$(dirname "$0")/.."

LOGDIR="${MIKA5_GATE_LOGS:-.gate-logs}"
mkdir -p "$LOGDIR"

# En CI de Linux, Electron necesita --no-sandbox. Se inyecta por entorno en vez
# de fijarlo aquí, para que en local siga corriendo con la configuración normal.
ELECTRON_ARGS="${MIKA5_ELECTRON_ARGS:-}"

NAMES=(
  "npm-test"
  "db"
  "knowledge-scope"
  "electron-security"
  "electron-renderer-integration"
  "image-download-electron"
  "print-pdf-electron"
)
CMDS=(
  "npm test"
  "npx electron $ELECTRON_ARGS test/db.test.js"
  "npx electron $ELECTRON_ARGS test/knowledge-scope.test.js"
  "npx electron $ELECTRON_ARGS test/electron-security.test.js"
  "npx electron $ELECTRON_ARGS test/electron-renderer-integration.test.js"
  "npx electron $ELECTRON_ARGS test/image-download-electron.test.js"
  "npx electron $ELECTRON_ARGS test/print-pdf-electron.test.js"
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
