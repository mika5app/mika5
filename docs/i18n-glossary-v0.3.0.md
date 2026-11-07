# Glosario de traducción ES/EN — MIKA5 v0.3.0

Referencia obligatoria para toda traducción del sitio. El objetivo es que el
español lea como escrito en español, no como inglés traducido, manteniendo la
precisión técnica.

## Términos con traducción fijada

| Inglés | Español | Nota |
|---|---|---|
| local-first | local-first | Se conserva: es un término de arquitectura ya establecido y no tiene equivalente breve. En prosa larga puede acompañarse de «local por defecto» como aclaración |
| workspace | espacio de trabajo | Nunca «workspace» suelto |
| project | proyecto | |
| chat | chat | Establecido en español; el plural es «chats» |
| Quick Chat | Chat rápido | Nombre de función; coincide con la UI española de la app |
| retrieval-augmented generation | generación aumentada por recuperación | Se usa la forma larga la primera vez y **RAG** en adelante |
| RAG | RAG | Sigla invariable |
| provider | proveedor | |
| cloud provider | proveedor cloud | «cloud» se mantiene en español: «proveedor en la nube» también es válido, pero se ha fijado «proveedor cloud» por coherencia con la UI |
| consent | consentimiento | |
| explicit authorization | autorización explícita | |
| to authorize | autorizar | |
| model routing | enrutado de modelo | |
| visual routing | enrutado visual | |
| source code | código fuente | |
| corresponding source | fuente correspondiente | Término de la AGPL; se traduce así en la propia licencia |
| checksum | checksum | Se conserva; «suma de verificación» sólo si el contexto lo pide |
| knowledge base | base de conocimiento | |
| embedding | embedding | Invariable en plural: «embeddings» |
| prompt | prompt | Invariable |
| chunk / chunking | fragmento / fragmentación | |
| attachment | adjunto | |
| composer | compositor | Coincide con la nomenclatura interna del proyecto |
| empty state | estado vacío | |
| collapse / expand | colapsar / expandir | Coincide con la UI de v0.3.0 |
| release | release | Se conserva; «versión publicada» si el contexto lo permite |
| installer | instalador | |
| notarization | notarización | |
| offline-ready | funciona sin conexión | Se evita el calco |

## Ediciones del producto

| Inglés | Español | Regla |
|---|---|---|
| Community | Community | Nombre de edición: invariable |
| Pro | Pro | Invariable |
| Cloud (edición) | Cloud | Invariable cuando nombra la edición futura |
| in development | en desarrollo | Fórmula fijada para Pro y Cloud |

Pro y Cloud se describen siempre en futuro o como «en desarrollo». Nunca
«disponible», «available» ni equivalentes.

## No se traducen nunca

MIKA5 · Ollama · llama.cpp · OpenAI · Anthropic · Groq · Moonshot ·
Alibaba Cloud Model Studio · GitHub · Electron · SQLite · Chromium ·
AppImage · DMG · NSIS · deb · rpm · AGPL-3.0 · AES-256-GCM · WAL · IPC

Tampoco: identificadores de modelo (`llama3.2:3b`, `qwen2.5vl:7b`,
`nomic-embed-text`…), comandos (`ollama pull`, `sha256sum`, `Get-FileHash`…),
nombres de archivo de la release, hashes, rutas y URLs.

## Criterio para textos idénticos en ambos idiomas

Un texto puede quedar igual en ES y EN sólo si es un nombre propio, un nombre
de plataforma, un formato de paquete, una cadena de versión o una palabra
idéntica en las dos lenguas (por ejemplo «Legal»). Cada caso está declarado en
la allowlist de `test/website-i18n.test.js` con su motivo. La suite falla si
alguien añade una excepción que en realidad sí está traducida.

## Registro y tono

- Tuteo: «tus datos», «cuando tú lo autorizas». Coherente con la UI de la app.
- Sin exclamaciones ni superlativos publicitarios.
- Frases cortas. El español tiende a alargarse un 15–20 % frente al inglés:
  conviene comprimir antes que dejar que el texto rompa el diseño.
- Ortografía completa: acentos y signos de apertura (¿ ¡) siempre.

## Términos añadidos en la Fase III (Model Guide)

| Inglés | Español | Nota |
|---|---|---|
| hardware tier | gama de hardware | «Gama de entrada», «gama media», «gama alta». **Workstation** se conserva sin traducir: es el nombre de la categoría |
| entry level | gama de entrada | |
| mid range | gama media | |
| high end | gama alta | |
| build (de un modelo) | compilación | «La compilación de 4b», no «la construcción» |
| weights | pesos | |
| quantization | cuantización | Los nombres de formato (`Q4_K_M`, `Q4_0`, `F16`) no se traducen |
| context window | ventana de contexto | |
| capability probe | sonda de capacidades | Nombre del mecanismo real de `provider-capabilities.js` |
| fill-in-the-middle | relleno intermedio | |
| mixture of experts | mezcla de expertos | |
| model card | ficha del modelo | Se refiere a la página oficial del modelo en `ollama.com/library` |
| tag (de Ollama) | tag | Invariable. Nunca «etiqueta» cuando designa `modelo:variante`, para no confundirlo con las etiquetas de la interfaz |
| offloading (a CPU) | descarga a CPU | |
| throughput | rendimiento por segundo | Se evita «throughput» suelto |
| reasoning model | modelo de razonamiento | |
| chain of thought | razonamiento explícito | Se evita el calco «cadena de pensamiento» |
| distillation | destilación | |
| opt-out (política) | exclusión voluntaria | |
| benchmark | benchmark | Invariable. La guía sólo lo usa para decir que **no** publica puntuaciones |
| benchmark score | puntuación de benchmark | |
| evaluation harness | arnés de evaluación | |
| image input | acepta imágenes | Como etiqueta de ficha; en prosa, «entrada de imágenes» |
| registry | registro | «El registro oficial de Ollama» |
| manifest | manifiesto | |
| Vision (etiqueta) | Visión | |
| Code (etiqueta) | Código | |
| Chat (etiqueta) | Chat | Invariable, ya fijado arriba |
| Embedding (rol en tabla) | Embeddings | El inglés usa singular como nombre de rol; el español usa el plural ya fijado |

## Estados del catálogo

Vocabulario canónico en inglés para la auditoría, con su forma publicada en
español. Los cuatro aparecen traducidos en la página:

| Canónico (auditoría) | Publicado en ES |
|---|---|
| VALIDATED IN MIKA5 v0.3.0 | VALIDADO EN MIKA5 v0.3.0 |
| AVAILABLE VIA OLLAMA | DISPONIBLE VÍA OLLAMA |
| PROVIDER ADAPTER COMPATIBLE, NOT VALIDATED | COMPATIBLE POR ADAPTADOR, SIN VALIDAR |
| FUTURE / NOT INCLUDED | FUTURO / NO INCLUIDO |

## Cifras y separador decimal

El español usa **coma decimal**: «4,7 GB», «14,8B parámetros». El inglés usa
punto. Por eso los tamaños y los recuentos de parámetros llevan clave propia en
el diccionario en lugar de dejarse como texto fijo: la ortografía cambia con el
idioma aunque el número no.

Las cifras en megabytes sin decimales («274 MB», «670 MB») quedan idénticas en
ambos idiomas y están declaradas como tales en la allowlist de la suite.

## Términos añadidos en la Fase IV (White Paper)

| Inglés | Español | Nota |
|---|---|---|
| threat model | modelo de amenaza | Singular. Se evita «modelo de amenazas» |
| attack surface | superficie de ataque | |
| context isolation | aislamiento de contexto | En prosa se traduce; el ajuste literal `contextIsolation: true` no se toca |
| sandbox | sandbox | Invariable. «En sandbox» / «fuera de sandbox». Se evita «aislado», que se confunde con el aislamiento de contexto |
| sandboxed | en sandbox | Nunca «sandboxeado» |
| preload bridge | puente de preload | El archivo se nombra siempre `preload` |
| IPC | IPC | Sigla invariable. «Frontera IPC», «handler IPC» |
| handler | handler | Invariable, coherente con el código |
| corresponding source | fuente correspondiente | Término de la AGPL, ya fijado |
| reproducible build | compilación reproducible | «Reproducir una compilación desde el código fuente» |
| build (sustantivo) | compilación | Ya fijado en la Fase III |
| checksum | checksum | Ya fijado |
| consent scope | ámbito de consentimiento | «Acotado a un proveedor y un proyecto» |
| scope (RAG) | ámbito | «Ámbito de conocimiento», «clave de ámbito» |
| ephemeral visual context | contexto visual efímero | Se describe como «no se acumula en una memoria visual persistente» |
| provider adapter | adaptador de proveedor | «Adaptador» a secas cuando el contexto es claro |
| capability contract | contrato de capacidades | Nombre del mecanismo real de `provider-capabilities.js` |
| local inference | inferencia local | |
| managed service | servicio gestionado | Se usa para la futura edición Cloud |
| managed runtime | runtime gestionado | «Runtime» invariable, ya fijado |
| loopback | loopback | Invariable |
| opt-in | opcional | «Será opcional, visible y auditable». Se evita «opt-in» suelto |
| by default | por defecto | |
| at rest (cifrado) | en reposo | «Las credenciales se cifran en reposo» |
| plaintext | texto claro | |
| authentication tag | etiqueta de autenticación | GCM |
| salt | sal | «Una sal por instalación» |
| key derivation | derivación de clave | |
| redaction | redacción | En el sentido de censurar/ocultar. Se acompaña siempre de «automática» para no confundir con redactar un texto |
| sanitise / sanitiser | sanear / saneador | «Saneado de HTML». Se reserva «sanitización» para nombrar la función desactivada del código |
| path traversal | recorrido de rutas | |
| allowlist | allowlist | Invariable, coherente con el código y con la suite |
| write-ahead logging | registro de escritura anticipada | Se acompaña de la sigla WAL |
| cascade delete | borrado en cascada | |
| top-k | top-k | Invariable |
| dense retrieval | recuperación densa | |
| hybrid retrieval | recuperación híbrida | |
| token streaming | streaming de tokens | |
| tool use | uso de herramientas | «Herramientas definidas por el usuario» para las futuras |
| agent loop | bucle de agente | |
| edition | edición | Community, Pro y Cloud son nombres de edición: invariables |
| roadmap | hoja de ruta | |

## Estados de la hoja de ruta

Vocabulario canónico en inglés para la auditoría, con su forma publicada en
español. Los cuatro aparecen traducidos en la página:

| Canónico (auditoría) | Publicado en ES |
|---|---|
| Available | Disponible |
| Planned / in development | Planificada — en desarrollo · Planificado |
| Experimental | Experimental |
| Not included in Community | No incluido en Community |

## Coherencia entre las tres páginas

Un mismo término no puede traducirse de dos maneras distintas en la landing, el
Model Guide y el White Paper. Casos revisados en esta fase:

| Término | Forma única | Dónde aparece |
|---|---|---|
| cloud provider | proveedor cloud | las tres páginas |
| knowledge base | base de conocimiento | Model Guide y White Paper |
| embedding / embeddings | embedding / embeddings | Model Guide y White Paper |
| chunk / chunking | fragmento / fragmentación | Model Guide y White Paper |
| capability probe | sonda de capacidades | Model Guide y White Paper |
| Quick Chat | Chat rápido | landing y White Paper |
| build | compilación | Model Guide y White Paper |
| tag | tag | Model Guide y White Paper |
| runtime | runtime | Model Guide y White Paper |
| local-first | local-first | landing y White Paper |
