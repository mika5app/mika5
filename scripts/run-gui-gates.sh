#!/usr/bin/env bash
#
# Gates que necesitan superficie gráfica de verdad.
#
#   npm run test:gui
#   xvfb-run -a npm run test:gui      # en Linux sin display
#
# Por qué existe separado de `test:all`: no toda la batería es GUI, y decir que
# lo es sería mentir sobre lo que cubre el display virtual. De las suites que
# corren bajo Electron, sólo estas cinco tocan la capa gráfica:
#
#   electron-security               abre BrowserWindow
#   electron-renderer-integration   abre BrowserWindow
#   image-download-electron         espera a app.whenReady()
#   print-pdf-electron              abre ventanas offscreen y imprime
#   provider-selector               abre la ventana real y mide maquetación
#
# Las otras tres —db, knowledge-scope y native-binding— corren bajo Electron
# porque necesitan su ABI y su módulo nativo, no su pantalla: arrancan, hacen su
# trabajo y salen sin crear ninguna ventana. Meterlas aquí no añadiría cobertura
# GUI, sólo tiempo.
#
# Igual que el gate canónico: cada suite corre sin tubería y su código de salida
# se comprueba explícitamente, porque filtrar con `| grep` devolvería el código
# de `grep` y una suite podría fallar con el comando entero en verde.
#
set -uo pipefail
cd "$(dirname "$0")/.."

LOGDIR="${MIKA5_GATE_LOGS:-.gate-logs}"
mkdir -p "$LOGDIR"

# En CI de Linux, Electron necesita --no-sandbox. Se inyecta por entorno, igual
# que en el gate canónico, para que en local siga corriendo tal cual.
#
# MIKA5_ELECTRON_ARGS sólo admite opciones adicionales de Electron. NO puede
# suministrar --user-data-dir: el aislamiento del perfil lo decide siempre
# scripts/run-electron-test.js, que descarta cualquier --user-data-dir externo y
# crea uno temporal por ejecución.
ELECTRON_ARGS="${MIKA5_ELECTRON_ARGS:-}"

NAMES=(
  "electron-security"
  "electron-renderer-integration"
  "image-download-electron"
  "print-pdf-electron"
  "provider-selector"
)
CMDS=(
  "node scripts/run-electron-test.js test/electron-security.test.js $ELECTRON_ARGS"
  "node scripts/run-electron-test.js test/electron-renderer-integration.test.js $ELECTRON_ARGS"
  "node scripts/run-electron-test.js test/image-download-electron.test.js $ELECTRON_ARGS"
  "node scripts/run-electron-test.js test/print-pdf-electron.test.js $ELECTRON_ARGS"
  "node scripts/run-electron-test.js test/provider-selector.test.js $ELECTRON_ARGS"
)

FAILED=0
for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  cmd="${CMDS[$i]}"
  log="$LOGDIR/gui-$name.log"
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
  echo "GATES GUI EN VERDE (código de salida real de cada proceso)"
else
  echo "HAY GATES GUI EN ROJO — logs completos en $LOGDIR/"
fi
exit $FAILED
