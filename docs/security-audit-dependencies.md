# Auditoría de dependencias

**Fecha:** 2026-08-05 · **Rama:** `chore/website-v0.3.0` · **Herramienta:** `npm audit`

`npm audit` contaba 20 vulnerabilidades. El número por sí solo no dice nada:
17 de ellas están en la cadena de `electron-builder`, que sólo corre en la
máquina que construye el instalador y nunca se empaqueta. Lo que importa es
qué llega al usuario.

## Resumen

| | Antes | Ahora |
|---|---|---|
| Total | 20 | 19 |
| Que llegan al usuario | 4 | **3** |

`xlsx-parse-json` estaba declarado en `dependencies` y **no lo usaba nadie**:
ni `src/`, ni `scripts/`, ni las pruebas. Se empaquetaba, arrastraba una
vulnerabilidad alta y no aportaba nada. Retirado.

---

## Lo que llega al usuario

### 1. `xlsx` (SheetJS) — alta — **sin arreglo en npm**

Prototype pollution y ReDoS. Es la más seria de las tres, y no por la
severidad sino por dónde está: `file:extractSpreadsheet` en `main.js` llama a
`XLSX.read()` sobre un fichero que elige el usuario. Un `.xlsx` preparado se
procesa en el **proceso principal**, que es el que tiene Node entero.

El paquete `xlsx` de npm está congelado en 0.18.5: SheetJS dejó de publicar en
npm y distribuye desde su propio CDN. Es decir, `npm audit fix` no puede
arreglarlo y nunca podrá.

Salidas posibles, ninguna gratis:

- Instalar `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. Corrige la
  vulnerabilidad y cambia el origen de instalación a un host que no es el
  registro de npm, con lo que eso implica para reproducibilidad y para la
  cadena de suministro.
- Mover el parseo a un proceso hijo sin permisos. Contiene el daño en vez de
  eliminarlo, y no depende de terceros.
- Retirar el soporte de hojas de cálculo. Elimina el riesgo y también la
  función.

**No se decide aquí.** Es una decisión de producto con coste en las tres
direcciones.

### 2. `electron` 31.7.7 — alta

*ASAR Integrity Bypass* e inyección de AppleScript en `app.moveToApplicationsFolder`
(sólo macOS). Es `devDependency`, pero **el binario de Electron es el runtime
que se empaqueta**: esto sí llega al usuario. El arreglo es Electron 43, cuatro
majors por encima. Es una migración con su propio plan de pruebas, no un
`npm audit fix`.

### 3. `uuid` 9 — moderada

Falta de comprobación de límites en v3/v5/v6 cuando se pasa `buf`. MIKA5 no
pasa `buf` y no usa v3/v5/v6. **No explotable aquí.** El arreglo es `uuid@14`,
un salto mayor que no aporta nada mientras el uso siga siendo v4 sin buffer.

---

## Lo que no llega al usuario

Dieciséis de las diecinueve están bajo `electron-builder@24.13.3` y sólo se
ejecutan al construir:

`tar` (crítica, path traversal) · `lodash` · `form-data` · `tmp` · `minimatch` ·
`brace-expansion` · `@xmldom/xmldom` · `@tootallnate/once` · `app-builder-lib` ·
`builder-util` · `builder-util-runtime` · `dmg-builder` · `electron-publish` ·
`electron-builder-squirrel-windows` · `electron-builder` · `js-yaml`

La crítica —`tar`, creación arbitraria de ficheros por enlaces duros— exige un
artefacto malicioso durante el empaquetado. Importa para la máquina de
construcción; no viaja en el instalador.

Todas se arreglan con `electron-builder@26`, que es un salto mayor y cambia el
formato de configuración. No se hace durante una estabilización.

---

## Qué se hizo y qué no

**Hecho:** retirar `xlsx-parse-json`, que no se usaba.

**No hecho, y por qué:** ningún salto mayor. Electron 31 → 43,
electron-builder 24 → 26 y uuid 9 → 14 son migraciones con su propio riesgo, y
meterlas en la misma rama que la estabilización de los gates haría imposible
saber qué rompió qué. Van en su propia rama, con su propia verificación.

**Lo que no se puede posponer indefinidamente:** `xlsx`. Es la única con
exposición real a entrada del usuario y la única sin arreglo disponible en el
registro.
