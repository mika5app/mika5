# Validación del sitio — MIKA5 Community v0.3.0

**Fecha:** 2026-08-04
**Rama:** `chore/website-v0.3.0`
**Base:** `f87e2cefdb24eed1d4404495c37d51b3fc8aca75` (tag `v0.3.0`)
**Alcance:** `web/landing.html`, `web/models.html`, `web/whitepaper.html`, `web/sitemap.xml`

Diseño congelado: no se ha modificado ninguna regla CSS, clase, componente,
color, tipografía, breakpoint ni animación. Todos los cambios son de contenido
dentro de los contenedores existentes.

## 1. Barrido de contenido

| Comprobación | Resultado |
|---|---|
| Referencias a `0.1.0` / `0.2.0` | **0** |
| `outperform*` sin fuente | **0** (antes 7) |
| `MMLU/MT-Bench/HumanEval/GSM8K` con cifras | **0** (antes 38 menciones) |
| «the only local AI desktop» | **0** |
| «your data never leaves your machine» | **0** |
| «zero network calls» / «zero outbound network requests» | **0** |
| Sanitización automática de PII | **0** (eliminada del White Paper) |
| Tag `:cloud` de Ollama (no soportado por MIKA5) | **0** |
| Funciones futuras descritas como disponibles | **0** |
| Secretos, claves o rutas personales | **0** |

Las dos únicas coincidencias del barrido de rutas eran documentación de la
ubicación de la base de datos en el White Paper; además estaban mal
(`AppData/Roaming/MIKA5`) y se han corregido a `AppData/Roaming/mika5-desktop`,
que es el nombre real del paquete.

## 2. Enlaces de descarga — 13/13 responden HTTP 200

`MIKA5-Setup-0.3.0-win-x64.exe` · `MIKA5-Portable-0.3.0-win-x64.exe` ·
`MIKA5-0.3.0-mac-arm64.dmg` · `MIKA5-0.3.0-mac-x64.dmg` ·
`MIKA5-0.3.0-linux-x86_64.AppImage` · `MIKA5-0.3.0-linux-amd64.deb` ·
`MIKA5-0.3.0-linux-x86_64.rpm` · `MIKA5-0.3.0-source.tar.gz` ·
`SHA256SUMS.txt` · `LICENSE` · `BUILDING.md` · `COMMUNITY.md` ·
`BUILD-METADATA.json`

## 3. Modelos: verificación contra el registro oficial de Ollama

Método: `registry.ollama.ai/v2/library/<modelo>/manifests/<tag>`, 2026-08-04.
El código HTTP de `ollama.com/library` no sirve: devuelve 200 para rutas
inexistentes.

**Retirados por no existir:**

| Identificador anterior | Resultado | Sustituto |
|---|---|---|
| `qwen2.5-vl:7b` | 404 — el tag real no lleva guion | `qwen2.5vl:7b` |
| `gemma3:9b` | 404 — existen 4b y 12b | `gemma3:12b` |
| `phi4:3b` | 404 — existen latest y 14b | `phi4:14b` |
| `qwen3.5:72b` | 404 | `qwen2.5:72b` |
| `glm-5:cloud` | 404 | `qwen2.5-coder:14b` |
| `kimi-k2:cloud` | 404 | `deepseek-r1:14b` |
| `nemotron-3-super:cloud` | sin listado de tags | `mistral-small:latest` |
| `glm-ocr:latest` | sin listado de tags | `llama3.2-vision:11b` |

**Verificados (200 en el registro):** `llama3.2:3b`, `qwen2.5:7b`, `qwen2.5:72b`,
`qwen2.5vl:7b`, `llava:7b`, `llava:13b`, `llama3.2-vision:11b`, `deepseek-r1:7b`,
`deepseek-r1:14b`, `deepseek-r1:70b`, `mistral:7b`, `mistral-small:latest`,
`llama3.3:70b`, `qwen2.5-coder:7b`, `qwen2.5-coder:14b`, `gemma3:4b`,
`gemma3:12b`, `phi4:14b`, `starcoder2:15b`, `deepseek-coder-v2:16b`,
`nomic-embed-text`.

## 4. Alibaba Cloud Model Studio

El adapter existe en `ai-providers.js:1702` con endpoint compatible-Anthropic,
catálogo configurable, región, workspace y modo de facturación. El código trae
una lista sugerida de identificadores (`ALIBABA_TOKEN_PLAN_MODELS`), pero **no
se publican en la web**: no hay documentación oficial contrastable desde aquí y
el catálogo real depende del workspace del usuario. La web describe la
capacidad, no modelos concretos, tal como se pidió.

## 5. Paridad ES/EN

Diccionario de `landing.html`: **136 claves en inglés, 136 en español**, sin
huecos en ninguna dirección. `models.html` y `whitepaper.html` siguen siendo
monolingües en inglés en su cuerpo, igual que antes de este cambio: convertirlos
sería trabajo de contenido nuevo, no de actualización, y queda fuera de alcance.

## 6. Integridad del markup

| Archivo | Etiquetas abiertas | Cerradas | Delta |
|---|---|---|---|
| `landing.html` | 251 | 251 | 0 |
| `models.html` | 406 | 406 | 0 |
| `whitepaper.html` | 196 | 196 | 0 |

`git diff --check` → exit 0.

## 7. Capturas

**Estado: pendiente.** No se ha sustituido ninguna imagen y no se ha introducido
ningún material inventado.

El hero de la landing **no usa una imagen**: es un mockup construido con HTML y
CSS que simula la interfaz. Muestra una versión de la UI que ya no corresponde a
v0.3.0 (sin menú «Más acciones», sin contexto activo, sin el aviso cloud
actual). Se conserva intacto hasta disponer de capturas reales, momento en el
que se sustituirá por una imagen dentro del mismo contenedor y proporción.

### Capturas disponibles (generadas desde la app real del tag, datos sintéticos)

`hero-main`, `projects-rag`, `code-blocks`, `empty-state`, `chat-actions`,
`composer` — pendientes de recorte y conversión a WebP.

### Capturas que faltan de Roxana

| Archivo | Contenido | Advertencia |
|---|---|---|
| `settings-providers.png` | Modal «Configurar API Key» con las pestañas de proveedores | Campos vacíos o valores sintéticos enmascarados; nunca una clave real |
| `visual-routing.png` | Conversación con enrutado visual: análisis o generación de imagen | Imagen neutra, sin documentos personales |
| `cloud-consent.png` | Modal de consentimiento cloud con sus categorías | Proyecto de ejemplo |

Formato: PNG 1280×820 o 1440×900, tema oscuro, ventana completa de v0.3.0.

## 8. Fuera de alcance en este parche

- Sustitución de imágenes del hero (bloqueada por el punto 7).
- Sección «Novedades de v0.3.0» en la landing: requiere un contenedor nuevo y,
  con el diseño congelado, debe decidirse dónde encaja sin alterar la
  estructura de secciones existente.
- Enlaces a `source.tar.gz`, `SHA256SUMS.txt` y avisos de SmartScreen: la
  cuadrícula de descargas actual tiene tres tarjetas de plataforma sin hueco
  para assets adicionales; añadirlos implica tocar el layout.
- Etiquetado `IMPLEMENTED / PLANNED / EXPERIMENTAL / NOT INCLUDED` en el
  roadmap del White Paper: pendiente de decidir si se marca con texto plano
  dentro de los `<li>` existentes.
