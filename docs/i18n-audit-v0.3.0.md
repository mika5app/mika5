# Auditoría i18n — MIKA5 Community v0.3.0

**Fecha:** 2026-08-04
**Rama:** `chore/website-v0.3.0`
**Páginas públicas:** `landing.html` (servida como `/`, `/index.html`, `/landing.html` y `/privacy`), `models.html`, `whitepaper.html`

## Veredicto

**I18N_ES_EN_COMPLETE: NO.** El sitio no está al 100 % en ambos idiomas y la
distancia es mucho mayor de lo que sugería el recuento de claves del parche
anterior.

Las 136 claves con paridad correcta cubren **la landing y sólo parcialmente**.
El cuerpo del Model Guide y del White Paper está escrito directamente en inglés
dentro del HTML: el mecanismo de idioma existe en las tres páginas, pero en dos
de ellas sólo traduce la cabecera y la navegación.

## 1. Medición del hueco

Nodos de texto visibles frente a nodos conectados al sistema i18n:

| Página | Nodos de texto | Con `data-i18n` | **Hardcodeados** | Caracteres sin traducir |
|---|---|---|---|---|
| `landing.html` | 219 | 142 | **77** | ~7 300 |
| `models.html` | 362 | 7 | **355** | ~24 000 |
| `whitepaper.html` | 312 | 7 | **305** | ~31 600 |
| **Total** | 893 | 156 | **737** | **~63 000** |

Traducido a trabajo real: unas **9 500 palabras** de prosa técnica que hoy sólo
existen en inglés, más la conversión de cada nodo a una clave i18n y su
diccionario.

## 2. Mecanismo de idioma actual

Idéntico en las tres páginas y **funcional**:

```js
let currentLang = localStorage.getItem('mika5-lang')
  || (navigator.language.startsWith('es') ? 'es' : 'en');
// applyLang(lang): recorre [data-i18n], sustituye textContent,
// actualiza el botón y document.documentElement.lang
```

| Comprobación | Estado |
|---|---|
| Selector visible en las tres páginas | **PASS** (`#lang-toggle`) |
| Persistencia entre páginas y sesiones | **PASS** (`localStorage['mika5-lang']`) |
| Idioma por defecto según navegador | **PASS**, con reserva a inglés |
| `<html lang>` cambia al alternar | **PASS** (`document.documentElement.lang = lang`) |
| Cambio sin recargar | **PASS** en los nodos con `data-i18n` |
| Traduce el cuerpo de models/whitepaper | **FAIL** — sólo 7 nodos por página |

El mecanismo no necesita rediseño: hay que **conectarle el contenido que hoy no
pasa por él**.

## 3. Metadata, accesibilidad y datos estructurados

| Elemento | landing | models | whitepaper | Estado |
|---|---|---|---|---|
| `<title>` | 1 | 1 | 1 | **HARDCODED** — inglés fijo, no cambia con el selector |
| `meta description` | 1 | 1 | 1 | **HARDCODED** |
| `og:title` / `og:description` | 2 | 2 | 2 | **HARDCODED** |
| `twitter:title` / `twitter:description` | 2 | 2 | 2 | **HARDCODED** |
| JSON-LD `SoftwareApplication` | 1 | 1 | 1 | **HARDCODED** (`description` en inglés) |
| `aria-label` | 2 | 0 | 0 | **HARDCODED**, sin mecanismo `data-i18n-aria` |
| `alt` de imágenes | 2 | 2 | 2 | **HARDCODED** |
| `placeholder` | 1 | 0 | 0 | **HARDCODED** (`you@example.com`, aceptable: es un ejemplo técnico) |

El `applyLang` actual sólo escribe `textContent`. No toca atributos, así que
ningún `alt`, `aria-label`, `title` ni etiqueta `<meta>` puede traducirse hoy
sin ampliar el mecanismo con `data-i18n-attr`.

## 4. Inventario por bloque

### 4.1 `landing.html` — 77 textos hardcodeados

| Bloque | Ejemplos | Estado |
|---|---|---|
| Mockup del hero | «Proyectos», «Investigación», «Analiza el documento…», «RAG: 3 fragmentos relevantes encontrados» | **HARDCODED** — hoy está fijo en español dentro de la simulación de UI |
| Píldoras del hero | `Offline-ready`, `No telemetry`, `SQLite local memory`, `Ollama compatible`, `Vision models`, `Built-in RAG engine`, `Cloud optional` | **HARDCODED** (inglés) |
| Listas de modelos | `llama3.2:3b`, `qwen2.5:7b`, … | **ALLOWLIST** — identificadores técnicos |
| Etiquetas de gama | «Popular & everyday — local via Ollama», «High-end — require 32–64 GB RAM / GPU 24 GB+» | **HARDCODED** |
| Comparativa cloud | «Subscription lock-in», «Token billing», «Data exposure» y sus descripciones | **HARDCODED** |
| Diagramas de flujo | «You → Browser → Vendor Cloud → …», «# No calls to MIKA5 servers…» | **HARDCODED** |
| Tarjetas de descarga | «Windows 10 / 11 · x64», «Apple Silicon · Intel x64», «x64 · AppImage · deb · rpm» | **HARDCODED** |
| Aviso macOS | «The app is not notarized. On first launch…» | **HARDCODED** |
| Bloque de verificación | «# Verify download integrity», comandos, «# Compare with the checksums…» | Comandos → **ALLOWLIST**; comentarios → **HARDCODED** |
| Quick Start | Pasos, requisitos de sistema, «AppImage tip», textos de las tres pestañas | **PASS parcial** — títulos con clave, cuerpos sin ella |
| Footer | «Product», «Community», «Legal», «Privacy», «License (AGPL-3.0)», «Trademark» | **HARDCODED** |

### 4.2 `models.html` — 355 textos hardcodeados

Todo el cuerpo salvo cabecera y navegación: título y subtítulo de la portada,
índice de contenidos, las cuatro gamas de hardware con sus descripciones, las
fichas de cada modelo (nombre, etiqueta local/cloud, párrafo descriptivo,
tamaño, velocidad, notas), la sección por caso de uso, la nueva tabla de guía
práctica (encabezados y las 15 filas con sus notas), los dos párrafos sobre
proveedores cloud y sobre lo no incluido en Community, la referencia de
instalación y la sección de embeddings.

### 4.3 `whitepaper.html` — 305 textos hardcodeados

El documento entero: abstract, las once secciones (`s1`–`s11`) con todos sus
párrafos, los diagramas ASCII de arquitectura, las tablas del esquema SQLite,
el roadmap y el pie. Es el bloque más denso: ~31 600 caracteres de prosa
técnica.

## 5. Estados agregados

| Estado | Recuento |
|---|---|
| **PASS** — clave en ES y EN, cambia correctamente | 136 |
| **HARDCODED** — texto visible fuera del sistema i18n | **737** |
| **MISSING** — clave presente en un solo idioma | 0 |
| **MISMATCH** — misma cadena en ES y EN sin ser término técnico | 0 |

No hay claves huérfanas ni traducciones vacías: el problema no es el
diccionario, es todo lo que nunca entró en él.

## 6. Allowlist propuesta

Textos que deben permanecer idénticos en ambos idiomas:

- **Marcas y nombres propios:** MIKA5, Ollama, llama.cpp, OpenAI, Anthropic, Groq, Moonshot, Alibaba Cloud Model Studio, GitHub, Electron, SQLite, Chromium, NVIDIA, Meta, Google, Microsoft, Mistral, DeepSeek, Qwen.
- **Identificadores de modelo:** `llama3.2:3b`, `qwen2.5:7b`, `qwen2.5vl:7b`, `llava:13b`, `llama3.2-vision:11b`, `deepseek-r1:7b/14b/70b`, `mistral:7b`, `mistral-small:latest`, `gemma3:12b`, `phi4:14b`, `llama3.3:70b`, `qwen2.5:72b`, `qwen2.5-coder:7b/14b`, `starcoder2:15b`, `deepseek-coder-v2:16b`, `nomic-embed-text`.
- **Comandos y rutas:** `ollama pull …`, `ollama serve`, `chmod +x`, `dpkg -i`, `rpm -i`, `sha256sum`, `shasum -a 256`, `Get-FileHash`, `127.0.0.1:11434`, `%AppData%\Roaming\mika5-desktop\mika5.db`.
- **Nombres de archivo y assets:** `MIKA5-Setup-0.3.0-win-x64.exe` y los otros ocho artefactos, `SHA256SUMS.txt`, `LICENSE`, `BUILDING.md`, `COMMUNITY.md`, `BUILD-METADATA.json`.
- **Siglas técnicas:** RAG, SQLite, WAL, IPC, AES-256-GCM, AGPL-3.0, API, GPU, VRAM, RAM, PDF, HTML, WebP, OCR, SEO.
- **Términos deliberadamente iguales:** «Quick Chat» (nombre de función en la propia app, idéntico en la UI española), «AppImage», «DMG», «NSIS», «deb», «rpm».

La allowlist es explícita: no hay comodines que puedan tapar un error.

## 7. Trabajo necesario para llegar a 100 %

| Fase | Contenido | Volumen |
|---|---|---|
| **I** | Ampliar `applyLang` para traducir atributos (`data-i18n-attr` para `alt`, `aria-label`, `title`, `placeholder`) y metadata (`<title>`, `description`, `og:*`, `twitter:*`, JSON-LD) | ~30 líneas de JS por página, sin tocar CSS |
| **II** | Completar la landing: 77 textos a clave + traducción | 77 claves × 2 |
| **III** | Model Guide completo | ~355 claves × 2, ~24 000 caracteres |
| **IV** | White Paper completo | ~305 claves × 2, ~31 600 caracteres |
| **V** | Los tres bloques autorizados (novedades v0.3.0, source/SHA256SUMS/SmartScreen, etiquetas del roadmap) directamente bilingües | ~40 claves × 2 |
| **VI** | Validador automático + pruebas de conmutación y de viewport | suite nueva |

Total estimado: **~1 550 entradas de diccionario** y unas 9 500 palabras de
traducción técnica.

## 8. Limitación SEO conocida

El sitio usa **una sola URL por página** con conmutación en cliente. En
consecuencia:

- los buscadores indexan la versión servida por defecto (inglés, salvo que el
  navegador pida español);
- `hreflang` no es aplicable sin URLs distintas (`/es/`, `/en/`);
- `canonical` apunta a la URL única y es correcto tal cual.

No he inventado rutas `/es/` ni `/en/`: cambiar la arquitectura de URLs es una
decisión que excede este parche y requiere tocar nginx y el sitemap. Queda
documentado como limitación, no como defecto a corregir aquí.

## 9. Bloques pendientes autorizados

Los tres elementos aprobados (novedades de v0.3.0, enlaces de source /
SHA256SUMS / avisos SmartScreen, y etiquetas del roadmap) **no se han añadido
todavía**: hacerlo antes de que exista el andamiaje bilingüe significaría
introducir 40 textos nuevos en inglés y agrandar el problema. Se añadirán ya
bilingües en la Fase V.

## 10. Estado de las capturas

Sin cambios respecto a `site-validation-v0.3.0.md`: ninguna imagen sustituida,
el mockup del hero sigue siendo HTML/CSS y faltan tres capturas de Roxana
(`settings-providers`, `visual-routing`, `cloud-consent`).

Nota adicional detectada en esta auditoría: el mockup del hero está **fijo en
español** aunque el resto de la landing conmute a inglés. Es un caso de
Spanglish visible con el selector en EN, y se resuelve al conectarlo al sistema
i18n en la Fase II.

---

# Apéndice B — Fase I y Fase II completadas (2026-08-04)

## B.1 Mecanismo ampliado (Fase I)

`applyLang` en `landing.html` pasa de traducir sólo `textContent` a cubrir:

| Capacidad | Implementación |
|---|---|
| Texto | `[data-i18n]` → `textContent` |
| HTML controlado | `[data-i18n-html]` → `innerHTML`, sólo con cadenas del propio diccionario |
| Atributos | `data-i18n-attr="alt:clave;aria-label:otra"` con **allowlist cerrada**: `alt`, `aria-label`, `aria-description`, `title`, `placeholder`. Cualquier otro nombre se ignora, así el contenido nunca puede inyectar atributos arbitrarios |
| Metadata | `document.title`, `meta[name=description]`, `og:title`, `og:description`, `twitter:title`, `twitter:description` |
| Datos estructurados | JSON-LD: se reescriben `description` e `inLanguage` conservando el resto del objeto |
| Idioma del documento | `document.documentElement.lang` |

Se conserva intacto lo que ya funcionaba: `localStorage['mika5-lang']`,
detección por `navigator.language`, conmutación sin recarga y el mismo selector.
Sin dependencias nuevas, sin framework, sin tocar CSS.

## B.2 Landing completa (Fase II)

| Métrica | Antes | Ahora |
|---|---|---|
| Claves por idioma | 136 | **177** |
| Nodos user-facing hardcodeados | 77 | **0** |
| `aria-label` traducidos | 0 | 3 |
| Metadata traducida | 0 | 6 campos + JSON-LD |
| Mockup del hero | fijo en español | 13 claves, conmuta entero |

Claves nuevas organizadas por sección: `landing.meta.*` (6), `landing.nav.*` (2),
`landing.mockup.*` (13), `landing.flow.*` (8), `landing.verify.*` (3),
`landing.qs.*` (9).

## B.3 Prueba funcional ES → EN → ES

Ejecutada en Electron real contra la landing:

| Comprobación | Resultado |
|---|---|
| `<html lang>` sigue al idioma | es → en → es |
| Mockup del hero conmuta entero | «MIKA5 — Proyecto: Investigación / Proyectos / Investigación» ↔ «MIKA5 — Project: Research / Projects / Research» |
| Volver a español restaura el texto | idéntico al estado inicial |
| Longitud del texto tras el ciclo | 6787 = 6787 caracteres |
| Sin marcas del idioma contrario | verificado en ambos sentidos |
| `title`, `description`, `og:title`, `twitter:title`, JSON-LD | los cinco cambian |
| `aria-label` | «Abrir menú de navegación / Cerrar menú» ↔ «Open navigation menu / Close menu» |

## B.4 Viewports: overflow preexistente, no regresión

Medido con el mismo instrumento sobre la landing **anterior al parche** (HEAD) y
sobre la actual:

| Combinación | HEAD | Con el parche |
|---|---|---|
| es 320 px | 97 px | 97 px |
| es 375 px | 42 px | 42 px |
| es 768 px | 134 px | **105 px** |
| es 1024 px | sin overflow | sin overflow |
| es 1440 px | sin overflow | sin overflow |
| en 320 px | 83 px | 83 px |
| en 375 px | 28 px | 28 px |
| en 768 px | 54 px | **25 px** |
| en 1024 px | sin overflow | sin overflow |
| en 1440 px | sin overflow | sin overflow |

**El desbordamiento horizontal en 320, 375 y 768 px es un defecto previo del
sitio**, presente en ambos idiomas antes de tocar nada. La traducción no lo
introduce ni lo agrava: en 768 px incluso lo reduce, porque los textos nuevos
son más cortos. Siguiendo la instrucción de no modificar CSS salvo defecto
demostrado por la traducción, **no se ha tocado ningún estilo**. Queda
registrado como tarea aparte:

**`WEBSITE_MOBILE_OVERFLOW_PREEXISTING`** — corregir el desbordamiento
horizontal en anchos móviles y tablet. Requiere tocar CSS y por tanto
autorización explícita.

## B.5 Limitación SEO

Confirmada y sin cambios: una sola URL por página con conmutación en cliente.
Los buscadores indexan la versión servida por defecto; `hreflang` no aplica sin
rutas distintas. No se han inventado `/es/` ni `/en/` ni se ha añadido
`hreflang` falso. El `canonical` actual es correcto.

Registrada como tarea futura separada:

**`BILINGUAL_SEO_URL_ARCHITECTURE`** — evaluar rutas `/es/` y `/en/` con
`hreflang` recíproco, sitemap por idioma y configuración de nginx. Fuera del
alcance de la traducción funcional.

## B.6 Validador automático

`test/website-i18n.test.js` — 40 comprobaciones. Falla si:

- queda texto visible fuera del sistema i18n (allowlist explícita, sin comodines);
- una clave existe en un solo idioma o su traducción está vacía;
- una clave del markup no existe en ambos diccionarios;
- un texto no técnico es idéntico en ES y EN sin estar en la allowlist de claves justificada;
- la allowlist contiene excepciones sobrantes (claves que sí están traducidas);
- falta metadata bilingüe o el conmutador deja de actualizarla;
- un `aria-label` no pasa por i18n o no está traducido;
- el conmutador deja de actualizar `<html lang>`;
- el mockup del hero vuelve a tener texto sin clave.

Informa además del recuento pendiente de `models.html` (295 nodos) y
`whitepaper.html` (291 nodos), sin darlos por hechos.

---

# Apéndice C — Fase III completada: Model Guide bilingüe (2026-08-04)

## C.1 Alcance

`web/models.html` completo. No se ha tocado `landing.html` (Fase II, cerrada) ni
`whitepaper.html` (Fase IV, pendiente). No se han añadido los bloques de la
Fase V, ni capturas, ni dependencias, ni framework, ni rediseño.

## C.2 Cobertura conseguida

| Métrica | Antes | Ahora |
|---|---|---|
| Nodos user-facing hardcodeados | **295** | **0** |
| Claves por idioma | 7 | **259** |
| Atributos `data-i18n` en el markup | 9 | **396** |
| `data-i18n-html` | 0 | 1 (nota del hero, con `<code>`) |
| `data-i18n-attr` | 0 | 4 (`alt` ×2, `aria-label` ×1, más el par del footer) |
| Metadata traducida | 0 | 6 campos + JSON-LD completo |
| `aria-label` traducidos | 0 | 1 (conmutador de idioma) |
| `alt` traducidos | 0 | 2 (logotipo de cabecera y de pie) |

Las 259 claves son menos que las ~355 estimadas en §7 porque las cadenas
repetidas —«Local», los roles, los requisitos de hardware, los tamaños que
comparten ficha y tabla— se resuelven con una sola clave reutilizada en varios
nodos. La cobertura es la misma; el diccionario no está inflado.

## C.3 Espacios de nombres

`models.meta.*` (15) · `models.nav.*` (5) · `models.hero.*` (5) ·
`models.toc.*` (17) · `models.local.*` (1) · `models.hardware.*` (13) ·
`models.tag.*` (11) · `models.cards.*` (15) · `models.size.*` (26) ·
`models.params.*` (20) · `models.ws.*` (5) · `models.useCases.*` (35) ·
`models.cloud.*` (8) · `models.table.*` (11) · `models.role.*` (5) ·
`models.hw.*` (8) · `models.status.*` (8) · `models.notes.*` (28) ·
`models.install.*` (13) · `models.embeddings.*` (5) · `models.footer.*` (5).

Ninguna clave numérica sin significado. Cero claves huérfanas y cero claves
declaradas sin uso: verificado por la propia suite.

## C.4 Mecanismo

Mismo contrato validado en la landing, sin duplicar diseño ni tocar CSS:
`data-i18n` → `textContent`; `data-i18n-html` → `innerHTML` sólo con cadenas
del diccionario; `data-i18n-attr` con la misma allowlist cerrada (`alt`,
`aria-label`, `aria-description`, `title`, `placeholder`); `document.title`,
`meta description`, Open Graph, Twitter; `document.documentElement.lang`.

Única diferencia justificada: el JSON-LD de esta página es un `@graph`, no un
objeto plano. `aplicarMetadata` lo recorre nodo a nodo y reescribe sólo texto
—`headline`, `description` e `inLanguage` del `Article`, los nombres del
`BreadcrumbList` y las tres preguntas y respuestas del `FAQPage`— conservando
`@type`, URLs e identificadores.

No se ha extraído un helper común: hacerlo obligaba a tocar `landing.html`, que
está cerrada y validada.

## C.5 Prueba funcional ES → EN → ES

Ejecutada en Electron real contra `web/models.html`:

| Comprobación | Resultado |
|---|---|
| `<html lang>` | es → en → es |
| `document.title` | «Guía de modelos de MIKA5 — Modelos locales, hardware y casos de uso» ↔ «MIKA5 Model Guide — Local models, hardware and use cases» |
| `meta description` | cambia en ambos sentidos |
| `og:title` / `twitter:title` | cambian en ambos sentidos |
| JSON-LD | `inLanguage` es ↔ en y `headline` traducido |
| `alt` del logotipo | «Logotipo de MIKA5» ↔ «MIKA5 logo» |
| `aria-label` del conmutador | «Cambiar el idioma a inglés» ↔ «Switch language to Spanish» |
| Longitud del texto | 24 133 → 22 442 → 24 133 caracteres |
| ES restaurado idéntico | **sí**, carácter a carácter |
| Residuos del idioma contrario | ninguno en ninguno de los dos sentidos |

## C.6 Viewports: 10 combinaciones, cero desbordes

Medido con el mismo instrumento sobre la versión publicada (HEAD) y sobre la
actual. Criterio: `document.scrollWidth === document.clientWidth`.

| Combinación | HEAD | Fase III |
|---|---|---|
| es / en 320 px | sin desborde | **sin desborde** |
| es / en 375 px | sin desborde | **sin desborde** |
| es / en 768 px | sin desborde | **sin desborde** |
| es / en 1024 px | sin desborde | **sin desborde** |
| es / en 1440 px | sin desborde | **sin desborde** |

`body` y `html` conservan `overflow-x: visible`: no se ha ocultado nada.

Defecto encontrado y corregido: en HEAD la tabla de workstation vivía en un
contenedor `overflow-hidden`, así que a 320 y 375 px sus columnas quedaban
**recortadas e inalcanzables** —el instrumento las detectó desbordando su caja
sin scroll posible—. Ahora usa `overflow-x-auto`, igual que la tabla práctica.
Es el único cambio de clase CSS del parche y responde al requisito explícito de
«tablas utilizables mediante scroll interno». Verificado: las dos tablas tienen
scroll interno real a 320 y 375 px, ninguna recorta y ninguna empuja el `body`.

## C.7 Suite ampliada

`test/website-i18n.test.js` pasa de 40 a **115 comprobaciones** y ahora audita
landing y models con las mismas reglas, mediante una función común. Novedades:

- las comprobaciones de página se aplican a las dos, no sólo a la landing;
- allowlist de claves idénticas **por página**, cada entrada con su motivo
  (11 en `models.html`: nombres de gama, marcas, «Local», «Chat», «Cloud»,
  «Hardware», cifras en MB y el nombre del White Paper);
- el contenido de un elemento `data-i18n-html` se vacía antes de escanear,
  porque lo define el diccionario; la clave sigue pasando por todo lo demás;
- patrón cerrado para etiquetas de modelo (exige dígito o `:`) y para nombres
  de cuantización GGUF, en lugar de listarlas una a una;
- todo `alt` de imagen o pasa por i18n o su texto es marca/técnico;
- catálogo: fallan `glm-5`, `kimi-k2`, `nemotron`, `glm-ocr`, `qwen3.5`,
  `qwen3:`, `:cloud`, `qwen2.5-vl:`, `gemma3:9b`, `phi4:3b` si reaparecen;
- contenido: fallan `GPT-4`, `outperform`, `MMLU`, `HumanEval`, `MT-Bench`,
  `GSM8K`, `TextVQA`, `MMBench`, `o1-level`, `state of the art`,
  `see model card` y `tok/s` si reaparecen;
- exige que el descargo «sin benchmarks» exista en los dos idiomas;
- exige que la sección cloud no mezcle comandos de modelos locales;
- exige los cuatro estados del catálogo declarados y traducidos.

La suite se ha enganchado a `npm test` (`test:website-i18n`): antes existía
pero no la ejecutaba ningún gate.

## C.8 Pendiente

`whitepaper.html` sigue con **290 nodos** sin traducir y la suite lo declara
como tal. La Fase V (novedades de v0.3.0, source/SHA256SUMS/SmartScreen,
etiquetas del roadmap) sigue sin empezar, igual que las capturas.

---

# Apéndice D — Fase IV completada: White Paper bilingüe (2026-08-04)

## D.1 Alcance

`web/whitepaper.html` completo, con auditoría factual previa contra el tag
`f87e2ce`. No se ha tocado `landing.html` (Fase II) ni `models.html`
(Fase III), ambas cerradas y en verde. No se han añadido los bloques de la
Fase V, ni capturas, ni dependencias. `package-lock.json` intacto.

## D.2 Cobertura conseguida

| Métrica | Antes | Ahora |
|---|---|---|
| Nodos user-facing hardcodeados | **290** | **0** |
| Claves por idioma | 7 | **166** |
| Atributos `data-i18n` | 7 | **83** |
| `data-i18n-html` | 0 | **73** |
| `data-i18n-attr` | 0 | 4 (`alt` ×2, `aria-label` ×1) |
| Metadata traducida | 0 | 6 campos + JSON-LD (`TechArticle` y `BreadcrumbList`) |
| Secciones | 11 | **12** |

La proporción de `data-i18n-html` es alta porque el cuerpo es prosa técnica con
`<strong>`, `<em>`, `<code>` y enlaces dentro de cada párrafo. Partir cada
párrafo en fragmentos sueltos habría multiplicado las claves y roto la frase en
español, cuyo orden no coincide con el inglés. Cada valor sale del propio
diccionario: no hay HTML de terceros en ninguna de las 73 claves.

## D.3 Espacios de nombres

`whitepaper.meta.*` (9) · `nav.*` (5) · `hero.*` (7) · `abstract.*` (3) ·
`toc.*` (13) · `problem.*` (7) · `foundation.*` (7) · `architecture.*` (10) ·
`privacy.*` (9) · `rag.*` (11) · `providers.*` (9) · `storage.*` (11) ·
`security.*` (11) · `llamacpp.*` (6) · `licensing.*` (7) · `roadmap.*` (16) ·
`editions.*` (8) · `conclusion.*` (7) · `refs.*` (2) · `footer.*` (5).

Cero claves huérfanas, cero declaradas sin uso, cero traducciones vacías.

## D.4 Mecanismo

El mismo contrato de la landing y del Model Guide, sin tocar el de esas
páginas. El JSON-LD de esta página es un `@graph` con `TechArticle` y
`BreadcrumbList`; `aplicarMetadata` los recorre y reescribe `headline`,
`description`, `inLanguage` y los nombres de la miga de pan, conservando
`@type`, URLs e identificadores.

## D.5 Prueba funcional ES → EN → ES

Ejecutada en Electron real:

| Comprobación | Resultado |
|---|---|
| `<html lang>` | es → en → es |
| `document.title` | «White Paper de MIKA5 — Arquitectura de IA local-first, v0.3.0» ↔ «MIKA5 White Paper — Local-first AI architecture, v0.3.0» |
| `meta description`, `og:*`, `twitter:*` | cambian en ambos sentidos |
| JSON-LD | `inLanguage` y `headline` traducidos |
| `alt` del logotipo | «Logotipo de MIKA5» ↔ «MIKA5 logo» |
| `aria-label` del conmutador | «Cambiar el idioma a inglés» ↔ «Switch language to Spanish» |
| Longitud del texto | 37 610 → 34 378 → 37 610 caracteres |
| ES restaurado idéntico | **sí**, carácter a carácter |
| Residuos del idioma contrario | ninguno |

## D.6 Viewports: 10 combinaciones

| Combinación | HEAD | Fase IV |
|---|---|---|
| es 320 px | **desborde 14 px** | **sin desborde** |
| en 320 px | **desborde 14 px** | **sin desborde** |
| es / en 375 px | sin desborde | sin desborde |
| es / en 768 px | sin desborde | sin desborde |
| es / en 1024 px | sin desborde | sin desborde |
| es / en 1440 px | sin desborde | sin desborde |

`body` y `html` conservan `overflow-x: visible`.

**Defecto preexistente diagnosticado.** El selector exacto era un `<code>` sin
clase dentro de un `<p>` de la sección de modelo de datos, con el texto
`%AppData%\Roaming\MIKA5\mika5.db`: 295 px de ancho en un viewport de 314 px,
sin punto de corte de línea, que empujaba `scrollWidth` a 328. Desaparece sin
tocar CSS porque la ruta publicada era además **incorrecta**: el directorio
real es `mika5-desktop`, y `%AppData%\Roaming\mika5-desktop\mika5.db` sí ofrece
un punto de corte en el guion. Corregir el dato corrigió la maqueta.

**Único cambio de CSS del parche.** Se añade `overflow-x: auto` a la regla
`.terminal`. Medido con y sin la regla:

| Bloque a 320 px | Ancho de caja | Ancho de contenido | Sin la regla | Con la regla |
|---|---|---|---|---|
| Diagrama de arquitectura | 214 px | 161 px | cabe | cabe, sin cambio |
| Flujo del RAG | 214 px | 168 px | cabe | cabe, sin cambio |
| Comandos de llama.cpp | 254 px | **265 px** | el texto se derrama fuera del bloque | scroll interno dentro del bloque |

La regla **no** es necesaria para el desbordamiento de página, que es cero en
las diez combinaciones con o sin ella. Es necesaria para que el bloque de
comandos de llama.cpp se lea dentro de su caja en lugar de derramarse sobre lo
que tiene al lado. No altera nada donde el contenido ya cabe. Si se prefiere
tratarlo como cambio visual aparte, revertirlo es una línea.

## D.7 Suite ampliada

`test/website-i18n.test.js` pasa de 115 a **218 comprobaciones** y audita las
tres páginas con la misma función. Novedades de esta fase:

- vaciado de `data-i18n-html` **con conteo de profundidad**, para que un bloque
  con elementos anidados del mismo tipo se cierre donde corresponde;
- allowlist de claves idénticas para `whitepaper.html`: 8 entradas, todas
  nombres propios, nombres de edición, marca o cadena de versión;
- afirmaciones prohibidas: `PII sanit`, `[EMAIL]`, `[PHONE]`, `cero peticiones
  de red`, `Renderer — sandboxed`, `never leaves your machine`, `nunca salen de
  tu equipo`, redacción automática activa;
- comprobación **sensible al contexto** para «zero outbound/network», «renderer
  en sandbox» y «detección por nombre»: la página puede decir que versiones
  anteriores lo afirmaban, pero no puede afirmarlo ella. Una prohibición literal
  habría impedido escribir la corrección;
- exige `sandbox: false` y `sandbox: true` escritos, más `contextIsolation`,
  `nodeIntegration` y la CSP;
- exige las correcciones presentes en los dos idiomas;
- exige etiqueta de estado en cada punto de la hoja de ruta: `Not included in
  Community` / `No incluido en Community` para sync, móvil, agentes, equipos y
  vLLM; `Planned` / `Planificado` para los seis planificados; `Experimental`
  para los dos experimentales;
- exige que Pro y Cloud se declaren inexistentes en v0.3.0;
- prohíbe `0.1.0` y `0.2.0` en toda la página;
- comprueba que los enlaces internos existen en `web/` y que los archivos
  citados (`LICENSE`, `BUILDING.md`, `COMMUNITY.md`, `SECURITY.md`,
  `TRADEMARK.md`) existen en el repositorio;
- exige 15 assets y 14 entradas de checksum declarados en ambos idiomas, con la
  explicación de por qué el archivo no se incluye a sí mismo;
- mantiene la prohibición de benchmarks y comparaciones también aquí.

## D.8 Estado del sitio

| Página | Nodos hardcodeados | Claves por idioma |
|---|---|---|
| `landing.html` | 0 | 177 |
| `models.html` | 0 | 259 |
| `whitepaper.html` | 0 | 166 |

**I18N_ES_EN_COMPLETE: YES** para las tres páginas públicas. Queda pendiente la
Fase V (novedades de v0.3.0, enlaces de source y checksums, avisos de
SmartScreen y macOS, etiquetas del roadmap en la landing) y las capturas reales,
que siguen bloqueando el despliegue por `WEBSITE_REAL_SCREENSHOTS_REQUIRED`.

---

# Apéndice E — Fase V: cierre de contenido web (2026-08-04)

## E.1 Inventario de páginas públicas

| Documento | Sirve las URLs | Estado i18n |
|---|---|---|
| `web/landing.html` | `https://mika5.xyz/` **y** `https://mika5.xyz/landing.html` | 0 hardcodeados · 212 claves/idioma |
| `web/models.html` | `https://mika5.xyz/models.html` | 0 hardcodeados · 259 claves/idioma |
| `web/whitepaper.html` | `https://mika5.xyz/whitepaper.html` | 0 hardcodeados · 174 claves/idioma |

**La cuarta URL del sitemap es la raíz `https://mika5.xyz/`, y no es una página
distinta.** El workflow `deploy-landing.yml:34` ejecuta
`cp /var/www/html/landing.html /var/www/html/index.html`: la raíz y
`/landing.html` sirven el mismo documento. No existe `privacy.html` ni ninguna
otra página HTML en `web/`; el directorio contiene exactamente tres.

Consecuencia: **las cuatro URLs del sitemap están cubiertas al 100 % en ES y
EN**, porque se resuelven sobre tres documentos y los tres están cerrados.

Queda registrada una observación de SEO, no corregida en esta fase porque
cambiar la arquitectura de URLs excede el parche de contenido:

**`SITEMAP_DUPLICATE_ROOT_URL`** — el sitemap declara `/` y `/landing.html`
para el mismo documento. Conviene dejar una sola de las dos y que el
`canonical` apunte a ella.

## E.2 Defectos encontrados y corregidos en la landing

| # | Defecto | Corrección |
|---|---|---|
| L-39 | El enlace **Privacidad** del pie apuntaba a `href="#"`: no llevaba a ninguna parte | La sección de privacidad, que ya existía y ya era bilingüe, no tenía `id`. Se le añade `id="privacy"` y el enlace pasa a `href="#privacy"` |
| L-40 | La etiqueta de gama declaraba «High-end — require 32–64 GB RAM / GPU 24 GB+» para una lista que incluye `qwen2.5-coder:14b` y `deepseek-r1:14b`, de 9 GB y 12 GB de VRAM | Reescrita: «desde 12 GB de VRAM; los modelos de 70B necesitan 48 GB de VRAM o 64 GB de RAM». Es el mismo tipo de requisito falso de hardware que se eliminó del Model Guide |

Verificación de los identificadores citados en la landing: los 16 responden 200
en `registry.ollama.ai`. `mistral-small:latest` es válido pero **no está
documentado en el Model Guide**; queda registrado como
**`LANDING_MODEL_NOT_IN_GUIDE`** para decidir si se documenta o se sustituye.

Control del método de verificación: tags inventados (`zzzz:1b`,
`modelo-que-no-existe:99b`) devuelven 404, y `qwen3.5:72b` y `glm-5:cloud`
siguen devolviendo 404, lo que confirma que las retiradas de la Fase III eran
correctas.

## E.3 Contenido añadido

**Novedades de v0.3.0** (`#whatsnew` en la landing). Doce entradas, con el
mismo patrón de lista que ya usaba la sección «The cloud isn't neutral»: marca
verde, título y descripción. Sin componentes ni colores nuevos. Cubre barra
superior, aviso cloud y consentimiento, contexto activo, acciones de chat,
compositor, estados vacíos, iconos y colores de proyecto, bloques de código,
menú nativo, desplazamiento lateral, contraste y accesibilidad, y aislamiento
de `userData` en pruebas. Este último se redacta de forma expresa como «un
detalle de ingeniería más que una función», y la suite lo comprueba.

**Descargas y verificación.** Notas por plataforma dentro de cada tarjeta
existente, sin cuadrícula nueva:

- Windows: sin firma Authenticode, aviso posible de SmartScreen, y la
  indicación de comprobar que el nombre lleva 0.3.0 y su SHA-256;
- macOS: sin notarizar y **no distribuido por la App Store**, autorización
  manual en el primer arranque;
- Linux: sólo x86-64, sin compilación ARM, y qué es cada formato.

Enlaces secundarios añadidos dentro del contenedor de verificación ya
existente: `MIKA5-0.3.0-source.tar.gz`, `SHA256SUMS.txt`, `BUILDING.md`,
`COMMUNITY.md` y `BUILD-METADATA.json`.

**Etiquetas del roadmap** (White Paper, sección 11). Se añade el grupo
`Implemented in v0.3.0 / Implementado en v0.3.0` con siete capacidades
entregadas, junto a los grupos ya existentes de planificado, experimental y no
incluido. Sin badges ni componentes nuevos: el mismo `span.status-tag` de la
Fase IV.

## E.4 Inventario final de assets

| Concepto | Cantidad | Detalle |
|---|---|---|
| Publicados en la release | **15** | verificados uno a uno con HTTP 200 |
| Entradas en `SHA256SUMS.txt` | **14** | descargado y contado; no se incluye a sí mismo |
| Enlazados desde la web | **13** | 9 instaladores menos los 2 ZIP, más source, SHA256SUMS, LICENSE, BUILDING.md, COMMUNITY.md, BUILD-METADATA.json |
| Publicados y no enlazados | **2** | `MIKA5-0.3.0-mac-arm64.zip` y `MIKA5-0.3.0-mac-x64.zip`, deliberado: el `.dmg` cubre las mismas arquitecturas |

Los 15 assets devolvieron **200** el 2026-08-04. Cero enlaces a v0.1.0 o
v0.2.0 en las tres páginas, comprobado por la suite.

## E.5 Capturas: bloqueadas, con dos motivos verificados

Se construyó un arnés que arranca **la aplicación real** desde el código del
tag con un perfil `userData` temporal, sin tocar ninguna instalación. La
aplicación arranca y renderiza correctamente (445 nodos, barra lateral y
conversación presentes). Aun así, las capturas **no pueden producirse aquí**:

1. **`capturePage()` devuelve una imagen de 0×0 y 0 bytes** en este entorno.
   La ventana se crea pero no llega a componerse: la app desactiva la
   aceleración por hardware en Windows y la sesión no tiene escritorio visible.
2. **El desplegable de modelos muestra el inventario real de Ollama de esta
   máquina**: `kimi-k3:cloud`, `deepseek-v4-pro:cloud`, `qwen3-coder:480b-cloud`,
   `kimi-k2.7-code:cloud`, `glm-5.2:cloud`, `qwen3.5:9b`, `qwen3.5:4b`,
   `qwen2.5-coder:7b`. Son datos reales del equipo, que el encargo prohíbe en
   las capturas, y además son modelos que la web **no documenta**; varios usan
   el sufijo `:cloud` que el sitio describe como no soportado. Publicar esa
   imagen reintroduciría por la puerta de atrás lo que la Fase III eliminó.

El origen del segundo problema es que `src/main/ollama.js:5` fija
`const BASE = "http://127.0.0.1:11434"` sin variable de entorno ni ajuste, así
que no se puede apuntar la aplicación a un catálogo sintético sin modificar
código de la app, que está fuera del alcance de un parche de contenido web.

Por eso el mockup HTML/CSS del hero **permanece**, tal y como autoriza el
encargo, hasta que exista la captura real que lo sustituya. Sigue vigente el
bloqueo **`WEBSITE_REAL_SCREENSHOTS_REQUIRED`**.

## E.6 Viewports

30 combinaciones: 3 páginas × 5 anchos × 2 idiomas. **Cero desbordamiento
global** en las 30 (`document.scrollWidth === document.clientWidth`).
`body` y `html` conservan `overflow-x: visible` en las tres páginas.

Observación medida, no defecto de página: a 320 y 375 px hay 17 elementos que
salen de su caja dentro del **mockup del hero**, contenidos por
`div.glass-card` con `overflow-x: hidden`. En español llegan a 454 px y en
inglés a 405, porque el texto español es más largo. No empujan la página. Ese
mockup es justamente el elemento que la captura real debe sustituir.

## E.7 Suite

`test/website-i18n.test.js` pasa de 218 a **295 comprobaciones**. Añadido en
esta fase:

- inventario: todo `.html` de `web/` tiene que estar auditado por la suite;
- toda URL del sitemap debe tener un documento que la sirva, con la raíz
  reconocida como la landing copiada a `index.html`;
- cero anclas internas rotas en las tres páginas, lo que es exactamente lo que
  detectó el `href="#"` del pie;
- las 24 claves de novedades presentes y traducidas;
- el aislamiento de pruebas descrito como ingeniería y no como función;
- los tres avisos por plataforma, con Authenticode, SmartScreen, App Store,
  notarización y arquitectura comprobados por contenido;
- los 13 assets enlazados, y los 2 ZIP de macOS comprobados como **no**
  enlazados;
- 15 assets y 14 checksums declarados en ambos idiomas;
- cero enlaces a releases anteriores en las tres páginas;
- las 7 etiquetas `Implemented in v0.3.0` en ambos idiomas;
- todo punto del roadmap con exactamente una etiqueta de estado (19 puntos).

---

# Apéndice F — Cierre de las dos inconsistencias de Fase V (2026-08-04)

## F.1 `SITEMAP_DUPLICATE_ROOT_URL` — CERRADO

`web/landing.html` se publicaba bajo dos URLs porque el despliegue lo copia a
`index.html`. El sitemap declaraba las dos, así que el mismo documento entraba
dos veces en el índice.

| Elemento | Antes | Ahora |
|---|---|---|
| URLs del sitemap | 4 | **3**, una por documento |
| `https://mika5.xyz/landing.html` | declarada | **eliminada** |
| `https://mika5.xyz/` | declarada, prioridad 1.0 | conservada, sin cambios |
| `canonical` de la landing | `https://mika5.xyz/` | correcto, sin cambios |
| `og:url` | `https://mika5.xyz/` | correcto, sin cambios |
| JSON-LD, campos `url` | `https://mika5.xyz` (sin barra) ×3 | `https://mika5.xyz/` ×3, idéntico al canonical |
| `hreflang` | ausente | ausente; no se ha inventado ninguno |

Los tres campos `url` del JSON-LD —`Organization`, `WebSite` y
`SoftwareApplication`— apuntaban a `https://mika5.xyz` sin barra final. No era
un error funcional, pero difería como cadena del `canonical`. Normalizados.

Los enlaces internos de `models.html` y `whitepaper.html` siguen apuntando a
`landing.html` en relativo, a propósito: funcionan igual servidos que abiertos
en local, y la redirección futura los resolverá con un salto.

**Tarea de despliegue registrada, fuera de este parche:**

**`LANDING_HTML_301_REDIRECT`** — configurar en Nginx la redirección
permanente `/landing.html → /`. No se ha tocado la configuración del servidor.
Su ausencia no bloquea este parche: el sitemap ya no anuncia la URL duplicada y
el `canonical` señala la raíz, que es lo que determina qué indexan los
buscadores.

**`SITEMAP_DUPLICATE_ROOT_URL: CLOSED`**
**`CANONICAL_ROOT_URL: https://mika5.xyz/`**

## F.2 `LANDING_MODEL_NOT_IN_GUIDE` — CERRADO

| Identificador retirado | `mistral-small:latest` |
|---|---|
| Dónde estaba | Lista «gama alta» de la landing, una píldora entre seis |
| ¿Era válido? | **Sí.** Responde 200 en `registry.ollama.ai`; no es un identificador inventado |
| Razón de la retirada | **Consistencia entre páginas.** El Model Guide es el catálogo editorial publicado y no lo documenta. Un modelo promocionado en la portada sin ficha ni clasificación deja al lector sin tamaño, sin requisitos de hardware y sin estado |
| Alternativa descartada | Documentarlo en el Model Guide: obligaba a reabrir una página cerrada y a repetir la verificación completa de ficha por un modelo que no cubre ninguna categoría vacía |
| Sustitución | **Ninguna.** No se ha puesto otro modelo en su lugar: la lista mantiene el mismo `flex flex-wrap`, ahora con cinco píldoras |
| Layout | Sin cambios. Ni clases, ni colores, ni estructura |
| Paridad ES/EN | Intacta: la píldora no llevaba clave de traducción, es un identificador técnico |

Comprobación posterior: los **15** identificadores que quedan en la landing
están documentados en `models.html`.

`deepseek-r1:7b` · `deepseek-r1:14b` · `deepseek-r1:70b` · `gemma3:12b` ·
`llama3.2:3b` · `llama3.2-vision:11b` · `llama3.3:70b` · `llava:13b` ·
`mistral:7b` · `nomic-embed-text` · `phi4:14b` · `qwen2.5:7b` · `qwen2.5:72b` ·
`qwen2.5-coder:14b` · `qwen2.5vl:7b`.

**`LANDING_MODELS_NOT_IN_GUIDE: 0`**

## F.3 Comprobaciones permanentes añadidas

La suite pasa de 295 a **306 comprobaciones**. Las once nuevas impiden que
cualquiera de las dos inconsistencias vuelva:

- el sitemap declara la raíz y **no** declara `/landing.html`;
- el sitemap no repite ninguna URL y declara exactamente 3;
- el `canonical` de la landing es `https://mika5.xyz/`;
- `og:url` usa esa misma URL;
- todos los campos `url` del JSON-LD usan la raíz canónica;
- ninguna de las tres páginas declara `hreflang`, que exigiría URLs por idioma;
- la landing cita al menos 10 identificadores de modelo;
- **todo modelo citado en la landing existe en el Model Guide**;
- `mistral-small` no puede reaparecer en la landing sin ficha.

La comprobación de consistencia entre páginas es la que cierra el problema de
raíz: en adelante, añadir un modelo a la portada sin documentarlo rompe la
suite.

## F.4 Plan de capturas

Escrito en `docs/screenshot-plan-v0.3.0.md`: especificación general, escenario
sintético común y una ficha por captura con contenido, estado de la app, datos
necesarios, qué debe verse, qué debe quedar fuera, ubicación en la web,
contenedor que sustituye, proporción, `alt` en ES y EN, dependencia de
proveedor cloud y estado `USER_REQUIRED`.

Siete de las nueve no necesitan ninguna clave. `cloud-consent` requiere un
proveedor seleccionado para que el modal aparezca, pero se captura **antes** de
autorizar el envío. `visual-routing` sólo necesita proveedor si se captura
generación de imagen; el análisis puede hacerse con un modelo de visión local.

No se ha sustituido el mockup, no se han añadido marcadores de posición y no se
ha generado ninguna imagen. `WEBSITE_REAL_SCREENSHOTS_REQUIRED` sigue vigente.

---

# Apéndice G — Corrección de la calidad de las comprobaciones (2026-08-04)

Una revisión externa señaló que dos comprobaciones añadidas en el cierre de la
Fase V eran defectuosas y dos débiles. Los cuatro puntos eran correctos.

## G.1 El test del enlace de privacidad no podía fallar

La condición escrita era:

```js
check(!/data-i18n="footer\.privacy"/.test(landing.replace(/href="#privacy"[^>]*data-i18n="footer\.privacy"/, '')) === false
  || /href="#privacy"[^>]*data-i18n="footer\.privacy"/.test(landing), ...)
```

El primer disyunto pregunta si queda alguna aparición de
`data-i18n="footer.privacy"` tras eliminar la del enlace correcto. La clave
aparece además **en los dos diccionarios** del propio archivo, así que ese
disyunto era **siempre verdadero**. La comprobación no es que fuese débil: era
una tautología que no podía fallar en ningún caso, ni siquiera borrando el
enlace entero.

Sustituida por dos comprobaciones independientes, insensibles al orden de los
atributos:

```js
const ENLACE_PRIVACIDAD = /<a\b(?=[^>]*\bhref="#privacy")(?=[^>]*\bdata-i18n="footer\.privacy")[^>]*>/;
check(ENLACE_PRIVACIDAD.test(landing), 'el enlace de privacidad apunta a #privacy');
const destinosPrivacidad = (landing.match(/\bid="privacy"/g) || []).length;
check(destinosPrivacidad === 1, `existe exactamente un destino #privacy (${destinosPrivacidad})`);
```

Más una prueba negativa en la propia suite, que rompe el `href` sobre una copia
en memoria y exige que la validación falle.

Nota de implementación: el primer intento usó `/\bid="privacy"\b/`. El `\b`
final no puede casar nunca, porque a un lado hay una comilla y al otro un
espacio, ambos caracteres que no son de palabra. Lo detectó la comprobación de
recuento exacto, que devolvió 0 destinos donde hay 1.

## G.2 El cruce de modelos no demostraba que existiera ficha

`models.includes(t)` sólo demuestra que la cadena aparece en algún punto del
archivo: una nota, una advertencia, una lista de retirados o parte de otra
cadena más larga habrían contado como ficha. La extracción por `font-mono`
tampoco servía: esa clase se usa también para versiones, comandos y tamaños.

Sustituido por comparación **estructural y exacta** mediante un atributo
semántico que no cambia el diseño:

- `data-model-id` en cada uno de los **15** modelos promocionados en la landing;
- `data-model-id` en cada una de las **26** filas canónicas de la tabla
  práctica del Model Guide.

```js
function idsDeModelo(html) {
  return new Set([...html.matchAll(/\bdata-model-id="([^"]+)"/g)].map(m => m[1]));
}
const sinFicha = [...idsDeModelo(landing)].filter(id => !idsDeModelo(models).has(id));
```

Añadida una comprobación adicional: el identificador declarado debe coincidir
con el texto visible del elemento, para que el atributo no pueda divergir de lo
que lee el usuario.

**Eliminado** el veto específico `!landing.includes('mistral-small')`. Era una
prohibición permanente que habría impedido documentar ese modelo en el futuro.
El contrato general lo cubre: si algún día tiene ficha canónica, la regla lo
admite sola.

## G.3 Enlaces internos a la URL canónica

`models.html` y `whitepaper.html` enlazaban el inicio a `landing.html`, así que
la URL duplicada seguía siendo descubrible desde el propio sitio aunque el
sitemap ya no la anunciara. Los cuatro enlaces —cabecera y pie de cada
página— pasan a `href="/"`.

Contrapartida aceptada: abrir `models.html` o `whitepaper.html` directamente
desde el disco deja el enlace de inicio apuntando a la raíz del sistema de
archivos. La corrección de la URL canónica en producción pesa más que la
navegación en previsualización local.

`LANDING_HTML_301_REDIRECT` se mantiene como endurecimiento adicional del
despliegue, ya no como requisito para que la navegación interna sea correcta.

## G.4 JSON-LD analizado de verdad

La regex anterior sólo veía `"url": "https://mika5.xyz..."` con ese espaciado
exacto. No cubría `@id`, `mainEntityOfPage`, el JSON minificado, las
estructuras anidadas ni un bloque sintácticamente inválido.

Ahora la suite extrae todos los `script[type="application/ld+json"]` de las tres
páginas, ejecuta `JSON.parse`, **falla si algún bloque es inválido**, recorre
`@graph` cuando existe y valida:

- `Organization.url`, `WebSite.url` y `SoftwareApplication.url` contra
  `https://mika5.xyz/`;
- que el `@id` de esos nodos cuelgue de la raíz canónica;
- `mainEntityOfPage`, donde exista, contra el dominio canónico;
- que ningún valor de ningún nodo, a cualquier profundidad, referencie
  `/landing.html`.

No se exige que los logos, las URLs de descarga ni las páginas secundarias sean
la raíz: cada una conserva la suya.

## G.5 Prueba de mutación

Para no volver a dar por buena una comprobación que no puede fallar, cada regla
se verificó rompiendo el árbol a propósito y exigiendo que la suite fallase.
Nueve mutaciones, con copia de seguridad y restauración garantizada:

| # | Mutación | Resultado |
|---|---|---|
| — | árbol sin mutar | PASA |
| 1 | `href="#privacy"` → `href="#"` | **FALLA** |
| 2 | se borra el destino `id="privacy"` | **FALLA** |
| 3 | modelo promocionado sin ficha en el Guide | **FALLA** |
| 4 | identificador sólo en prosa del Guide, sin fila canónica | **FALLA** |
| 5 | `data-model-id` divergente del texto visible | **FALLA** |
| 6 | enlace de inicio revertido a `landing.html` | **FALLA** |
| 7 | JSON-LD sintácticamente inválido | **FALLA** |
| 8 | `url` del JSON-LD fuera de la raíz canónica | **FALLA** |
| 9 | el sitemap vuelve a duplicar la landing | **FALLA** |
| — | árbol restaurado | PASA |

9 de 9 detectadas. La primera ejecución dio un falso negativo en la mutación 7
por un fallo del propio arnés, no de la suite: perl interpolaba `@type` como
array vacío y la mutación nunca llegaba a aplicarse. Corregido el escapado, la
suite la detecta.

## G.6 Estado de la suite

De 306 a **340 comprobaciones**. Se conservan sin cambios las comprobaciones de
sitemap sin `/landing.html`, sin URLs duplicadas, con la raíz presente, sin
`hreflang` y con exactamente tres URLs públicas.

---

# Apéndice H — Endurecimiento final del gate pre-capturas (2026-08-04)

Tres debilidades restantes, cerradas.

## H.1 Canonical exacto por página

La comprobación anterior sólo miraba la landing y usaba la raíz como
referencia. `models.html` y `whitepaper.html` no se validaban: cualquier
canonical incorrecto en ellas habría pasado.

```js
const CANONICAL_BY_FILE = {
  'landing.html': 'https://mika5.xyz/',
  'models.html': 'https://mika5.xyz/models.html',
  'whitepaper.html': 'https://mika5.xyz/whitepaper.html'
};
```

Para cada una de las tres páginas se valida por **igualdad exacta**:
`link rel=canonical`, `og:url` y `mainEntityOfPage` donde exista.

`startsWith()` queda eliminado como criterio de dominio. Donde sólo hace falta
comprobar el origen se usa:

```js
new URL(valor).origin === 'https://mika5.xyz'
```

con `try/catch` para que una URL inválida cuente como fallo, no como
excepción. La suite incluye la comprobación de que ese criterio **rechaza**
`https://mika5.xyz.ejemplo.com/`, que sí habría pasado un `startsWith`.

Quedan separados tres conceptos que antes se mezclaban:

| Concepto | Regla |
|---|---|
| URL canónica de la página | igualdad exacta contra `CANONICAL_BY_FILE` |
| `@id` de un nodo JSON-LD | mismo origen, ruta `/` y fragmento `#\w+` válido |
| Logos, descargas y assets | URL propia; no se exige la raíz |

Se añade además un recorrido completo del JSON-LD que recoge toda URL absoluta
que **aparente** ser del dominio y exige que su origen lo sea de verdad.

## H.2 Unicidad e integridad de `data-model-id`

Los identificadores se extraen ahora como **Array**, no como `Set`: un `Set`
habría escondido justo el fallo que hay que detectar.

| Comprobación | Valor v0.3.0 |
|---|---|
| Ocurrencias en la landing | 15 |
| Identificadores únicos en la landing | 15 |
| Filas canónicas en el Model Guide | 26 |
| Identificadores únicos en el Guide | 26 |
| Duplicados | 0 |
| Elementos con dos `data-model-id` | 0 |
| Modelos de la landing sin ficha | 0 |
| Píldoras cuyo atributo difiere del texto visible | 0 |
| Filas cuyo atributo difiere de su primera celda | 0 |

Los conteos van en constantes nombradas, `MODELOS_LANDING_V030` y
`FICHAS_GUIA_V030`, con el motivo escrito: corresponden al catálogo editorial
de esta versión y una versión futura con otro catálogo hará fallar la suite
hasta que alguien confirme la cifra nueva a propósito.

## H.3 Fixture real de «sólo en prosa»

La condición débil `models.includes('mistral')` queda eliminada. En su lugar,
un fixture sintético dentro de la propia suite donde el identificador exacto
aparece en un párrafo y **no** en ningún `data-model-id`:

```js
const FIXTURE_GUIA = `
  <p>El modelo <code>mistral-small:latest</code> se evaluo y no se incluyo en
     el catalogo editorial de esta version.</p>
  <table><tbody>
    <tr data-model-id="qwen2.5:7b"><td>qwen2.5:7b</td><td>Chat</td></tr>
    <tr data-model-id="llama3.2:3b"><td>llama3.2:3b</td><td>Chat</td></tr>
  </tbody></table>`;
```

Demuestra las cuatro afirmaciones: la presencia exacta en prosa no cuenta;
un prefijo (`qwen2.5:7`, `qwen2`, `llama3.2`) no cuenta; un sufijo adicional
(`qwen2.5:7b-extra`, `qwen2.5:7bb`, `llama3.2:3b-instruct`) no cuenta; sólo el
`data-model-id` exacto satisface el contrato.

## H.4 Mutación de privacidad insensible al orden

La mutación anterior usaba una regex que exigía `href` antes de `data-i18n`:
habría dejado de mutar en cuanto alguien reordenase los atributos, y la prueba
negativa se habría vuelto vacía sin avisar.

Ahora se localiza el anchor con la **propia expresión de validación** y se
reemplaza `href="#privacy"` dentro de la etiqueta encontrada:

```js
function romperHrefPrivacidad(html) {
  const m = ENLACE_PRIVACIDAD.exec(html);
  if (!m) return html;
  const roto = m[0].replace('href="#privacy"', 'href="#"');
  return html.slice(0, m.index) + roto + html.slice(m.index + m[0].length);
}
```

La suite comprueba además, sobre un anchor con los atributos en orden inverso,
que la validación lo acepta y que la mutación lo rompe igual.

## H.5 Evidencia reproducible

Las pruebas esenciales viven dentro de `test/website-i18n.test.js`: el fixture
de prosa, la mutación insensible al orden, los conteos exactos, la integridad
atributo/texto y el rechazo del dominio impostor. Ninguna regla crítica depende
del arnés de scratchpad, que se conserva sólo como evidencia adicional.

### Segunda tanda de mutación

| # | Mutación | Esperado | Resultado |
|---|---|---|---|
| — | árbol sin mutar | PASA | PASA |
| A | canonical de `models.html` puesto a la raíz | FALLA | **FALLA** |
| B | `og:url` de `whitepaper.html` puesto a la raíz | FALLA | **FALLA** |
| C | `mainEntityOfPage` incorrecto | FALLA | **FALLA** |
| D | `url` con dominio `mika5.xyz.ejemplo.com` | FALLA | **FALLA** |
| E | `@id` con dominio impostor | FALLA | **FALLA** |
| F | identificador duplicado en la landing | FALLA | **FALLA** |
| G | falta un identificador en la landing (14 de 15) | FALLA | **FALLA** |
| H | falta una ficha en el Guide (25 de 26) | FALLA | **FALLA** |
| I | fila con texto divergente del atributo | FALLA | **FALLA** |
| J | dos `data-model-id` en un mismo elemento | FALLA | **FALLA** |
| K | atributos del enlace de privacidad reordenados | **PASA** | **PASA** |
| — | árbol restaurado | PASA | PASA |

La mutación K es la que importa para el punto 4: reordenar los atributos del
anchor real no rompe la validación. Las diez anteriores confirman que cada
regla nueva detecta su regresión.

La primera tanda de nueve mutaciones se repitió tras estos cambios y sigue
dando 9 de 9.

## H.6 Estado de la suite

De 340 a **363 comprobaciones**.

## H.7 Tarea diferida registrada

**`WEBSITE_TESTS_HTML_PARSER`** — la suite analiza el markup con expresiones
regulares en varios puntos. Es aceptable para estos tres archivos estáticos y
su markup controlado, y las reglas críticas están cubiertas por mutación, pero
una refactorización futura ganaría robustez usando un parser HTML real.
Observación de revisión, no bloqueante: no detiene esta fase.
