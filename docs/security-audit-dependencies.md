# Auditoría de dependencias

**Fecha:** 2026-08-05 · **Rama:** `stabilize/provider-layer` · **Herramienta:** `npm audit`

`npm audit` contaba 20 vulnerabilidades. El número por sí solo no dice nada:
la mayoría están en la cadena de `electron-builder`, que sólo corre en la
máquina que construye el instalador y nunca se empaqueta. Lo que importa es
qué llega al usuario.

## Resumen

| | Antes | Ahora |
|---|---|---|
| Total | 20 | 17 |
| **Que llegan al usuario** | **4** | **1** |

Lo que queda en producción es `uuid`, y no es alcanzable aquí.

---

## Lo que se corrigió

### `xlsx` (SheetJS) — alta — **vendorizada 0.20.3**

Prototype pollution y ReDoS. Era la más seria, y no por la severidad sino por
dónde estaba: `file:extractSpreadsheet` en `main.js` llama a `XLSX.read()`
sobre un fichero que elige el usuario, en el **proceso principal**, que tiene
Node entero.

El paquete `xlsx` del registro npm está congelado en 0.18.5 — SheetJS dejó de
publicar allí —, así que `npm audit fix` no podía arreglarlo y nunca podrá.

**Resuelto vendorizando 0.20.3.** El tarball se obtuvo una vez de
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, se verificó y vive en el
repositorio:

```
vendor/xlsx-0.20.3.tgz
sha256  8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8
```

Se declara como `file:vendor/xlsx-0.20.3.tgz`. **`npm ci` no habla con el
CDN**: descargar de un host remoto en cada instalación cambiaría un problema de
cadena de suministro por otro. Comprobado instalando la dependencia con
`npm install --offline`, sin red, y obteniendo 0.20.3.

`test/xlsx-vendored.test.js` fija el SHA-256 aprobado, así que sustituir el
tarball sin actualizar ese valor no puede pasar en silencio, y ejercita
lecturas reales de `.xlsx` y `.xls`. El soporte de hojas de cálculo se conserva
íntegro: el handler y las extensiones no se tocan.

Verificado en el empaquetado: el `app.asar` lleva `xlsx@0.20.3` con su
`LICENSE` de Apache-2.0. El paquete no trae `NOTICE`, así que no hay aviso
adicional que propagar (Apache-2.0 §4(d) sólo obliga si el original lo incluye).

### `@xmldom/xmldom` — alta — **actualizada a 0.8.13**

**Corrección de la auditoría anterior de esta rama, que la clasificó mal.** Se
dijo que era sólo de construcción y no lo es: `mammoth` la arrastra para leer
`.docx`, y `mammoth` es dependencia de producción. Sí llegaba al usuario.

`mammoth` acepta `^0.8.6`, así que 0.8.13 entra sin romper nada y cierra cinco
avisos, entre ellos inyección XML por serialización de CDATA.

### `xlsx-parse-json` — alta — **retirada**

Declarada en `dependencies`, se empaquetaba, arrastraba un aviso alto y **no la
usaba nadie**: ni `src/`, ni `scripts/`, ni las pruebas. Verificado ausente del
`app.asar`.

---

## Lo que queda en producción

### `uuid` 9 — moderada — no alcanzable

Falta de comprobación de límites en v3/v5/v6 cuando se pasa `buf`
([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)).
MIKA5 usa v4 y nunca pasa `buf`: **el código vulnerable no se ejecuta**. El
arreglo es `uuid@14`, un salto mayor que no aporta nada mientras el uso siga
siendo el actual.

No se silencia. `npm audit` la sigue reportando y así debe ser: la evaluación
de alcanzabilidad es de este código y de esta versión, y deja de valer si
alguno de los dos cambia.

---

## Lo que no llega al usuario

Dieciséis avisos bajo `electron-builder@24.13.3`, que sólo corre al construir:

`tar` (crítica, path traversal) · `lodash` · `form-data` · `tmp` · `minimatch` ·
`brace-expansion` · `@tootallnate/once` · `app-builder-lib` · `builder-util` ·
`builder-util-runtime` · `dmg-builder` · `electron-publish` ·
`electron-builder-squirrel-windows` · `electron-builder` · `js-yaml`

La crítica —`tar`, creación arbitraria de ficheros por enlaces duros— exige un
artefacto malicioso durante el empaquetado. Importa para la máquina de
construcción; no viaja en el instalador. Se arreglan con
`electron-builder@26`, un salto mayor que cambia el formato de configuración.

### Caso aparte: `electron` 31.7.7 — alta

*ASAR Integrity Bypass* e inyección de AppleScript en
`app.moveToApplicationsFolder` (sólo macOS). Es `devDependency`, pero **el
binario de Electron es el runtime que se empaqueta**: esto sí llega al usuario,
aunque `npm audit --omit=dev` no lo cuente. El arreglo es Electron 43, cuatro
majors por encima: es una migración con su propio plan de pruebas.

---

## Pendiente

1. **Electron 31 → 43.** La única de la lista con exposición real al usuario
   que sigue abierta. Rama propia, plan de pruebas propio.
2. **Aislar el parseo de hojas de cálculo.** Segunda capa, recomendada aunque
   0.20.3 cierre las vulnerabilidades conocidas. Un proceso hijo con Node
   completo, el entorno heredado y acceso normal al sistema de ficheros **no
   cuenta como aislamiento**: haría falta restringir de verdad permisos,
   entorno y sistema de ficheros.
3. **electron-builder 24 → 26.** Cierra los dieciséis de construcción,
   incluida la crítica.

Ninguna se hizo aquí: son saltos mayores, y meterlos en la misma rama que la
estabilización de los gates haría imposible saber qué rompió qué.
