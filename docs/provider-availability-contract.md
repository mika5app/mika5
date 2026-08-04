# Contrato de disponibilidad de proveedores

**Ámbito:** MIKA5 Community v0.3.1
**Congelado en:** `c25124d`
**Implementación:** `src/main/ai-providers.js`, `src/main/provider-errors.js`
**Verificación:** `test/provider-availability.test.js` — 267 comprobaciones

Este documento describe el contrato **tal y como está implementado**. No propone
cambios. Donde el código difiere de una especificación previa, se dice y se deja
la decisión abierta: ver §7.

---

## 1. Por qué existe esta capa

Hasta `1c0fe55`, la disponibilidad de un proveedor era un único booleano.
`status()` devolvía `ok: !!apiKey` para todo proveedor cloud, y el renderer
poblaba el selector de modelos con esa señal. Cuatro preguntas distintas
viajaban colapsadas en una:

- ¿está configurado?
- ¿responde su servidor?
- ¿aceptó la credencial?
- ¿tiene catálogo?

Las consecuencias eran visibles. Una clave inválida se anunciaba como
disponible. La píldora decía «Conectado» mientras el selector decía «Proveedor
no disponible». Y un runtime que no pide credencial no podía estar disponible
nunca, porque `ok` dependía de una clave inexistente.

Dos intentos posteriores fallaron por el mismo motivo de fondo: **afirmar sin
prueba**. El primero dedujo conectividad del hecho de que `listModels()`
devolviera modelos —falso, un catálogo puede estar declarado en el propio
adaptador— y clasificó los fallos con una expresión regular sobre el texto del
error, que cualquier traducción rompía. El segundo perdía la evidencia de un
`2xx` cuando el cuerpo era ilegible.

La regla que gobierna todo lo que sigue: **la ausencia de evidencia se llama
`null` y nunca se presenta como una afirmación.**

---

## 2. Forma del contrato

`AIProviderManager.getAvailability(providerId)` devuelve exactamente estos
campos. La lista es cerrada: nada más cruza al renderer.

| Campo | Tipo | Significado |
|---|---|---|
| `providerId` | `string` | Identificador del proveedor consultado |
| `configured` | `boolean` | Su configuración es utilizable |
| `reachable` | `true \| false \| null` | Su endpoint contestó. `null` = nadie lo ha comprobado |
| `authenticated` | `true \| false \| null` | La credencial fue aceptada. `null` = sin evidencia o no aplica |
| `modelsAvailable` | `number` | Cuántos modelos ofrece |
| `models` | `Array` | El catálogo, para no volver a pedirlo |
| `canAttempt` | `boolean` | **Configurado para intentarlo**, sin verificar |
| `ready` | `boolean` | **Verificado utilizable** |
| `uiState` | `string` | Uno de los ocho de §4 |
| `errorCode` | `string \| null` | Código estable; contrato de traducción |
| `httpStatus` | `number \| null` | Único metadato numérico permitido |

### Lo que NO viaja

No hay campo de mensaje libre. Un error de proveedor puede arrastrar la URL del
endpoint, credenciales incrustadas o el propio token, y el renderer los
mostraría en un tooltip visible y copiable.

El detalle saneado existe —`sanearMensaje()` retira tokens, claves con prefijo
`sk-` y URLs completas— pero **sólo alimenta el log del proceso principal**, vía
`registrarFalloDeProveedor()`. El renderer compone su texto a partir de
`errorCode` y, como mucho, `httpStatus`.

---

## 3. `ready` frente a `canAttempt`

Son dos ejes distintos y confundirlos fue el error de dos versiones seguidas.

```
canAttempt = configured
          && authenticated !== false
          && modelsAvailable > 0
          && !impideUso(errorCode)
          && reachable !== false

ready      = las mismas condiciones, pero exigiendo  reachable === true
```

**`ready` exige evidencia positiva.** Un catálogo declarado por el adaptador y
una clave meramente presente permiten *intentarlo*, pero no prueban nada: el
proveedor puede estar caído y la clave caducada, y sólo el primer envío lo dirá.
Llamar «listo» a eso afirmaba una verificación que nunca ocurrió.

**`canAttempt` es «configurado para intentarlo».** Es lo que usa el renderer
para poblar el selector de modelos, así que la interfaz no pierde nada: Alibaba
sigue ofreciendo su catálogo configurado sin haber hablado con ningún servidor.

Caso de referencia — Alibaba con clave que nadie ha verificado:

```
configured=true  reachable=null  authenticated=null
modelsAvailable=6  canAttempt=true  ready=false  uiState=unknown
```

### `impideUso(errorCode)`

Un error del proveedor bloquea el uso aunque haya catálogo. Importa porque
varios adaptadores **degradan a una lista declarada** cuando su endpoint falla
—groq devuelve cinco modelos fijos—, y ese respaldo no puede convertir un 500 en
un proveedor utilizable.

Bloquean: `PROVIDER_AUTH_REJECTED`, `PROVIDER_FORBIDDEN`,
`PROVIDER_RATE_LIMITED`, `PROVIDER_TRANSPORT_UNREACHABLE`,
`PROVIDER_UNKNOWN_ERROR`, `PROVIDER_RESPONSE_INVALID`, y toda la familia
`PROVIDER_HTTP_*`, que es abierta por definición.

---

## 4. Estados de interfaz

Ocho, cerrados. `resolverUiState()` los deriva por prioridad: primero lo que
depende del usuario, después lo que depende del proveedor, y sólo al final la
conectividad genérica.

| Estado | Cuándo | Color del punto |
|---|---|---|
| `configuration-required` | `configured === false` | Ámbar |
| `authentication-rejected` | `authenticated === false` | Rojo |
| `authorization-forbidden` | `PROVIDER_FORBIDDEN` | Rojo |
| `rate-limited` | `PROVIDER_RATE_LIMITED` | Naranja |
| `provider-error` | `PROVIDER_HTTP_*`, `PROVIDER_RESPONSE_INVALID`, `PROVIDER_UNKNOWN_ERROR` | Naranja |
| `offline` | `reachable === false` | Rojo |
| `connected` | `reachable === true` | Verde |
| `unknown` | sin evidencia | Gris |

Dos reglas que el modelo anterior violaba:

- **`reachable === null` nunca es «Conectado».** Sin prueba de que el servidor
  contestara, el estado es `unknown` y se dice como tal.
- **«El servidor contestó» no es «el servicio funciona».** Un 404, un 429 o un
  500 prueban que hay alguien al otro lado y ninguno significa que el proveedor
  pueda usarse: tienen estado propio y no se pintan en verde.

El punto del disparador lleva `data-provider-state` con el estado completo. El
booleano `data-runtime` que lo precedía marcaba **en rojo** un proveedor
meramente sin verificar; ya no existe.

---

## 5. Fuentes de evidencia

Sólo dos, y ninguna más. **Nada se deduce del catálogo.**

### 5.1 `status()` del adaptador

Opcional. Quien la declara sabe sondear su propio endpoint. La tienen `local` y
`llamacpp`. Un `ok: false` fija `reachable = false`.

### 5.2 `probe` de `listModels()`

Cada `listModels()` devuelve `{ models, probe }`:

```js
probe = {
  attempted,      // ¿hubo intento real de red?
  reachable,      // true | false | null
  authenticated,  // true | false | null
  httpStatus,     // número o null
  errorCode       // código estable o null
}
```

Una sonda con `attempted: false` no aporta nada: es lo que devuelve un adaptador
cuyo catálogo está declarado en el código (`anthropic`, `moonshot`, `alibaba`).

Constructores en `provider-errors.js`: `probeDeExito()`, `probeDeError()`,
`probeDeRespuestaInvalida()`, `probeNoIntentada()`.

---

## 6. Reglas de respuesta

### 6.1 Catálogo vacío válido — **no es un error**

```
HTTP 200   { "data": [] }
→ reachable=true   authenticated=true (si el proveedor autentica)
  modelsAvailable=0   errorCode=PROVIDER_CATALOG_EMPTY   ready=false
```

El servidor respondió y aceptó la credencial. Ambas cosas quedan demostradas.
Simplemente no hay nada que usar, y `ready` es `false` por falta de catálogo,
no por falta de conexión. El estado sigue siendo `connected`.

### 6.2 `2xx` con respuesta ilegible

Un cuerpo que no se entiende **no borra lo que el código de estado demostró**.

```
HTTP 200   cuerpo no-JSON, o {}, o { "data": "texto" }
→ reachable=true
  authenticated=true    proveedores que exigen credencial: un 200 no se emite
                        tras rechazar una clave
  authenticated=null    runtimes locales, que no autentican
  httpStatus=<el recibido>
  errorCode=PROVIDER_RESPONSE_INVALID
  ready=false   canAttempt=false   uiState=provider-error
```

La distinción que importa: `{ "data": [] }` es **catálogo vacío**; `{}` o
`{ "data": "texto" }` son **respuesta inválida**. Estructura correcta y sin
elementos no es lo mismo que estructura equivocada.

Aplican este contrato los tres adaptadores que analizan JSON recibido por red:
`openai`, `groq` y `llamacpp`. Una prueba recorre sus bloques y falla si alguno
deja de declararlo.

### 6.3 Clasificación de fallos

Sólo por campos **estructurados**: `kind` declarado, `status` HTTP, códigos de
Node, `name` del abort. **Nunca por el texto del mensaje** — un adaptador que
traduzca su redacción no puede cambiar la clasificación.

| Situación | `errorCode` | `reachable` | `authenticated` |
|---|---|---|---|
| Sin credencial, antes de pedir nada | `PROVIDER_CREDENTIAL_REQUIRED` | `null` | `null` |
| Configuración incompleta | `PROVIDER_CONFIG_REQUIRED` / `PROVIDER_ENDPOINT_REQUIRED` / `PROVIDER_CATALOG_REQUIRED` | `null` | `null` |
| HTTP 401 | `PROVIDER_AUTH_REJECTED` | `true` | `false` |
| HTTP 403 | `PROVIDER_FORBIDDEN` | `true` | `null` |
| HTTP 404 | `PROVIDER_HTTP_404` | `true` | `null` |
| HTTP 429 | `PROVIDER_RATE_LIMITED` | `true` | `null` |
| HTTP 500, 502, 503… | `PROVIDER_HTTP_<n>` | `true` | `null` |
| HTTP 408, 504 | `PROVIDER_TIMEOUT` | `null` | `null` |
| `2xx` ilegible | `PROVIDER_RESPONSE_INVALID` | `true` | según proveedor |
| ECONNREFUSED, ENOTFOUND, EAI_AGAIN… | `PROVIDER_TRANSPORT_UNREACHABLE` | `false` | `null` |
| ETIMEDOUT, timeout interno | `PROVIDER_TIMEOUT` | `null` | `null` |
| AbortError | `PROVIDER_ABORTED` | `null` | `null` |
| Catálogo vacío | `PROVIDER_CATALOG_EMPTY` | según sonda | según sonda |

Dos matices deliberados:

- **Un 403 no afirma nada sobre la validez de la clave.** El servidor puede
  reconocerla y negar la operación, o rechazarla con ese código. `authenticated`
  queda en `null`.
- **Un timeout no prueba que el servidor esté caído.** Puede estar lento o
  saturado, así que `reachable` queda en `null`, no en `false`.

---

## 7. Divergencias con la especificación previa

Dos, ambas deliberadas. Se documentan sin resolverlas: cambiarlas es una
decisión de producto, no de este documento.

### 7.1 El campo `message` no existe

Una especificación anterior incluía `message` en `ProviderStatus`. Se retiró en
`b50c4bf`, por la instrucción de no enviar mensajes técnicos arbitrarios al
renderer. El contrato real tiene, en su lugar, `providerId`, `models`,
`canAttempt` y `uiState`, y el detalle saneado vive en el log del proceso
principal.

Si se quisiera recuperar un `message`, tendría que ser **texto ya localizado**
generado desde `errorCode`, nunca el mensaje del proveedor.

### 7.2 Nombres de los códigos

| Especificación previa | Implementado |
|---|---|
| `AUTHENTICATION_REQUIRED` | `PROVIDER_CREDENTIAL_REQUIRED` (antes de pedir) |
| `AUTHENTICATION_FAILED` | `PROVIDER_AUTH_REJECTED` (tras un 401) |
| `AUTHORIZATION_FORBIDDEN` | `PROVIDER_FORBIDDEN` |
| `ENDPOINT_NOT_FOUND` | `PROVIDER_HTTP_404` |
| `RATE_LIMITED` | `PROVIDER_RATE_LIMITED` |
| `PROVIDER_ERROR` | `PROVIDER_HTTP_500` (familia `PROVIDER_HTTP_*`) |
| `PROVIDER_TIMEOUT` | `PROVIDER_TIMEOUT` ✔ |

Los conceptos coinciden; los nombres no. El prefijo `PROVIDER_` es uniforme y
`PROVIDER_HTTP_<n>` es una familia abierta que cubre 502, 503 y cualquier otro
sin añadir código. Renombrar tocaría `provider-errors.js`, `ai-providers.js`,
las 30 claves de i18n y las pruebas: **no se hace en un commit documental**.

---

## 8. Reglas para adaptadores futuros

Un adaptador nuevo obtiene el comportamiento correcto sin tocar
`getAvailability()`. Todo sale de rasgos declarados; una prueba recorre el
cuerpo de la función y **falla si aparece el nombre de cualquier proveedor**.

1. **Declara `requiresKey`.** Decide `configured` cuando no hay
   `validateConfig()`.

2. **Declara `validateConfig(config, apiKey)`** si tu configuración es más que
   una credencial. Devuelve `{ ok, errorCode?, message? }` con código estable.
   Puede lanzar: se captura y produce `PROVIDER_CONFIG_INVALID`.

3. **Declara `status()`** si sabes sondear tu endpoint. Devuelve `{ ok, error? }`.
   Es la única evidencia de conectividad previa a pedir el catálogo.

4. **Devuelve `{ models, probe }` desde `listModels()`.** Si no haces red,
   `probeNoIntentada()`. Nunca afirmes conectividad que no hayas comprobado.

5. **Nunca deduzcas evidencia del catálogo.** Ni de su tamaño ni de su origen.
   Si tu lista está declarada en el código, tu sonda es `attempted: false`.

6. **Lanza errores estructurados**, no texto. Usa `errorDeRespuesta(status)` o
   `ProviderError(kind, { status, code })`. La clasificación por mensaje está
   prohibida y una prueba lo vigila.

7. **Un `2xx` ilegible conserva su evidencia.** Usa
   `probeDeRespuestaInvalida({ httpStatus, authenticated })`, no un error
   genérico.

8. **Distingue catálogo vacío de estructura inválida.** Valida la forma antes de
   mapear.

9. **Ningún secreto en el mensaje.** Lo que registres pasa por
   `sanearMensaje()`; lo que devuelvas al renderer es sólo `errorCode` y
   `httpStatus`.

10. **Todo texto nuevo, en i18n ES y EN.** Cada `errorCode` necesita
    `provider.error.<CODIGO>` en ambos idiomas, y el gate lo comprueba.

---

## 9. Limitación conocida

**Ningún `listModels()` acepta señal externa de cancelación.** `local` y
`llamacpp` lo declaran sin parámetros; el resto sólo reciben credencial y
configuración. La única cancelación existente es el `AbortSignal.timeout(3000)`
interno de `llamacpp`, que produce `PROVIDER_TIMEOUT`.

Por tanto **`PROVIDER_ABORTED` es hoy inalcanzable a través de `listModels()`**.
El clasificador lo soporta, y una prueba inspecciona las firmas de los siete
adaptadores para que la limitación deje de ser cierta el día que uno admita
señal, en lugar de dar por probado algo que no ocurre.

---

## 10. Estado de verificación

| Comprobación | Resultado |
|---|---|
| `test/provider-availability.test.js` | 267 comprobaciones |
| `npm run test:all` | 8/8 gates |
| Mutaciones sobre esta capa | 11/11 detectadas |
| Referencias a vLLM en `src/` | 0 |

vLLM no forma parte de MIKA5 Community. La documentación pública lo declara
así, y `test/website-i18n.test.js` lo verifica en ambos idiomas.
