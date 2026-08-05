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

1. **`local` no admite cancelación.** No tiene fetch propio: delega en
   `ollamaApi.tags()`. Propagarle una señal exige cambiar `ollama.js`.

2. **`alibaba.js` recibe su configuración por inyección.** Su módulo exporta
   una factoría en lugar de un objeto, porque importar `alibaba-config` desde
   el adaptador y componerlo desde `ai-providers.js` cerraría un ciclo. Es una
   asimetría real frente a los otros seis.

3. **La migración de `PROVIDERS[id]` al registro está a medias.** Se hizo en la
   guarda de `init()`, que es donde aporta y está cubierta por prueba. Migrar
   los otros siete accesos hacía que el gate de Electron agotase su plazo de
   forma reproducible y no se aisló la causa; se revirtió para no dejar el
   árbol en rojo. `PROVIDERS` sigue siendo la vía de acceso normal y es API
   interna con consumidores dentro y fuera del módulo.

4. **`getAvailability()` no consulta el registro.** Sigue trabajando sobre
   `PROVIDERS`, y cumple igual el principio de no contener casos especiales por
   proveedor: una prueba recorre su cuerpo y falla si aparece el nombre de
   cualquiera.

5. **El gate de Electron es sensible al estado de la máquina.** Cada
   `switchProvider()` hace que `loadRuntime()` sondee con `/api/show` todos los
   modelos que Ollama tenga instalados. La suite tarda segundos con la máquina
   en reposo y minutos bajo carga; su plazo global es de diez minutos por ese
   motivo, no por prudencia genérica.

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
| `test/provider-availability.test.js` | 315 |
| `test/provider-registry.test.js` | 91 |
| `test/provider-credentials.test.js` | 30 |
| `npm run test:all` | 8/8 gates |
