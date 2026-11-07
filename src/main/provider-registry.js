'use strict';

// Registro interno de adaptadores de proveedor.
//
// Es una frontera TÉCNICA, no legal. No carga nada de disco, no descubre
// plugins, no acepta rutas del usuario y no usa `require` dinámico: los
// adaptadores incorporados se registran explícitamente desde código de
// confianza, en `ai-providers.js`. Cualquier otra vía de carga sería un
// vector de ejecución de código arbitrario y aquí no existe.
//
// La validación es fail-closed y ocurre en `register()`, no en el primer uso.
// El motivo está documentado: un `ai_provider` persistido que ya no existía en
// el registro hacía que `getProvider()` leyese `undefined.privacy`. Un
// adaptador mal formado tiene que caerse al registrarlo, cuando hay contexto
// para saber quién lo registró, no tres capas más abajo.

/**
 * Versión del contrato de adaptador. Se incrementa cuando cambia de forma
 * incompatible: un adaptador que declare otra versión se rechaza.
 */
const PROVIDER_API_VERSION = 1;

/** Métodos que todo adaptador debe traer. `status()` NO está aquí: es opcional. */
const METODOS_OBLIGATORIOS = ['chat', 'listModels'];

/** Métodos opcionales, con su tipo esperado si están presentes. */
const METODOS_OPCIONALES = ['status', 'validateConfig', 'generateImage', 'embed'];

const PRIVACIDADES = new Set(['private', 'cloud']);

class ProviderRegistryError extends Error {
  constructor(codigo, mensaje) {
    super(mensaje);
    this.name = 'ProviderRegistryError';
    this.code = codigo;
  }
}

function fallar(codigo, mensaje) {
  throw new ProviderRegistryError(codigo, mensaje);
}

/**
 * Comprueba la forma de un adaptador. Devuelve el descriptor validado.
 *
 * Los metadatos son declarativos: `id`, `displayName` y `traits` son datos, no
 * funciones. Obtenerlos ejecutando código obligaría a llamar a un adaptador
 * todavía no validado para decidir si es válido.
 */
function validarAdaptador(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    fallar('ADAPTER_INVALID', 'El adaptador debe ser un objeto');
  }

  const { apiVersion, id, displayName, traits, adapter } = descriptor;

  if (apiVersion === undefined || apiVersion === null) {
    fallar('ADAPTER_API_VERSION_MISSING', 'El adaptador debe declarar apiVersion');
  }
  if (apiVersion !== PROVIDER_API_VERSION) {
    fallar('ADAPTER_API_VERSION_UNSUPPORTED',
      `apiVersion ${apiVersion} no es compatible con ${PROVIDER_API_VERSION}`);
  }

  if (typeof id !== 'string' || id.trim() === '') {
    fallar('ADAPTER_ID_INVALID', 'El adaptador debe declarar un id no vacío');
  }
  if (id !== id.trim() || !/^[a-z][a-z0-9-]*$/.test(id)) {
    fallar('ADAPTER_ID_INVALID', `El id "${id}" debe ser minúsculas, dígitos y guiones`);
  }

  if (typeof displayName !== 'string' || displayName.trim() === '') {
    fallar('ADAPTER_DISPLAY_NAME_INVALID', `El adaptador ${id} debe declarar displayName`);
  }

  if (!traits || typeof traits !== 'object' || Array.isArray(traits)) {
    fallar('ADAPTER_TRAITS_INVALID', `El adaptador ${id} debe declarar traits`);
  }
  if (typeof traits.requiresKey !== 'boolean') {
    fallar('ADAPTER_TRAITS_INVALID', `${id}: traits.requiresKey debe ser booleano`);
  }
  if (!PRIVACIDADES.has(traits.privacy)) {
    fallar('ADAPTER_TRAITS_INVALID',
      `${id}: traits.privacy debe ser "private" o "cloud", no ${JSON.stringify(traits.privacy)}`);
  }
  if (traits.visualCapabilities !== undefined
    && (typeof traits.visualCapabilities !== 'object' || traits.visualCapabilities === null
      || Array.isArray(traits.visualCapabilities))) {
    fallar('ADAPTER_TRAITS_INVALID', `${id}: traits.visualCapabilities debe ser un objeto si está`);
  }

  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    fallar('ADAPTER_INVALID', `El adaptador ${id} debe traer su implementación en \`adapter\``);
  }
  for (const metodo of METODOS_OBLIGATORIOS) {
    if (typeof adapter[metodo] !== 'function') {
      fallar('ADAPTER_METHOD_MISSING', `${id}: falta el método obligatorio ${metodo}()`);
    }
  }
  for (const metodo of METODOS_OPCIONALES) {
    if (adapter[metodo] !== undefined && typeof adapter[metodo] !== 'function') {
      fallar('ADAPTER_METHOD_INVALID', `${id}: ${metodo} está declarado y no es una función`);
    }
  }

  return { apiVersion, id, displayName, traits, adapter };
}

class ProviderRegistry {
  constructor() {
    // Map y no objeto literal: sin prototipo heredado, y `has()` no puede
    // confundir una clave real con `toString` o `constructor`.
    this._entradas = new Map();
  }

  /** Registra un adaptador validado. Lanza si algo no cuadra. */
  register(descriptor) {
    const validado = validarAdaptador(descriptor);
    if (this._entradas.has(validado.id)) {
      fallar('ADAPTER_DUPLICATE', `El proveedor ${validado.id} ya está registrado`);
    }
    this._entradas.set(validado.id, Object.freeze({
      ...validado,
      traits: Object.freeze({ ...validado.traits })
    }));
    return this;
  }

  has(id) {
    return this._entradas.has(id);
  }

  /** Devuelve el descriptor, o `undefined`. Nunca lanza: quien pregunta decide. */
  get(id) {
    return this._entradas.get(id);
  }

  /** Implementación del adaptador, o `undefined`. */
  getAdapter(id) {
    const entrada = this._entradas.get(id);
    return entrada ? entrada.adapter : undefined;
  }

  /**
   * Copia de los descriptores, en orden de registro. Es una copia a propósito:
   * mutar el resultado no puede alterar el registro.
   */
  list() {
    return [...this._entradas.values()];
  }

  /** Identificadores en orden de registro. */
  ids() {
    return [...this._entradas.keys()];
  }

  get size() {
    return this._entradas.size;
  }
}

module.exports = {
  PROVIDER_API_VERSION,
  METODOS_OBLIGATORIOS,
  METODOS_OPCIONALES,
  ProviderRegistry,
  ProviderRegistryError,
  validarAdaptador
};
