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
const { ORIGEN, ORIGEN_DE_MOTORES, GestorDeDescargas, urlDe, entradaValida } = require('../src/main/model-download');

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
  const fetchLocal = (url, opciones) => fetch(String(url).replace(ORIGEN_DE_MOTORES, `${base}/motores/`).replace(ORIGEN, base), opciones);
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

    console.log('\n=== 6. «Instalar y comenzar»: motor y modelo con un solo permiso ===');
    {
      const net = require('net');
      const childProcess = require('child_process');
      const { AIProviderManager, PROVIDERS, READINESS } = require('../src/main/ai-providers');
      const { GestorDeMotores } = require('../src/main/local-engines');
      const DOBLE = path.join(__dirname, 'helpers', 'fake-llama-server.js');
      const spec = PROVIDERS.bitnet.engine;
      const nombreExe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
      const binario = crypto.randomBytes(50000);
      const motor = {
        platform: process.platform, arch: process.arch, file: nombreExe, size: binario.length,
        url: `${ORIGEN_DE_MOTORES}bitnet-runtime-test/${nombreExe}`,
        sha256: crypto.createHash('sha256').update(binario).digest('hex')
      };
      check(entradaValida(motor), 'un motor con URL de las versiones de MIKA5, tamaño y SHA-256 es descargable');
      for (const [nombre, malo] of [
        ['alojado en otro sitio', { ...motor, url: `https://ejemplo.test/${nombreExe}` }],
        ['con una URL que sale de su carpeta', { ...motor, url: `${ORIGEN_DE_MOTORES}../../otro/${nombreExe}` }],
        ['con parámetros en la URL', { ...motor, url: `${motor.url}?x=1` }],
        ['sin huella', { ...motor, sha256: '' }]
      ]) {
        check(!entradaValida(malo), `un motor ${nombre} se rechaza`);
      }
      // GGUF con arquitectura BitNet, como modelo del catálogo.
      const valorBitnet = Buffer.from('bitnet-b1.58', 'utf8');
      const ggufBitnet = Buffer.concat([Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(1),
        u64(clave.length), clave, u32(8), u64(valorBitnet.length), valorBitnet, crypto.randomBytes(20000)]);
      const modeloBitnet = {
        id: 'bitnet-de-prueba', label: 'BitNet de prueba', architecture: 'bitnet-b1.58', repo: 'org/bitnet-GGUF',
        revision: 'b'.repeat(40), file: 'bitnet-de-prueba.gguf', size: ggufBitnet.length, license: 'MIT',
        sha256: crypto.createHash('sha256').update(ggufBitnet).digest('hex')
      };
      const puertoLibre = () => new Promise((resolve) => {
        const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
      });
      // Lo que el adaptador publica de verdad: cada motor fija sistema, URL
      // exacta bajo las versiones de MIKA5, tamaño y huella, y se instala con
      // un nombre de la lista cerrada de ejecutables.
      check(spec.runtimes.length > 0 && spec.runtimes.every(r => entradaValida(r)
        && ['win32', 'linux', 'darwin'].includes(r.platform) && ['x64', 'arm64'].includes(r.arch)
        && r.file === (r.platform === 'win32' ? 'llama-server.exe' : 'llama-server')),
        'los motores de BitNet publicados fijan sistema, URL de MIKA5, tamaño y SHA-256');
      check(new Set(spec.runtimes.map(r => `${r.platform}/${r.arch}`)).size === spec.runtimes.length,
        'y no hay dos motores para el mismo sistema');
      // Las pruebas siguientes parten de «nada publicado» y publican uno falso.
      const runtimesReales = spec.runtimes.splice(0, spec.runtimes.length);
      const catalogoReal = spec.catalogo.splice(0, spec.catalogo.length, modeloBitnet);
      const baseOriginal = PROVIDERS.bitnet.baseUrl;
      const montar = (dirPerfil, lanzados) => {
        const motores = new GestorDeMotores({
          env: { HOME: dirPerfil, USERPROFILE: dirPerfil, PATH: '', SystemRoot: process.env.SystemRoot }, platform: process.platform,
          spawn: (cmd, args, opciones) => {
            if (/taskkill\.exe$/i.test(cmd)) return childProcess.spawn(cmd, args, opciones);
            lanzados.push({ cmd, args });
            return childProcess.spawn(process.execPath, [DOBLE, ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
          }
        });
        const almacen = new Map();
        const db = { prepare: (sql) => (/^SELECT key, value/i.test(sql)
          ? { all: (...k) => k.filter(x => almacen.has(x)).map(x => ({ key: x, value: almacen.get(x) })) }
          : (/^INSERT OR REPLACE/i.test(sql) ? { run: (k, v) => almacen.set(k, v) } : { all: () => [], get: () => undefined, run: () => {} })) };
        const m = new AIProviderManager(db, {
          motores, descargas: new GestorDeDescargas({ fetchFn: fetchLocal }),
          modelsDir: path.join(dirPerfil, 'models'), enginesDir: path.join(dirPerfil, 'engines')
        });
        return { m, motores, almacen };
      };
      const hastaTerminar = async (m) => {
        for (let i = 0; i < 300 && m.engineSetupStatus('bitnet').state === 'running'; i += 1) await esperar(50);
        return m.engineSetupStatus('bitnet');
      };
      try {
        // Sin motor publicado para este sistema: experimental, y no se finge nada.
        {
          const lanzados = [];
          const { m } = montar(path.join(tmp, 'perfil-sin-motor'), lanzados);
          const plan = m.engineSetupPlan('bitnet');
          const descrito = m.describeEngine('bitnet');
          check(plan.possible === false && plan.engineMissing && !plan.engineAvailable && descrito.experimental === true,
            'sin un motor publicado para este sistema, BitNet se declara experimental y no ofrece instalarse');
          check(m.prepareEngine('bitnet').errorCode === 'ENGINE_SETUP_UNAVAILABLE' && lanzados.length === 0,
            'y «Instalar y comenzar» no hace nada: ni descarga ni ejecuta');
        }

        // Con motor publicado: un permiso, dos descargas verificadas, motor en marcha.
        spec.runtimes.push(motor);
        {
          const lanzados = [];
          const perfil = path.join(tmp, 'perfil-ok');
          const { m, motores, almacen } = montar(perfil, lanzados);
          PROVIDERS.bitnet.baseUrl = `http://127.0.0.1:${await puertoLibre()}/v1`;
          guion = { cuerpo: null, lento: false };
          const porRuta = { [`/motores/bitnet-runtime-test/${nombreExe}`]: binario };
          const servir = (req) => porRuta[req] || ggufBitnet;
          // El servidor sintético responde según la ruta pedida.
          servidor.removeAllListeners('request');
          servidor.on('request', (req, res) => { peticiones.push(req.url); res.writeHead(200); res.end(servir(req.url)); });
          const plan = m.engineSetupPlan('bitnet');
          check(plan.possible && plan.steps.map(p => p.kind).join() === 'engine,model'
            && plan.totalSize === binario.length + ggufBitnet.length,
            'el plan dice qué se va a instalar y cuánto ocupa: motor y modelo');
          check(!JSON.stringify(plan).includes('http') && !JSON.stringify(plan).includes(perfil),
            'el plan que ve la interfaz no lleva URL ni rutas');
          const antes = peticiones.length;
          check(m.prepareEngine('bitnet').ok === true, 'la preparación autorizada arranca');
          check(m.prepareEngine('bitnet').already === true, 'pedirla dos veces no la duplica');
          const fin = await hastaTerminar(m);
          check(fin.state === 'done', `la preparación termina bien (${fin.state} ${fin.errorCode || ''})`);
          const exe = path.join(perfil, 'engines', 'bitnet', nombreExe);
          check(fs.readFileSync(exe).equals(binario) && fs.existsSync(path.join(perfil, 'models', modeloBitnet.file)),
            'el motor queda en la carpeta de motores de MIKA5 y el modelo en la de modelos');
          check(peticiones.slice(antes).join() === `/motores/bitnet-runtime-test/${nombreExe},/org/bitnet-GGUF/resolve/${'b'.repeat(40)}/bitnet-de-prueba.gguf`,
            'se descargó exactamente el motor y el modelo del catálogo, una vez cada uno');
          const guardado = JSON.parse(almacen.get('engine_bitnet'));
          check(guardado.approval.sha256 === motor.sha256 && m.engineIdentity('bitnet').approved,
            'el motor instalado queda autorizado con la huella que se comprobó');
          check(lanzados.length === 1 && fs.realpathSync(lanzados[0].cmd) === fs.realpathSync(exe)
            && lanzados[0].args.includes('-ngl') && lanzados[0].args[1].endsWith(modeloBitnet.file),
            'y MIKA5 arranca ese motor con ese modelo, sin más pasos');
          let listo = await m.getReadiness('bitnet');
          for (let i = 0; i < 100 && listo.readiness !== READINESS.READY; i += 1) { await esperar(100); listo = await m.getReadiness('bitnet'); }
          check(listo.readiness === READINESS.READY && listo.engine.status === 'ready',
            'el proveedor queda listo para conversar');
          const plan2 = m.engineSetupPlan('bitnet');
          check(plan2.possible && plan2.steps.length === 0, 'con todo instalado, la siguiente vez no hay nada que descargar');
          // Alguien cambia el motor instalado: deja de ejecutarse.
          await motores.detener('bitnet');
          fs.writeFileSync(exe, 'sustituido');
          motores.descubrir(spec, { fresca: true });
          check(m.engineIdentity('bitnet').approved === false
            && (await m.getReadiness('bitnet', { autoStart: true })).action === 'approve-engine' && lanzados.length === 1,
            'si el motor instalado se sustituye, MIKA5 deja de ejecutarlo y vuelve a pedir permiso');
        }

        // El motor descargado no coincide con su huella: no se instala.
        {
          const lanzados = [];
          const perfil = path.join(tmp, 'perfil-malo');
          const { m } = montar(perfil, lanzados);
          servidor.removeAllListeners('request');
          servidor.on('request', (req, res) => { res.writeHead(200); res.end(Buffer.concat([binario.subarray(0, -1), Buffer.from([binario.at(-1) ^ 1])])); });
          m.prepareEngine('bitnet');
          const fin = await hastaTerminar(m);
          check(fin.state === 'failed' && fin.errorCode === 'MODEL_DOWNLOAD_CHECKSUM'
            && !fs.existsSync(path.join(perfil, 'engines', 'bitnet', nombreExe)) && lanzados.length === 0,
            'un motor alterado en la descarga se descarta: ni se instala ni se ejecuta');
        }
      } finally {
        spec.runtimes.splice(0, spec.runtimes.length, ...runtimesReales);
        spec.catalogo.splice(0, spec.catalogo.length, ...catalogoReal);
        PROVIDERS.bitnet.baseUrl = baseOriginal;
      }
    }

    console.log(`\nmodel-download: ${comprobaciones} comprobaciones OK`);
  } finally {
    await new Promise(resolve => servidor.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
