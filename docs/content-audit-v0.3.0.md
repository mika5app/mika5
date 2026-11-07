# Auditoría de contenido del sitio — MIKA5 Community v0.3.0

**Fecha:** 2026-08-04
**Commit auditado:** `f87e2cefdb24eed1d4404495c37d51b3fc8aca75` (tag `v0.3.0`)
**Release pública:** https://github.com/mika5app/mika5-releases/releases/tag/v0.3.0
**Páginas auditadas:** `web/landing.html` (servida como `/` e `/index.html`), `web/models.html`, `web/whitepaper.html`

El sitio público es, tras normalizar finales de línea, **idéntico** a `web/` en el
repositorio: `landing.html` → `/` (0 líneas de diferencia), `models.html` y
`whitepaper.html` igual, y `robots.txt` / `sitemap.xml` con SHA-256 idéntico. La
cadena de publicación real es `web/` → workflow *Deploy Landing* → `/var/www/html/`.
La ruta `/var/www/techybot` no interviene.

## Alcance

Diseño **congelado**: no se tocan colores, tipografías, tamaños, fondos,
gradientes, bordes, sombras, botones, tarjetas, navegación, header, footer,
estructura de secciones, distribución, animaciones, breakpoints ni clases CSS.
Sólo cambia contenido: textos, versión, enlaces, nombres de archivo, comandos,
metadata, FAQ, Model Guide, White Paper y capturas dentro de sus contenedores
actuales.

## Estado de la traducción

`landing.html` tiene 141 nodos `data-i18n` con diccionario ES/EN embebido;
`models.html` y `whitepaper.html` tienen 9 cada uno (sólo cabecera y navegación:
su cuerpo es monolingüe en inglés). Toda entrada marcada **UPDATE** o **ADD** en
la landing debe modificarse en las dos lenguas del diccionario.

## Fuentes de verdad usadas

| Afirmación a comprobar | Evidencia en el commit |
|---|---|
| Proveedores implementados | `src/main/ai-providers.js:1233,1326,1409,1534,1624,1702,1862` — `local`, `openai`, `anthropic`, `groq`, `moonshot`, `alibaba`, `llamacpp` |
| Cifrado de credenciales | `src/main/ai-providers.js:81,94` `aes-256-gcm`; clave por `safeStorage` (`:46-50`) con reserva `scryptSync` (`:68`) |
| Sanitización de prompts | `src/main/ai-providers.js:1997` `this.sanitizeCloud = false`; `CLAUDE.md:78-86` la declara desactivada y prohíbe describirla |
| Consentimiento cloud | `src/renderer/cloud-consent.js:8,36` — esquema v1, clave por proveedor y proyecto |
| Formatos de exportación | `src/renderer/app.js` `doExport` 1..5 → `.md`, `.txt`, `.html`, `.py`, `.pdf` |
| RAG y embeddings | `src/main/rag.js:7` `EMBED_MODEL_DEFAULT = "nomic-embed-text"`; `:64` `embedBatch` vía Ollama |
| Telemetría | `grep -riE "telemetry|analytics|mixpanel|posthog|sentry|gtag\("` sobre `src/main`, `src/renderer/app.js`, `src/renderer/i18n.js`, `package.json` → **0 coincidencias** |
| Idiomas de la app | `src/renderer/i18n.js` — diccionarios `es` y `en`, 160 claves cada uno, paridad completa |
| Empaquetado | `electron-builder.json` — win NSIS/portable, mac dmg/zip arm64+x64, linux AppImage/deb/rpm |
| Sandbox del renderer | `src/main/main.js:44-46` `contextIsolation: true`, `nodeIntegration: false`, **`sandbox: false`** |
| Menú nativo | `src/main/application-menu.js` + `main.js:40,51,99` |
| Bloques de código | `src/renderer/app.js` `addCopyButtonsToCodeBlocks`, umbral `CODE_BLOCK_COLLAPSE_THRESHOLD = 40` |

---

## 1. Landing — Hero y posicionamiento

| # | Sección | Texto actual | Clasificación | Problema | Texto propuesto | Evidencia | Captura |
|---|---|---|---|---|---|---|---|
| L-01 | head/nav/footer, badge hero | `v0.2.0` (41 apariciones) | **UPDATE** | Versión obsoleta | `v0.3.0` | `package.json` = 0.3.0 en `f87e2ce` | no |
| L-02 | hero, subtítulo | «The **only** local AI desktop with built-in RAG…» | **REMOVE** | Superlativo no demostrable; existen Jan, LM Studio, AnythingLLM, GPT4All | «A local-first, multi-model AI workspace with built-in RAG, project organization and optional cloud providers — in English and Spanish.» / ES: «Un espacio de trabajo de IA local-first y multimodelo, con RAG integrado, organización por proyectos y proveedores cloud opcionales — en español e inglés.» | Posicionamiento acordado; no hay evidencia de exclusividad | no |
| L-03 | hero, subtítulo | «No subscriptions. No hidden cloud.» | **UPDATE** | «No subscriptions» se lee como promesa perpetua y choca con Pro/Cloud futuros | «Community is free and AGPL-3.0. Cloud providers are optional and only used when you choose them.» / ES: «Community es gratis y AGPL-3.0. Los proveedores cloud son opcionales y sólo se usan cuando tú los eliges.» | `LICENSE` AGPL-3.0; Pro/Cloud no existen en el código | no |
| L-04 | hero, píldoras | `Offline-ready`, `No telemetry`, `SQLite local memory`, `Ollama compatible`, `Vision models`, `Built-in RAG engine`, `Cloud optional` | **KEEP** | Todas verificables | sin cambios | telemetría: 0 coincidencias; resto en código | no |
| L-05 | hero, mockup de la app | Mockup HTML/CSS que simula la UI (proyectos «Investigación», «Código Personal»…) | **UPDATE** | No es la interfaz de v0.3.0: no tiene menú «Más acciones», ni contexto activo, ni el aviso cloud actual | Sustituir por captura real dentro del mismo contenedor y proporción | UI v0.3.0 en `src/renderer/index.html` | **sí** |
| L-06 | hero, badge | `v0.2.0 — Windows · macOS · Linux` | **UPDATE** | Versión | `v0.3.0 — Windows · macOS · Linux` | release v0.3.0 con los 9 instaladores | no |

## 2. Landing — Características

| # | Sección | Texto actual | Clasificación | Problema | Texto propuesto | Evidencia | Captura |
|---|---|---|---|---|---|---|---|
| L-07 | features, intro | «No extensions. No integrations. **No API keys required to get started.**» | **UPDATE** | Cierto sólo con Ollama local; con proveedores cloud sí hacen falta | «No extensions. No integrations. No API key needed for local use with Ollama — cloud providers require your own key.» / ES: «Sin extensiones ni integraciones. No necesitas API key para el uso local con Ollama; los proveedores cloud requieren tu propia clave.» | `ai-providers.js` — `local` sin `apiKey`; `openai/anthropic/groq/moonshot/alibaba` lo exigen | no |
| L-08 | features, RAG | «Upload documents and MIKA5 automatically chunks, embeds, and retrieves… Per-project and per-chat knowledge bases.» | **KEEP** | Correcto | sin cambios | `rag.js` chunking + `embedBatch` + `chat_id` scope | no |
| L-09 | features, Projects & Chats | «Organize work into projects… Quick Chat for ad-hoc conversations» | **UPDATE** | Correcto pero incompleto: falta el contexto activo nuevo de v0.3.0 | Añadir: «The active project and chat are now marked explicitly in the sidebar.» / ES: «El proyecto y el chat activos se marcan ahora de forma explícita en la barra lateral.» | `app.js` `markActiveProject`, `aria-current` | **sí** |
| L-10 | features, Vision | «MIKA5 auto-detects vision-capable models (**LLaVA, GLM-OCR, Gemma3, Qwen2.5-VL, GPT-4o, Claude**)…» | **UPDATE** | La detección es por sonda de capacidades, no por lista fija; `glm-ocr` y `gemma3` no están validados | «MIKA5 detects vision-capable models through the provider's capability probe and warns when the selected model cannot process images.» + ejemplos sólo con modelos verificados (`qwen2.5-vl`, `llava`, `gpt-4o`, Claude con visión) | `provider-capabilities.js:225,250` sonda `/api/show`; `app.js` `modelSupportsVision` | no |
| L-11 | features, Cloud AI | «Connect OpenAI, Anthropic, Groq, or Moonshot…» | **UPDATE** | Falta **Alibaba Cloud Model Studio**, implementado en v0.3.0 | «Connect OpenAI, Anthropic, Groq, Moonshot or Alibaba Cloud Model Studio when you need them.» | `ai-providers.js:1702` `alibaba` con `chat()`, `generateImage()` y configuración de endpoint | **sí** (settings) |
| L-12 | features, Cloud AI | «API keys stored with AES-256-GCM encryption. A privacy indicator shows when cloud is active.» | **UPDATE** | Correcto pero incompleto: v0.3.0 añade consentimiento explícito por proveedor y proyecto | Añadir: «Before the first cloud send, MIKA5 asks for explicit consent and lists exactly what will leave the device: message, history, project instructions, attachments, images and RAG context. The authorization is scoped to that provider and project and can be revoked.» | `cloud-consent.js` categorías + `app.js` `ensureCloudConsent`, `revokeCloudConsent` | **sí** |
| L-13 | features, Model Tracking | «Every message is tagged with the model… Model switches highlighted inline» | **KEEP** | Correcto | sin cambios | `app.js` `model-badge`, `model-change-indicator` | no |
| L-14 | features, Export | «Export… to Markdown, plain text, HTML, Python, or PDF.» | **KEEP** | Verificado uno a uno | sin cambios | `doExport` 1→`.md`, 2→`.txt`, 3→`.html`, 4→`.py`, 5→`.pdf` | no |
| L-15 | features, lista «Popular & everyday» | `gemma3:9b`, `phi4:14b`, `glm-ocr:latest` | **UPDATE** | Etiquetas no verificadas en el registro de Ollama con esa forma exacta | Dejar sólo los verificables: `llama3.2:3b`, `qwen2.5:7b`, `qwen2.5-vl:7b`, `deepseek-r1:7b`, `mistral:7b`, `llava:13b`, `nomic-embed-text` | Requiere verificación contra ollama.com/library antes de publicar | no |
| L-16 | features, lista «High-end» | `qwen3.5:72b`, `glm-5:cloud`, `kimi-k2:cloud`, `nemotron-3-super:cloud` | **REMOVE** | `qwen3.5` y `glm-5` no existen como tales; `:cloud` no es un sufijo que MIKA5 soporte | Sustituir por los verificables: `llama3.3:70b`, `deepseek-r1:70b`, `qwen2.5:72b` | MIKA5 pasa el nombre tal cual a Ollama; un tag inexistente falla | no |
| L-17 | features, pie de la lista | «Local runtimes: Ollama · llama.cpp — Cloud providers: OpenAI · Anthropic · Groq · Moonshot» | **UPDATE** | Falta Alibaba | «Cloud providers: OpenAI · Anthropic · Groq · Moonshot · Alibaba Cloud Model Studio» | `ai-providers.js:1702` | no |
| L-18 | features, «MIKA5 flow» | «You → MIKA5 Desktop → Local Ollama → Done — **# Zero network calls. Your hardware. Your data.**» | **UPDATE** | Absoluto y falso en cuanto se activa un proveedor cloud; además la app consulta el catálogo de modelos y descarga imágenes generadas | «# No calls to MIKA5 servers. Local inference stays on your hardware.» / ES: «# Ninguna llamada a servidores de MIKA5. La inferencia local se queda en tu hardware.» + nota «Cloud mode adds explicit calls to the provider you choose.» | telemetría 0; pero `network-security.js` existe justo porque hay descargas controladas | no |
| L-19 | features, sección nueva | — | **ADD** | No hay «Novedades de v0.3.0» | Bloque con: nueva jerarquía de la barra superior · contexto activo de proyecto y chat · acciones de chat accesibles y separadas · compositor alineado con la conversación · estados vacíos con acción · visuales de proyecto estables · bloques de código con lenguaje, líneas, copiar y colapsar · consentimiento y señalización cloud · menú nativo adaptado por plataforma · mejoras de contraste y accesibilidad | Commits `7995013`, `a845179`, `7704884`, `3c4072d` | **sí** |

## 3. Landing — Privacidad

| # | Sección | Texto actual | Clasificación | Problema | Texto propuesto | Evidencia | Captura |
|---|---|---|---|---|---|---|---|
| L-20 | privacidad, H2 | «**Your data never leaves your machine.**» | **UPDATE** | Falso cuando se usa un proveedor cloud, que la propia web ofrece | «Local by default. Cloud only when you authorize it.» / ES: «Local por defecto. Cloud sólo cuando tú lo autorizas.» | `ensureCloudConsent` bloquea el envío hasta que hay consentimiento | no |
| L-21 | privacidad, subtítulo | «No telemetry. No background sync. No account creation. No hidden calls home.» | **KEEP** | Verificado: 0 telemetría, sin cuentas, sin sincronización | sin cambios | grep de telemetría sin resultados; no hay módulo de cuentas | no |
| L-22 | privacidad, checks | «Zero telemetry by default», «No analytics or crash reporting», «Cloud providers optional and user-configured», «API keys encrypted with AES-256-GCM» | **KEEP** | Los cuatro verificables | sin cambios | `ai-providers.js:81` | no |
| L-23 | privacidad, check nuevo | — | **ADD** | Falta la garantía más fuerte de v0.3.0 | «Explicit consent before every new cloud scope, revocable per provider and project» / ES: «Consentimiento explícito antes de cada nuevo ámbito cloud, revocable por proveedor y proyecto» | `cloud-consent.js` + `revokeCloudConsent` | no |
| L-24 | privacidad, aviso ausente | — | **ADD** | La web no dice que el contenido se envía **sin alterar** | «MIKA5 does not rewrite or redact your prompts: what you authorize is what is sent.» / ES: «MIKA5 no reescribe ni censura tus prompts: se envía exactamente lo que autorizas.» | `ai-providers.js:1997` `sanitizeCloud = false`; `CLAUDE.md:78-86` | no |

## 4. Landing — Descargas y Quick Start

| # | Sección | Texto actual | Clasificación | Problema | Texto propuesto | Evidencia | Captura |
|---|---|---|---|---|---|---|---|
| L-25 | download, 7 enlaces | URLs `…/download/v0.2.0/MIKA5-…-0.2.0-…` | **UPDATE** | Apuntan a la release anterior | Nombres exactos de la release v0.3.0: `MIKA5-Setup-0.3.0-win-x64.exe`, `MIKA5-Portable-0.3.0-win-x64.exe`, `MIKA5-0.3.0-mac-arm64.dmg`, `MIKA5-0.3.0-mac-x64.dmg`, `MIKA5-0.3.0-linux-x86_64.AppImage`, `MIKA5-0.3.0-linux-amd64.deb`, `MIKA5-0.3.0-linux-x86_64.rpm` | Listado real de assets de la release; los 5 ligeros y los 2 de Windows verificados con SHA-256 por mí | no |
| L-26 | download, assets ausentes | — | **ADD** | No se ofrecen fuente ni verificación | Enlaces a `MIKA5-0.3.0-source.tar.gz`, `SHA256SUMS.txt`, `LICENSE`, `BUILDING.md`, `COMMUNITY.md`, `BUILD-METADATA.json` | 15 assets en la release; obligación AGPL de ofrecer el fuente correspondiente | no |
| L-27 | download, aviso macOS | «The app is not notarized…» | **KEEP** | Cierto y necesario | sin cambios | `CSC_IDENTITY_AUTO_DISCOVERY: false` en el workflow | no |
| L-28 | download, aviso Windows | — | **ADD** | No advierte de SmartScreen | «Windows: the installer is not signed with Authenticode. SmartScreen may warn on first run — verify the SHA-256 before installing.» / ES equivalente | `Get-AuthenticodeSignature` sobre el .exe publicado → `NotSigned` | no |
| L-29 | download, comandos de checksum | `Get-FileHash "MIKA5-Setup-0.2.0-win-x64.exe"`, `shasum -a 256 MIKA5-0.2.0-mac-arm64.dmg`, `sha256sum MIKA5-0.2.0-linux-x86_64.AppImage` | **UPDATE** | Nombres de la versión anterior | Los mismos comandos con los nombres 0.3.0 | release v0.3.0 | no |
| L-30 | quickstart, paso 3 | «Run the **MIKA5-Setup-0.2.0-win-x64.exe** installer…» y `chmod +x MIKA5-0.2.0-linux-x86_64.AppImage`, `dpkg -i MIKA5-0.2.0-linux-amd64.deb`, `rpm -i MIKA5-0.2.0-linux-x86_64.rpm` | **UPDATE** | Comandos con nombres obsoletos | Sustituir por los nombres 0.3.0 | idem | no |
| L-31 | quickstart, modelos recomendados | `llama3.2:3b`, `qwen2.5:7b`, `qwen2.5-vl:7b`, `nomic-embed-text` | **KEEP** | Los cuatro son etiquetas reales y `nomic-embed-text` es el modelo de embeddings por defecto | sin cambios | `rag.js:7` | no |
| L-32 | quickstart, requisitos | «Windows 10/11, 8 GB RAM mínimo, 4 GB disco, Ollama instalado, GPU opcional» | **KEEP** | Coherente con `README.md` | sin cambios | `README.md:121-123` | no |

## 5. Landing — Pro / Cloud y pie

| # | Sección | Texto actual | Clasificación | Problema | Texto propuesto | Evidencia | Captura |
|---|---|---|---|---|---|---|---|
| L-33 | CTA final, Pro | «MIKA5 Pro **is coming**. Team collaboration, cloud sync, advanced RAG, and more.» | **UPDATE** | El titular está bien («is coming»), pero enumera capacidades sin etiquetarlas como no disponibles | «MIKA5 Pro and Cloud are in development. Nothing listed here exists in Community v0.3.0.» + lista marcada «planned» / ES: «MIKA5 Pro y Cloud están en desarrollo. Nada de lo listado existe en Community v0.3.0.» | No hay código de cuentas, sincronización, equipos ni agentes en `f87e2ce` | no |
| L-34 | CTA final | «v0.2.0 · Windows · macOS · Linux · Free & Open Source» | **UPDATE** | Versión | `v0.3.0 · …` | idem | no |
| L-35 | footer | «v0.2.0 · © 2026 MIKA5 · AGPL-3.0» | **UPDATE** | Versión | `v0.3.0 · © 2026 MIKA5 · AGPL-3.0` | idem | no |
| L-36 | footer, legal | Enlaces Privacy · License · Trademark | **KEEP** | Presentes y correctos | sin cambios | `LICENSE`, `TRADEMARK.md` en el repo | no |
| L-37 | head, metadata | `og:*`, `twitter:*`, JSON-LD `SoftwareApplication` con `softwareVersion` 0.2.0 | **UPDATE** | Versión, `datePublished` y URL de descarga desactualizadas | `softwareVersion: "0.3.0"`, `datePublished: "2026-08-04"`, `downloadUrl` a la release v0.3.0, `operatingSystem: "Windows, macOS, Linux"` | release publicada 2026-08-04T03:13Z | no |
| L-38 | `sitemap.xml` | `<lastmod>` anterior | **UPDATE** | Fecha obsoleta | `2026-08-04` en las tres URLs | — | no |

## 6. Model Guide (`models.html`)

| # | Sección | Texto actual | Clasificación | Problema | Texto propuesto | Evidencia | Captura |
|---|---|---|---|---|---|---|---|
| M-01 | cabecera | «MIKA5 Official Guide · **Updated March 2026**» | **UPDATE** | Fecha obsoleta y sin vínculo a la versión | «MIKA5 Official Guide · Updated August 2026 · Verified against MIKA5 Community v0.3.0» | — | no |
| M-02 | intro | «…their **benchmark performance**…» | **UPDATE** | Anuncia benchmarks que la guía no puede sostener | Reenfocar a «hardware requirements, strengths and limitations» | ver M-03 | no |
| M-03 | `#benchmark-table` | Tabla «Benchmark Comparison» con cifras y comparaciones tipo «outperforms models twice its size» (38 menciones de benchmark, 12 de GPT-4, 7 de outperform) | **REMOVE** | Ninguna cifra cita fuente primaria, variante de cuantización, fecha ni metodología | Sustituir por «Practical guidance» sin cifras: velocidad observada por gama de hardware y notas cualitativas, con enlace a la model card oficial de cada modelo | Regla explícita del encargo: sin fuente primaria vinculada al mismo modelo y configuración, fuera | no |
| M-04 | listas de modelos | `qwen3.5:72b`, `glm-5`, `kimi-k2`, `nemotron-3-super`, `glm-ocr`, `phi4:3b`, `gemma3:9b` | **REMOVE** | Etiquetas no verificadas o inexistentes en el registro de Ollama | Mantener sólo los verificados; cada uno con `ollama pull <tag>` comprobado antes de publicar | Se verificará tag a tag contra ollama.com/library | no |
| M-05 | estructura general | Secciones por gama de hardware y caso de uso | **KEEP** | Es la estructura práctica pedida | sin cambios de diseño | — | no |
| M-06 | organización | No separa local/cloud/embeddings/visión ni «probado» de «compatible» | **ADD** | Falta la taxonomía pedida | Añadir grupos: A local vía Ollama · B cloud por proveedor implementado · C embeddings · D visión · E generación de imagen (sólo Alibaba, si se confirma el modelo exacto) · F probado por MIKA5 · G compatible por protocolo, sin validar · H futuro | `ai-providers.js` proveedores; `provider-capabilities.js` capacidades | no |
| M-07 | proveedores cloud | Sólo OpenAI/Anthropic/Groq/Moonshot | **UPDATE** | Falta Alibaba Cloud Model Studio | Añadir sección con su configuración real: endpoint, protocolo `anthropic-compatible`, región, workspace, modo de facturación | `index.html` modal Alibaba; `ai-providers.js:1702` | no |
| M-08 | vLLM | No aparece | **KEEP** | Correcto que no aparezca | No introducirlo: no está en Community v0.3.0 | no hay proveedor vLLM en `ai-providers.js` | no |
| M-09 | embeddings | «Embedding Models — Required for RAG» | **KEEP** | Correcto | Añadir sólo la nota de que `nomic-embed-text` es el valor por defecto | `rag.js:7` | no |
| M-10 | ficha por modelo | Faltan campos | **ADD** | No indica fecha de verificación ni fuente oficial | Añadir a cada ficha: identificador exacto · local/cloud · tipo · RAM/VRAM · contexto · fortalezas · limitaciones · comando · fecha de verificación · enlace a la fuente | requisito del encargo | no |

## 7. White Paper (`whitepaper.html`)

Cada cambio va justificado; no se reescribe nada «a ciegas».

| # | Sección | Texto actual | Clasificación | Problema | Texto propuesto | Evidencia | Captura |
|---|---|---|---|---|---|---|---|
| W-01 | portada y pie | «Technical White Paper — **v0.1.0**», «Version 0.1.0 · April 2026», «This is version 0.1.0» (11 apariciones) | **UPDATE** | Documento dos versiones por detrás | «v0.3.0 · August 2026» en portada, cuerpo y pie | tag `v0.3.0` | no |
| W-02 | §4 Privacy Model | «MIKA5 also includes a basic **PII sanitization** step… email addresses, phone numbers… replaced with `[EMAIL]`, `[PHONE]`, `[ID]`… before transmission» | **REMOVE** | **Falso en v0.3.0 y contrario a la política del proyecto.** `AIProviderManager` fija `sanitizeCloud = false`; los `sanitize = true` de las firmas son valores muertos | «MIKA5 does not modify the content you authorize. Automatic redaction is disabled by default: what the consent dialog lists is what is transmitted, byte for byte. Any future redaction will be opt-in, visible and auditable.» | `ai-providers.js:1997,2136`; `CLAUDE.md:78-86` prohíbe describir MIKA5 como sanitizador | no |
| W-03 | §4 Privacy Model | «…MIKA5 makes **zero outbound network requests**…» | **UPDATE** | Absoluto: el catálogo de modelos, la descarga de imágenes generadas y las comprobaciones de estado hacen peticiones, aunque sean locales o autorizadas | «In its default configuration MIKA5 contacts no MIKA5-operated server. Inference goes to the local Ollama instance; any outbound request to a third party happens only after the user selects a cloud provider and authorizes the scope.» | `network-security.js` existe precisamente para acotar descargas; sin telemetría | no |
| W-04 | §4 Privacy Model | «cuando el usuario activa un proveedor cloud (OpenAI, Anthropic, Groq, or Moonshot) la UI cambia…» | **UPDATE** | Falta Alibaba y falta el mecanismo nuevo de consentimiento | Añadir Alibaba y describir el consentimiento con esquema versionado, ámbito por proveedor y proyecto, categorías declaradas y revocación | `cloud-consent.js:8,36,41` | no |
| W-05 | §3 System Architecture | «El renderer corre en un entorno Chromium **sandboxed**» | **UPDATE** | Inexacto: `sandbox: false` en la ventana principal. Sí hay `contextIsolation` y `nodeIntegration: false`, y la ventana de impresión sí usa `sandbox: true` | «The renderer runs with context isolation enabled and Node integration disabled; all privileged access is mediated by a narrow preload bridge. The offscreen PDF window runs fully sandboxed.» | `main.js:44-46`; `CLAUDE.md:144-146` | no |
| W-06 | §3 System Architecture | «AppImage for Linux» | **UPDATE** | v0.3.0 publica AppImage, deb y rpm; y macOS en dmg y zip para dos arquitecturas | Enumerar los 9 artefactos reales | `electron-builder.json`; assets de la release | no |
| W-07 | §6 Provider Architecture | Lista de proveedores sin Alibaba | **UPDATE** | Incompleta | Añadir Alibaba Cloud Model Studio con protocolo compatible-Anthropic y catálogo configurable | `ai-providers.js:1702-1861` | no |
| W-08 | §9 llama.cpp | «has been implemented in **v0.1.0**» | **UPDATE** | Referencia de versión obsoleta; el proveedor sigue presente | «implemented and available since v0.1.0; still present in v0.3.0» | `ai-providers.js:1862` | no |
| W-09 | §8 Security Design | No menciona el aislamiento de perfiles en pruebas | **ADD** | Detalle técnico real de v0.3.0 | Subsección breve: cada prueba Electron corre contra un `userData` temporal único creado por `scripts/run-electron-test.js`, que descarta cualquier `--user-data-dir` externo | `scripts/run-electron-test.js`; `test/electron-test-isolation.test.js` (92 comprobaciones) | no |
| W-10 | §10 Roadmap | Lista de planes sin etiquetar | **UPDATE** | No distingue estado | Etiquetar cada punto: `IMPLEMENTED IN v0.3.0` · `PLANNED` · `EXPERIMENTAL` · `NOT INCLUDED IN COMMUNITY` | requisito del encargo | no |
| W-11 | sección nueva | — | **ADD** | No documenta la distribución Community | Subsección: AGPL-3.0, fuente correspondiente publicada como `MIKA5-0.3.0-source.tar.gz`, `BUILD-METADATA.json` con el commit, y `SHA256SUMS.txt` que cubre los 14 assets | verificado por mí: hash del árbol del tarball idéntico al `git archive` del tag | no |
| W-12 | §5 RAG | Descripción del pipeline y caché de 5 minutos | **KEEP** | Coincide con el código | sin cambios | `rag.js` | no |
| W-13 | §7 Data Model | Esquema SQLite | **KEEP** | Coincide | sin cambios | `db.js` WAL + claves foráneas | no |
| W-14 | §2 Open-Source Models | «Alibaba releases Qwen with multilingual breadth that **outpaces Western models**» | **UPDATE** | Comparación sin fuente | «Alibaba releases Qwen with strong multilingual coverage, including Spanish.» | sin fuente primaria para la comparación | no |

## 8. Resumen por clasificación

| Clasificación | Landing | Model Guide | White Paper | Total |
|---|---|---|---|---|
| KEEP | 8 | 3 | 2 | 13 |
| UPDATE | 21 | 4 | 9 | 34 |
| REMOVE | 2 | 2 | 1 | 5 |
| ADD | 5 | 1 | 2 | 8 |

## 9. Capturas necesarias

Generadas por mí desde la aplicación real del tag, con datos sintéticos:
`hero-main`, `projects-rag`, `code-blocks`, `empty-state`, `chat-actions`, `composer`.

Pendientes de Roxana (requieren credenciales reales):

| Archivo | Contenido | Advertencia |
|---|---|---|
| `settings-providers.webp` | Modal «Configurar API Key» con las pestañas de proveedores | Ocultar las claves antes de enviar |
| `visual-routing.webp` | Conversación con enrutado visual (análisis o generación de imagen) | Imagen neutra, sin documentos personales |
| `cloud-consent.webp` | Modal de consentimiento cloud con categorías reales | Proyecto de ejemplo, no uno real |

Formato: PNG 1280×820 o 1440×900, tema oscuro, ventana completa de v0.3.0.

## 10. Verificaciones pendientes antes de publicar

1. Comprobar tag a tag, contra ollama.com/library, cada modelo que quede en la landing y en el Model Guide (afecta a L-15, L-16, M-04).
2. Confirmar el identificador exacto del modelo de generación de imagen de Alibaba antes de documentar esa capacidad (afecta a M-06 grupo E).
3. `HEAD` sobre las 13 URLs de descarga nuevas.
4. Paridad ES/EN del diccionario de la landing tras los cambios.

---

# Apéndice A — Decisiones cerradas (2026-08-04)

## A.1 Corrección de la lógica de sustitución de modelos

El primer parche sustituyó identificadores inválidos **uno a uno**, conservando
la ficha original. Eso produjo un defecto peor que el corregido: fichas que
atribuían a un modelo las características de otro. Verificado en las cuatro:

| Ficha tras la sustitución | Texto que conservaba |
|---|---|
| `mistral-small:latest` | descripción de Nemotron Super de NVIDIA |
| `llama3.2-vision:11b` | descripción de GLM-OCR de Zhipu AI |
| `qwen2.5-coder:14b` | descripción de GLM-5 de Zhipu AI |
| `deepseek-r1:14b` | descripción de Kimi K2 de Moonshot AI |

**Regla aplicada ahora:** un identificador inválido se elimina con su ficha
completa. Un modelo nuevo se añade sólo si la categoría lo justifica, con texto
propio y razón independiente. No se afirma equivalencia entre modelos distintos.

### Identificadores eliminados

| Eliminado | Razón | Categoría que ocupaba | Reemplazo | Razón independiente del reemplazo | Fuente | Verificado | Estado |
|---|---|---|---|---|---|---|---|
| `qwen3.5:72b` | no existe en el registro de Ollama (404) | Chat de gama alta, local | `qwen2.5:72b` | Modelo insignia de la familia Qwen 2.5 realmente publicado; cubre chat multilingüe en workstation, que era el hueco | registry.ollama.ai | 2026-08-04 | **VALIDATED** |
| `glm-5:cloud` | no existe (404); el sufijo `:cloud` no es un mecanismo que MIKA5 soporte | Cloud multilingüe | *ninguno* | El hueco lo cubre la nota general de proveedores cloud: los modelos disponibles los define el catálogo del proveedor, no MIKA5 | — | 2026-08-04 | eliminado sin reemplazo |
| `kimi-k2:cloud` | no existe (404) | Cloud de contexto largo | *ninguno* | Igual que el anterior: Moonshot sigue documentado como proveedor, sin fijar modelos | — | 2026-08-04 | eliminado sin reemplazo |
| `nemotron-3-super:cloud` | sin listado de tags; no verificable | Cloud especialista en código | *ninguno* | No hay adapter de NVIDIA en v0.3.0; documentarlo inducía a error | — | 2026-08-04 | eliminado sin reemplazo |
| `glm-ocr:latest` | sin listado de tags; no verificable | Visión/OCR local | `llama3.2-vision:11b` | Modelo de visión local publicado por Meta y presente en el registro; cubre análisis de imágenes, que es la categoría real que MIKA5 detecta por sonda de capacidades. **No se presenta como equivalente de GLM-OCR**: no se le atribuye especialización en OCR | registry.ollama.ai | 2026-08-04 | **VALIDATED** |
| `qwen2.5-vl:7b` | el tag correcto no lleva guion antes de `vl` | Visión local | `qwen2.5vl:7b` | Corrección ortográfica del mismo modelo, no sustitución | registry.ollama.ai | 2026-08-04 | **VALIDATED** |
| `gemma3:9b` | no existe (404); la familia publica 4b y 12b | Chat local intermedio | `gemma3:12b` | Variante realmente publicada de la misma familia | registry.ollama.ai | 2026-08-04 | **VALIDATED** |
| `phi4:3b` | no existe (404) | Razonamiento compacto | `phi4:14b` | Variante publicada de la misma familia | registry.ollama.ai | 2026-08-04 | **VALIDATED** |

### Fichas eliminadas del Model Guide

Cuatro fichas de modelo y tres tarjetas de la sección «High-End & Cloud»
(`Nemotron-3-Super`, `GLM-5 (Zhipu AI)`, `Kimi K2 (Moonshot AI)`), más los
párrafos que las describían y la mención especulativa «Qwen3.5 (if available
via Ollama in your region)». El markup quedó equilibrado: 144 `<div>` abiertos
y 144 cerrados.

### Separación local / cloud

- **Local vía Ollama, VALIDATED:** `llama3.2:3b`, `qwen2.5:3b/7b/14b/72b`, `qwen2.5vl:7b/72b`, `llava:13b`, `llama3.2-vision:11b`, `deepseek-r1:7b/14b/70b`, `deepseek-coder-v2:16b`, `mistral:7b`, `gemma2:2b`, `gemma3:12b`, `phi4:14b`, `llama3.1:8b`, `llama3.3:70b`, `qwen2.5-coder:7b/14b/32b`, `starcoder2:15b`, `nomic-embed-text`. Todos con manifiesto 200 en `registry.ollama.ai` el 2026-08-04.
- **Cloud, COMPATIBLE NOT VALIDATED:** los modelos de OpenAI, Anthropic, Groq, Moonshot y Alibaba Cloud Model Studio los expone el proveedor según la cuenta del usuario. MIKA5 los solicita al configurar la clave; la web no fija identificadores.

## A.2 Reconciliación del inventario de assets

La cifra «13/13 responden 200» del informe anterior era engañosa: describía
URLs que yo construí y comprobé, no assets enlazados desde la web. Inventario
real:

| Conjunto | Cantidad | Detalle |
|---|---|---|
| Assets publicados en la release | **15** | 9 instaladores + source.tar.gz + LICENSE + BUILDING.md + COMMUNITY.md + BUILD-METADATA.json + SHA256SUMS.txt |
| Entradas en `SHA256SUMS.txt` | **14** | los 15 menos el propio `SHA256SUMS.txt`: un fichero no puede contener su propio hash. Cobertura completa |
| Enlazados hoy desde la web | **8** | 7 instaladores + LICENSE |
| Publicados pero no enlazados | **7** | `MIKA5-0.3.0-mac-arm64.zip`, `MIKA5-0.3.0-mac-x64.zip`, `MIKA5-0.3.0-source.tar.gz`, `SHA256SUMS.txt`, `BUILDING.md`, `COMMUNITY.md`, `BUILD-METADATA.json` |

**Decisión sobre los 7 no enlazados:**

- Los dos `.zip` de macOS son redundantes con los `.dmg` para el usuario final:
  se mantienen publicados, sin enlace en la web. Deliberado.
- `source.tar.gz`, `SHA256SUMS.txt`, `BUILDING.md`, `COMMUNITY.md` y
  `BUILD-METADATA.json` **deben enlazarse**: los tres primeros son obligación
  práctica de la AGPL y de la verificación de integridad. Entran en la Fase V
  (punto B), dentro de las tarjetas de descarga existentes.

Los 13 enlaces que verifiqué con HTTP 200 siguen siendo válidos como
comprobación de que esos assets existen y son descargables; lo que no era
cierto es que la web los ofreciera todos.

## A.3 Elementos aprobados y diferidos a la Fase V

Aprobados por Roxana, pendientes de implementación **completa en ES y EN, sin
rediseño**:

| Ref | Elemento | Ubicación acordada |
|---|---|---|
| **V-A** | Novedades de v0.3.0 | dentro de un contenedor ya existente, sin nuevo lenguaje visual |
| **V-B** | Source, `SHA256SUMS.txt`, aviso de SmartScreen y de macOS sin notarizar | como enlaces y notas secundarias dentro de las tarjetas de descarga actuales; sin cuadrícula nueva |
| **V-C** | Etiquetas `IMPLEMENTED IN v0.3.0` / `PLANNED` / `EXPERIMENTAL` / `NOT INCLUDED IN COMMUNITY` | como texto dentro de los `<li>` existentes del roadmap del White Paper; sin badges ni componentes nuevos |

## A.4 Bloqueo previo al despliegue

**`WEBSITE_REAL_SCREENSHOTS_REQUIRED`**

El mockup HTML/CSS del hero y cualquier otra representación de la interfaz
anterior pueden permanecer durante el trabajo de traducción, pero **no pueden
llegar al despliegue final**. Antes de publicar deben sustituirse por capturas
auténticas de MIKA5 v0.3.0 conservando contenedor, dimensiones y tratamiento
visual.

Capturas que faltan de Roxana: `settings-providers`, `visual-routing`,
`cloud-consent` (detalle y advertencias en `site-validation-v0.3.0.md`).

---

# Apéndice B — Catálogo final del Model Guide (2026-08-04)

## B.1 Fuentes de verdad de esta pasada

| Afirmación | Evidencia |
|---|---|
| Existencia de cada etiqueta | `HEAD https://registry.ollama.ai/v2/library/<modelo>/manifests/<tag>` → 200, las 27 comprobadas |
| Tamaño en disco | suma de `layers[].size` del manifiesto, redondeada a un decimal |
| Parámetros y cuantización | `model_type` y `file_type` del blob de configuración del manifiesto |
| `llama3.2` = `llama3.2:3b` | mismo digest de configuración `34bb5ab01051` en `latest` y en `3b` |
| Modelo de embeddings por defecto | `src/main/rag.js:7` `EMBED_MODEL_DEFAULT = "nomic-embed-text"` |
| Descarga sugerida por la app | `src/renderer/app.js:6025` `pullModel('llama3.2')` en el estado vacío |
| Detección de visión local | `src/main/provider-capabilities.js` — `local` usa `vision: { policy: 'probe' }` (sonda `/api/show`); `openai` y `anthropic` usan `allowlist`; `groq` y `moonshot` están en `pending`; `alibaba` en `catalog`; `llamacpp` en `none` |
| Cifrado de la API key | `src/main/ai-providers.js:81` `aes-256-gcm` |

Fecha de verificación de todo lo anterior: **2026-08-04**.

## B.2 Catálogo final — 26 modelos

Todos locales vía Ollama. Fuente oficial de cada uno:
`https://ollama.com/library/<modelo>`.

| # | Identificador exacto | Categoría | Ejecución | Proveedor | Tamaño (Q4) | Parámetros | Cuantización | Hardware | Caso de uso | Estado |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `llama3.2:3b` | Chat | Local | Meta | 2,0 GB | 3.2B | Q4_K_M | 8 GB RAM, CPU | Chat de entrada | **VALIDATED IN MIKA5 v0.3.0** |
| 2 | `qwen2.5:3b` | Chat | Local | Alibaba | 1,9 GB | 3.1B | Q4_K_M | 8 GB RAM, CPU | Chat multilingüe de entrada | AVAILABLE VIA OLLAMA |
| 3 | `gemma2:2b` | Chat | Local | Google | 1,6 GB | 2.6B | Q4_0 | 8 GB RAM, CPU | Hardware muy limitado | AVAILABLE VIA OLLAMA |
| 4 | `gemma3:4b` | Visión | Local | Google | 3,3 GB | 4.3B | Q4_K_M | 8 GB RAM, CPU | Imágenes en gama de entrada | AVAILABLE VIA OLLAMA |
| 5 | `qwen2.5:7b` | Chat | Local | Alibaba | 4,7 GB | 7.6B | Q4_K_M | 16 GB RAM / 6 GB VRAM | Uso general | AVAILABLE VIA OLLAMA |
| 6 | `llama3.1:8b` | Chat | Local | Meta | 4,9 GB | 8.0B | Q4_K_M | 16 GB RAM / 6 GB VRAM | Chat orientado al inglés | AVAILABLE VIA OLLAMA |
| 7 | `mistral:7b` | Chat | Local | Mistral | 4,4 GB | 7.2B | Q4_K_M | 16 GB RAM / 6 GB VRAM | Salida estructurada, lenguas europeas | AVAILABLE VIA OLLAMA |
| 8 | `deepseek-r1:7b` | Razonamiento | Local | DeepSeek | 4,7 GB | 7.6B | Q4_K_M | 16 GB RAM / 6 GB VRAM | Razonamiento explícito | AVAILABLE VIA OLLAMA |
| 9 | `qwen2.5-coder:7b` | Código | Local | Alibaba | 4,7 GB | 7.6B | Q4_K_M | 16 GB RAM / 6 GB VRAM | Programación | AVAILABLE VIA OLLAMA |
| 10 | `qwen2.5vl:7b` | Visión | Local | Alibaba | 6,0 GB | 8.3B | Q4_K_M | 16 GB RAM / 8 GB VRAM | Análisis de imágenes | AVAILABLE VIA OLLAMA |
| 11 | `llama3.2-vision:11b` | Visión | Local | Meta | 7,8 GB | 10.7B | Q4_K_M | 16 GB RAM / 8 GB VRAM | Entrada de imágenes | AVAILABLE VIA OLLAMA |
| 12 | `gemma3:12b` | Visión | Local | Google | 8,2 GB | 12.2B | Q4_K_M | 32 GB RAM / 12 GB VRAM | Texto e imágenes | AVAILABLE VIA OLLAMA |
| 13 | `llava:13b` | Visión | Local | LLaVA | 8,0 GB | 13B | Q4_0 | 16 GB RAM / 10 GB VRAM | Descripción de imágenes | AVAILABLE VIA OLLAMA |
| 14 | `qwen2.5:14b` | Chat | Local | Alibaba | 9,0 GB | 14.8B | Q4_K_M | 32 GB RAM / 12 GB VRAM | Documentos largos | AVAILABLE VIA OLLAMA |
| 15 | `qwen2.5-coder:14b` | Código | Local | Alibaba | 9,0 GB | 14.8B | Q4_K_M | 32 GB RAM / 12 GB VRAM | Código multiarchivo | AVAILABLE VIA OLLAMA |
| 16 | `deepseek-r1:14b` | Razonamiento | Local | DeepSeek | 9,0 GB | 14.8B | Q4_K_M | 32 GB RAM / 12 GB VRAM | Cadenas de razonamiento largas | AVAILABLE VIA OLLAMA |
| 17 | `phi4:14b` | Razonamiento | Local | Microsoft | 9,1 GB | 14.7B | Q4_K_M | 32 GB RAM / 12 GB VRAM | STEM | AVAILABLE VIA OLLAMA |
| 18 | `starcoder2:15b` | Código | Local | BigCode | 9,1 GB | 16B | Q4_0 | 32 GB RAM / 12 GB VRAM | Relleno intermedio | AVAILABLE VIA OLLAMA |
| 19 | `deepseek-coder-v2:16b` | Código | Local | DeepSeek | 8,9 GB | 15.7B | Q4_0 | 32 GB RAM / 12 GB VRAM | Código, mezcla de expertos | AVAILABLE VIA OLLAMA |
| 20 | `qwen2.5-coder:32b` | Código | Local | Alibaba | 19,9 GB | 32.8B | Q4_K_M | 64 GB RAM / 24 GB VRAM | Código en workstation | AVAILABLE VIA OLLAMA |
| 21 | `llama3.3:70b` | Chat | Local | Meta | 42,5 GB | 70.6B | Q4_K_M | 64 GB RAM / 48 GB VRAM | Chat en workstation | AVAILABLE VIA OLLAMA |
| 22 | `deepseek-r1:70b` | Razonamiento | Local | DeepSeek | 42,5 GB | 70.6B | Q4_K_M | 64 GB RAM / 48 GB VRAM | Razonamiento en workstation | AVAILABLE VIA OLLAMA |
| 23 | `qwen2.5:72b` | Chat | Local | Alibaba | 47,4 GB | 72.7B | Q4_K_M | 64 GB RAM / 48 GB VRAM | Chat multilingüe en workstation | AVAILABLE VIA OLLAMA |
| 24 | `qwen2.5vl:72b` | Visión | Local | Alibaba | 48,7 GB | 73.4B | Q4_K_M | 64 GB RAM / 48 GB VRAM | Visión en workstation | AVAILABLE VIA OLLAMA |
| 25 | `nomic-embed-text` | Embeddings | Local | Nomic | 274 MB | 137M | F16 | Cualquiera | Indexación RAG | **VALIDATED IN MIKA5 v0.3.0** |
| 26 | `mxbai-embed-large` | Embeddings | Local | Mixedbread | 670 MB | 334M | F16 | Cualquiera | Indexación RAG alternativa | AVAILABLE VIA OLLAMA |

**Cloud:** OpenAI, Anthropic, Groq, Moonshot y Alibaba Cloud Model Studio.
Estado **PROVIDER ADAPTER COMPATIBLE, NOT VALIDATED**. No se fija ningún
identificador: el catálogo lo define el proveedor y la cuenta del usuario.
Alibaba se describe como proveedor implementado con endpoint compatible con
Anthropic y catálogo, región y facturación configurables; no se nombran sus
modelos porque el tag publicado v0.3.0 no los fija.

**FUTURE / NOT INCLUDED:** vLLM y otros runtimes de servidor, trabajo en
equipo, sincronización cloud, clientes móviles y agentes en segundo plano.

Sólo dos modelos llevan **VALIDATED IN MIKA5 v0.3.0**, y con motivo escrito:
`nomic-embed-text` porque el motor RAG lo fija como valor por defecto, y
`llama3.2:3b` porque es la descarga que la propia app ofrece en el estado
vacío. Del resto se afirma únicamente que su etiqueta existe en el registro
oficial y que MIKA5 puede ejecutarla.

## B.3 Defectos de contenido corregidos

| # | Defecto en el Model Guide | Corrección |
|---|---|---|
| C-01 | Ficha de `phi4:14b` en la gama de entrada con descripción de la variante 3B y «~2 GB» sobre un modelo de 14,7B y 9,05 GB. Herencia de la sustitución `phi4:3b` → `phi4:14b` | Ficha retirada de la gama de entrada. `phi4:14b` queda en gama alta con su texto y sus cifras propias |
| C-02 | Ficha de `gemma3:12b` describiendo «Gemma 3 9B», «el modelo de 9B» y «6 GB de VRAM», con «~5,8 GB» frente a 8,15 GB reales. Herencia de `gemma3:9b` → `gemma3:12b` | Texto reescrito para 12B, tamaño corregido y ficha movida a gama alta, que es donde encaja por VRAM |
| C-03 | Tarjeta «Qwen3.5 / Qwen3» que nombraba una familia sin etiqueta publicada, ejecutaba `ollama pull qwen2.5:72b` y afirmaba paridad con «los mejores modelos cloud de 2024» | Tarjeta eliminada. La sección pasa a ser «Proveedores cloud», con los cinco adaptadores realmente implementados |
| C-04 | Tabla de workstation con «Best overall», «Top MMLU», «Near o1 quality», «Near GPT-4 on HumanEval», «Exceeds GPT-4V on TextVQA» | Sustituidas por la función de cada modelo, sus parámetros y su tamaño real |
| C-05 | Restos del borrado anterior de benchmarks: «MATH: see model card», «MMLU: see model card», «MT-Bench: see model card/10», «GSM8K: see model card» | Eliminados; en su lugar, los tamaños verificados de cada variante |
| C-06 | «approaching human expert level» (deepseek-r1), «matches or exceeds Llama 3.3 70B» (qwen2.5), «Tops most vision benchmarks» (qwen2.5vl), «near o1-level» (deepseek-r1:14b), «The best local code models» (qwen2.5-coder) | Reescritos sin comparaciones ni superlativos |
| C-07 | «Mistral 7B offers better results than Llama equivalents for European language tasks» | Reescrito: se recomienda probar sobre el material propio, sin afirmar superioridad |
| C-08 | `<title>`, `description`, Open Graph, Twitter y JSON-LD anunciaban «Benchmarks» que la guía ya no publica | Reescritos: modelos locales, hardware y casos de uso |
| C-09 | JSON-LD `FAQPage` citaba `Phi-4-mini` y `DeepSeek-Coder-V2-Lite`, etiquetas que no están en el catálogo, y «highest coding benchmarks» | Reescrito con etiquetas verificadas y sus tamaños reales |
| C-10 | Pie: «Benchmark scores are approximate» | «Tags y tamaños verificados contra registry.ollama.ai el 4 de agosto de 2026» |
| C-11 | Navegación «Jump to benchmarks →» apuntando a un ancla cuyo título ya era «Practical Guidance» | «Ir a la tabla práctica →», ancla `#practical-table` |
| C-12 | Cifras de velocidad por modelo («6–10 tok/s CPU», «30–55 tok/s GPU») y ventanas de contexto, sin fuente y dependientes del equipo de cada usuario | Sustituidas por parámetros y cuantización del manifiesto. La regla de la página es ahora explícita: toda cifra sale del manifiesto oficial |
| C-13 | Tamaños desviados: `qwen2.5:72b` 44 → **47,4 GB**; `qwen2.5vl:72b` 44 → **48,7 GB**; `llama3.3:70b` 40 → **42,5 GB**; `qwen2.5vl:7b` 5,5 → **6,0 GB**; `mistral:7b` 4,1 → **4,4 GB**; `gemma2:2b` 1,5 → **1,6 GB** | Corregidos contra el manifiesto |
| C-14 | La tabla de workstation quedaba recortada en móvil (`overflow-hidden`) | `overflow-x-auto`, con scroll interno verificado a 320 y 375 px |

## B.4 Modelo añadido

| Añadido | Categoría que cubre | Razón independiente | Fuente | Verificado | Estado |
|---|---|---|---|---|---|
| `gemma3:4b` | Visión en gama de entrada | La gama de 8 GB no tenía ninguna opción que aceptase imágenes: era la única categoría vacía del cuadro. Es la compilación multimodal publicada más pequeña que cabe en ese presupuesto (3,3 GB). **No se presenta como equivalente de ningún modelo retirado** y su ficha advierte de que la entrada de imágenes depende de la sonda de capacidades | registry.ollama.ai | 2026-08-04 | AVAILABLE VIA OLLAMA |

`qwen2.5-coder:7b` no es un modelo nuevo: ya figuraba en la tabla de la guía y
ahora también tiene ficha en su gama.

## B.5 Estado de las secciones exigidas

| Sección exigida | Dónde está |
|---|---|
| Modelos locales vía Ollama | `#hardware-tiers`, cuatro gamas |
| Proveedores cloud | `#cloud`, sección propia |
| Embeddings | `#embedding` y `#documents` |
| Visión | `#vision` |
| Programación | `#coding` |
| Razonamiento | `#reasoning` |
| Documentos y RAG | `#documents` (**sección nueva**) |
| Recomendaciones 8 GB / 16 GB / workstation | `#entry-level`, `#mid-range`, `#high-end`, `#workstation` |
| Privacidad máxima | `#privacy` (**sección nueva**) |
| Probados frente a compatibles sin probar | leyenda de estados y columna «Estado y notas» de `#practical-table` |
| Funciones futuras no incluidas | nota final de `#practical-table`, estado FUTURE / NOT INCLUDED |

## B.6 Enlaces y comandos

Los 27 manifiestos consultados devolvieron 200. Los comandos `ollama pull` de
la guía cubren 23 etiquetas distintas y todas figuran en el catálogo de B.2.
No hay ningún comando que descargue un modelo que la guía no documente, ni
ninguna ficha sin su comando. La sección cloud no contiene comandos
`ollama pull`: verificado por la suite.

---

# Apéndice C — Auditoría factual del White Paper (2026-08-04)

Commit auditado: `f87e2cefdb24eed1d4404495c37d51b3fc8aca75` (tag `v0.3.0`), que es
además el `HEAD` de la rama `chore/website-v0.3.0`.

## C.0 Reconciliación: 27 manifiestos frente a 26 modelos

El Apéndice B decía «las 27 comprobadas» y «los 27 manifiestos». La cifra era
imprecisa: contaba el primer lote de verificación y dejaba fuera consultas
posteriores. Recuento exacto, repetido el 2026-08-04:

| Concepto | Cantidad |
|---|---|
| Etiquetas distintas consultadas en `registry.ollama.ai` | **29** |
| Respuestas 200 | **29** |
| Modelos publicados en el Model Guide | **26** |

La diferencia son tres entradas, y ninguna es un descarte por fallo:

| Etiqueta | Motivo de la diferencia |
|---|---|
| `llama3.2:1b` | Verificada como candidata para la gama de entrada. No se publica: `llama3.2:3b` cubre esa casilla con mejor calidad y el mismo presupuesto de memoria |
| `gemma3:27b` | Verificada al comprobar la familia Gemma 3. No se publica: excede la gama alta y duplicaría a `qwen2.5:72b` sin aportar categoría nueva |
| `llama3.2:latest` | **Alias, no modelo.** Mismo digest de configuración que `llama3.2:3b` (`34bb5ab01051`). Se consultó para demostrar que el botón `pullModel('llama3.2')` de la app descarga exactamente la ficha publicada |

Es decir: 29 consultas, 2 modelos verificados y no publicados por decisión
editorial, 1 alias que resuelve a un modelo ya publicado, 26 fichas finales.

## C.1 Clasificación de las afirmaciones del White Paper

Cada afirmación del documento anterior, contrastada contra el código del tag.

### REMOVE — falsas o no sostenibles

| Afirmación anterior | Realidad en v0.3.0 |
|---|---|
| «basic **PII sanitization**… email, phone… replaced with `[EMAIL]`, `[PHONE]`, `[ID]` before transmission» | No existe. `AIProviderManager` fija `sanitizeCloud = false` y lo propaga a cada adapter. `CLAUDE.md` prohíbe describir MIKA5 como saneador de prompts |
| «MIKA5 makes **zero outbound network requests**» | Falso en cuanto hay proveedor cloud, catálogo de modelos o descarga de imagen generada |
| «User Interface Layer (Renderer — **sandboxed**)» en el diagrama | `src/main/main.js` fija `sandbox: false` en la ventana principal |
| «The renderer… **cannot make network requests to external services**» sin explicar por qué | Cierto, pero por la CSP `connect-src 'none'` de `src/renderer/index.html`, no por el modelo de procesos. Faltaba la causa |
| «models like Qwen2.5 72B… **perform comparably to GPT-4**… often surpass it» | Comparación de benchmark sin fuente. Prohibida por la misma regla aplicada al Model Guide |
| «Alibaba releases Qwen with multilingual breadth that **outpaces Western models**» | Comparación sin fuente (ya señalada como W-14) |
| «A **name-based fallback** handles models that don't respond to the show endpoint» | Contradice `provider-capabilities.js`, cuyo propósito declarado es que MIKA5 **nunca** deduzca una capacidad del nombre |
| «Groq… **dramatically higher token throughput** than most alternatives» | Comparación de rendimiento sin fuente |
| «Kimi's models feature… **up to 256k tokens**» | Cifra de catálogo del proveedor, no verificable desde el repositorio |
| «Vision capabilities are supported for **GPT-4o and GPT-4-turbo**» | Incompleto: la allowlist real cubre además `gpt-4.1*`, `gpt-5*`, `o3*` y `o4-mini*` |
| «SHA256SUMS.txt **covering every asset**» | Cubre 14 de 15: un archivo de checksums no puede contener su propio hash |
| «Markdown rendering uses `marked.js` **with sanitization**» | Impreciso: el saneado lo hace **DOMPurify**, incorporado en `src/renderer/vendor/purify.min.js` |
| «This is version **0.1.0**» y «Version 0.1.0 · April 2026» | Dos versiones por detrás |

### IMPLEMENTED IN v0.3.0 — verificado

| Afirmación | Evidencia |
|---|---|
| Electron con proceso principal y renderer separados | `src/main/main.js`, `src/main/preload.js` |
| `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` | `src/main/main.js:44-46` |
| Ventana de PDF en sandbox | `src/main/print-export.js:75` `sandbox: true` |
| CSP con `connect-src 'none'` | `src/renderer/index.html:5` |
| SQLite con WAL y claves foráneas activadas | `src/main/db.js:120-121` |
| Seis tablas: `app_state`, `projects`, `chats`, `messages`, `knowledge_items`, `knowledge_chunks` | `src/main/db.js` |
| RAG: 4.200 caracteres, 700 de solape, top-k 3 acotado a 1–10, caché de 5 minutos | `src/main/rag.js:10,12,13,19,307` |
| Ámbito de conocimiento por proyecto y chat | `src/main/rag.js:24` `scopeKey` |
| `nomic-embed-text` como modelo de embeddings por defecto | `src/main/rag.js:7` |
| Siete adaptadores: local, openai, anthropic, groq, moonshot, alibaba, llamacpp | `src/main/ai-providers.js:1233,1326,1409,1534,1624,1702,1862` |
| Políticas de visión: `probe`, `allowlist`, `catalog`, `pending`, `none` | `src/main/provider-capabilities.js:78,95,112,132,150,167,188` |
| Consentimiento cloud versionado, por proveedor y proyecto, revocable | `src/renderer/cloud-consent.js:8,36` |
| API key cifrada con AES-256-GCM, `safeStorage` con reserva `scryptSync` | `src/main/ai-providers.js:46-50,68,81` |
| DOMPurify con allowlist y hook `afterSanitizeAttributes` | `src/renderer/app.js:1898-1930`, `src/renderer/vendor/purify.min.js` |
| Descarga de imagen acotada: rangos privados, redirecciones, tamaño máximo, MIME por bytes | `src/main/network-security.js:7,21,31,32,46,50` |
| Cancelación por `requestId` validado, con rechazo de duplicados | `src/main/request-registry.js:10-23` |
| Exportación a `.md`, `.txt`, `.html`, `.py` y PDF | `src/renderer/app.js` `doExport`; PDF por `src/main/print-export.js` |
| Generación de imagen como herramienta interna `generate_image` | `src/main/ai-providers.js:1094-1115` |
| Cero telemetría, analítica o informes de fallos | `grep -riE "telemetry|analytics|mixpanel|posthog|sentry|gtag\("` sobre `src/main`, `src/renderer` y `package.json` → **0** |
| Sin actualizador automático | `grep -rn "autoUpdater|electron-updater|checkForUpdates"` → **0** |
| Nueve instaladores por release | `electron-builder.json` y los assets publicados |
| 15 assets y 14 entradas en `SHA256SUMS.txt` | API de la release v0.3.0 y descarga del propio archivo |
| AGPL-3.0 | `LICENSE`, `package.json:9` |
| `SECURITY.md`, `TRADEMARK.md`, `BUILDING.md`, `COMMUNITY.md` presentes | raíz del repositorio |
| Aislamiento de `userData` en las pruebas de Electron | `scripts/run-electron-test.js`, `test/electron-test-isolation.test.js` |
| Menú nativo por plataforma | `src/main/application-menu.js` |

### PLANNED — sin implementar

Streaming de tokens · arrastrar y soltar documentos · herramientas definidas
por el usuario · interfaz de gestión de modelos · exportar e importar bases de
conocimiento · sistema de extensiones.

### EXPERIMENTAL — sin evaluar

Recuperación híbrida con BM25/FTS5 · enrutado de consultas entre modelos de
chat según el tipo de pregunta. (El enrutado **visual** —texto frente a
análisis o generación de imagen— sí está implementado; lo que no existe es la
clasificación de la pregunta para elegir modelo de chat.)

### NOT INCLUDED IN COMMUNITY

Sincronización entre equipos · cliente móvil · agentes remotos o continuos ·
trabajo en equipo, cuentas y permisos · marketplace · actualizador automático ·
vLLM y otros runtimes de servidor.

`vLLM` se menciona **una sola vez**, como posible infraestructura de una futura
edición Pro o Cloud, y con la etiqueta «No incluido en Community». No hay
adaptador de vLLM en `ai-providers.js`.

## C.2 Correcciones de seguridad aplicadas

| # | Corrección |
|---|---|
| W-15 | Eliminada toda mención a sanitización de PII y a sustitución por tokens. El documento declara ahora que **no hay redacción automática** y que cualquier redacción futura será opcional, visible y auditable |
| W-16 | Eliminado «zero outbound network requests». La sección 4 enumera de forma expresa las peticiones de salida que sí existen: envío al proveedor, catálogo de modelos y descarga de imagen generada |
| W-17 | Eliminado el rótulo «Renderer — sandboxed» del diagrama y sustituido por la configuración real. El documento **afirma explícitamente que el renderer no está en sandbox** y explica de dónde viene entonces la garantía: preload acotado, sin Node, y CSP con `connect-src 'none'` |
| W-18 | Diferenciadas las dos ventanas: principal con `sandbox: false`, ventana de PDF con `sandbox: true` |
| W-19 | Añadido que, una vez autorizado un proveedor cloud, **rigen sus políticas de retención y contenido** y MIKA5 no puede alterarlas. Se retira cualquier lectura de «cloud sin riesgo» |
| W-20 | Sustituido «marked.js with sanitization» por la descripción real: DOMPurify incorporado, con allowlist explícita y hook posterior al saneado |
| W-21 | Eliminada la detección de visión por nombre. Se describen las cinco políticas reales y se declara que las capacidades nunca se deducen del nombre del modelo |
| W-22 | Corregida la cobertura de `SHA256SUMS.txt`: 14 de 15, con el motivo escrito |

## C.3 Contenido nuevo, sólo sobre lo demostrado

Secciones añadidas o reescritas para cubrir v0.3.0: CSP del renderer ·
DOMPurify · descargas acotadas de imagen · cancelación por `requestId` ·
enrutado multimodal y herramienta `generate_image` · adjuntos sin memoria
visual persistente · exportación en cinco formatos · ámbito de conocimiento ·
aislamiento de `userData` en pruebas (situado como práctica de ingeniería, no
como función de usuario) · licencia, fuente correspondiente y verificación de
la release · ediciones Community, Pro y Cloud con su estado.

## C.4 Resumen por clasificación (White Paper)

| Clasificación | Recuento |
|---|---|
| REMOVE — falsa o no sostenible | 13 |
| IMPLEMENTED IN v0.3.0 | 26 |
| PLANNED | 6 |
| EXPERIMENTAL | 2 |
| NOT INCLUDED IN COMMUNITY | 7 |
