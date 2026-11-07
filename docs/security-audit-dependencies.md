# Auditoría de dependencias

**Fecha:** 2026-08-05 · **Rama:** `stabilize/provider-layer` · **Herramienta:** `npm audit`

## Contabilidad

Hay dos cuentas distintas y confundirlas fue un error de la versión anterior de
este documento, que decía «4 → 1» y a la vez reconocía que quedaban dos cosas
empaquetadas. Las dos cuentas, por separado:

| Cuenta | Antes | Ahora |
|---|---|---|
| `npm audit` completo | 20 | 16 |
| `npm audit --omit=dev` | 4 | **0** |
| **Componentes que llegan al usuario** | **5** | **1** |

La tercera fila es la que importa y no la da ninguna herramienta.
`npm audit --omit=dev` dice 0, y aun así **el runtime de Electron se
empaqueta** aunque esté declarado como `devDependency`. Esa es la única que
queda.

---

## Corregido

### `xlsx` (SheetJS) — alta — vendorizada 0.20.3

Prototype pollution y ReDoS. La más seria por dónde estaba:
`file:extractSpreadsheet` en `main.js` llama a `XLSX.read()` sobre un fichero
que elige el usuario, en el **proceso principal**, que tiene Node entero.

El paquete del registro npm está congelado en 0.18.5 —SheetJS dejó de publicar
allí—, así que `npm audit fix` no podía arreglarlo y nunca podrá.

```
vendor/xlsx-0.20.3.tgz
sha256  8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8
origen  https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

Declarada como `file:vendor/xlsx-0.20.3.tgz`. **`npm ci` no habla con el CDN**:
descargar de un host remoto en cada instalación cambiaría un problema de cadena
de suministro por otro. Comprobado con `npm install --offline`, sin red.

`test/xlsx-vendored.test.js` fija el SHA-256 aprobado y ejercita lecturas
reales de `.xlsx` y `.xls`. El `app.asar` lleva 0.20.3 con su `LICENSE` de
Apache-2.0; el paquete no trae `NOTICE`, así que no hay aviso adicional que
propagar. El soporte de hojas de cálculo se conserva íntegro.

### `uuid` — moderada — **actualizada a 11.1.1**

**Corrección.** La versión anterior de este documento afirmaba que el arreglo
era `uuid@14`, un salto mayor que no compensaba, y trataba el aviso como
excepción aceptada por no alcanzable. Las dos cosas estaban mal en la parte que
importa: el advisory
([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)) da
por corregida la rama en **11.1.1**, y no se probó antes de aceptar la
excepción.

Probado: 11.1.1 mantiene el `require('uuid')` de CommonJS que usan `db.js` y
`rag.js`, y `npm test` y el gate de `db` siguen verdes. Aplicada. La excepción
sobra.

### `@xmldom/xmldom` — alta — actualizada a 0.8.13

**Corrección.** Una auditoría anterior de esta rama la clasificó como sólo de
construcción y no lo es: `mammoth` la arrastra para leer `.docx`, y `mammoth`
es dependencia de producción. Sí llegaba al usuario. `mammoth` acepta `^0.8.6`,
así que 0.8.13 entra sin romper nada y cierra cinco avisos.

### `xlsx-parse-json` — alta — retirada

Declarada en `dependencies`, se empaquetaba, arrastraba un aviso alto y **no la
usaba nadie**. Verificada ausente del `app.asar`.

---

## Lo que sigue llegando al usuario: Electron 31.7.7

`npm audit --omit=dev` no lo cuenta porque es `devDependency`, pero el binario
de Electron **es** el runtime que se empaqueta.

### Alcanzabilidad de sus dos advisories

Ninguno de los dos es alcanzable, y por motivos distintos:

**Inyección de AppleScript en `app.moveToApplicationsFolder()`**
([GHSA-5rqw-r77c-jp79](https://github.com/advisories/GHSA-5rqw-r77c-jp79)) —
**no alcanzable**: MIKA5 no invoca esa API en ninguna parte. Verificado sobre
`src/` y `scripts/`.

**ASAR Integrity Bypass**
([GHSA-vmqv-hx8q-j7mg](https://github.com/electron/electron/security/advisories/GHSA-vmqv-hx8q-j7mg))
— **no alcanzable, y el motivo es peor que el fallo**: el aviso describe cómo
saltarse la validación de integridad del ASAR, y MIKA5 **no configura ningún
fuse**, así que `EnableEmbeddedAsarIntegrityValidation` y `OnlyLoadAppFromAsar`
están desactivados. No hay validación que saltarse porque no hay validación. El
`app.asar` empaquetado puede modificarse sin que nada lo detecte.

Eso convierte el hallazgo en otra cosa: no es un aviso que aplicar, es una
protección que falta. Habilitar los fuses es trabajo de endurecimiento con
entidad propia.

### Lo que sí es un problema, con o sin advisories

**Electron 31 está fuera de soporte.** Electron mantiene sólo las tres series
estables más recientes; con la 43 publicada, eso son 41, 42 y 43. La 31 no
recibe parches de seguridad: cualquier fallo futuro de Chromium o de V8 se
queda sin corregir en este runtime, y ninguna auditoría de npm lo va a señalar.

**Corrección.** La versión anterior decía «cuatro majors por encima». Son
**doce**: 31 → 43.

---

## Lo que no llega al usuario

Dieciséis avisos bajo `electron-builder@24.13.3`, que sólo corre al construir:

`tar` (crítica, path traversal) · `lodash` · `form-data` · `tmp` · `minimatch` ·
`brace-expansion` · `@tootallnate/once` · `app-builder-lib` · `builder-util` ·
`builder-util-runtime` · `dmg-builder` · `electron-publish` ·
`electron-builder-squirrel-windows` · `electron-builder` · `js-yaml`

La crítica exige un artefacto malicioso durante el empaquetado. Importa para la
máquina que construye; no viaja en el instalador. Se cierran con
`electron-builder@26`, salto mayor que cambia el formato de configuración.

---

## Pendiente, por orden

1. **Electron 31 → 43, y los fuses en ese mismo trabajo, no antes.** Doce
   majors. Runtime sin soporte; es lo único empaquetado que sigue abierto.

   > **No habilitar los fuses mientras MIKA5 siga en Electron 31.** El aviso de
   > bypass de integridad ASAR afecta precisamente a las aplicaciones que ya
   > tienen los dos fuses activos. Hoy MIKA5 no los tiene, y por eso el aviso no
   > la alcanza; encenderlos sobre la 31 la metería justo en el supuesto
   > vulnerable. Primero se actualiza Electron y después se habilitan
   > `EnableEmbeddedAsarIntegrityValidation` y `OnlyLoadAppFromAsar`, juntos.

   Una versión anterior de este documento los listaba como trabajo
   independiente y por delante de la actualización. En ese orden habrían
   empeorado la situación en vez de mejorarla.

   La rama de seguridad debe llevar: `electron@43.2.0`,
   `electron-builder@26.15.3`, `@electron/fuses@2.1.3`, los dos fuses
   habilitados, **comprobación de los fuses sobre el binario empaquetado** —no
   sobre la configuración, que dice lo que se pidió y no lo que quedó—, y
   checkout limpio con `npm audit`, build y `test:all` en verde.

2. **Aislar el parseo de hojas de cálculo.** Segunda capa, aunque 0.20.3 cierre
   las vulnerabilidades conocidas. Un proceso hijo con Node completo, el
   entorno heredado y acceso normal al sistema de ficheros **no cuenta como
   aislamiento**.

`electron-builder 24 → 26` va dentro del punto 1: cierra los dieciséis avisos
de construcción y hace falta de todas formas para empaquetar Electron 43.

Ninguna se hizo aquí: son saltos mayores, y meterlos en la rama de
estabilización haría imposible saber qué rompió qué.

---

## Nada se silencia

Sin `overrides` sobre paquetes con aviso, sin `audit-level` ni `audit=false` en
`.npmrc`. `test/xlsx-vendored.test.js` lo verifica. Los dieciséis de
construcción siguen apareciendo en `npm audit` y deben seguir apareciendo.
