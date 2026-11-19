'use strict';

// Descarga de modelos del catálogo: integridad, cancelación y no repetir.
//
// Hay red y disco reales, pero locales: un servidor HTTP sintético en un
// puerto efímero hace de Hugging Face y los ficheros van a una carpeta
// temporal. Ningún modelo real se descarga aquí.
//
//   npm run test:model-download

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { ORIGEN, GestorDeDescargas, urlDe, entradaValida } = require('../src/main/model-download');

let comprobaciones = 0;
function check(condicion, mensaje) {
  assert(condicion, mensaje);
  comprobaciones += 1;
  console.log(`  ✓ ${mensaje}`);
}
const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-descarga-'));
  // Un GGUF mínimo con arquitectura declarada, para que el descubrimiento lo lea.
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const clave = Buffer.from('general.architecture', 'latin1');
  const valor = Buffer.from('qwen2', 'utf8');
  const contenido = Buffer.concat([Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(1),
    u64(clave.length), clave, u32(8), u64(valor.length), valor, crypto.randomBytes(300000)]);
  const sha256 = crypto.createHash('sha256').update(contenido).digest('hex');
  const entrada = {
    id: 'modelo-de-prueba', label: 'Modelo de prueba', repo: 'org/modelo-GGUF',
    revision: 'a'.repeat(40), file: 'modelo-de-prueba.gguf', size: contenido.length, sha256, license: 'MIT'
  };

  let guion = { cuerpo: contenido, lento: false };
  const peticiones = [];
  const servidor = http.createServer((req, res) => {
    peticiones.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    if (!guion.lento) { res.end(guion.cuerpo); return; }
    // Goteo lento, para poder cancelar a mitad.
    let enviado = 0;
    const gota = setInterval(() => {
      if (enviado >= guion.cuerpo.length || res.destroyed) { clearInterval(gota); res.end(); return; }
      res.write(guion.cuerpo.subarray(enviado, enviado + 4096));
      enviado += 4096;
    }, 20);
    req.on('close', () => clearInterval(gota));
  });
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const fetchLocal = (url, opciones) => fetch(String(url).replace(ORIGEN, base), opciones);
  const terminar = (gestor, datos) => new Promise((resolve) => {
    const r = gestor.iniciar({ ...datos, alTerminar: resolve });
    if (!r.ok || r.already) resolve(r);
  });

  try {
    console.log('\n=== 1. Qué se puede descargar ===');
    check(urlDe(entrada) === `${ORIGEN}/org/modelo-GGUF/resolve/${'a'.repeat(40)}/modelo-de-prueba.gguf`,
      'la URL sale del repositorio, la revisión exacta y el fichero del catálogo');
    check(entradaValida(entrada), 'una entrada con revisión, tamaño y SHA-256 es válida');
    for (const [nombre, mala] of [
      ['sin SHA-256', { ...entrada, sha256: '' }],
      ['con una rama en vez de una revisión exacta', { ...entrada, revision: 'main' }],
      ['con un fichero fuera de su carpeta', { ...entrada, file: '../otro.gguf' }],
      ['con un fichero que no es GGUF', { ...entrada, file: 'instalador.exe' }],
      ['con un repositorio que es una URL', { ...entrada, repo: 'https://ejemplo.test/x' }],
      ['sin tamaño', { ...entrada, size: 0 }]
    ]) {
      check(!entradaValida(mala), `una entrada ${nombre} se rechaza`);
    }

    console.log('\n=== 2. Descarga verificada ===');
    const dir = path.join(tmp, 'models');
    const gestor = new GestorDeDescargas({ fetchFn: fetchLocal });
    check(gestor.estado().state === 'idle' && !gestor.yaDescargado(dir, entrada), 'al empezar no hay nada descargado');
    const fin = await terminar(gestor, { providerId: 'llamacpp', entrada, dir });
    const destino = path.join(dir, entrada.file);
    check(fin.state === 'done' && fin.received === entrada.size && fin.total === entrada.size,
      'la descarga termina e informa de lo recibido');
    check(fs.readFileSync(destino).equals(contenido) && !fs.existsSync(`${destino}.part`),
      'el fichero queda completo en la carpeta de modelos y no deja restos');
    check(peticiones.length === 1 && peticiones[0] === `/org/modelo-GGUF/resolve/${'a'.repeat(40)}/modelo-de-prueba.gguf`,
      'se pidió exactamente el fichero del catálogo, una vez');
    check(!JSON.stringify(gestor.estado()).includes(tmp) && !JSON.stringify(gestor.estado()).includes('http'),
      'el estado que ve la interfaz no lleva rutas ni URL');
    const otraVez = gestor.iniciar({ providerId: 'llamacpp', entrada, dir });
    check(otraVez.ok && otraVez.already === true && peticiones.length === 1,
      'un modelo que ya está no se descarga otra vez');

    console.log('\n=== 3. Lo que se descarta ===');
    for (const [nombre, cuerpo] of [
      ['con otro contenido del mismo tamaño', Buffer.concat([contenido.subarray(0, -1), Buffer.from([contenido.at(-1) ^ 1])])],
      ['más corto', contenido.subarray(0, 1000)],
      ['más largo', Buffer.concat([contenido, Buffer.alloc(10)])]
    ]) {
      const dirMalo = path.join(tmp, `malo-${comprobaciones}`);
      guion = { cuerpo, lento: false };
      const r = await terminar(new GestorDeDescargas({ fetchFn: fetchLocal }), { providerId: 'llamacpp', entrada, dir: dirMalo });
      check(r.state === 'failed' && r.errorCode === 'MODEL_DOWNLOAD_CHECKSUM'
        && !fs.existsSync(path.join(dirMalo, entrada.file)) && !fs.existsSync(path.join(dirMalo, `${entrada.file}.part`)),
        `un fichero ${nombre} se descarta y no queda nada en disco`);
    }
    const caida = await terminar(new GestorDeDescargas({ fetchFn: async () => { throw new Error('ENOTFOUND'); } }),
      { providerId: 'llamacpp', entrada, dir: path.join(tmp, 'sin-red') });
    check(caida.state === 'failed' && caida.errorCode === 'MODEL_DOWNLOAD_FAILED', 'sin red se informa del fallo');
    const invalida = new GestorDeDescargas({ fetchFn: fetchLocal }).iniciar({ providerId: 'x', entrada: { ...entrada, sha256: 'no' }, dir });
    check(invalida.ok === false && invalida.errorCode === 'MODEL_DOWNLOAD_INVALID', 'una entrada sin huella no se descarga');

    console.log('\n=== 4. Cancelación y una a la vez ===');
    guion = { cuerpo: contenido, lento: true };
    const dirCancel = path.join(tmp, 'cancelada');
    const lenta = new GestorDeDescargas({ fetchFn: fetchLocal });
    const finCancelada = new Promise(resolve => lenta.iniciar({ providerId: 'llamacpp', entrada, dir: dirCancel, alTerminar: resolve }));
    for (let i = 0; i < 100 && lenta.estado().received === 0; i += 1) await esperar(20);
    check(lenta.estado().state === 'downloading' && lenta.estado().received > 0 && lenta.estado().received < entrada.size,
      'el progreso se puede consultar a mitad de descarga');
    check(lenta.iniciar({ providerId: 'llamacpp', entrada, dir: dirCancel }).errorCode === 'MODEL_DOWNLOAD_BUSY',
      'no se inicia una segunda descarga mientras hay una en curso');
    lenta.cancelar();
    const cancelada = await finCancelada;
    check(cancelada.state === 'canceled' && cancelada.errorCode === 'MODEL_DOWNLOAD_CANCELED'
      && !fs.existsSync(path.join(dirCancel, entrada.file)) && !fs.existsSync(path.join(dirCancel, `${entrada.file}.part`)),
      'cancelar detiene la descarga y borra lo parcial');

    console.log('\n=== 5. Del catálogo al selector de modelos ===');
    {
      const { AIProviderManager, PROVIDERS } = require('../src/main/ai-providers');
      const { GestorDeMotores } = require('../src/main/local-engines');
      guion = { cuerpo: contenido, lento: false };
      const catalogoReal = PROVIDERS.llamacpp.engine.catalogo;
      for (const real of [...catalogoReal, ...PROVIDERS.bitnet.engine.catalogo]) {
        check(entradaValida(real) && /^(Apache-2\.0|MIT)$/.test(real.license),
          `el catálogo fija revisión, tamaño, SHA-256 y licencia abierta de ${real.label}`);
      }
      check(PROVIDERS.bitnet.engine.catalogo.every(e => /^bitnet/.test(e.architecture))
        && catalogoReal.every(e => !/^bitnet/.test(e.architecture)),
        'BitNet sólo ofrece descargar modelos de BitNet, y llama.cpp ninguno de BitNet');
      catalogoReal.push(entrada);
      const modelsDir = path.join(tmp, 'perfil', 'models');
      const m = new AIProviderManager({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }, {
        motores: new GestorDeMotores({ spawn: () => { throw new Error('no'); }, env: { HOME: tmp, USERPROFILE: tmp, PATH: '' }, platform: process.platform }),
        descargas: new GestorDeDescargas({ fetchFn: fetchLocal }), modelsDir
      });
      try {
        const antes = m.engineCatalog('llamacpp').find(e => e.id === entrada.id);
        check(antes && antes.installed === false && !('sha256' in antes) && !('revision' in antes),
          'el catálogo que ve la interfaz dice qué falta, sin huellas ni revisiones');
        check(m.downloadCatalogModel('llamacpp', 'no-existe').errorCode === 'MODEL_DOWNLOAD_INVALID'
          && m.downloadCatalogModel('bitnet', entrada.id).errorCode === 'MODEL_DOWNLOAD_INVALID',
          'sólo se descarga una entrada del catálogo de ESE motor');
        check(m.downloadCatalogModel('llamacpp', entrada.id).ok === true, 'la descarga autorizada arranca');
        for (let i = 0; i < 200 && m.descargas.estado().state === 'downloading'; i += 1) await esperar(20);
        check(m.descargas.estado().state === 'done' && m.engineCatalog('llamacpp').find(e => e.id === entrada.id).installed,
          'al terminar, el catálogo lo da por instalado');
        const descubierto = m.discoverEngineModels().find(x => x.id === 'modelo-de-prueba');
        check(descubierto && descubierto.source === 'MIKA5' && descubierto.architecture === 'qwen2',
          'y el modelo aparece entre los descubiertos, sin esperar a la caché');
      } finally {
        catalogoReal.pop();
      }
    }

    console.log(`\nmodel-download: ${comprobaciones} comprobaciones OK`);
  } finally {
    await new Promise(resolve => servidor.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
