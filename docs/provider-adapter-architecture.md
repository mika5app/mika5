# Arquitectura de adaptadores de proveedor

**Ámbito:** MIKA5 Community v0.3.1
**Complementa:** `docs/provider-availability-contract.md`, que describe el
contrato de disponibilidad y sigue vigente sin cambios.

Este documento describe la estructura **tal y como queda implementada**. No
propone trabajo futuro salvo donde se dice explícitamente que algo está
pendiente.

---

## 1. Estructura final

```
src/main/
  ai-providers.js            composición, AIProviderManager, enrutado visual
  provider-registry.js       registro interno versionado
  provider-runtime.js        utilidades compartidas por adaptadores
  provider-credentials.js    cifrado y custodia de credenciales
  provider-errors.js         taxonomía de fallos y sondas
  provider-capabilities.js   contrato de visión y normalización de respuesta
  providers/
    local.js  openai.js  anthropic.js  groq.js  moonshot.js  llamacpp.js
    alibaba.js           adaptador (factoría: recibe su configuración)
    alibaba-config.js    preajustes, catálogo y normalización de Alibaba
```

`ai-providers.js` pasó de 2 774 líneas a 1 507.

Dependencias, sin ciclos: los adaptadores importan de `provider-runtime`,
`provider-errors` y `provider-capabilities`; **ninguno importa
`ai-providers.js`**, que es quien los compone. Una prueba lo verifica módulo a
módulo.

---

## 2. Contrato de ProviderAdapter v1

`PROVIDER_API_VERSION = 1`. Un adaptador se registra con un **descriptor**:

```js
{
  apiVersion,          // debe coincidir con PROVIDER_API_VERSION
  id,                  // minúsculas, dígitos y guiones; empieza por letra
  displayName,         // texto no vacío
  traits: {
    requiresKey,       // booleano, obligatorio
    privacy,           // 'private' | 'cloud', obligatorio
    visualCapabilities // objeto, opcional
  },
  adapter              // la implementación
}
```

Los metadatos son **datos, no funciones**. Decidir si un adaptador es válido no
puede exigir ejecutarlo.

### Campos de la implementación

| Método | Obligatorio | Contrato |
|---|---|---|
| `chat(params)` | **sí** | Respuesta normalizada del proveedor |
| `listModels(apiKey, config, options = {})` | **sí** | `{ models, probe }` |
| `status()` | no | `{ ok, error? }` — sonda de alcanzabilidad |
| `validateConfig(config, apiKey)` | no | `{ ok, errorCode?, message? }` |
| `generateImage(params)` | no | Generación de imagen |
| `embed(params)` | no | Embeddings |

Un método opcional declarado y que no sea función se rechaza: declararlo mal es
peor que no declararlo.

---

## 3. Registro interno

`ProviderRegistry` con `register()`, `get()`, `getAdapter()`, `has()`,
`list()`, `ids()` y `size`.

**Es una frontera técnica, no legal.** No carga nada de disco, no descubre
plugins, no acepta rutas y no usa `require` dinámico ni `eval`. Una prueba
recorre la fuente del módulo y falla si aparece cualquiera de esas
capacidades: añadirlas lo convertiría en un vector de ejecución de código
arbitrario. Los siete incorporados se registran explícitamente desde
`ai-providers.js`.

### Fail-closed, y pronto

La validación ocurre en `register()`, no en el primer uso. El precedente es
real: un `ai_provider` persistido que ya no existía en el registro hacía que
`getProvider()` leyese `undefined.privacy` y la rehidratación se cayera entera.

Códigos de rechazo, todos estables:

`ADAPTER_INVALID` · `ADAPTER_ID_INVALID` · `ADAPTER_DUPLICATE` ·
`ADAPTER_API_VERSION_MISSING` · `ADAPTER_API_VERSION_UNSUPPORTED` ·
`ADAPTER_TRAITS_INVALID` · `ADAPTER_METHOD_MISSING` · `ADAPTER_METHOD_INVALID`

`list()` e `ids()` devuelven copias y los descriptores van congelados: mutar lo
devuelto no altera el registro.

### Compatibilidad de versiones

Sólo se acepta `apiVersion === PROVIDER_API_VERSION`. No hay rango ni
degradación: un adaptador de otra versión se rechaza al registrarlo. Cuando el
contrato cambie de forma incompatible, la constante sube y los adaptadores
declaran la nueva.

---

## 4. Semántica de `status()`, `listModels()` y cancelación

### `status()` es opcional

Su ausencia significa **«no comprobado»**, nunca «caído». El registro no
fabrica una sonda por defecto: inventarla afirmaría una conectividad que nadie
verificó. La tienen `local` y `llamacpp`.

### `listModels()` devuelve evidencia

```js
{ models, probe: { attempted, reachable, authenticated, httpStatus, errorCode } }
```

La sonda es la **única** fuente de evidencia sobre conectividad y credencial.
Nada se deduce del tamaño del catálogo ni del tipo de adaptador. Un adaptador
cuyo catálogo está declarado en el código devuelve `probeNoIntentada()`.

### Cancelación

`options.signal` es opcional y sólo lo aceptan los tres adaptadores que hacen
red: `openai`, `groq`, `llamacpp`. Las llamadas de dos argumentos siguen
funcionando.

```
cancelación externa  →  PROVIDER_ABORTED   reachable = null
plazo interno        →  PROVIDER_TIMEOUT   reachable = null
```

El combinador es `createAbortContext()`, que ya existía y está probado: une la
señal externa con un plazo propio, recuerda cuál disparó y limpia temporizador
y oyente en `cleanup()`. **No se usa `AbortSignal.any`.**

`anthropic`, `moonshot` y `alibaba` no reciben señal: sería una interfaz vacía
que finge una capacidad que no tienen.

---

## 5. Limitaciones conocidas

1. **`switchProvider()` no resuelve recién arrancada la aplicación.** Llamada
   unos dos segundos después de `did-finish-load` no termina, ni siquiera con
   un proveedor que no toca la red, y bloquea el hilo del renderer hasta el
   punto de que un `setTimeout` de respaldo tampoco dispara. El mismo
   `switchProvider()` funciona más adelante en la misma sesión. Es anterior a
   estos cambios y está sin diagnosticar. Para el usuario significaría que
   pulsar un proveedor justo al abrir no hace nada y no da ningún aviso. La
   sección 0 de `provider-selector.test.js` usa `setProvider` + `loadRuntime`
   por este motivo, no por gusto.

2. **`local` no admite cancelación.** No tiene fetch propio: delega en
   `ollamaApi.tags()`. `fetchWithTimeout` ya acepta `options.signal` y lo trata
   bien; lo que falta es que `tags()`, `show()` y `status()` lo acepten y lo
   propaguen.

3. **`alibaba.js` recibe su configuración por inyección.** Su módulo exporta
   una factoría en lugar de un objeto, porque importar `alibaba-config` desde
   el adaptador y componerlo desde `ai-providers.js` cerraría un ciclo. Es una
   asimetría real frente a los otros seis.

### Lo que ya no es limitación

- **El registro gobierna.** Los nueve accesos —`getProviderVisualCapabilities`,
  `setProvider`, `getProvider`, `setApiKey`, `chat`, `generateImage`,
  `listModels` y `getAvailability`— pasan por él. Una prueba recorre la fuente
  y falla si reaparece un `PROVIDERS[` directo, y exige además que el registro
  se consulte de verdad: sin esa segunda mitad, borrar todas las consultas
  también pasaría. `PROVIDERS` sigue exportado como API interna, con
  consumidores en las pruebas.

- **El gate de Electron no depende de la máquina.** `ollama.js` lee
  `MIKA5_OLLAMA_BASE`, cuyo valor por defecto es el de siempre y es el único
  que se usa en producción; está restringida a bucle local para que una
  variable de entorno no pueda desviar a un host remoto lo que el usuario cree
  que no sale de su equipo. La suite levanta su propio servidor en un puerto
  efímero antes de cargar los módulos y comprueba que ninguno estaba ya
  cargado, en vez de limpiar la caché de `require`. Tres corridas seguidas:
  24 s, 24 s, 24 s. Plazo de dos minutos, no de diez.

- **El sondeo secuencial de `/api/show` no era una regresión.** v0.2.0
  (tag `438d393`) recorre los modelos uno a uno igual que hoy. Sí hay una
  diferencia real, anterior a este trabajo: v0.2.0 caía a detección por nombre
  cuando `/api/show` fallaba, y hoy el modelo se queda sin visión. Fue
  deliberado —la detección por nombre dejaba perder la imagen en silencio— y
  aquí sólo se hace constar.

---

## 6. Lo que no existe todavía

- **No hay loader externo.** El registro no carga módulos desde disco ni acepta
  rutas. Cualquier carga externa se diseñará por separado, con su propio
  análisis de seguridad.
- **No hay adaptador vLLM**, ni referencia alguna a vLLM en `src/`. La
  documentación pública de Community sigue declarando que vLLM no forma parte
  de esta edición, y `test/website-i18n.test.js` lo verifica en ambos idiomas.
- **La frontera Pro se diseñará después.** El registro interno es una frontera
  técnica inicial y **no** constituye por sí solo una separación legal entre
  AGPL y componentes propietarios.

---

## 7. Verificación

| Suite | Comprobaciones |
|---|---|
| `test/provider-availability.test.js` | 325 |
| `test/provider-registry.test.js` | 93 |
| `test/provider-credentials.test.js` | 30 |
| `test/provider-selector.test.js` | 116 |
| `npm run test:all` | 8/8 gates, exit 0, 42 s |

## 8. Lo que el selector ofrece

`loadRuntime()` puebla el desplegable de modelos **sólo** con `canAttempt`, sin
reconstruirlo a partir de `configured`, `reachable` y `authenticated`. En
`rate-limited`, `authorization-forbidden` y `provider-error` el servidor
responde y la credencial vale, pero el proveedor no se puede usar: el selector
queda deshabilitado con el texto del estado y su única opción lleva valor
vacío, que `send()` ya rechaza. Conservar los modelos visibles pero
deshabilitados sería otro diseño, y sería un cambio de UX aparte.
