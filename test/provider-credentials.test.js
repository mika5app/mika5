'use strict';

// Custodia de credenciales de proveedor.
//
// Este módulo se extrajo de `ai-providers.js` sin tocar el código. Lo que estas
// pruebas fijan es lo que esa extracción NO puede haber cambiado: el formato
// persistido, la capacidad de leer lo que escribió la versión anterior, y que
// ningún camino de error deje una clave a la vista.
//
// La regresión que impiden es silenciosa y cara: si el formato cambiara, las
// claves guardadas por el usuario dejarían de descifrarse y la aplicación
// pediría reconfigurar todos los proveedores sin explicar por qué.
//
//   npm run test:provider-credentials

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getEncryptionKey, encrypt, decrypt } = require('../src/main/provider-credentials');
const { sanearMensaje } = require('../src/main/provider-errors');

let comprobaciones = 0;
function check(condicion, mensaje) {
  assert(condicion, mensaje);
  comprobaciones += 1;
  console.log(`  ✓ ${mensaje}`);
}

const CLAVE = 'sk-prueba-0123456789abcdefghijklmnop';

console.log('\n=== 1. Formato persistido ===');
{
  getEncryptionKey(null);
  const cifrado = encrypt(CLAVE);

  check(typeof cifrado === 'string' && cifrado.length > 0, 'cifrar produce una cadena');
  const partes = cifrado.split(':');
  check(partes.length === 3,
    `el formato persistido son tres campos separados por dos puntos (${partes.length})`);
  check(partes.every(p => /^[0-9a-f]+$/i.test(p)),
    'los tres campos son hexadecimal: iv, tag y contenido');
  check(partes[0].length === 32, `el iv son 16 bytes en hexadecimal (${partes[0].length} caracteres)`);
  check(partes[1].length === 32, `la etiqueta de autenticación son 16 bytes (${partes[1].length} caracteres)`);

  check(!cifrado.includes(CLAVE), 'el texto en claro no aparece dentro del valor cifrado');
  check(!cifrado.includes('sk-'), 'ni siquiera el prefijo reconocible sobrevive');
}

console.log('\n=== 2. Lectura y escritura de ida y vuelta ===');
{
  getEncryptionKey(null);
  for (const valor of [CLAVE, 'a', 'clave con espacios y acentuación ñ', '0'.repeat(512), '{"json":"dentro"}']) {
    const recuperado = decrypt(encrypt(valor));
    check(recuperado === valor,
      `se recupera exactamente lo guardado (${valor.length} caracteres)`);
  }

  // Dos cifrados del mismo texto no pueden ser iguales: el iv es aleatorio.
  const a = encrypt(CLAVE);
  const b = encrypt(CLAVE);
  check(a !== b, 'dos cifrados del mismo valor difieren: el vector de inicialización es aleatorio');
  check(decrypt(a) === decrypt(b), 'y ambos descifran al mismo valor');
}

console.log('\n=== 3. Compatibilidad con lo escrito antes de la extracción ===');
{
  // Se cifra con el módulo extraído y se descifra con la implementación tal y
  // como estaba dentro de `ai-providers.js`, cargada desde git. Si la
  // extracción hubiera alterado la derivación de clave o el formato, esto falla.
  const { execFileSync } = require('child_process');
  const raiz = path.join(__dirname, '..');
  let fuenteAnterior = null;
  try {
    fuenteAnterior = execFileSync('git', ['show', 'cde9f30:src/main/ai-providers.js'], {
      cwd: raiz, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    });
  } catch (_) {
    // Sin acceso a git —un tarball, por ejemplo— esta comprobación se omite.
  }

  if (fuenteAnterior) {
    const temporal = path.join(raiz, 'src/main/.credenciales-anteriores.js');
    // Se recorta el bloque de credenciales de la versión anterior y se expone.
    const inicio = fuenteAnterior.indexOf('// Encryption key - uses Electron safeStorage');
    assert(inicio > 0, 'el bloque de credenciales anterior debe localizarse');
    // El final se busca emparejando llaves desde `function decrypt`, no con un
    // texto ancla: los comentarios vecinos se han ido moviendo entre módulos y
    // un ancla textual arrastraba medio fichero.
    const lineas = fuenteAnterior.slice(inicio).split('\n');
    const iDecrypt = lineas.findIndex(l => /^function decrypt\(text\)/.test(l));
    assert(iDecrypt >= 0, 'decrypt() debe estar dentro del bloque anterior');
    let profundidad = 0;
    let iFin = iDecrypt;
    for (let i = iDecrypt; i < lineas.length; i++) {
      for (const c of lineas[i]) {
        if (c === '{') profundidad++;
        if (c === '}') profundidad--;
      }
      if (profundidad === 0 && i > iDecrypt) { iFin = i; break; }
    }
    const bloque = lineas.slice(0, iFin + 1).join('\n');
    fs.writeFileSync(temporal,
      "'use strict';\nconst crypto = require('crypto');\nconst path = require('path');\nconst fs = require('fs');\n"
      + bloque
      + '\nmodule.exports = { getEncryptionKey, encrypt, decrypt };\n');
    try {
      // Ambos módulos tienen que derivar la clave del MISMO salt persistido, y
      // ambos tienen que partir sin inicializar: `getEncryptionKey()` cachea la
      // clave en el ámbito del módulo, así que el ejemplar ya usado en las
      // pruebas anteriores devolvería la suya en vez de derivarla del salt.
      const perfil = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mika5-cred-'));
      const anterior = require(temporal);
      delete require.cache[require.resolve('../src/main/provider-credentials')];
      const extraida = require('../src/main/provider-credentials');

      anterior.getEncryptionKey(perfil);
      extraida.getEncryptionKey(perfil);
      check(fs.existsSync(path.join(perfil, '.mika5-salt')),
        'la ruta heredada persiste su salt en disco, como en una instalación real');

      const escritoAhora = extraida.encrypt(CLAVE);
      check(anterior.decrypt(escritoAhora) === CLAVE,
        'la implementación anterior descifra lo que escribe la extraída');

      const escritoAntes = anterior.encrypt(CLAVE);
      check(extraida.decrypt(escritoAntes) === CLAVE,
        'la extraída descifra lo que escribió la implementación anterior');

      check(escritoAhora.split(':').length === escritoAntes.split(':').length,
        'ambas producen el mismo formato: ningún cambio silencioso de persistencia');
    } finally {
      delete require.cache[require.resolve(temporal)];
      fs.unlinkSync(temporal);
    }
  } else {
    console.log('  – sin git disponible: se omite el contraste con la versión anterior');
  }
}

console.log('\n=== 4. Un valor ilegible no rompe ni filtra ===');
{
  getEncryptionKey(null);
  const basura = ['', 'no-es-hex', 'aa:bb', 'aa:bb:cc:dd', ':::', 'zz:zz:zz'];
  for (const v of basura) {
    let resultado;
    assert.doesNotThrow(() => { resultado = decrypt(v); },
      `descifrar "${v}" no puede lanzar: rompería el arranque`);
    check(resultado === null || resultado === undefined || typeof resultado === 'string',
      `un valor corrupto ("${v}") produce un resultado manejable, no una excepción`);
  }
}

console.log('\n=== 5. Ningún secreto en errores ni en logs ===');
{
  // Lo que se registre de un fallo pasa por el saneado. Se comprueba con los
  // formatos reales en los que una clave podría colarse.
  const casos = [
    `no se pudo usar la clave ${CLAVE}`,
    `Authorization: Bearer ${CLAVE}`,
    `https://usuario:${CLAVE}@api.ejemplo/v1/models`,
    `x-api-key=${CLAVE}`
  ];
  for (const texto of casos) {
    const saneado = sanearMensaje(texto);
    check(!saneado.includes(CLAVE), `el saneado retira la clave de: "${texto.slice(0, 40)}…"`);
  }

  // El módulo no puede escribir por consola en ninguno de sus caminos de error:
  // un `console.log` con el texto en claro sería una filtración a los logs.
  const fuente = fs.readFileSync(path.join(__dirname, '../src/main/provider-credentials.js'), 'utf8');
  const sospechosas = fuente.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /console\.(log|warn|error|info)/.test(l))
    .filter(([, l]) => /\b(text|key|apiKey|clave|secret|token|value)\b/.test(l));
  assert(sospechosas.length === 0,
    `ninguna traza puede incluir el material sensible: ${sospechosas.map(([i]) => 'línea ' + i).join(', ')}`);
  check(true, 'ninguna traza del módulo imprime el texto en claro ni la clave');

  check(!/module\.exports[\s\S]*ENCRYPTION_KEY/.test(fuente),
    'la clave de cifrado no se exporta: sólo salen las tres funciones');
}

console.log(`\nProvider credentials tests passed (${comprobaciones} comprobaciones)`);
