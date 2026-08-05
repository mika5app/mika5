'use strict';

// Cancelación de la cadena Ollama, extremo a extremo y contra un servidor real.
//
// Por qué existe: `local` era el único adaptador que no podía cancelarse. No
// hace fetch propio —delega en `ollamaApi`— y `ollamaApi.tags()`, `show()` y
// `status()` no aceptaban señal, así que `options.signal` moría en la frontera
// del módulo. `PROVIDER_ABORTED` era inalcanzable para el proveedor local por
// mucho que el usuario cancelase.
//
// Aquí se ejercita el adaptador REAL contra un servidor HTTP en un puerto
// efímero, no un doble de `ollamaApi`: lo que se comprueba es que la señal
// atraviesa adaptador -> ollamaApi -> fetchWithTimeout -> socket, y que el
// socket se cierra de verdad.
//
//   node test/ollama-cancellation.test.js

const assert = require('assert');
const http = require('http');
const fs2 = require('fs');
const path = require('path');

let comprobaciones = 0;
const fallos = [];
function check(condicion, mensaje) {
  comprobaciones += 1;
  if (condicion) console.log(`  ✓ ${mensaje}`);
  else { fallos.push(mensaje); console.log(`  ✗ ${mensaje}`); }
}

// --- Servidor sintético -----------------------------------------------------

const CATALOGO = [
  { name: 'stub-a:test', size: 1, digest: 'a' },
  { name: 'stub-b:test', size: 2, digest: 'b' }
];

const estado = {
  retrasoMs: 0,
  peticiones: [],
  abortadas: 0,
  pendientes: new Set()
};

const servidor = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', t => { cuerpo += t; });
  req.on('end', () => {
    const ruta = req.url.split('?')[0];
    estado.peticiones.push(`${req.method} ${ruta}`);

    const responder = () => {
      estado.pendientes.delete(temporizador);
      if (res.writableEnded || res.destroyed) return;
      const payload = ruta === '/api/tags'
        ? { models: CATALOGO }
        : { capabilities: ['completion'], model_info: {} };
      const texto = JSON.stringify(payload);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(texto)
      });
      res.end(texto);
    };

    // Que el cliente cierre el socket antes de la respuesta es la prueba de
    // que la cancelación llegó hasta abajo: si sólo se descartara la promesa,
    // el socket seguiría abierto esperando. Se escucha en `res`, no el evento
    // `aborted` de `req`, que está obsoleto y no dispara cuando el cuerpo de
    // la petición ya terminó.
    res.on('close', () => {
      if (!res.writableEnded) {
        estado.abortadas += 1;
        clearTimeout(temporizador);
        estado.pendientes.delete(temporizador);
      }
    });

    const temporizador = setTimeout(responder, estado.retrasoMs);
    estado.pendientes.add(temporizador);
  });
});

function limpiar() {
  for (const t of estado.pendientes) clearTimeout(t);
  estado.pendientes.clear();
  estado.peticiones.length = 0;
  estado.abortadas = 0;
}

async function principal() {
  await new Promise(r => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  // La base se fija ANTES de cargar nada: `BASE` se resuelve al requerir el
  // módulo, así que cargarlo antes lo dejaría apuntando al Ollama de verdad.
  process.env.MIKA5_OLLAMA_BASE = base;
  for (const modulo of ['../src/main/ollama', '../src/main/providers/local', '../src/main/provider-runtime']) {
    assert(!require.cache[require.resolve(modulo)],
      `${modulo} ya estaba cargado: la base habría quedado apuntando al Ollama real`);
  }
  const { ollamaApi } = require('../src/main/ollama');
  const { adaptadorLocal } = require('../src/main/providers/local');
  const { probeOllamaVision } = require('../src/main/provider-runtime');

  console.log('\n=== 0. La base sólo puede apuntar a bucle local ===');
  {
    const { resolverBaseOllama } = require('../src/main/ollama');
    check(resolverBaseOllama(undefined) === 'http://127.0.0.1:11434',
      'sin variable, la base es exactamente la de siempre');
    check(resolverBaseOllama('') === 'http://127.0.0.1:11434',
      'una variable vacía tampoco cambia el valor por defecto');
    for (const permitido of ['http://127.0.0.1:9999', 'http://localhost:1234', 'http://[::1]:8080']) {
      check(resolverBaseOllama(permitido).startsWith('http://'), `se admite ${permitido}`);
    }
    // Esto es lo que de verdad se está impidiendo: que una variable de entorno
    // baste para mandar a un host remoto todo lo que el usuario cree que no
    // sale de su máquina — prompts, adjuntos y contexto RAG. El modo local es
    // privado por definición.
    const PROHIBIDOS = [
      'http://evil.example.com:11434',
      'http://8.8.8.8:11434',
      'http://192.168.1.50:11434',
      'http://127.0.0.1.evil.com:11434',
      'https://127.0.0.1:11434',
      'file:///etc/passwd',
      'no-es-una-url'
    ];
    for (const prohibido of PROHIBIDOS) {
      let rechazado = false;
      try { resolverBaseOllama(prohibido); } catch (_) { rechazado = true; }
      check(rechazado, `se rechaza ${prohibido}`);
    }
  }

  console.log('\n=== 1. La base es la del servidor sintético ===');
  {
    estado.retrasoMs = 0;
    const s = await ollamaApi.status();
    check(s.ok === true && s.base === base, `status() habla con el servidor de prueba (${s.base})`);
    check(!/:11434(\/|$)/.test(s.base), 'y no con el Ollama real de la máquina');
  }

  console.log('\n=== 2. Sin señal, todo sigue funcionando ===');
  {
    limpiar();
    estado.retrasoMs = 0;
    const r = await adaptadorLocal.listModels();
    check(r.models.length === 2, `el catálogo llega entero (${r.models.length} modelos)`);
    check(r.probe.reachable === true && r.probe.authenticated === null,
      'la sonda declara alcanzable y sin credencial, como antes');
    check(r.probe.errorCode === null || r.probe.errorCode === undefined,
      `sin señal no hay código de error (${r.probe.errorCode})`);
    // Una llamada sin argumentos tiene que seguir valiendo: `getAvailability()`
    // la hace con dos, y otros sitios con ninguno.
    const dosArgs = await adaptadorLocal.listModels(undefined, undefined);
    check(dosArgs.models.length === 2, 'la llamada de dos argumentos sigue funcionando');
  }

  console.log('\n=== 3. Cancelación externa -> PROVIDER_ABORTED ===');
  {
    limpiar();
    estado.retrasoMs = 5000;
    const control = new AbortController();
    setTimeout(() => control.abort(), 150);
    const inicio = Date.now();
    const r = await adaptadorLocal.listModels(undefined, undefined, { signal: control.signal });
    const transcurrido = Date.now() - inicio;
    check(r.probe.errorCode === 'PROVIDER_ABORTED',
      `cancelar desde fuera atraviesa toda la cadena y da ${r.probe.errorCode}`);
    check(r.probe.reachable === null,
      'una cancelación no prueba nada sobre el servidor: reachable queda en null');
    check(r.models.length === 0, 'y no se devuelve un catálogo a medias');
    check(transcurrido < 3000, `corta de verdad, sin esperar al servidor (${transcurrido} ms)`);
    // El cierre del socket llega al servidor un turno después de que la
    // promesa del cliente se resuelva: se le da margen antes de mirar.
    await new Promise(r => setTimeout(r, 300));
    check(estado.abortadas >= 1,
      `el socket se cerró: el servidor vio ${estado.abortadas} petición(es) abortada(s)`);
  }

  console.log('\n=== 4. El plazo vencido -> PROVIDER_TIMEOUT, y es el de siempre ===');
  {
    // El adaptador NO impone un plazo propio al catálogo. Una versión anterior
    // de este cambio ponía 30 s al conjunto, y eso cambiaba el comportamiento
    // de v0.2.0: el catálogo son N+1 peticiones en serie —una por modelo— y en
    // una máquina lenta o con muchos modelos volvía vacío donde antes se
    // esperaba. Aquí se comprueba que ese límite no existe y que el plazo que
    // queda es el de `fetchWithTimeout`, con su código bien puesto.
    const fuenteLocal = fs2.readFileSync(path.join(__dirname, '../src/main/providers/local.js'), 'utf8');
    const codigo = fuenteLocal.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(!/createAbortContext/.test(codigo),
      'listModels() no crea un plazo propio para el catálogo');

    const fuenteOllama = fs2.readFileSync(path.join(__dirname, '../src/main/ollama.js'), 'utf8');
    check(/FETCH_TIMEOUT\s*=\s*600000/.test(fuenteOllama),
      'el plazo por petición sigue siendo el de v0.2.0: diez minutos');
    check(/vencido\.code\s*=\s*'PROVIDER_TIMEOUT'/.test(fuenteOllama),
      'y cuando vence lleva código, no sólo un texto que nadie puede clasificar');

    // Que ese error se clasifique bien se comprueba de verdad, no leyendo la
    // fuente: se construye el mismo error que produce el plazo.
    const { probeDeError } = require('../src/main/provider-errors');
    const vencido = new Error('Timeout: La operación excedió 10 minutos');
    vencido.code = 'PROVIDER_TIMEOUT';
    const probe = probeDeError(vencido);
    check(probe.errorCode === 'PROVIDER_TIMEOUT',
      `un plazo vencido da ${probe.errorCode}, distinto de una cancelación`);
    check(probe.reachable === null, 'y tampoco prueba nada del servidor');
  }

  console.log('\n=== 5. Los dos códigos salen del MISMO camino ===');
  {
    limpiar();
    estado.retrasoMs = 5000;
    const control = new AbortController();
    setTimeout(() => control.abort(), 120);
    const cancelado = await adaptadorLocal.listModels(undefined, undefined, { signal: control.signal });

    limpiar();
    const yaAbortada = AbortSignal.abort();
    const previo = await adaptadorLocal.listModels(undefined, undefined, { signal: yaAbortada });

    check(cancelado.probe.errorCode === 'PROVIDER_ABORTED' && previo.probe.errorCode === 'PROVIDER_ABORTED',
      'el mismo adaptador distingue quién cortó, y una señal ya abortada también aborta');
    check(estado.peticiones.length === 0,
      `una señal ya abortada ni sale a la red (${estado.peticiones.length} peticiones)`);
  }

  console.log('\n=== 6. La sonda de visión propaga la cancelación ===');
  {
    limpiar();
    estado.retrasoMs = 5000;
    const control = new AbortController();
    setTimeout(() => control.abort(), 120);
    let lanzado = null;
    try {
      await probeOllamaVision('stub-a:test', { signal: control.signal });
    } catch (e) {
      lanzado = e;
    }
    // Devolver `false` aquí diría «este modelo no acepta imágenes», que es una
    // afirmación sobre el modelo. Nadie la comprobó: se canceló.
    check(lanzado && lanzado.name === 'AbortError',
      `una sonda cancelada lanza en vez de fingir «sin visión» (${lanzado && lanzado.name})`);

    limpiar();
    estado.retrasoMs = 0;
    const sinVision = await probeOllamaVision('stub-a:test');
    check(sinVision === false, 'y un modelo que no declara visión sigue devolviendo false');
  }

  console.log('\n=== 7. La cancelación llega al catálogo a medio recorrer ===');
  {
    // Cancelar durante las sondas, no en el /api/tags inicial: el bucle es
    // secuencial y ahí es donde se pasa la mayor parte del tiempo.
    limpiar();
    estado.retrasoMs = 400;
    const control = new AbortController();
    setTimeout(() => control.abort(), 600);
    const r = await adaptadorLocal.listModels(undefined, undefined, { signal: control.signal });
    check(r.probe.errorCode === 'PROVIDER_ABORTED',
      `cancelar mientras se sondean los modelos también aborta (${r.probe.errorCode})`);
    check(r.models.length === 0,
      'y no se entrega el catálogo parcial que ya se había construido');
    check(estado.peticiones.length >= 2,
      `se había avanzado de verdad antes de cortar (${estado.peticiones.join(', ')})`);
  }

  console.log('\n=== 8. Ningún secreto en el mensaje de error ===');
  {
    limpiar();
    estado.retrasoMs = 5000;
    const control = new AbortController();
    setTimeout(() => control.abort(), 100);
    const r = await adaptadorLocal.listModels('sk-secreto-de-prueba-123456', undefined, { signal: control.signal });
    const serializado = JSON.stringify(r);
    check(!/sk-secreto/.test(serializado), 'la clave no aparece en lo que devuelve el adaptador');
    check(!/127\.0\.0\.1|localhost/.test(String(r.probe.errorCode)),
      'ni el código de error lleva el endpoint');
  }

  servidor.close();
  for (const t of estado.pendientes) clearTimeout(t);

  if (fallos.length) {
    console.error(`\nollama-cancellation: ${fallos.length} de ${comprobaciones} comprobaciones fallaron`);
    for (const f of fallos) console.error('  FALLO: ' + f);
    process.exitCode = 1;
    return;
  }
  console.log(`\nOllama cancellation tests passed (${comprobaciones} comprobaciones)`);
}

principal().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
