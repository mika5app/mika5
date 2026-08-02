'use strict';

// Lectura e inspección del código del renderer para las pruebas que asertan
// sobre su fuente.
//
// Por qué existe: `sliceRendererFunction` vivía dentro de alibaba-provider.test.js
// y localizaba el cierre de una función con `indexOf('\n}\n')`. Con `core.autocrlf`
// activo, Git materializa app.js con CRLF en Windows y ese delimitador deja de
// existir: el test fallaba por cómo estaba el checkout, no por el código. Ocurrió
// dos veces durante la descomposición del árbol.
//
// La fuente se normaliza a LF **en memoria**. No se toca el archivo, no se
// normaliza el repositorio y las aserciones existentes no cambian de significado.

const fs = require('fs');

/** Normaliza CRLF y CR sueltos a LF. Sólo afecta a la copia en memoria. */
function normalizeEol(source) {
  return String(source).replace(/\r\n?/g, '\n');
}

/**
 * Extrae el cuerpo completo de una función declarada en columna 0.
 * Conserva el prefijo `async`: sin él, un `await` del cuerpo no compilaría al
 * evaluarse en el test.
 *
 * Falla con un error explícito si la función no existe o no tiene cierre en
 * columna 0. Nunca devuelve un bloque parcial ni una cadena vacía.
 */
function sliceFunction(source, name) {
  const text = normalizeEol(source);
  const declaration = text.indexOf(`function ${name}(`);
  if (declaration < 0) throw new Error(`no se encontró function ${name}`);
  const asyncPrefix = 'async ';
  const start = text.startsWith(asyncPrefix, declaration - asyncPrefix.length)
    ? declaration - asyncPrefix.length
    : declaration;
  const end = text.indexOf('\n}\n', start);
  if (end <= start) throw new Error(`function ${name} sin cierre en columna 0`);
  return text.slice(start, end + 2);
}

/**
 * Lee un archivo fuente y devuelve su texto ya normalizado más un `slice`
 * ligado a él. Quien llama trabaja siempre con LF, sea cual sea el checkout.
 */
function readRendererSource(filePath) {
  const text = normalizeEol(fs.readFileSync(filePath, 'utf8'));
  return {
    text,
    slice: name => sliceFunction(text, name)
  };
}

module.exports = { normalizeEol, sliceFunction, readRendererSource };
