# Plan de capturas — MIKA5 Community v0.3.0

**Fecha:** 2026-08-04
**Rama:** `chore/website-v0.3.0`
**Estado global:** `REAL_SCREENSHOTS_READY: NO` · las nueve capturas son
`USER_REQUIRED`.

Este documento es la especificación que debe seguir quien genere las capturas.
No se han producido aquí por dos motivos verificados, documentados en el
Apéndice E de `docs/i18n-audit-v0.3.0.md`:

1. `capturePage()` devuelve una imagen de 0×0 en el entorno de trabajo: la
   ventana se crea pero no llega a componerse sin escritorio visible.
2. El desplegable de modelos muestra el inventario real de Ollama de la
   máquina. Son datos reales y además modelos que la web no documenta, varios
   con sufijo `:cloud`, que el sitio describe como no soportado. `ollama.js:5`
   fija `const BASE = "http://127.0.0.1:11434"` sin variable de entorno, así
   que no se puede apuntar la aplicación a un catálogo sintético sin modificar
   código de la app.

---

## 1. Especificación general

Aplica a las nueve capturas.

| Requisito | Valor |
|---|---|
| Formato entregado | **PNG original**. Ni WebP ni recorte por parte de quien captura: la optimización, las dimensiones finales y los `alt` los hace la integración |
| Dimensiones | **1440×900** en las nueve, sin excepción |
| Escala de pantalla | 100 %. Sin zoom del sistema ni del navegador |
| Tema | Oscuro |
| Ventana | Completa de MIKA5 Community v0.3.0, sin recortar por el usuario |
| Versión | Exactamente v0.3.0. No sirven capturas de versiones anteriores |
| Datos | Sintéticos, del escenario de la sección 2 |
| Credenciales | Ninguna visible, ni siquiera parcial o enmascarada de una clave real |
| Rutas | Ninguna ruta personal, ni en títulos, ni en tooltips, ni en la barra de título |
| Nombres | Ninguna persona, empresa o marca real |
| Documentos | Ninguno privado ni que aparente ser confidencial |
| Edición | Ninguna. No se retoca la interfaz ni se reconstruye en HTML |
| Selector de modelos | **Cerrado o fuera del encuadre** |
| Lista de modelos | Ninguna lista real de la máquina puede quedar visible |
| Notificaciones | Ninguna del sistema operativo visible |
| Cursor | Fuera del área principal, salvo cuando la captura necesite mostrar un estado hover |

### 1.1 Orden de producción recomendado

Minimiza el retrabajo: se monta el escenario una sola vez y se dejan para el
final las que dependen de un proveedor.

| Paso | Qué | Por qué en ese momento |
|---|---|---|
| 1 | Montar el escenario sintético completo de la sección 2 | Se hace una vez y sirve para las nueve |
| 2 | `hero-main`, `projects-rag`, `code-blocks`, `empty-state`, `chat-actions`, `composer` | Las seis que no necesitan ningún proveedor |
| 3 | `settings-providers` con los campos vacíos | El modal se abre sin configurar nada |
| 4 | `cloud-consent`, **antes** de autorizar el envío | Requiere proveedor seleccionado, pero no enviar nada |
| 5 | `visual-routing` con análisis local e imagen neutral | Última, y por la vía que no necesita credenciales |

### 1.2 Revisión antes de entregar

Comprobar en cada PNG, una por una:

- barra superior del sistema y reloj;
- notificaciones del sistema operativo;
- nombres de usuario, en cualquier parte de la ventana;
- rutas visibles en adjuntos o en tooltips;
- nombres reales de modelos en desplegables o listas;
- mensajes de error que muestren endpoints o claves;
- metadatos visibles de documentos.

Cualquiera de los siete invalida la captura: se repite, no se retoca.

---

## 2. Escenario sintético común

Las nueve capturas comparten el mismo escenario, para que no parezcan nueve
sesiones distintas.

**Proyecto:** `Investigación de mercado`

**Descripción del proyecto:** análisis comparativo de soluciones de energía
solar para una empresa ficticia.

**Chats del proyecto:**

1. `Resumen del mercado`
2. `Comparación de proveedores`
3. `Riesgos y recomendaciones`

**Documentos sintéticos de la base de conocimiento:**

| Archivo | Contenido |
|---|---|
| `panorama-energia-solar.md` | Notas generales de mercado, inventadas |
| `proveedores-ejemplo.pdf` | Tres alternativas ficticias con datos inventados |
| `notas-tecnicas.txt` | Notas técnicas breves, inventadas |

Ninguno debe parecer un informe real ni llevar marcas de confidencialidad.

**Consulta de referencia para la conversación:**

> Resume las diferencias principales entre las tres alternativas y cita el
> contexto del proyecto.

**Código de ejemplo** (para `code-blocks`): algo inocuo, como una función de
cálculo de consumo energético o la lectura de un CSV sintético.

**Imagen neutral** (para `visual-routing`): panel solar genérico, diagrama
geométrico, envase ficticio o escritorio sin personas ni marcas.

---

## 3. Fichas de las nueve capturas

### 3.1 `hero-main.png`

| Campo | Valor |
|---|---|
| Contenido | Ventana principal con el proyecto activo y una conversación limpia |
| Estado de la app | Proyecto `Investigación de mercado` abierto, chat `Resumen del mercado` con dos o tres turnos |
| Datos sintéticos | Proyecto, chats y conversación de la sección 2 |
| Debe verse | Barra lateral, cabecera real de v0.3.0, contexto activo señalado, conversación legible |
| Debe quedar fuera | Selector de modelos desplegado, cualquier lista de modelos, avisos cloud |
| Ubicación en la web | `web/landing.html`, hero |
| Contenedor que reemplaza | El mockup HTML/CSS `div.glass-card.rounded-2xl` del hero |
| Proporción | 16:10 aproximada, la del contenedor actual |
| `alt` ES | Ventana principal de MIKA5 v0.3.0 con un proyecto abierto y una conversación en curso |
| `alt` EN | MIKA5 v0.3.0 main window with a project open and a conversation in progress |
| Requiere proveedor cloud | No |
| Estado | `USER_REQUIRED` |

### 3.2 `projects-rag.png`

| Campo | Valor |
|---|---|
| Contenido | Barra lateral con varios proyectos y una respuesta apoyada en contexto RAG |
| Estado de la app | Los tres chats creados, documentos indexados, respuesta a la consulta de referencia |
| Datos sintéticos | Proyecto, chats y los tres documentos de la sección 2 |
| Debe verse | Varios proyectos, el activo claramente marcado, la respuesta citando el contexto del proyecto |
| Debe quedar fuera | Rutas locales de los documentos, selector de modelos, nombres reales |
| Ubicación en la web | `web/landing.html`, bloque de características de proyectos y RAG |
| Contenedor que reemplaza | Ninguno todavía: se integra en el contenedor de la característica correspondiente |
| Proporción | 16:10 |
| `alt` ES | Barra lateral de MIKA5 con varios proyectos y una respuesta que cita el contexto recuperado del proyecto |
| `alt` EN | MIKA5 sidebar with several projects and an answer citing the retrieved project context |
| Requiere proveedor cloud | No |
| Estado | `USER_REQUIRED` |

### 3.3 `code-blocks.png`

| Campo | Valor |
|---|---|
| Contenido | Respuesta del asistente con un bloque de código completo |
| Estado de la app | Conversación donde se pide una función de cálculo de consumo energético |
| Datos sintéticos | Código inocuo, sin credenciales ni rutas |
| Debe verse | Etiqueta de lenguaje, numeración de líneas, botón de copiar y control de colapso |
| Debe quedar fuera | Selector de modelos, cualquier ruta del sistema |
| Ubicación en la web | `web/landing.html`, novedades de v0.3.0, entrada de bloques de código |
| Contenedor que reemplaza | Ninguno: se añade dentro del bloque existente |
| Proporción | 16:10 o recorte al bloque manteniendo la proporción del contenedor |
| `alt` ES | Bloque de código en MIKA5 con etiqueta de lenguaje, numeración de líneas y botones de copiar y colapsar |
| `alt` EN | Code block in MIKA5 showing the language label, line numbers and the copy and collapse controls |
| Requiere proveedor cloud | No |
| Estado | `USER_REQUIRED` |

### 3.4 `empty-state.png`

| Campo | Valor |
|---|---|
| Contenido | Estado vacío auténtico de la aplicación |
| Estado de la app | Perfil recién creado, sin chats, o proyecto sin conversaciones |
| Datos sintéticos | Ninguno necesario más allá del proyecto vacío |
| Debe verse | El texto explicativo real y la acción inicial que ofrece la app |
| Debe quedar fuera | Cualquier lista de modelos de la máquina, datos personales |
| Ubicación en la web | `web/landing.html`, novedades de v0.3.0, entrada de estados vacíos |
| Contenedor que reemplaza | Ninguno |
| Proporción | 16:10 |
| `alt` ES | Estado vacío de MIKA5 explicando la situación y ofreciendo la acción siguiente |
| `alt` EN | MIKA5 empty state explaining the situation and offering the next action |
| Requiere proveedor cloud | No |
| Estado | `USER_REQUIRED` |

### 3.5 `chat-actions.png`

| Campo | Valor |
|---|---|
| Contenido | Menú de acciones de chat abierto |
| Estado de la app | Menú desplegado sobre uno de los chats sintéticos |
| Datos sintéticos | Nombres de chat de la sección 2 |
| Debe verse | El menú auténtico con sus acciones separadas |
| Debe quedar fuera | Cualquier confirmación de acción destructiva ejecutada; no borrar nada para la captura |
| Ubicación en la web | `web/landing.html`, novedades de v0.3.0, entrada de acciones de chat |
| Contenedor que reemplaza | Ninguno |
| Proporción | 16:10 |
| `alt` ES | Menú de acciones de un chat en MIKA5, con las opciones agrupadas y separadas |
| `alt` EN | Chat actions menu in MIKA5, with the options grouped and separated |
| Requiere proveedor cloud | No |
| Estado | `USER_REQUIRED` |

### 3.6 `composer.png`

| Campo | Valor |
|---|---|
| Contenido | Compositor enfocado con texto escrito y sin enviar |
| Estado de la app | Cursor en el área de escritura, con la consulta de referencia tecleada |
| Datos sintéticos | El texto de la consulta de referencia |
| Debe verse | El compositor alineado con la conversación y los controles que existan en v0.3.0 |
| Debe quedar fuera | Controles que no existan en v0.3.0, selector de modelos desplegado |
| Ubicación en la web | `web/landing.html`, novedades de v0.3.0, entrada del compositor |
| Contenedor que reemplaza | Ninguno |
| Proporción | 16:10 o recorte al compositor manteniendo proporción |
| `alt` ES | Compositor de MIKA5 enfocado, alineado con el ancho de la conversación |
| `alt` EN | MIKA5 composer focused and aligned with the width of the conversation |
| Requiere proveedor cloud | No |
| Estado | `USER_REQUIRED` |

### 3.7 `settings-providers.png`

| Campo | Valor |
|---|---|
| Contenido | Modal «Configurar API Key» con las pestañas de proveedores |
| Estado de la app | Modal abierto, sin guardar nada |
| Datos sintéticos | Campos **vacíos**, o valores sintéticos enmascarados que no procedan de una clave real |
| Debe verse | Las pestañas de proveedores y la estructura del modal |
| Debe quedar fuera | Cualquier API key real, aunque esté parcialmente oculta; el portapapeles; mensajes que contengan claves |
| Ubicación en la web | `web/landing.html`, característica de proveedores cloud |
| Contenedor que reemplaza | Ninguno |
| Proporción | 16:10 |
| `alt` ES | Modal de configuración de proveedores de MIKA5 con los campos de clave vacíos |
| `alt` EN | MIKA5 provider settings dialog with the key fields empty |
| Requiere proveedor cloud | **No.** El modal se abre sin configurar ninguno |
| Estado | `USER_REQUIRED` |

### 3.8 `visual-routing.png`

| Campo | Valor |
|---|---|
| Contenido | Conversación con análisis visual o generación de imagen |
| Estado de la app | Imagen neutral adjuntada y respuesta del modelo sobre ella |
| Datos sintéticos | Imagen de la sección 2 |
| Debe verse | El enrutado visual funcionando sobre la imagen neutral |
| Debe quedar fuera | El proveedor y el modelo si el encuadre mostrase inventario real; cualquier contenido personal |
| Ubicación en la web | `web/landing.html`, característica de visión |
| Contenedor que reemplaza | Ninguno |
| Proporción | 16:10 |
| `alt` ES | Conversación de MIKA5 analizando una imagen neutral mediante enrutado visual |
| `alt` EN | MIKA5 conversation analysing a neutral image through visual routing |
| Requiere proveedor cloud | **Depende.** Con un modelo de visión local basta; con generación de imagen sí hace falta proveedor |
| Estado | `USER_REQUIRED` |

### 3.9 `cloud-consent.png`

| Campo | Valor |
|---|---|
| Contenido | Modal de consentimiento cloud |
| Estado de la app | Modal abierto **antes** de enviar nada al proveedor |
| Datos sintéticos | Proyecto y chat de la sección 2 |
| Debe verse | Las categorías reales, el alcance por proveedor y proyecto, y las opciones del modal |
| Debe quedar fuera | Cualquier API key; no hace falta mostrar ninguna |
| Ubicación en la web | `web/landing.html`, característica de consentimiento cloud, y novedades de v0.3.0 |
| Contenedor que reemplaza | Ninguno |
| Proporción | 16:10 |
| `alt` ES | Modal de consentimiento de MIKA5 enumerando qué datos saldrían hacia el proveedor cloud |
| `alt` EN | MIKA5 consent dialog listing what data would leave for the cloud provider |
| Requiere proveedor cloud | **Sí**, un proveedor seleccionado para que el modal aparezca. La captura se toma antes de autorizar el envío |
| Estado | `USER_REQUIRED` |

---

## 4. Resumen de dependencias

| Captura | Requiere proveedor cloud configurado |
|---|---|
| `hero-main` | No |
| `projects-rag` | No |
| `code-blocks` | No |
| `empty-state` | No |
| `chat-actions` | No |
| `composer` | No |
| `settings-providers` | No — el modal se abre sin configurar ninguno |
| `visual-routing` | Sólo si se captura generación de imagen; el análisis puede ser local |
| `cloud-consent` | Sí — hace falta un proveedor seleccionado, pero **no** enviar nada |

Siete de las nueve se pueden producir sin ninguna clave. Ninguna requiere usar
una clave real para el contenido de la imagen.

---

## 5. Qué se hará al recibirlas

En este orden, y no antes:

1. revisión de autenticidad (que sean de v0.3.0 y sin retoque);
2. inspección de secretos, rutas y nombres reales;
3. recorte mínimo si es necesario;
4. optimización a WebP conservando el PNG original;
5. `alt` ES y EN según las fichas de la sección 3;
6. integración dentro de los contenedores ya existentes, con `width` y
   `height` explícitos;
7. validación responsive en 320, 375, 768, 1024 y 1440 px, en ambos idiomas.

Hasta entonces **no** se sustituye el mockup del hero, **no** se añaden
marcadores de posición y **no** se generan imágenes de sustitución. El bloqueo
`WEBSITE_REAL_SCREENSHOTS_REQUIRED` sigue vigente.
