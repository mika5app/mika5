'use strict';

// Selector de proveedor, salida de la aplicación y ausencia de aviso bloqueante.
//
// La regresión que estas pruebas impiden es la de v0.3.0: el commit 7995013
// añadió `overflow: hidden` a `.provider-selector`, el contenedor de
// posicionamiento del desplegable. El menú seguía abriéndose (301x522 px) pero
// quedaba recortado al completo: área visible 0, ninguna de las siete opciones
// pulsable. Ni el markup ni el registro de proveedores estaban rotos, así que
// una prueba de "existe el nodo" habría pasado. Por eso aquí se mide con
// `elementFromPoint`: la única comprobación que distingue "está en el DOM" de
// "el usuario puede pulsarlo".
//
// El recorte no se vigila sólo en el selector. Hay un detector genérico que
// recorre, para cada superficie flotante, la cadena de antepasados capaces de
// recortarla. Introducir el mismo fallo en cualquier otra capa también falla.
//
// Se ejecuta con Electron, no con node: el flujo depende de IPC real, de un
// preload real y de la maquetación real de Chromium. Los handlers son los de
// src/main/main.js, no dobles.
//
//   npm run test:provider-selector

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { app } = require('electron');

// userData aislado ANTES de cargar main.js: la prueba nunca lee ni escribe los
// proyectos, chats, documentos ni credenciales reales del usuario.
const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-test-selector-'));
app.setPath('userData', perfil);
app.setPath('sessionData', perfil);

// Chromium trata una ventana tapada por otra como ventana en segundo plano y
// deja de propagar el nuevo tamaño al renderer: `getContentSize()` ya dice 261
// mientras `window.innerHeight` sigue en 181, indefinidamente. Medido: al
// crecer de 220 a 300 px el renderer no se enteraba ni tras cuatro segundos.
//
// Sin esto, la prueba mediría la geometría de la ventana ANTERIOR y sería
// coherente consigo misma —el menú se dimensiona con ese mismo innerHeight
// obsoleto—, así que pasaría sin haber comprobado la altura que dice comprobar.
//
// Es un ajuste del arnés, no del producto: lo fija el proceso de la prueba, que
// es quien arranca Electron aquí. La aplicación no lo lleva.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// `app:quit` se prueba de verdad, hasta el handler de main.js. Sólo se
// intercepta el efecto final para que la prueba no se mate a sí misma.
let llamadasQuit = 0;
app.quit = () => { llamadasQuit += 1; };

// ---------------------------------------------------------------------------
// Ollama de prueba
// ---------------------------------------------------------------------------
//
// Esta suite no puede hablar con el Ollama de la máquina. `local.listModels()`
// pide el catálogo y luego sonda CADA modelo con `/api/show`, en serie: en un
// equipo con trece modelos son trece peticiones por cada `switchProvider()`, y
// la suite cambia de proveedor una decena de veces. El resultado dependía del
// catálogo instalado y de la carga del equipo, y el plazo hubo que subirlo a
// diez minutos para que cupiese.
//
// El bucle secuencial NO es una regresión de esta rama: v0.2.0 (tag 438d393)
// hace exactamente lo mismo, modelo a modelo. Aquí no se cambia el
// comportamiento del producto — sólo a dónde apunta la prueba.
//
// Los nombres del catálogo no pueden existir en un Ollama real. Ésa es la
// prueba decisiva de aislamiento: si alguna petición hubiese llegado al 11434
// de la máquina, el selector mostraría los modelos del usuario y no éstos.
const CATALOGO_STUB = [
  { name: 'mika5-stub-chat:test', size: 1073741824, digest: 'stubchat0001' },
  { name: 'mika5-stub-vision:test', size: 2147483648, digest: 'stubvis00002' },
  { name: 'mika5-stub-embed:test', size: 268435456, digest: 'stubemb00003' }
];
// Capacidades por modelo, fijas y declaradas: ni heurística por nombre ni azar.
const CON_VISION = new Set(['mika5-stub-vision:test']);

const peticionesStub = [];
const BASE_PREVIA = process.env.MIKA5_OLLAMA_BASE;

const stub = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', trozo => { cuerpo += trozo; });
  req.on('end', () => {
    const ruta = req.url.split('?')[0];
    peticionesStub.push({ metodo: req.method, ruta, cuerpo });

    const responder = (codigo, objeto) => {
      const texto = JSON.stringify(objeto);
      res.writeHead(codigo, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(texto)
      });
      res.end(texto);
    };

    if (req.method === 'GET' && ruta === '/api/tags') {
      return responder(200, { models: CATALOGO_STUB });
    }

    if (req.method === 'POST' && ruta === '/api/show') {
      // Se acepta el cuerpo que Ollama recibe de verdad. `ollamaApi.show()`
      // manda `{ name }`; la API también admite `{ model }`. Un cuerpo sin
      // ninguno de los dos es un 400, como en Ollama.
      let pedido = null;
      try {
        const json = JSON.parse(cuerpo || '{}');
        pedido = json.name || json.model || null;
      } catch (_) { /* cuerpo ilegible: se trata como ausente */ }
      if (!pedido) return responder(400, { error: 'model name is required' });
      if (!CATALOGO_STUB.some(m => m.name === pedido)) {
        return responder(404, { error: `model '${pedido}' not found` });
      }
      // Las dos formas que reconoce el detector: la clave `.vision.` de los
      // modelos locales y el array `capabilities` de los proxied.
      return responder(200, CON_VISION.has(pedido)
        ? { capabilities: ['completion', 'vision'], model_info: { 'clip.vision.embedding_length': 1024 } }
        : { capabilities: ['completion'], model_info: { 'general.architecture': 'llama' } });
    }

    if (req.method === 'POST' && ruta === '/api/chat') {
      return responder(200, {
        model: 'mika5-stub-chat:test',
        message: { role: 'assistant', content: 'respuesta de prueba' },
        done: true,
        done_reason: 'stop'
      });
    }

    responder(404, { error: 'not found' });
  });
});

// Los módulos que hablan con Ollama se cargan DESPUÉS de fijar la variable:
// `BASE` se resuelve una sola vez, al requerir el módulo.
let PROVIDERS, AIProviderManager, getDb, ollamaApi, IDS_CANONICOS, ALTO_MINIMO_VENTANA;

function cerrarStub() {
  if (BASE_PREVIA === undefined) delete process.env.MIKA5_OLLAMA_BASE;
  else process.env.MIKA5_OLLAMA_BASE = BASE_PREVIA;
  try { stub.close(); } catch (_) { /* ya cerrado */ }
}

const fallos = [];
let comprobaciones = 0;

function check(condicion, mensaje) {
  comprobaciones += 1;
  if (!condicion) fallos.push(mensaje);
}

async function esperar(win, expresion, ms = 8000) {
  const inicio = Date.now();
  while (Date.now() - inicio < ms) {
    if (await win.webContents.executeJavaScript(`Boolean(${expresion})`, true)) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Timeout esperando ${expresion}`);
}

const ev = (win, codigo) => win.webContents.executeJavaScript(`(async () => { ${codigo} })()`, true);

// Desacuerdo tolerado entre `getContentSize()` y `window.innerHeight`.
//
// Comportamiento OBSERVADO en Electron 31 sobre Windows con escalado
// fraccionario, no un mecanismo deducido: a scaleFactor 1.25, pedir 222 px deja
// contenido 185 e innerHeight 186, y siguen separados en todas las lecturas
// posteriores, no sólo un instante. Electron documenta la geometría de pantalla
// en puntos independientes de dispositivo
// (https://electronjs.org/docs/latest/api/structures/display); por qué las dos
// lecturas acaban en enteros distintos no se ha demostrado aquí y esta prueba no
// lo afirma. Lo que sí se midió es que exigir igualdad exacta colgaba la espera
// hasta agotar el plazo.
//
// El margen sigue siendo diminuto frente a lo que esta espera existe para
// detectar: cuando Chromium deja de propagar el tamaño a una ventana tapada, la
// diferencia medida fue de 80 px, no de uno.
const DESFASE_DPI = 2;

/**
 * Redimensiona y espera a que Electron TERMINE.
 *
 * Un plazo fijo no vale: el tamaño exterior, el de contenido y el
 * `window.innerHeight` del renderer no cambian en el mismo instante, y medir
 * en medio da la geometría de la ventana anterior. Se espera a que el renderer
 * concuerde con el tamaño de contenido —dentro del desfase de redondeo por
 * DPI— y a que deje de moverse.
 *
 * Devuelve el tamaño EXTERIOR resultante, que no tiene por qué ser el pedido:
 * si se pide menos que `minHeight`, Electron recorta y aquí se ve.
 */
async function redimensionar(win, ancho, alto) {
  win.setSize(ancho, alto);
  let previo = -1;
  let ultimo = null;
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 50));
    const [, contenido] = win.getContentSize();
    const [, exterior] = win.getSize();
    const interior = await win.webContents.executeJavaScript('window.innerHeight', true);
    ultimo = { exterior, contenido, interior };
    if (Math.abs(interior - contenido) <= DESFASE_DPI && interior === previo) return ultimo;
    previo = interior;
  }
  throw new Error(`el redimensionado a ${alto}px no se estabilizó: ${JSON.stringify(ultimo)}`);
}

async function ejecutar(win) {
  await esperar(win, "document.querySelectorAll('#providerOptions .provider-option').length > 0");
  assert.ok(IDS_CANONICOS.length >= 7,
    'el registro canónico debe declarar al menos los siete proveedores');

  // --- 0. Aislamiento: nada llegó al Ollama real ----------------------------
  //
  // No basta con que el stub haya recibido peticiones: hay que demostrar que no
  // hubo además un segundo canal hacia el 11434 de la máquina. La prueba
  // decisiva es el catálogo. Los nombres del stub no existen en ningún Ollama
  // real, así que si el selector muestra exactamente esos y sólo esos, no hay
  // ninguna respuesta del Ollama del usuario en el camino.

  const baseEnUso = await ollamaApi.status();
  check(baseEnUso.base === process.env.MIKA5_OLLAMA_BASE,
    `ollama.js resuelve la base del stub (${baseEnUso.base})`);
  check(!/:11434(\/|$)/.test(baseEnUso.base),
    `la base en uso no es el puerto real de Ollama (${baseEnUso.base})`);

  const rutasVistas = [...new Set(peticionesStub.map(p => `${p.metodo} ${p.ruta}`))];
  check(peticionesStub.length > 0, `el stub recibió tráfico (${peticionesStub.length} peticiones)`);
  check(rutasVistas.includes('GET /api/tags'), `el stub sirvió el catálogo (${rutasVistas.join(' | ')})`);
  check(rutasVistas.includes('POST /api/show'), 'el stub sirvió la sonda de capacidades');
  const CONOCIDAS = ['GET /api/tags', 'POST /api/show', 'POST /api/chat'];
  const desconocidas = rutasVistas.filter(r => !CONOCIDAS.includes(r));
  check(desconocidas.length === 0,
    `no se pidió ninguna ruta fuera del contrato de Ollama (${desconocidas.join(' | ') || 'ninguna'})`);

  // El cuerpo tiene que ser el que Ollama recibe de verdad, no uno inventado
  // para que el doble responda: si `show()` dejase de mandar el nombre, la
  // sonda devolvería 400 en producción y aquí seguiría pasando.
  const cuerposShow = peticionesStub.filter(p => p.ruta === '/api/show');
  const cuerposValidos = cuerposShow.filter(p => {
    try {
      const json = JSON.parse(p.cuerpo);
      return typeof (json.name || json.model) === 'string';
    } catch (_) { return false; }
  });
  check(cuerposShow.length > 0 && cuerposValidos.length === cuerposShow.length,
    `cada /api/show llegó con el nombre del modelo (${cuerposValidos.length}/${cuerposShow.length})`);

  // Se activa con un CLIC REAL sobre la opción, que es la ruta del usuario:
  // el `onclick` del markup, `switchProvider()` entero y el `loadRuntime()` que
  // dispara. Ni `setProvider` ni `loadRuntime` por separado — rodear la ruta
  // que se quiere verificar deja sin comprobar justo lo que importa.
  const catalogo = await ev(win, `
    const desplegable = document.getElementById('providerOptions');

    // La senal de fin es la PROMESA del manejador, no un efecto que se le
    // parezca. Se envuelve switchProvider para capturarla y despues se pulsa de
    // verdad: el clic entra por el atributo onclick del markup y ejecuta la
    // funcion entera, sin que la prueba la invoque por su cuenta.
    //
    // Antes esto esperaba a estados observables y los dos candidatos enganaban.
    // Que el desplegable este cerrado no vale: el clic burbujea hasta el oyente
    // de document, que lo cierra al instante. Que se pueda reabrir y siga
    // abierto tampoco: con un plazo corto, un switchProvider que termine
    // despues cierra el menu cuando ya nadie mira.
    const original = window.switchProvider;
    let promesa = null;
    window.switchProvider = (...args) => { promesa = original(...args); return promesa; };
    try {
      document.getElementById('providerTrigger').click();
      const opcion = [...desplegable.querySelectorAll('.provider-option')]
        .find(n => (n.getAttribute('onclick') || '').includes("switchProvider('local')"));
      if (!opcion) return { error: 'no existe la opción local en el markup' };
      opcion.click();
      if (!promesa) return { error: 'el onclick del markup no llamó a switchProvider' };
      await promesa;
    } finally {
      window.switchProvider = original;
    }
    return [...document.getElementById('modelSelect').options].map(o => o.value || o.textContent.trim());
  `);
  if (catalogo && catalogo.error) throw new Error(`no se pudo activar local -> ${catalogo.error}`);
  const trasClic = await ev(win, `
    return {
      proveedor: (await window.mika5.ai.getCurrentProvider()).id,
      desplegable: document.getElementById('providerOptions').style.display
    };
  `);
  check(trasClic.proveedor === 'local',
    `pulsar la opción del selector activa el proveedor (${trasClic.proveedor})`);
  // Pulsar una opción cierra el desplegable: es la única forma de que el
  // disparador vuelva a abrirlo, porque alterna leyendo `style.display`.
  check(trasClic.desplegable === 'none',
    `elegir un proveedor cierra el desplegable (display=${trasClic.desplegable || '(vacío)'})`);

  // El desplegable que el usuario reabre no puede cerrarse solo.
  //
  // `switchProvider()` cerraba el menú en su última línea, después de esperar a
  // `loadRuntime()`. Con un proveedor cloud lento eso son segundos, y en ese
  // hueco el cierre quedaba pendiente: reabrir el menú y verlo cerrarse solo.
  // Aquí se reproduce con una espera artificialmente larga en el runtime, que
  // es lo que la hacía visible, y se comprueba que el menú sigue abierto.
  const carrera = await ev(win, `
    const desplegable = document.getElementById('providerOptions');
    const runtimeOriginal = window.loadRuntime;
    const switchOriginal = window.switchProvider;
    window.loadRuntime = async (...args) => {
      await new Promise(r => setTimeout(r, 800));
      return runtimeOriginal(...args);
    };
    let promesa = null;
    window.switchProvider = (...args) => { promesa = switchOriginal(...args); return promesa; };
    try {
      document.getElementById('providerTrigger').click();
      const opcion = [...desplegable.querySelectorAll('.provider-option')]
        .find(n => (n.getAttribute('onclick') || '').includes("switchProvider('local')"));
      opcion.click();
      // El usuario vuelve a abrir el menú mientras el runtime sigue cargando.
      await new Promise(r => setTimeout(r, 100));
      document.getElementById('providerTrigger').click();
      const alReabrir = desplegable.style.display;
      await promesa;
      const trasTerminar = desplegable.style.display;
      document.getElementById('providerTrigger').click();
      return { alReabrir, trasTerminar };
    } finally {
      window.loadRuntime = runtimeOriginal;
      window.switchProvider = switchOriginal;
    }
  `);
  check(carrera.alReabrir === 'block',
    `el desplegable se puede reabrir mientras el proveedor carga (${carrera.alReabrir})`);
  check(carrera.trasTerminar === 'block',
    `y sigue abierto cuando switchProvider() termina (${carrera.trasTerminar})`);
  // `mika5-stub-embed:test` no aparece: el filtro de modelos de embedding del
  // renderer lo descarta, y que lo descarte forma parte de lo que se comprueba.
  check(catalogo.includes('mika5-stub-chat:test') && catalogo.includes('mika5-stub-vision:test'),
    `el selector muestra el catálogo del stub (${catalogo.join(', ')})`);
  check(!catalogo.includes('mika5-stub-embed:test'),
    'el modelo de embedding del stub se filtra y no se ofrece para chatear');
  check(catalogo.every(n => n === '' || /^mika5-stub-/.test(n)),
    `ningún modelo del Ollama real se coló en el selector (${catalogo.join(', ')})`);

  // --- 1. El selector se abre y el desplegable se ve -------------------------

  const apertura = await ev(win, `
    const d = document.getElementById('providerTrigger');
    const o = document.getElementById('providerOptions');
    const cerrado = getComputedStyle(o).display;
    d.click();
    await new Promise(r => setTimeout(r, 150));
    const env = document.querySelector('.provider-selector');
    const re = env.getBoundingClientRect(), ro = o.getBoundingClientRect();
    return {
      cerrado,
      abierto: getComputedStyle(o).display,
      overflowEnvoltorio: getComputedStyle(env).overflow,
      cajaDesplegable: { w: Math.round(ro.width), h: Math.round(ro.height) },
      cajaEnvoltorio: { w: Math.round(re.width), h: Math.round(re.height) }
    };
  `);
  check(apertura.cerrado === 'none', `parte cerrado (display=${apertura.cerrado})`);
  check(apertura.abierto === 'block', `pulsar el disparador lo abre (display=${apertura.abierto})`);
  check(apertura.overflowEnvoltorio === 'visible',
    `.provider-selector no recorta el desplegable (overflow=${apertura.overflowEnvoltorio})`);
  check(apertura.cajaDesplegable.h > apertura.cajaEnvoltorio.h,
    `el desplegable es más alto que su envoltorio, que es justo lo que se recortaba (${apertura.cajaDesplegable.h} vs ${apertura.cajaEnvoltorio.h})`);

  // --- 2. Están los proveedores del registro canónico y se pueden pulsar -----
  //
  // El markup lista los proveedores a mano. Esta comprobación es la que impide
  // que la lista y el registro canónico diverjan: si alguien añade o retira un
  // proveedor en ai-providers.js y no toca index.html, falla.

  const pintados = await ev(win, `
    const nodos = [...document.querySelectorAll('#providerOptions .provider-option')];
    return nodos.map(n => {
      const r = n.getBoundingClientRect();
      const enPunto = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const handler = n.getAttribute('onclick') || '';
      const etiqueta = n.querySelector('.privacy-tag');
      return {
        id: (handler.match(/switchProvider\\('([^']+)'\\)/) || [])[1] || null,
        nombre: n.querySelector('.provider-name').textContent.trim(),
        etiqueta: etiqueta ? etiqueta.textContent.trim() : '',
        clasePrivacidad: etiqueta ? etiqueta.className : '',
        accionable: Boolean(enPunto && n.contains(enPunto))
      };
    });
  `);

  const idsEnMarkup = pintados.map(p => p.id).filter(Boolean).sort();
  check(JSON.stringify(idsEnMarkup) === JSON.stringify([...IDS_CANONICOS].sort()),
    `el selector ofrece exactamente los proveedores del registro canónico (markup: ${idsEnMarkup.join(',')} | registro: ${[...IDS_CANONICOS].sort().join(',')})`);

  // Los siete de la referencia v0.2.0 siguen presentes en v0.3.x.
  for (const id of ['local', 'openai', 'anthropic', 'groq', 'moonshot', 'alibaba', 'llamacpp']) {
    check(idsEnMarkup.includes(id), `el proveedor ${id} sigue en el selector`);
  }

  // La regresión concreta: en el DOM pero imposible de pulsar.
  const accionables = pintados.filter(p => p.accionable).length;
  check(accionables === pintados.length && accionables === IDS_CANONICOS.length,
    `las ${IDS_CANONICOS.length} opciones reciben el clic en su centro (accionables: ${accionables} de ${pintados.length})`);

  // --- 3. Locales y cloud se distinguen -------------------------------------

  for (const p of pintados) {
    if (!p.id) continue;
    const esPrivado = PROVIDERS[p.id].privacy === 'private';
    check(/privacy-tag/.test(p.clasePrivacidad), `${p.id} muestra etiqueta de privacidad`);
    check(esPrivado ? /private/.test(p.clasePrivacidad) : /cloud/.test(p.clasePrivacidad),
      `${p.id} se marca como ${esPrivado ? 'privado' : 'cloud'} (clase: ${p.clasePrivacidad})`);
    check(esPrivado ? /privado|private/i.test(p.etiqueta) : !/privado|private/i.test(p.etiqueta),
      `${p.id} rotula bien su privacidad ("${p.etiqueta}")`);
  }
  const locales = pintados.filter(p => p.id && PROVIDERS[p.id].privacy === 'private').map(p => p.id);
  check(locales.length === 2 && locales.includes('local') && locales.includes('llamacpp'),
    `los dos proveedores locales están declarados como tales (${locales.join(',')})`);

  // --- 4. Selección manual, modelo automático y no-desplazamiento -----------

  const traza = await ev(win, `
    const salida = [];
    for (const objetivo of ['alibaba', 'groq', 'llamacpp', 'openai', 'local']) {
      await switchProvider(objetivo);
      const actual = await window.mika5.ai.getCurrentProvider();
      salida.push({ pedido: objetivo, activo: actual.id, privacidad: actual.privacy });
    }
    return salida;
  `);
  for (const paso of traza) {
    check(paso.activo === paso.pedido,
      `elegir ${paso.pedido} activa ${paso.pedido} y no otro (activo: ${paso.activo})`);
    const esperada = PROVIDERS[paso.pedido].privacy;
    check(paso.privacidad === esperada,
      `${paso.pedido} conserva su privacidad al activarse (${paso.privacidad})`);
  }
  const trasAlibaba = traza.slice(traza.findIndex(p => p.pedido === 'alibaba') + 1);
  check(trasAlibaba.length > 0 && trasAlibaba.every(p => p.activo === p.pedido),
    'tras pasar por Alibaba, los demás proveedores siguen eligiéndose sin redirección');

  // `__automatic__` es un identificador de MODELO, no de proveedor: elegirlo no
  // puede tocar la elección manual de proveedor.
  const automatico = await ev(win, `
    await switchProvider('groq');
    const antes = (await window.mika5.ai.getCurrentProvider()).id;
    await window.mika5.setAppState('lastModel', AUTOMATIC_MODEL_ID);
    const select = document.getElementById('modelSelect');
    if (select) { select.value = AUTOMATIC_MODEL_ID; select.dispatchEvent(new Event('change')); }
    await new Promise(r => setTimeout(r, 200));
    return { antes, despues: (await window.mika5.ai.getCurrentProvider()).id, esModelo: AUTOMATIC_MODEL_ID === '__automatic__' };
  `);
  check(automatico.esModelo, '__automatic__ es el identificador de modelo automático');
  check(automatico.antes === 'groq' && automatico.despues === 'groq',
    `el modelo automático no sustituye al proveedor elegido a mano (${automatico.antes} -> ${automatico.despues})`);

  // --- 5. Persistencia y rehidratación --------------------------------------

  await ev(win, `await switchProvider('moonshot'); return true;`);
  const guardado = getDb().prepare('SELECT value FROM app_state WHERE key = ?').get('ai_provider');
  check(guardado && guardado.value === 'moonshot',
    `la elección se persiste con el mecanismo existente (app_state.ai_provider=${guardado && guardado.value})`);

  // Un gestor nuevo sobre la misma base rehidrata lo elegido: es lo que ocurre
  // al reiniciar la aplicación.
  const rehidratado = new AIProviderManager(getDb());
  check(rehidratado.getProvider().id === 'moonshot',
    `al reiniciar se recupera el proveedor elegido (${rehidratado.getProvider().id})`);

  // Un identificador que ya no existe no puede dejar la app sin proveedor.
  getDb().prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)')
    .run('ai_provider', 'proveedor-retirado');
  const conBasura = new AIProviderManager(getDb());
  check(conBasura.getProvider().id === 'local',
    `un proveedor desconocido persistido cae al local en vez de romper (${conBasura.getProvider().id})`);
  getDb().prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)')
    .run('ai_provider', 'local');

  // Ninguna credencial puede viajar al renderer con la lista de proveedores.
  const listaIpc = await ev(win, `return JSON.stringify(await window.mika5.ai.getProviders());`);
  check(!/sk-|api[_-]?key|"key"/i.test(listaIpc),
    'ai:get-providers no expone claves ni campos de credencial');

  // --- 6. Salir de MIKA5 ----------------------------------------------------

  const salida = await ev(win, `
    const boton = document.getElementById('btnQuitApp');
    if (!boton) return { existe: false };
    const menu = document.getElementById('moreActionsMenu');
    menu.hidden = false;
    await new Promise(r => setTimeout(r, 80));
    const r = boton.getBoundingClientRect();
    const enPunto = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      existe: true,
      rol: boton.getAttribute('role'),
      etiqueta: (boton.textContent || '').trim(),
      accionable: Boolean(enPunto && boton.contains(enPunto)),
      version: document.getElementById('appVersionValue').textContent.trim()
    };
  `);
  check(salida.existe, 'existe una acción visible para salir de la aplicación');
  check(salida.rol === 'menuitem', `la acción vive en un menú (role=${salida.rol})`);
  check(salida.accionable, 'la acción de salida es pulsable con el menú abierto');

  // Nombrar la acción «cerrar sesión» prometería invalidar una sesión que no
  // existe y sugeriría que algo se borra. La regla se fija sobre los DOS
  // diccionarios, porque el idioma del perfil de prueba lo decide el sistema.
  const rotulos = await ev(win, `
    return Object.fromEntries(Object.entries(MIKA5_TRANSLATIONS)
      .map(([lang, dict]) => [lang, dict['app.quitApp']]));
  `);
  check(Object.keys(rotulos).length >= 2, `hay rótulo en los dos idiomas (${Object.keys(rotulos).join(',')})`);
  for (const [lang, rotulo] of Object.entries(rotulos)) {
    check(typeof rotulo === 'string' && rotulo.length > 0, `${lang}: la acción de salida tiene rótulo`);
    check(!/cerrar sesi|sign out|log ?out|logout/i.test(rotulo || ''),
      `${lang}: el rótulo no promete cerrar una sesión inexistente ("${rotulo}")`);
    check(/mika5/i.test(rotulo || ''),
      `${lang}: el rótulo nombra la aplicación de la que se sale ("${rotulo}")`);
  }

  // Estado previo: lo que salir NO puede tocar.
  const antesDeSalir = {
    proyectos: getDb().prepare('SELECT COUNT(*) c FROM projects').get().c,
    estados: getDb().prepare('SELECT COUNT(*) c FROM app_state').get().c
  };

  const quitPrevio = llamadasQuit;
  await ev(win, `
    document.getElementById('btnQuitApp').click();
    await new Promise(r => setTimeout(r, 150));
    document.getElementById('mikaConfirmOkBtn').click();
    await new Promise(r => setTimeout(r, 250));
    return true;
  `);
  check(llamadasQuit === quitPrevio + 1,
    `salir llega al mecanismo real app:quit (${llamadasQuit - quitPrevio} invocaciones)`);

  const despuesDeSalir = {
    proyectos: getDb().prepare('SELECT COUNT(*) c FROM projects').get().c,
    estados: getDb().prepare('SELECT COUNT(*) c FROM app_state').get().c
  };
  check(despuesDeSalir.proyectos === antesDeSalir.proyectos,
    `salir no borra proyectos (${antesDeSalir.proyectos} -> ${despuesDeSalir.proyectos})`);
  check(despuesDeSalir.estados === antesDeSalir.estados,
    `salir no borra configuración ni credenciales (${antesDeSalir.estados} -> ${despuesDeSalir.estados})`);
  check(Boolean(getDb().prepare('SELECT value FROM app_state WHERE key = ?').get('ai_provider')),
    'el proveedor elegido sobrevive a salir');

  // Salir siempre confirma: un clic accidental en el menú no puede cerrar la app.
  const quitAntesDeCancelar = llamadasQuit;
  await ev(win, `
    document.getElementById('btnQuitApp').click();
    await new Promise(r => setTimeout(r, 150));
    mikaConfirmCancel();
    await new Promise(r => setTimeout(r, 150));
    return true;
  `);
  check(llamadasQuit === quitAntesDeCancelar, 'cancelar la confirmación no cierra la aplicación');

  // --- 7. Cambio de idioma --------------------------------------------------
  //
  // Los rótulos escritos desde JS se congelan al pintarse. Si nadie los
  // repinta al cambiar de idioma, se quedan en el anterior.

  const idioma = await ev(win, `
    const menu = document.getElementById('moreActionsMenu');
    menu.hidden = false;
    const antes = {
      salir: document.getElementById('btnQuitAppLabel').textContent.trim(),
      version: document.getElementById('appVersionLabel').textContent.trim()
    };
    document.getElementById('btnLangToggle').click();
    await new Promise(r => setTimeout(r, 400));
    const despues = {
      salir: document.getElementById('btnQuitAppLabel').textContent.trim(),
      version: document.getElementById('appVersionLabel').textContent.trim()
    };
    document.getElementById('btnLangToggle').click();
    await new Promise(r => setTimeout(r, 350));
    const vuelta = document.getElementById('btnQuitAppLabel').textContent.trim();
    menu.hidden = true;
    return { antes, despues, vuelta };
  `);
  check(idioma.antes.salir !== idioma.despues.salir,
    `la acción de salida se traduce al cambiar de idioma ("${idioma.antes.salir}" -> "${idioma.despues.salir}")`);
  check(idioma.antes.version !== idioma.despues.version,
    `la etiqueta de versión se traduce ("${idioma.antes.version}" -> "${idioma.despues.version}")`);
  check(idioma.vuelta === idioma.antes.salir,
    `volver al idioma original restaura el rótulo ("${idioma.vuelta}")`);

  // --- 8. Ninguna capa flotante recortada por un antepasado ------------------
  //
  // Generaliza el fallo de v0.3.0 en vez de vigilar sólo el selector: para cada
  // superficie se recorre la cadena de antepasados que pueden recortarla y se
  // exige que su caja quepa entera. `position: fixed` sólo queda contenido por
  // un antepasado con transform, filter, perspective o contain.

  const capas = await ev(win, `
    const pausa = ms => new Promise(r => setTimeout(r, ms));
    function contiene(e) {
      return e.transform !== 'none' || e.filter !== 'none'
        || e.perspective !== 'none' || /paint|layout|strict|content/.test(e.contain || '');
    }
    function recortadores(nodo) {
      const r = nodo.getBoundingClientRect();
      const area = r.width * r.height;
      if (!area) return ['(sin caja)'];
      const fijo = getComputedStyle(nodo).position === 'fixed';
      const fuera = [];
      let p = nodo.parentElement, contenido = !fijo;
      while (p) {
        const c = getComputedStyle(p);
        if (fijo && !contenido) contenido = contiene(c);
        if (contenido && /hidden|clip|auto|scroll/.test(c.overflow + ' ' + c.overflowX + ' ' + c.overflowY)) {
          const rp = p.getBoundingClientRect();
          const w = Math.max(0, Math.min(r.right, rp.right) - Math.max(r.left, rp.left));
          const h = Math.max(0, Math.min(r.bottom, rp.bottom) - Math.max(r.top, rp.top));
          if ((w * h) / area < 0.999) fuera.push((p.id || String(p.className).split(' ')[0]) + ':' + c.overflow);
        }
        p = p.parentElement;
      }
      return fuera;
    }
    const MODALES = ['apiKeyModal','exportModal','mikaPromptModal','mikaConfirmModal','mikaSelectModal'];
    const cerrarTodo = () => {
      const po = document.getElementById('providerOptions'); if (po) po.style.display = 'none';
      const mo = document.getElementById('modelOptions'); if (mo) mo.classList.remove('open');
      closeMoreActionsMenu();
      for (const id of MODALES) { const m = document.getElementById(id); if (m) m.style.display = 'none'; }
    };
    const salida = [];
    const anota = (nombre, nodo) => salida.push({
      capa: nombre, presente: Boolean(nodo), recortadaPor: nodo ? recortadores(nodo) : ['(ausente)']
    });

    cerrarTodo();
    document.getElementById('providerOptions').style.display = 'block'; await pausa(140);
    anota('providerOptions', document.getElementById('providerOptions'));
    cerrarTodo(); document.getElementById('modelTrigger').click(); await pausa(140);
    anota('modelOptions', document.getElementById('modelOptions'));
    cerrarTodo(); openMoreActionsMenu(); await pausa(140);
    anota('moreActionsMenu', document.getElementById('moreActionsMenu'));
    cerrarTodo();
    for (const id of MODALES) {
      const m = document.getElementById(id);
      m.style.display = 'flex'; await pausa(110);
      anota(id, m);
      m.style.display = 'none';
    }
    const consentimiento = requestCloudConsentChoice('OpenAI', { scope: 'proyecto' }, null);
    await pausa(250);
    anota('cloudConsentModal', document.getElementById('cloudConsentModal'));
    const cancelar = document.querySelector('#cloudConsentModal button');
    if (cancelar) cancelar.click();
    consentimiento.catch(() => {});
    await pausa(150);
    salida.push({ capa: 'cloudConsentModal:cerrado', presente: !document.getElementById('cloudConsentModal'), recortadaPor: [] });
    cerrarTodo();
    return salida;
  `);
  for (const capa of capas) {
    if (capa.capa.endsWith(':cerrado')) {
      check(capa.presente, 'el modal de consentimiento se retira del DOM al cancelarlo');
      continue;
    }
    check(capa.presente, `la capa ${capa.capa} existe cuando se abre`);
    check(capa.recortadaPor.length === 0,
      `la capa ${capa.capa} no la recorta ningún antepasado (${capa.recortadaPor.join(', ')})`);
  }
  check(capas.length >= 9, `se auditaron todas las capas flotantes (${capas.length})`);

  // --- 9. Aviso de versión --------------------------------------------------
  //
  // MIKA5 no trae actualizador: no hay `electron-updater` en las dependencias
  // ni una sola llamada a `autoUpdater` en `src/`. Lo que se fija aquí es esa
  // realidad y su consecuencia comprobable: nada bloquea la ventana al
  // arrancar. Si alguien añade un aviso de actualización, estas comprobaciones
  // fallan y obligan a implementarlo con cierre y posposición reales.

  const pantalla = await ev(win, `
    const W = innerWidth, H = innerHeight;
    const capas = [];
    for (const nodo of document.body.querySelectorAll('*')) {
      const c = getComputedStyle(nodo);
      if (c.position !== 'fixed' && c.position !== 'absolute') continue;
      if (c.display === 'none' || c.visibility === 'hidden' || c.opacity === '0') continue;
      const r = nodo.getBoundingClientRect();
      if ((r.width * r.height) / (W * H) < 0.5) continue;
      capas.push(nodo.id || String(nodo.className).slice(0, 40));
    }
    return {
      capasQueTapan: capas,
      entradaHabilitada: !document.getElementById('input').disabled,
      textoConVersion: (document.body.innerText || '').split('\\n').map(s => s.trim())
        .filter(s => /nueva versi|new version|actualizaci|update available/i.test(s))
    };
  `);
  check(pantalla.capasQueTapan.length === 0,
    `ninguna capa tapa la ventana al arrancar (${pantalla.capasQueTapan.join(', ')})`);
  check(pantalla.entradaHabilitada, 'la caja de escritura queda utilizable');
  check(pantalla.textoConVersion.length === 0,
    `no hay aviso de nueva versión en la interfaz (${pantalla.textoConVersion.join(' | ')})`);

  const pkg = require('../package.json');
  const dependencias = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  check(!dependencias['electron-updater'],
    'MIKA5 no declara electron-updater: cualquier aviso de versión sería de otra aplicación');

  const fuentes = ['src/main/main.js', 'src/renderer/app.js', 'src/main/preload.js']
    .map(rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')).join('\n');
  check(!/autoUpdater|checkForUpdates/.test(fuentes),
    'no hay comprobación de actualizaciones en el código: nada puede bloquear la ventana por ese camino');

  // La versión instalada y la disponible son cosas distintas: MIKA5 sólo
  // conoce la instalada y así lo dice, en vez de inventar una comparación.
  const versionIpc = await ev(win, `return await window.mika5.app.getVersion();`);
  check(versionIpc.installed === pkg.version,
    `la versión instalada es la real del paquete (${versionIpc.installed} vs ${pkg.version})`);
  check(typeof versionIpc.packaged === 'boolean',
    'se distingue una compilación empaquetada de una de desarrollo');
  check(!('available' in versionIpc) && !('latest' in versionIpc),
    'no se publica una "versión disponible" que nadie ha consultado');
  check(/^v\d+\.\d+\.\d+/.test(salida.version),
    `se muestra la versión instalada, no una inventada (${salida.version})`);
  check(app.isPackaged || /desarrollo|development/i.test(salida.version),
    `en worktree la versión se marca como desarrollo (${salida.version})`);

  // La cifra que se enseña tiene que ser la que sella electron-builder, y ésa
  // vive en package.json. `app.getVersion()` devuelve la de Electron cuando el
  // punto de entrada no es la raíz del proyecto.
  check(versionIpc.installed !== process.versions.electron,
    `la versión mostrada no es la de Electron (${versionIpc.installed})`);

  // --- 10. Sin regresión en proyectos y chats -------------------------------

  const datos = await ev(win, `
    const proyecto = await window.mika5.db.createProject({ name: 'Proyecto de prueba', description: '' });
    const proyectos = await window.mika5.db.listProjects();
    const destino = proyectos.find(p => p.name === 'Proyecto de prueba');
    await window.mika5.db.createChat({ projectId: destino.id, title: 'Chat de prueba' });
    const chats = await window.mika5.db.listChats(destino.id);
    await loadProjects();
    await selectProject(destino.id, destino.name);
    await new Promise(r => setTimeout(r, 400));
    return {
      creado: Boolean(proyecto),
      proyectos: proyectos.length,
      chats: chats.length,
      enBarraLateral: document.getElementById('projectList').children.length,
      titulo: document.getElementById('activeTitle').textContent.trim()
    };
  `);
  check(datos.creado && datos.proyectos >= 1, `los proyectos se crean y se listan (${datos.proyectos})`);
  check(datos.chats >= 1, `los chats se crean y se listan (${datos.chats})`);
  check(datos.enBarraLateral >= 1, `los proyectos aparecen en la barra lateral (${datos.enBarraLateral})`);
  check(datos.titulo.includes('Proyecto de prueba'),
    `seleccionar un proyecto lo refleja en la cabecera (${datos.titulo})`);

  // El desplegable sigue completo y pulsable al final del recorrido.
  const final = await ev(win, `
    const opciones = document.getElementById('providerOptions');
    opciones.style.display = 'none';
    document.getElementById('providerTrigger').click();
    // Espera activa en vez de un plazo fijo: tras crear un proyecto y
    // recargarlo, el repintado puede tardar más de los 150 ms que había aquí y
    // la comprobación resultaba intermitente. Se espera al estado, no al reloj.
    for (let i = 0; i < 40; i++) {
      if (getComputedStyle(opciones).display === 'block'
          && opciones.getBoundingClientRect().height > 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    // Dos fotogramas para que el desplegable esté maquetado antes de medir,
    // pero con plazo: Chromium no entrega requestAnimationFrame cuando la
    // ventana no está pintando —minimizada, tapada o en segundo plano— y sin
    // el respaldo esta espera no termina nunca. Ese cuelgue no se distingue de
    // un fallo real: el gate se agotaba sin decir dónde.
    await new Promise(r => {
      const listo = () => { clearTimeout(plazo); r(); };
      const plazo = setTimeout(r, 500);
      requestAnimationFrame(() => requestAnimationFrame(listo));
    });
    const nodos = [...document.querySelectorAll('#providerOptions .provider-option')];
    const vivos = nodos.filter(n => {
      const r = n.getBoundingClientRect();
      const p = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(p && n.contains(p));
    });
    return { total: nodos.length, vivos: vivos.length };
  `);
  check(final.vivos === final.total && final.total === IDS_CANONICOS.length,
    `el selector sigue completo y pulsable al final (${final.vivos}/${final.total})`);

  // --- 11. El desplegable es usable a TODA altura soportada ----------------
  //
  // Con siete proveedores la lista mide ~520 px: en una ventana baja no cabe.
  // Lo que se comprueba es que se recorta dentro de su propia caja y no por
  // debajo de la pantalla, que cabe al menos una fila entera y accionable, que
  // se llega a las siete opciones, y que el hueco que deja libre es
  // exactamente el margen declarado — ni más ni menos.
  //
  // Dos regresiones concretas cierra esto:
  //
  // 1. `max-height: calc(100vh - 96px)` en CSS. Ese 96 suponía dónde empieza el
  //    menú, que empieza en y=50, así que reservaba 46 px y los dejaba vacíos:
  //    media fila de proveedor perdida en toda ventana lo bastante baja como
  //    para recortar. Lo caza la cota superior del hueco.
  // 2. `Math.max(120, ...)` como suelo del alto del menú. Por debajo de cierta
  //    altura ese suelo ganaba, el menú se comía el margen inferior y acababa
  //    saliéndose. Lo caza la cota inferior del hueco: si el suelo está activo,
  //    el menú baja de `innerHeight - MARGEN` por construcción.
  //
  // Y no hay umbral de escape. Una versión anterior sólo exigía alcanzar las
  // siete opciones cuando quedaban ≥ 80 px libres, así que aceptaba un menú de
  // altura cero como resultado válido. Ahora la altura mínima la impone
  // `minHeight` en `BrowserWindow`, calculada desde la geometría real de una
  // fila, y por eso las comprobaciones pueden exigirse SIEMPRE.
  const [anchoOriginal, altoOriginal] = win.getSize();
  const MARGEN = 16;

  // Se pide una ventana muy por debajo del mínimo. Electron tiene que recortar.
  //
  // La relación es `>=`, no `===`, y no por comodidad. Comportamiento observado
  // en Electron 31 sobre Windows a scaleFactor 1.25: con `minHeight` en 220,
  // pedir 100 devuelve 222 exteriores, no 220. En qué unidad aplica Electron ese
  // recorte por dentro no se ha demostrado y aquí no se afirma; lo medido es el
  // resultado. Exigir 220 exacto ataba la prueba a una pantalla sin escalado.
  //
  // Lo que no se relaja es la garantía: la altura interior resultante, sea la
  // que sea, tiene que dar de sí para una fila entera, y eso lo comprueba el
  // bucle de abajo midiendo geometría real.
  const minima = await redimensionar(win, anchoOriginal, 100);
  const dpr = await win.webContents.executeJavaScript('window.devicePixelRatio', true);
  check(minima.exterior >= ALTO_MINIMO_VENTANA,
    `Electron aplica la altura mínima declarada (pedido 100, resultante ${minima.exterior}, minHeight ${ALTO_MINIMO_VENTANA})`);
  check(minima.exterior > 100,
    `la ventana no baja de lo pedido por debajo del mínimo (pedido 100, resultante ${minima.exterior})`);
  // El marco puede medir CERO. Bajo Xvfb no hay gestor de ventanas y no hay
  // decoración: `getSize()` y `window.innerHeight` coinciden. Exigir que el
  // interior fuese estrictamente menor que el exterior ataba la prueba a un
  // escritorio con decoración. Lo que sí se sigue exigiendo es que la altura
  // interior exista, sea coherente con la exterior, y —abajo, midiendo
  // geometría— que dé de sí para una fila entera.
  const marco = minima.exterior - minima.interior;
  check(minima.interior > 0 && marco >= 0 && minima.interior <= minima.exterior,
    `la altura interior efectiva del mínimo es ${minima.interior}px (exterior ${minima.exterior}px, marco ${marco}px)`);
  console.log(`provider-selector: mínimo declarado ${ALTO_MINIMO_VENTANA}px → ventana real `
    + `${minima.exterior}px exteriores → window.innerHeight ${minima.interior}px `
    + `(marco ${minima.exterior - minima.interior}px, devicePixelRatio ${dpr})`);

  // La primera altura de la lista es la mínima EFECTIVA, la que Electron dejó,
  // no una que se dé por supuesta. Las demás son alturas mayores
  // representativas.
  for (const alto of [minima.exterior, 300, 420, 600, 1000]) {
    const ventana = await redimensionar(win, anchoOriginal, alto);
    const g = await ev(win, `
      const menu = document.getElementById('providerOptions');
      menu.style.display = 'none';
      document.getElementById('providerTrigger').click();
      await new Promise(r => setTimeout(r, 200));
      const caja = menu.getBoundingClientRect();
      const opciones = [...menu.querySelectorAll('.provider-option')];
      const alturasFila = opciones.map(n => n.getBoundingClientRect().height);

      // Área realmente visible del menú. \`clientHeight\` es la caja de relleno:
      // el borde queda fuera, el padding dentro, y el padding empuja a la
      // primera fila hacia abajo, así que no puede darse por área útil.
      const cs = getComputedStyle(menu);
      const borde = parseFloat(cs.borderTopWidth) || 0;
      const relleno = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const cliente = menu.clientHeight;
      const contenido = menu.scrollHeight;
      const recorta = contenido > cliente;
      const visibleArriba = caja.top + borde;
      const visibleAbajo = visibleArriba + cliente;

      // Desplazamiento REAL, no un \`overflow-y: auto\` declarado que un
      // antepasado con \`overflow: hidden\` deje sin efecto.
      menu.scrollTop = contenido;
      const scrollMax = menu.scrollTop;
      menu.scrollTop = 0;

      // Fila entera y accionable: una opción íntegramente dentro del área
      // visible del menú Y que responde al hit-testing en su centro. Que la
      // caja del menú quepa en el viewport no basta: un menú de altura cero
      // también cabe.
      await new Promise(r => setTimeout(r, 60));
      let enteras = 0;
      for (const n of opciones) {
        const r = n.getBoundingClientRect();
        if (r.height <= 0) continue;
        if (r.top < visibleArriba - 0.5 || r.bottom > visibleAbajo + 0.5) continue;
        const centro = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (centro && n.contains(centro)) enteras += 1;
      }

      // Recorrido completo, como lo haría el usuario: cada opción tiene que
      // llegar a ser pulsable en algún momento del desplazamiento.
      const alcanzadas = new Set();
      const pasos = Math.ceil(contenido / Math.max(1, cliente)) + 2;
      for (let i = 0; i <= pasos; i++) {
        menu.scrollTop = (contenido / pasos) * i;
        await new Promise(r => setTimeout(r, 60));
        for (const n of opciones) {
          const r = n.getBoundingClientRect();
          if (r.height <= 0) continue;
          const centro = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (centro && n.contains(centro)) alcanzadas.add(n.getAttribute('onclick'));
        }
      }
      menu.scrollTop = 0;
      document.getElementById('providerTrigger').click();
      return {
        ventana: window.innerHeight,
        top: Math.round(caja.top),
        bottom: Math.round(caja.bottom),
        // Sin redondear: el margen se comprueba sobre el borde REAL. Redondear
        // el borde puede sumar medio píxel y convertir un margen correcto en un
        // fallo, o al revés.
        topExacto: caja.top,
        bottomExacto: caja.bottom,
        cliente, contenido, recorta, relleno, scrollMax,
        util: cliente - relleno,
        filaMax: Math.max(...alturasFila),
        filaMin: Math.min(...alturasFila),
        enteras,
        alcanzadas: alcanzadas.size,
        total: opciones.length
      };
    `);

    const etiqueta = `${alto}px ext / innerHeight ${g.ventana}`;
    check(g.ventana === ventana.interior,
      `${etiqueta}: la prueba mide sobre el innerHeight efectivo (${g.ventana} == ${ventana.interior})`);
    check(g.bottom <= g.ventana,
      `${etiqueta}: el desplegable no supera el borde inferior (${g.bottom} <= ${g.ventana})`);
    // Espacio para una fila entera. Se compara contra la fila MÁS ALTA medida,
    // no contra una constante: la de llama.cpp lleva la descripción a dos
    // líneas y mide más que las otras seis.
    check(g.util >= g.filaMax,
      `${etiqueta}: cabe una fila entera (área útil ${g.util}px >= fila más alta ${g.filaMax.toFixed(2)}px)`);
    check(g.enteras >= 1,
      `${etiqueta}: al menos una fila completa es accionable de verdad (${g.enteras})`);
    check(g.total === IDS_CANONICOS.length,
      `${etiqueta}: el menú lista los ${IDS_CANONICOS.length} proveedores (${g.total})`);
    check(g.alcanzadas === g.total,
      `${etiqueta}: las ${g.total} opciones se alcanzan y pasan hit-testing (${g.alcanzadas})`);
    check(g.recorta ? g.scrollMax > 0 : g.scrollMax === 0,
      `${etiqueta}: el desplazamiento vertical existe justo cuando hace falta `
      + `(contenido ${g.contenido}, visible ${g.cliente}, scrollTop máximo ${g.scrollMax})`);
    if (g.recorta) {
      // El hueco bajo el menú tiene que ser EXACTAMENTE el margen declarado.
      // Por debajo, el menú se está comiendo el margen; por encima, está
      // desperdiciando alto.
      //
      // Se mide sobre el borde REAL, sin redondear. El menú no empieza en una
      // coordenada entera fuera de Windows —en Linux arranca en 49,x—, así que
      // redondear el borde inferior desplazaba el resultado medio píxel. El
      // margen mínimo no lleva tolerancia: `1e-9` es ruido de coma flotante al
      // sumar `top + max-height`, no permiso para invadir el margen.
      const huecoExacto = g.ventana - g.bottomExacto;
      check(huecoExacto >= MARGEN - 1e-9,
        `${etiqueta}: al recortar respeta el margen inferior `
        + `(deja ${huecoExacto.toFixed(3)}px, margen ${MARGEN}, borde ${g.bottomExacto.toFixed(3)})`);
      check(huecoExacto <= MARGEN + 4,
        `${etiqueta}: al recortar aprovecha el alto disponible `
        + `(deja ${huecoExacto.toFixed(3)}px, margen ${MARGEN})`);
    }
    console.log(`provider-selector: ${etiqueta} — menú ${g.top}..${g.bottom}, `
      + `visible ${g.cliente}px (útil ${g.util}px), contenido ${g.contenido}px, `
      + `fila ${g.filaMin.toFixed(2)}..${g.filaMax.toFixed(2)}px, `
      + `filas enteras ${g.enteras}, alcanzadas ${g.alcanzadas}/${g.total}`);
  }

  // A la altura mínima el contenido no cabe: el desplazamiento es obligatorio,
  // no opcional. Si algún día cupiese entero, esta comprobación avisa de que la
  // premisa cambió en vez de dejar pasar un recorrido que no recorre nada.
  const enMinima = await redimensionar(win, anchoOriginal, minima.exterior);
  const scrollMinima = await ev(win, `
    const menu = document.getElementById('providerOptions');
    menu.style.display = 'none';
    document.getElementById('providerTrigger').click();
    await new Promise(r => setTimeout(r, 200));
    const r = { contenido: menu.scrollHeight, visible: menu.clientHeight };
    document.getElementById('providerTrigger').click();
    return r;
  `);
  check(scrollMinima.contenido > scrollMinima.visible,
    `a la altura mínima (innerHeight ${enMinima.interior}) el menú se desplaza por dentro `
    + `(contenido ${scrollMinima.contenido} > visible ${scrollMinima.visible})`);

  // Redimensionar con el menú abierto tiene que reajustarlo, no dejarlo con el
  // alto de la ventana anterior.
  await redimensionar(win, anchoOriginal, 1000);
  const reajuste = await ev(win, `
    const menu = document.getElementById('providerOptions');
    menu.style.display = 'none';
    document.getElementById('providerTrigger').click();
    await new Promise(r => setTimeout(r, 200));
    return { antes: Math.round(menu.getBoundingClientRect().bottom) };
  `);
  await redimensionar(win, anchoOriginal, 480);
  const despues = await ev(win, `
    const menu = document.getElementById('providerOptions');
    const caja = menu.getBoundingClientRect();
    const r = { bottom: Math.round(caja.bottom), ventana: window.innerHeight };
    document.getElementById('providerTrigger').click();
    return r;
  `);
  check(despues.bottom <= despues.ventana,
    `encoger la ventana con el menú abierto lo reajusta (${despues.bottom} <= ${despues.ventana}, antes ${reajuste.antes})`);

  await redimensionar(win, anchoOriginal, altoOriginal);
}

// El oyente se registra antes de cargar main.js, que es quien abre la ventana.
app.on('browser-window-created', (_e, win) => {
  // Los errores del renderer no llegan solos a la salida del gate. Sin esto,
  // una excepción dentro de `executeJavaScript` se manifiesta como un plazo
  // agotado sin causa visible.
  win.webContents.on('console-message', (_ev, nivel, mensaje) => {
    if (nivel >= 2) console.error(`[renderer] ${mensaje}`);
  });
  win.webContents.once('did-finish-load', async () => {
    // El arranque del renderer es asíncrono y se deja asentar antes de medir.
    await new Promise(r => setTimeout(r, 2000));
    let error = null;
    try {
      await ejecutar(win);
    } catch (e) {
      error = e;
    }

    // El recuento por ruta se imprime siempre: es la evidencia de que todo el
    // tráfico de Ollama terminó en el stub, y deja de haber que instrumentar a
    // mano para saberlo cuando algo cambie.
    const porRuta = new Map();
    for (const p of peticionesStub) {
      const clave = `${p.metodo} ${p.ruta}`;
      porRuta.set(clave, (porRuta.get(clave) || 0) + 1);
    }
    console.log(`provider-selector: stub en ${process.env.MIKA5_OLLAMA_BASE} — `
      + `${peticionesStub.length} peticiones: `
      + [...porRuta].map(([r, n]) => `${r} x${n}`).join(', '));

    cerrarStub();

    if (error) {
      console.error('provider-selector: la prueba no pudo completarse:', error && error.stack || error);
      app.exit(1);
      return;
    }
    if (fallos.length) {
      console.error(`\nprovider-selector: ${fallos.length} de ${comprobaciones} comprobaciones fallaron:`);
      for (const f of fallos) console.error('  FALLO: ' + f);
      app.exit(1);
      return;
    }
    console.log(`provider-selector: ${comprobaciones} comprobaciones OK`);
    app.exit(0);
  });
});

// Sólo cuando el stub escucha se fija la variable y se cargan los módulos. El
// orden es la garantía: `BASE` se resuelve al requerir `ollama.js`, así que
// cargarlo antes dejaría la suite hablando con el Ollama real.
stub.listen(0, '127.0.0.1', () => {
  process.env.MIKA5_OLLAMA_BASE = `http://127.0.0.1:${stub.address().port}`;

  // Nadie puede haber cargado ya estos módulos con la base real. No se limpia
  // la caché: se comprueba. Borrarla escondería el problema y dejaría dos
  // copias del módulo vivas, cada una con su `BASE`.
  const contaminados = ['../src/main/ollama', '../src/main/ai-providers', '../src/main/main']
    .filter(m => require.cache[require.resolve(m)]);
  if (contaminados.length) {
    console.error(`provider-selector: módulos cargados antes de fijar la base: ${contaminados.join(', ')}`);
    cerrarStub();
    app.exit(3);
    return;
  }

  // La altura mínima se lee del propio main.js: la prueba comprueba la ventana
  // contra el número que la ventana usa, no contra una copia que envejezca.
  ({ ALTO_MINIMO_VENTANA } = require('../src/main/main.js'));
  ({ PROVIDERS, AIProviderManager } = require('../src/main/ai-providers'));
  ({ getDb } = require('../src/main/db'));
  ({ ollamaApi } = require('../src/main/ollama'));
  IDS_CANONICOS = Object.keys(PROVIDERS);
});

// Plazo ajustado al coste real, que ahora es constante: el catálogo del stub
// son tres modelos, así que `loadRuntime()` hace cuatro peticiones locales por
// cambio de proveedor y ninguna sale de la máquina. Los diez minutos de antes
// pagaban el catálogo del equipo y la carga de un Ollama compartido con los
// siete gates anteriores; ya no hay nada de eso que pagar. Dos minutos dejan
// margen de sobra al arranque de Chromium y siguen cortando de verdad si algo
// se bloquea.
setTimeout(() => {
  console.error('provider-selector: timeout global');
  cerrarStub();
  app.exit(2);
}, 120000);
