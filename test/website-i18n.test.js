// test/website-i18n.test.js — El sitio publico debe estar completo en espanol e
// ingles, y el conmutador debe cambiarlo todo.
//
// Run: node test/website-i18n.test.js
//
// Por que existe: el diccionario puede tener paridad perfecta y aun asi dejar
// medio sitio en un solo idioma, porque el texto vive en el HTML sin clave. Eso
// paso: 136 claves con paridad y 737 nodos hardcodeados. Esta suite mide la
// cobertura real, no el tamano del diccionario.
//
// Esta fase cubre landing.html y models.html. whitepaper.html sigue pendiente y
// esta declarado como tal: la suite falla si alguien lo da por hecho sin
// traducirlo.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
let passed = 0;

function check(condition, message) {
  assert(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}

const leer = rel => fs.readFileSync(path.join(WEB, rel), 'utf8').replace(/\r\n?/g, '\n');

// =====================================================================
// Allowlist explicita: texto identico en ambos idiomas por ser tecnico.
// Sin comodines: cada entrada se justifica sola.
// =====================================================================
const ALLOWLIST_TEXTO = [
  // marcas y nombres propios
  'MIKA5', 'Ollama', 'llama.cpp', 'OpenAI', 'Anthropic', 'Groq', 'Moonshot',
  'Alibaba Cloud Model Studio', 'GitHub', 'Electron', 'SQLite', 'Windows',
  'macOS', 'Linux', 'AppImage', 'DMG', 'NSIS', '.deb', '.rpm',
  // identificadores de modelo sin digito ni etiqueta (no los cubre el patron)
  'nomic-embed-text', 'mxbai-embed-large',
  // comentarios de comando identicos en ambos idiomas
  '# Windows', '# macOS', '# Linux',
  // control de idioma
  'EN', 'ES', '×', '&times;'
];

// Patrones de texto que no son user-facing: comandos, rutas, URLs, hashes.
const PATRONES_TECNICOS = [
  /^\$?\s*(ollama|curl|chmod|dpkg|rpm|sudo|sha256sum|shasum|Get-FileHash|PS&gt;|\.\/)/i,
  /^#?\s*MIKA5-[\w.-]+\.(exe|dmg|zip|AppImage|deb|rpm|tar\.gz)$/,
  /^(https?:\/\/|github\.com|ollama\.com|127\.0\.0\.1)/,
  /^[a-f0-9]{32,}$/i,
  /^[\d.]+\s*(GB|MB|KB)$/i,
  /^v?\d+\.\d+\.\d+$/,
  // Etiqueta de modelo de Ollama: minusculas, con digito o dos puntos.
  // Exige digito o ':' para que una palabra suelta en prosa no pase por aqui.
  /^[a-z][a-z0-9.-]*(:[a-z0-9.-]+)?$/,
  // Nombre de cuantizacion GGUF tal y como lo publica el registro.
  /^(Q\d(_\d|_[KM](_[SML])?)?|F16|F32|BF16)$/,
  // Nombre de archivo publicado en la release: un solo token con extension
  // conocida. La prosa no puede coincidir porque exige token unico.
  /^[A-Za-z][\w.-]*\.(md|json|txt|exe|dmg|zip|AppImage|deb|rpm|gz|tar\.gz)$/,
  // Familia de modelo con varias etiquetas: "qwen2.5-coder:7b / 14b / 32b"
  /^[a-z][a-z0-9.:-]*(\s*\/\s*[a-z0-9.]+)+$/
];

function esTecnico(texto) {
  if (ALLOWLIST_TEXTO.includes(texto)) return true;
  if (/^[a-z][a-z0-9.-]*(:[a-z0-9.-]+)?$/.test(texto) && !/[0-9:]/.test(texto)) return false;
  return PATRONES_TECNICOS.some(p => p.test(texto));
}

/**
 * Vacia el contenido de cada elemento con data-i18n-html contando la
 * profundidad de su propia etiqueta, para que un bloque con elementos
 * anidados del mismo tipo (un <div> de diagrama con <div> dentro) se cierre
 * donde corresponde y no en el primer cierre que aparezca.
 */
function vaciarI18nHtml(html) {
  const apertura = /<(\w+)([^>]*\sdata-i18n-html="[^"]*"[^>]*)>/;
  let salida = html;
  for (let vuelta = 0; vuelta < 500; vuelta++) {
    const m = apertura.exec(salida);
    if (!m) break;
    const tag = m[1];
    const token = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
    token.lastIndex = m.index + m[0].length;
    let profundidad = 1;
    let cierre = -1;
    let t;
    while ((t = token.exec(salida)) !== null) {
      profundidad += t[1] ? -1 : 1;
      if (profundidad === 0) { cierre = t.index; break; }
    }
    if (cierre === -1) break;
    // Se conserva la etiqueta, sin el atributo, para no volver a encontrarla.
    salida = `${salida.slice(0, m.index)}<${tag} data-i18n-html-vaciado>${salida.slice(cierre)}`;
  }
  return salida;
}

/** Nodos de texto visibles que no pasan por el sistema i18n. */
function nodosHardcodeados(html) {
  const limpio = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // El <title> lo traduce aplicarMetadata, no una clave del markup.
  let sinTitle = limpio.replace(/<title>[\s\S]*?<\/title>/gi, '');

  // El contenido de un elemento data-i18n-html lo define el diccionario: el
  // markup solo lleva el idioma por defecto. Se valida la clave (paridad,
  // traduccion distinta), no el HTML de respaldo, asi que se vacia aqui.
  // No es una via de escape: la clave sigue pasando por todas las demas
  // comprobaciones de esta suite.
  sinTitle = vaciarI18nHtml(sinTitle);

  const fuera = [];
  for (const m of sinTitle.matchAll(/>([^<>]+)</g)) {
    const texto = m[1].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (!texto || texto.length < 2) continue;
    if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2}/.test(texto)) continue;
    // La etiqueta de apertura puede ocupar varias lineas: se busca en todo el
    // documento, no solo en la linea del texto.
    const antes = sinTitle.slice(0, m.index);
    const apertura = antes.slice(antes.lastIndexOf('<'));
    if (/data-i18n(?:-html)?=/.test(apertura)) continue;
    if (esTecnico(texto)) continue;
    fuera.push(texto);
  }
  return fuera;
}

function diccionarios(html) {
  const en = html.slice(html.indexOf('  en: {'), html.indexOf('  es: {'));
  const es = html.slice(html.indexOf('  es: {'));
  const parse = bloque => {
    const mapa = new Map();
    for (const m of bloque.matchAll(/'([a-zA-Z0-9._-]+)':\s*'((?:\\'|[^'])*)'/g)) {
      mapa.set(m[1], m[2]);
    }
    return mapa;
  };
  return { en: parse(en), es: parse(es) };
}

// Claves cuyo texto coincide en ES y EN de forma deliberada. Cada una lleva su
// motivo: son nombres de plataforma, formatos de paquete, marcas o cadenas de
// version. Traducirlas empeoraria el texto.
const ALLOWLIST_CLAVES_IDENTICAS = {
  'landing.html': {
    'landing.verify.win': 'nombre de plataforma dentro de un comentario de comando',
    'landing.verify.mac': 'nombre de plataforma dentro de un comentario de comando',
    'landing.verify.linux': 'nombre de plataforma dentro de un comentario de comando',
    'nav.whitepaper': 'nombre propio del documento, se usa igual en espanol',
    'footer.whitepaper': 'nombre propio del documento, se usa igual en espanol',
    'nav.github': 'marca',
    'hero.badge': 'version y nombres de sistema operativo',
    'footer.copyright': 'version, marca y licencia',
    'dl.win.name': 'nombre de plataforma',
    'dl.win.desc': 'version de sistema y arquitectura',
    'dl.mac.name': 'nombre de plataforma',
    'dl.mac.desc': 'nombres de arquitectura de Apple',
    'dl.mac.arm': 'arquitectura y extension de archivo',
    'dl.mac.intel': 'arquitectura y extension de archivo',
    'dl.linux.name': 'nombre de plataforma',
    'dl.linux.desc': 'arquitectura y formatos de paquete',
    'dl.linux.appimage': 'formato de paquete',
    'qs.tab.win': 'nombre de plataforma',
    'qs.tab.mac': 'nombre de plataforma',
    'qs.tab.linux': 'nombre de plataforma',
    'footer.legal': 'palabra identica en ambos idiomas',
    'new.more.link': 'nombre propio del documento, se usa igual en espanol'
  },
  'models.html': {
    'models.toc.workstation': 'nombre de gama de hardware, se usa igual en espanol',
    'models.hardware.wsBadge': 'nombre de gama de hardware, se usa igual en espanol',
    'models.tag.local': 'palabra identica en ambos idiomas',
    'models.tag.cloud': 'termino fijado en el glosario: cloud se conserva en espanol',
    'models.table.runsLocal': 'palabra identica en ambos idiomas',
    'models.table.colHardware': 'palabra identica en ambos idiomas',
    'models.role.chat': 'termino fijado en el glosario: chat se conserva en espanol',
    'models.size.nomicembedtext': 'cifra en megabytes, sin decimales que separar',
    'models.size.mxbaiembedlarge': 'cifra en megabytes, sin decimales que separar',
    'models.footer.whitepaper': 'nombre propio del documento, se usa igual en espanol',
    'models.footer.github': 'marca'
  },
  'whitepaper.html': {
    'whitepaper.nav.title': 'nombre propio del documento, se usa igual en espanol',
    'whitepaper.meta.crumbGuide': 'nombre propio del documento en la miga de pan',
    'whitepaper.toc.s9': 'nombre del proyecto llama.cpp',
    'whitepaper.editions.communityName': 'nombre de edicion: invariable segun el glosario',
    'whitepaper.editions.proName': 'nombre de edicion: invariable segun el glosario',
    'whitepaper.editions.cloudName': 'nombre de edicion: invariable segun el glosario',
    'whitepaper.footer.github': 'marca',
    'whitepaper.footer.tagline': 'version, ano y licencia'
  }
};

/**
 * Comprobaciones comunes a toda pagina bilingue. Cada pagina pasa por las
 * mismas reglas: si una pagina necesitase una excepcion, tendria que
 * declararla aqui y quedaria a la vista.
 */
function auditarPagina(archivo, prefijo) {
  console.log(`\n=== ${archivo}: cobertura real ===`);
  const html = leer(archivo);
  const allowClaves = ALLOWLIST_CLAVES_IDENTICAS[archivo] || {};

  const sueltos = nodosHardcodeados(html);
  check(sueltos.length === 0,
    `${archivo}: sin texto user-facing fuera del sistema i18n (${sueltos.length}${sueltos.length ? ': ' + sueltos.slice(0, 4).join(' | ') : ''})`);

  const { en, es } = diccionarios(html);
  check(en.size > 0 && es.size > 0, `${archivo}: los dos diccionarios existen (EN ${en.size}, ES ${es.size})`);

  const soloEn = [...en.keys()].filter(k => !es.has(k));
  const soloEs = [...es.keys()].filter(k => !en.has(k));
  check(soloEn.length === 0, `${archivo}: ninguna clave sin traduccion espanola (${soloEn.join(', ') || 'ninguna'})`);
  check(soloEs.length === 0, `${archivo}: ninguna clave sin traduccion inglesa (${soloEs.join(', ') || 'ninguna'})`);

  const vacias = [...en.entries()].filter(([, v]) => !v.trim())
    .concat([...es.entries()].filter(([, v]) => !v.trim()));
  check(vacias.length === 0, `${archivo}: ninguna traduccion vacia (${vacias.length})`);

  // Toda clave usada en el markup debe existir en ambos diccionarios.
  const usadas = new Set([...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map(m => m[1]));
  const huerfanas = [...usadas].filter(k => !en.has(k) || !es.has(k));
  check(huerfanas.length === 0, `${archivo}: toda clave del markup existe en EN y ES (${huerfanas.join(', ') || 'ninguna'})`);

  const identicas = [...en.entries()]
    .filter(([k, v]) => es.get(k) === v)
    .filter(([k]) => !allowClaves[k])
    .filter(([, v]) => !esTecnico(v.trim()))
    .filter(([, v]) => /[A-Za-z]{4}/.test(v));
  check(identicas.length === 0,
    `${archivo}: ningun texto no tecnico identico en ES y EN (${identicas.length ? identicas.slice(0, 3).map(([k]) => k).join(', ') : 'ninguno'})`);

  // La allowlist no puede crecer con claves que en realidad si estan traducidas:
  // eso indicaria que sobra una excusa.
  const allowlistInnecesaria = Object.keys(allowClaves)
    .filter(k => en.has(k) && es.has(k) && en.get(k) !== es.get(k));
  check(allowlistInnecesaria.length === 0,
    `${archivo}: la allowlist de claves no contiene excepciones sobrantes (${allowlistInnecesaria.join(', ') || 'ninguna'})`);

  // Metadata bilingue completa.
  for (const sufijo of ['title', 'description', 'ogTitle', 'ogDescription', 'twitterTitle', 'twitterDescription']) {
    const clave = `${prefijo}.meta.${sufijo}`;
    check(en.has(clave) && es.has(clave), `${archivo}: ${clave} definida en ambos idiomas`);
    check(en.get(clave) !== es.get(clave), `${archivo}: ${clave} realmente traducida`);
  }

  check(/document\.title\s*=/.test(html), `${archivo}: el conmutador actualiza el title del documento`);
  check(/meta\[property="og:title"\]/.test(html), `${archivo}: el conmutador actualiza Open Graph`);
  check(/meta\[name="twitter:title"\]/.test(html), `${archivo}: el conmutador actualiza Twitter cards`);
  check(/application\/ld\+json/.test(html) && /JSON\.stringify\(datos/.test(html),
    `${archivo}: el conmutador reescribe el JSON-LD`);
  check(/document\.documentElement\.lang\s*=\s*lang/.test(html),
    `${archivo}: el conmutador actualiza <html lang>`);

  check(/I18N_ATTR_ALLOWLIST/.test(html), `${archivo}: los atributos traducibles usan allowlist cerrada`);
  const attrPermitidos = (html.match(/I18N_ATTR_ALLOWLIST\s*=\s*\[([^\]]+)\]/) || [])[1] || '';
  for (const attr of ['alt', 'aria-label', 'placeholder', 'title']) {
    check(attrPermitidos.includes(`'${attr}'`), `${archivo}: la allowlist de atributos incluye ${attr}`);
  }

  const markup = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  const ariaTraducidos = [...markup.matchAll(/data-i18n-attr="[^"]*aria-label:([a-zA-Z0-9._-]+)/g)].map(m => m[1]);
  check(ariaTraducidos.length >= 1, `${archivo}: los aria-label pasan por i18n (${ariaTraducidos.length})`);
  for (const clave of ariaTraducidos) {
    check(en.has(clave) && es.has(clave) && en.get(clave) !== es.get(clave),
      `${archivo}: ${clave} traducido en ambos idiomas`);
  }

  const altTraducidos = [...markup.matchAll(/data-i18n-attr="[^"]*alt:([a-zA-Z0-9._-]+)/g)].map(m => m[1]);
  for (const clave of new Set(altTraducidos)) {
    check(en.has(clave) && es.has(clave) && en.get(clave) !== es.get(clave),
      `${archivo}: ${clave} traducido en ambos idiomas`);
  }

  // Todo alt de imagen o pasa por i18n o su texto es una marca / cadena
  // tecnica identica en ambos idiomas. Un alt en prosa sin clave falla.
  const altsSueltos = [...markup.matchAll(/<img\b[^>]*>/g)]
    .filter(m => !/data-i18n-attr="[^"]*alt:/.test(m[0]))
    .map(m => (m[0].match(/\balt="([^"]*)"/) || [])[1])
    .filter(alt => alt !== undefined && alt.trim() && !esTecnico(alt.trim()));
  check(altsSueltos.length === 0,
    `${archivo}: ningun alt en prosa fuera del sistema i18n (${altsSueltos.join(' | ') || 'ninguno'})`);

  return { en, es, usadas };
}

// =====================================================================
const { en, es } = auditarPagina('landing.html', 'landing');
// =====================================================================

console.log('\n=== El mockup del hero cambia de idioma ===');

const landing = leer('landing.html');
const usadasLanding = new Set([...landing.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map(m => m[1]));
const clavesMockup = [...usadasLanding].filter(k => k.startsWith('landing.mockup.'));
check(clavesMockup.length >= 10, `el mockup esta conectado al i18n (${clavesMockup.length} claves)`);
for (const clave of ['landing.mockup.projects', 'landing.mockup.projQuick', 'landing.mockup.inputPlaceholder']) {
  check(en.has(clave) && es.has(clave) && en.get(clave) !== es.get(clave),
    `${clave} cambia entre idiomas`);
}
const landingMarkup = landing.replace(/<script[\s\S]*?<\/script>/gi, '');
const mockupSinClave = [...landingMarkup.matchAll(/>(Chats Rápidos|Proyectos|Sin proyecto|Escribe tu mensaje\.\.\.)</g)]
  .filter(m => {
    const antes = landingMarkup.slice(0, m.index);
    return !/data-i18n(?:-html)?=/.test(antes.slice(antes.lastIndexOf('<')));
  });
check(mockupSinClave.length === 0,
  `todo texto del mockup pasa por i18n (${mockupSinClave.length} sin clave)`);

// =====================================================================
const modelos = auditarPagina('models.html', 'models');
// =====================================================================

console.log('\n=== models.html: integridad del catalogo ===');

const models = leer('models.html');

// Identificadores retirados por no existir o no ser verificables. No pueden
// volver: cada uno se elimino con su ficha completa (docs/content-audit A.1).
const PROHIBIDOS = [
  'glm-5', 'kimi-k2', 'nemotron', 'glm-ocr', 'qwen3.5', 'qwen3:',
  ':cloud', 'qwen2.5-vl:', 'gemma3:9b', 'phi4:3b'
];
for (const id of PROHIBIDOS) {
  check(!models.includes(id), `no reaparece el identificador retirado ${id}`);
}

// Comparaciones y cifras sin fuente primaria. La guia declara explicitamente
// que no publica benchmarks: el texto tiene que sostenerlo.
const PROHIBIDOS_TEXTO = [
  'GPT-4', 'outperform', 'MMLU', 'HumanEval', 'MT-Bench', 'GSM8K', 'TextVQA',
  'MMBench', 'o1-level', 'near o1', 'state of the art', 'see model card',
  'tok/s'
];
for (const frase of PROHIBIDOS_TEXTO) {
  check(!new RegExp(frase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(models),
    `no reaparece la afirmacion sin fuente «${frase}»`);
}

// La unica mencion admisible a los benchmarks es la que dice que no se
// publican, y tiene que estar en los dos idiomas.
check(/publishes no benchmark scores/.test(models) && /no publica puntuaciones de benchmark/.test(models),
  'el descargo de «sin benchmarks» esta en ingles y en espanol');
check(!/\b\d+(\.\d+)?\s*(%|puntos|points)\b.{0,40}(benchmark|eval)/i.test(models),
  'ninguna puntuacion numerica asociada a un benchmark');

// Cada tag que aparece en un comando debe tener ficha o fila en la tabla.
const tagsEnComandos = new Set([...models.matchAll(/ollama pull ([a-z0-9.:-]+)/g)].map(m => m[1]));
check(tagsEnComandos.size >= 15, `la guia documenta comandos para ${tagsEnComandos.size} modelos`);

// Los estados del catalogo existen y estan traducidos.
for (const clave of ['models.status.validated', 'models.status.ollama', 'models.status.adapter', 'models.status.future']) {
  check(modelos.en.has(clave) && modelos.es.has(clave) && modelos.en.get(clave) !== modelos.es.get(clave),
    `${clave} declarado y traducido`);
}

// Separacion local / cloud: la seccion cloud no puede fijar identificadores.
const seccionCloud = (models.match(/id="cloud"[\s\S]*?<\/section>/) || [''])[0];
check(!/ollama pull/.test(seccionCloud), 'la seccion cloud no mezcla comandos de modelos locales');
check(/models\.cloud\.alibaba/.test(models), 'Alibaba figura como proveedor implementado');

// El JSON-LD tiene que llevar sus textos al diccionario, no quedarse en ingles.
for (const clave of ['models.meta.faq1Q', 'models.meta.faq1A', 'models.meta.faq2Q', 'models.meta.faq2A',
  'models.meta.faq3Q', 'models.meta.faq3A', 'models.meta.crumbHome', 'models.meta.crumbGuide']) {
  check(modelos.en.has(clave) && modelos.es.has(clave) && modelos.en.get(clave) !== modelos.es.get(clave),
    `${clave} traducido para el JSON-LD`);
}
check(/@graph/.test(models) && /BreadcrumbList/.test(models) && /FAQPage/.test(models),
  'el JSON-LD conserva Article, BreadcrumbList y FAQPage');

// =====================================================================
const wp = auditarPagina('whitepaper.html', 'whitepaper');
// =====================================================================

const paper = leer('whitepaper.html');

console.log('\n=== whitepaper.html: afirmaciones de seguridad ===');

// Afirmaciones falsas o absolutas que el documento arrastraba. Ninguna puede
// volver, ni en ingles ni en espanol.
const CLAIMS_PROHIBIDOS = [
  /PII sanit/i,
  /sanitizaci[oó]n de PII/i,
  /\[EMAIL\]|\[PHONE\]/,
  /cero (peticiones|llamadas) de red/i,
  /Renderer — sandboxed/,
  /never leaves your machine/i,
  /nunca salen de tu equipo/i,
  /anonymis(es|ation) (is )?automatic/i,
  /redacci[oó]n autom[aá]tica (est[aá] )?activ/i
];
for (const patron of CLAIMS_PROHIBIDOS) {
  check(!patron.test(paper), `no reaparece la afirmacion prohibida ${patron}`);
}

// «zero outbound / zero network» sólo es admisible dentro de un desmentido.
// Se comprueba el contexto de cada aparición, no la mera presencia: prohibirla
// del todo impediría escribir la frase que corrige el error original.
const absolutosRed = [...paper.matchAll(/zero (outbound|network)[^.<]*/gi)]
  .filter(m => !/not true|no es cierto/i.test(paper.slice(Math.max(0, m.index - 90), m.index)));
check(absolutosRed.length === 0,
  `«zero outbound/network» solo aparece dentro de un desmentido (${absolutosRed.length} afirmaciones sueltas)`);

// The documented settings must follow the production window policy.
const DESMENTIDO = /not true|no es cierto|earlier versions|versiones anteriores|afirmaban|claimed|<em>not<\/em>|<em>no<\/em>/i;
const preferences = require('../src/main/window-security').MAIN_WEB_PREFERENCES;
check(preferences.sandbox === true && !/sandbox: false/.test(paper),
  'documenta el sandbox habilitado en la ventana principal');
check(/sandbox: true/.test(paper), 'declara sandbox: true');
check(/contextIsolation: true/.test(paper) && /nodeIntegration: false/.test(paper),
  'declara contextIsolation y nodeIntegration reales');
check(/connect-src/.test(paper), 'documenta la CSP del renderer');

// Correcciones obligatorias, presentes en los dos idiomas.
check(/It is not true that data never leaves the machine/.test(paper)
  && /No es cierto que los datos nunca salgan del equipo/.test(paper),
  'corrige el absoluto de red en ingles y en espanol');
check(/no automatic redaction/i.test(paper) && /no aplica ninguna redacci[oó]n autom[aá]tica/i.test(paper),
  'declara que no hay redaccion automatica, en ambos idiomas');
check(/sandboxing on/.test(paper) && /sandbox activado/.test(paper),
  'describe la configuración actual de sandbox en ambos idiomas');

console.log('\n=== whitepaper.html: funciones futuras ===');

// Todo lo que no existe tiene que ir etiquetado en las dos lenguas.
for (const clave of ['whitepaper.roadmap.sync', 'whitepaper.roadmap.mobile',
  'whitepaper.roadmap.agents', 'whitepaper.roadmap.teams', 'whitepaper.roadmap.vllm']) {
  check(/Not included in Community/.test(wp.en.get(clave) || ''),
    `${clave} etiquetado como no incluido (EN)`);
  check(/No incluido en Community/.test(wp.es.get(clave) || ''),
    `${clave} etiquetado como no incluido (ES)`);
}
for (const clave of ['whitepaper.roadmap.streaming', 'whitepaper.roadmap.dragdrop',
  'whitepaper.roadmap.tools', 'whitepaper.roadmap.modelui', 'whitepaper.roadmap.exportkb',
  'whitepaper.roadmap.plugins']) {
  check(/>Planned</.test(wp.en.get(clave) || '') && />Planificado</.test(wp.es.get(clave) || ''),
    `${clave} etiquetado como planificado en ambos idiomas`);
}
for (const clave of ['whitepaper.roadmap.bm25', 'whitepaper.roadmap.routing']) {
  check(/>Experimental</.test(wp.en.get(clave) || '') && />Experimental</.test(wp.es.get(clave) || ''),
    `${clave} etiquetado como experimental en ambos idiomas`);
}

// vLLM nunca como parte de Community.
check(/vLLM is not part of Community/.test(paper) && /vLLM no forma parte de Community/.test(paper),
  'vLLM declarado fuera de Community en ambos idiomas');

// Pro y Cloud descritos como inexistentes hoy.
check(/does not exist in v0\.3\.1/.test(wp.en.get('whitepaper.editions.proBody') || '')
  && /No existe en v0\.3\.1/.test(wp.es.get('whitepaper.editions.proBody') || ''),
  'Pro declarado inexistente en v0.3.1');
check(/None of them exists in Community v0\.3\.1/.test(wp.en.get('whitepaper.editions.cloudBody') || '')
  && /Ninguno existe en Community v0\.3\.1/.test(wp.es.get('whitepaper.editions.cloudBody') || ''),
  'Cloud declarado inexistente en v0.3.1');
check(/whitepaper\.editions\.statusPlanned/.test(paper),
  'Pro y Cloud llevan estado planificado');

console.log('\n=== whitepaper.html: versiones, enlaces y datos de release ===');

// Versiones anteriores solo valdrian dentro de una seccion historica
// etiquetada; no existe tal seccion, asi que no pueden aparecer.
for (const version of ['0.1.0', '0.2.0', '0.3.0']) {
  check(!paper.includes(version), `no queda ninguna referencia a v${version}`);
}
check((paper.match(/0\.3\.1/g) || []).length > 5, 'la version vigente aparece de forma consistente');

// Enlaces internos y archivos citados del repositorio. El inicio se enlaza por
// la raiz canonica; el resto por su archivo, que debe existir en web/.
check(/href="\/"/.test(paper) && fs.existsSync(path.join(WEB, 'landing.html')),
  'el enlace de inicio usa la raiz y la landing existe para servirla');
for (const destino of ['models.html']) {
  check(paper.includes(`href="${destino}"`) && fs.existsSync(path.join(WEB, destino)),
    `el enlace interno a ${destino} existe`);
}
for (const archivo of ['LICENSE', 'BUILDING.md', 'COMMUNITY.md', 'SECURITY.md', 'TRADEMARK.md']) {
  check(paper.includes(archivo), `cita ${archivo}`);
  check(fs.existsSync(path.join(ROOT, archivo)), `${archivo} existe en el repositorio`);
}

// Reconciliacion de la release: 15 assets, 14 entradas de checksum.
check(/fifteen assets/.test(paper) && /quince assets/.test(paper),
  'declara los 15 assets en ambos idiomas');
check(/fourteen entries/.test(paper) && /catorce entradas/.test(paper),
  'declara las 14 entradas de SHA256SUMS en ambos idiomas');
check(/cannot contain its own hash/.test(paper) && /no puede contener su propio hash/.test(paper),
  'explica por que el archivo de checksums no se incluye a si mismo');

// Sin benchmarks ni comparaciones, igual que en el Model Guide.
for (const frase of ['GPT-4', 'outperform', 'MMLU', 'HumanEval', 'MT-Bench', 'GSM8K', 'TextVQA']) {
  check(!new RegExp(frase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(paper),
    `el White Paper no reintroduce «${frase}»`);
}
check(/publishes no benchmark scores/.test(paper) && /no publica puntuaciones de benchmark/.test(paper),
  'el descargo de «sin benchmarks» esta en ambos idiomas');

// Proveedores: los siete adaptadores, sin fijar modelos cloud.
check(/seven adapters/.test(paper) && /siete adaptadores/.test(paper),
  'declara los siete adaptadores en ambos idiomas');
check(/Alibaba Cloud Model Studio/.test(paper), 'incluye Alibaba Cloud Model Studio');
// La deteccion de vision por nombre solo puede mencionarse para negarla:
// provider-capabilities.js existe justamente para impedirla.
const porNombre = [...paper.matchAll(/(name-based fallback|deteccci[oó]n por nombre|visi[oó]n por nombre)/gi)]
  .filter(m => !DESMENTIDO.test(paper.slice(Math.max(0, m.index - 160), m.index + m[0].length + 160)));
check(porNombre.length === 0,
  `nunca se describe la vision resuelta por nombre de modelo (${porNombre.length} afirmaciones sueltas)`);
check(/never infers a capability from a model name/.test(paper)
  && /nunca deduce una capacidad del nombre/.test(paper),
  'declara que las capacidades no se deducen del nombre, en ambos idiomas');

// =====================================================================
console.log('\n=== Fase V: paginas publicas, novedades y release ===');
// =====================================================================

// Inventario: todo HTML de web/ debe estar auditado por esta suite.
const PAGINAS_AUDITADAS = ['landing.html', 'models.html', 'whitepaper.html'];
const htmlEnWeb = fs.readdirSync(WEB).filter(f => f.endsWith('.html')).sort();
check(htmlEnWeb.join(',') === PAGINAS_AUDITADAS.slice().sort().join(','),
  `toda pagina HTML de web/ esta auditada (${htmlEnWeb.join(', ')})`);

// El sitemap no puede anunciar una URL que no sirva ninguna de esas paginas.
// `/` es la landing: el despliegue copia landing.html a index.html.
const sitemap = fs.readFileSync(path.join(WEB, 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
check(urls.length > 0, `el sitemap declara ${urls.length} URLs`);
const sinRespaldo = urls.filter(u => {
  const archivo = u.replace(/^https?:\/\/[^/]+\//, '');
  if (archivo === '') return false; // raiz = landing.html copiada a index.html
  return !fs.existsSync(path.join(WEB, archivo));
});
check(sinRespaldo.length === 0,
  `toda URL del sitemap tiene documento que la sirva (${sinRespaldo.join(', ') || 'ninguna huerfana'})`);

// La raiz es la URL canonica de la landing. El sitemap no puede anunciar
// ademas /landing.html: seria el mismo documento indexado dos veces.
check(urls.includes('https://mika5.xyz/'), 'el sitemap declara la raiz como URL de la landing');
check(!urls.some(u => /\/landing\.html$/.test(u)),
  'el sitemap ya no duplica la landing bajo /landing.html');
check(new Set(urls).size === urls.length, 'el sitemap no repite ninguna URL');
check(urls.length === 6, `el sitemap declara 6 URLs, una por documento y por idioma (${urls.length})`);

// =====================================================================
// Paginas en espanol. Cada una tiene su direccion y sale ya escrita en
// espanol: un buscador que no ejecuta el script no veia mas que ingles, y
// /es devolvia la portada en ingles. Se generan desde el mismo diccionario.
// =====================================================================
{
  const { PAGINAS, generar } = require('../scripts/build-web-es.js');
  for (const { pagina, html } of generar()) {
    const enDisco = fs.existsSync(path.join(WEB, pagina.salida)) ? fs.readFileSync(path.join(WEB, pagina.salida), 'utf8') : null;
    check(enDisco === html, `web/${pagina.salida} esta al dia con web/${pagina.fuente} (node scripts/build-web-es.js)`);
    check(/<html lang="es" data-lang="es">/.test(html) && html.includes(`<link rel="canonical" href="${pagina.es}">`)
      && html.includes(`<meta property="og:url" content="${pagina.es}">`) && html.includes('<meta property="og:locale" content="es_ES">'),
      `${pagina.salida}: se declara en espanol y con su propia direccion canonica`);
    const fuente = leer(pagina.fuente);
    const alternas = (texto) => [...texto.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map(m => `${m[1]}=${m[2]}`).join(' ');
    check(alternas(html) === `en=${pagina.en} es=${pagina.es} x-default=${pagina.en}` && alternas(fuente) === alternas(html),
      `${pagina.fuente} y ${pagina.salida} se anuncian mutuamente con hreflang`);
    check(urls.includes(pagina.es) && urls.includes(pagina.en), `el sitemap declara las dos direcciones de ${pagina.fuente}`);
    // Un nivel mas abajo: los recursos compartidos se piden al padre y existen.
    const recursos = [...html.matchAll(/\b(?:src|href)="(\.\.\/[^"]+)"/g)].map(m => m[1]);
    check(recursos.length >= 3 && recursos.every(r => fs.existsSync(path.join(WEB, 'es', r))),
      `${pagina.salida}: sus recursos compartidos existen (${[...new Set(recursos)].join(', ')})`);
    // Todo nodo traducible lleva ya el texto espanol del diccionario.
    const ini = html.indexOf('const STRINGS = {');
    const dic = new Function(`${html.slice(ini, html.indexOf('\n};', ini) + 3)}; return STRINGS;`)();
    const plano = (t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    const nodos = [...html.slice(0, ini).matchAll(/<[a-z0-9]+\b[^>]*\bdata-i18n="([^"]+)"[^>]*>([^<]*)<\//g)];
    const enOtroIdioma = nodos.filter(m => dic.es[m[1]] !== undefined && plano(m[2]) !== plano(dic.es[m[1]])).map(m => m[1]);
    check(nodos.length > 50 && enOtroIdioma.length === 0,
      `${pagina.salida}: sus ${nodos.length} textos traducibles estan en espanol sin ejecutar ningun script`);
  }
  check(PAGINAS.length === PAGINAS_AUDITADAS.length, 'toda pagina del sitio tiene su version en espanol');
}

// =====================================================================
// Recursos que las paginas anuncian. La imagen social estuvo anunciada en las
// tres sin existir: el servidor respondia con el HTML de la portada y las
// vistas previas salian rotas. Lo que se enlaza tiene que estar en web/.
// =====================================================================
const dimensionesPng = (rel) => {
  const b = fs.readFileSync(path.join(WEB, rel));
  const esPng = b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return esPng ? { ancho: b.readUInt32BE(16), alto: b.readUInt32BE(20), bytes: b.length } : null;
};
const social = dimensionesPng('og-image.png');
check(social && social.ancho === 1200 && social.alto === 630,
  `og-image.png existe y es un PNG de 1200x630 (${social && `${social.ancho}x${social.alto}`})`);
for (const pagina of PAGINAS_AUDITADAS) {
  const html = leer(pagina);
  const locales = [...html.matchAll(/<(?:img|link)\b[^>]*?\b(?:src|href)="([^"#:?]+\.png)"/g)].map(m => m[1]);
  check(locales.length >= 3 && locales.every(r => dimensionesPng(r)),
    `${pagina}: toda imagen local enlazada existe (${[...new Set(locales)].join(', ')})`);
  check(/<meta property="og:image" content="https:\/\/mika5\.xyz\/og-image\.png">\s*<meta property="og:image:width" content="1200">\s*<meta property="og:image:height" content="630">/.test(html),
    `${pagina}: la imagen social declara el tamano que tiene`);
  // El icono de 1 MB no se descarga para pintarlo a 20 o 28 px.
  const iconos = [...html.matchAll(/<img\b[^>]*>/g)].map(m => m[0]);
  check(iconos.length === 2 && iconos.every(i => /src="icon-64\.png"/.test(i) && /\bwidth="\d+" height="\d+"/.test(i)),
    `${pagina}: los iconos usan la version pequena y declaran ancho y alto`);
  check(dimensionesPng('icon-64.png').bytes < 20000 && !/(?:src|href)="icon\.png"/.test(html),
    `${pagina}: ya no carga el icono original`);
  check(/scrollbar-color: var\(--scrollbar-thumb\) var\(--scrollbar-track\)/.test(html)
    && /@supports not \(scrollbar-color: auto\)/.test(html),
    `${pagina}: la barra de desplazamiento usa las propiedades estandar, con respaldo`);
}

// Enlaces de las seis paginas: toda ancla interna tiene destino en su pagina y
// todo enlace o recurso relativo existe en web/. Un menu que apunta a una
// seccion renombrada, o una pagina en espanol que pide un fichero al nivel
// equivocado, no rompe ninguna otra comprobacion.
for (const pagina of [...PAGINAS_AUDITADAS, 'es/index.html', 'es/models.html', 'es/whitepaper.html']) {
  const html = fs.readFileSync(path.join(WEB, pagina), 'utf8');
  const marcado = html.slice(0, html.indexOf('const STRINGS = {'));
  const ids = new Set([...marcado.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const referencias = [...marcado.matchAll(/<(?:a|link|img|script)\b[^>]*?\b(?:href|src)="([^"]*)"/g)].map(m => m[1]);
  const anclasRotas = referencias.filter(r => r.startsWith('#') && r.length > 1 && !ids.has(r.slice(1)));
  check(anclasRotas.length === 0, `${pagina}: toda ancla interna tiene destino (${anclasRotas.join(', ') || 'ninguna rota'})`);
  const base = path.dirname(path.join(WEB, pagina));
  const relativosRotos = referencias.filter(r => r && !/^(#|https?:|mailto:|data:)/.test(r)).filter(r => {
    const limpio = r.split('#')[0].split('?')[0];
    if (limpio === '/') return false;                                   // raiz = landing.html
    const destino = limpio.startsWith('/') ? path.join(WEB, limpio) : path.join(base, limpio);
    const fichero = limpio.endsWith('/') ? path.join(destino, 'index.html') : destino;
    return !fs.existsSync(fichero);
  });
  check(referencias.length > 10 && relativosRotos.length === 0,
    `${pagina}: todo enlace y recurso relativo existe (${relativosRotos.join(', ') || 'ninguno roto'})`);
}

// La portada es tambien la pagina de descarga. Lleva a la vista el enlace
// «Code signing policy» (lo exige SignPath Foundation en ambas), la politica
// de privacidad y el repositorio publico del codigo, en los dos idiomas.
for (const pagina of ['landing.html', 'es/index.html']) {
  const html = fs.readFileSync(path.join(WEB, pagina), 'utf8');
  const marcado = html.slice(0, html.indexOf('const STRINGS = {'));
  const enlaces = [...marcado.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map(m => ({ href: m[1], texto: m[2].trim() }));
  const politica = enlaces.filter(e => e.href === 'https://github.com/mika5app/mika5/blob/main/CODE_SIGNING_POLICY.md');
  check(politica.length === 2 && politica.every(e => e.texto.includes('Code signing policy')),
    `${pagina}: el enlace «Code signing policy» esta en la zona de descarga y en el pie (${politica.map(e => e.texto).join(' | ')})`);
  check(enlaces.some(e => e.href === 'https://github.com/mika5app/mika5/blob/main/PRIVACY.md' && e.texto.length > 5),
    `${pagina}: enlaza la politica de privacidad`);
  check(enlaces.some(e => e.href === 'https://github.com/mika5app/mika5' && e.texto.length > 5),
    `${pagina}: enlaza el repositorio publico del codigo`);
}
check(fs.existsSync(path.join(ROOT, 'CODE_SIGNING_POLICY.md')) && fs.existsSync(path.join(ROOT, 'PRIVACY.md')),
  'los dos documentos enlazados existen en la raiz del repositorio');

// Logo v2 (brand/README.md). Cada pagina, tambien las de /es/, ofrece el
// favicon ICO, el SVG y los PNG de 16 y 32, y todos existen desde la ruta de
// esa pagina: las de /es/ los piden al padre, y un `../` olvidado en
// build-web-es.js deja la pestana sin icono sin que nada falle.
{
  const FAVICONS = [
    ['favicon.ico', 'sizes="any"'],
    ['favicon.svg', 'type="image/svg+xml"'],
    ['favicon-32.png', 'sizes="32x32"'],
    ['favicon-16.png', 'sizes="16x16"']
  ];
  for (const pagina of [...PAGINAS_AUDITADAS, 'es/index.html', 'es/models.html', 'es/whitepaper.html']) {
    const html = leer(pagina);
    const prefijo = pagina.startsWith('es/') ? '../' : '';
    for (const [archivo, rasgo] of FAVICONS) {
      const etiqueta = new RegExp(`<link rel="icon"[^>]*href="${prefijo.replace(/\./g, '\\.')}${archivo.replace(/\./g, '\\.')}"[^>]*>`).exec(html);
      check(etiqueta && etiqueta[0].includes(rasgo)
        && fs.existsSync(path.join(WEB, path.dirname(pagina), prefijo + archivo)),
        `${pagina}: enlaza ${prefijo}${archivo} (${rasgo}) y el archivo existe`);
    }
    check(!/sizes="64x64" href="(?:\.\.\/)?icon-64\.png"/.test(html), `${pagina}: el favicon ya no es icon-64.png`);
  }
  const ico = fs.readFileSync(path.join(WEB, 'favicon.ico'));
  const lados = ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1
    ? Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i] || 256).sort((a, b) => a - b) : [];
  check(lados.join() === '16,32,48', `favicon.ico contiene 16, 32 y 48 px (${lados.join(', ')})`);
  const svg = leer('favicon.svg');
  check(/^<svg [^>]*viewBox="0 0 32 32"/.test(svg) && !/<script|\son\w+=|href=|<foreignObject/i.test(svg),
    'favicon.svg es un SVG estatico, sin scripts ni referencias externas');
  for (const [archivo, lado] of [['favicon-16.png', 16], ['favicon-32.png', 32], ['icon-64.png', 64], ['icon-180.png', 180], ['icon.png', 1024]]) {
    const png = dimensionesPng(archivo);
    check(png && png.ancho === lado && png.alto === lado, `${archivo} es un PNG de ${lado}x${lado}`);
  }
  // El logo del JSON-LD era un PNG de 1 MB; el de logo v2 pesa unos 37 KB.
  check(dimensionesPng('icon.png').bytes < 100000, `icon.png (logo del JSON-LD) pesa menos de 100 KB (${dimensionesPng('icon.png').bytes})`);
  check(social.bytes < 150000, `og-image.png pesa menos de 150 KB (${social.bytes})`);
}

// --- Auditoria SEO/AEO: lo que leen buscadores y motores de respuesta ---
// Un rastreador no ejecuta el conmutador de idioma: lee el HTML tal cual.
console.log('\n=== Metadatos y datos estructurados que lee un rastreador ===');
{
  const ldDe = (html) => JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const nodo = (ld, tipo) => (ld['@graph'] || [ld]).find(n => n['@type'] === tipo);
  const atributo = (html, patron) => (patron.exec(html) || [])[1];

  // La cabecera inglesa dice lo mismo que el diccionario inglés; antes decía
  // "No cloud" y "runs 100% on your computer" con proveedores cloud opcionales.
  for (const [campo, patron] of [
    ['description', /<meta name="description" content="([^"]*)">/],
    ['ogDescription', /<meta property="og:description" content="([^"]*)">/],
    ['twitterDescription', /<meta name="twitter:description" content="([^"]*)">/]
  ]) {
    check(atributo(landing, patron) === en.get(`landing.meta.${campo}`),
      `landing.html: ${campo} estatico igual al del diccionario ingles`);
  }
  const cabecera = landing.slice(0, landing.indexOf('</head>'));
  check(!/no cloud|100% on your computer|runs entirely on your machine/i.test(cabecera),
    'la cabecera de la landing no niega los proveedores cloud opcionales');

  const ld = ldDe(landing);
  const app = nodo(ld, 'SoftwareApplication');
  check(app.name === 'MIKA5 Community' && app.description === en.get('landing.meta.description'),
    'SoftwareApplication se llama MIKA5 Community y describe lo mismo que la meta');
  check(nodo(ld, 'Organization').sameAs.includes('https://github.com/mika5app/mika5'),
    'Organization enlaza el repositorio del codigo en sameAs');
  check(!nodo(ld, 'BreadcrumbList'), 'la portada no declara migas: no tiene padre');

  // FAQ visible y FAQ de los datos estructurados: las mismas preguntas.
  const visibles = [...landing.matchAll(/data-i18n="faq\.(q\d+)">([^<]*)</g)];
  const faq = nodo(ld, 'FAQPage').mainEntity;
  check(visibles.length === 7 && faq.length === 7
    && faq.every((p, i) => p.name === en.get(`faq.${visibles[i][1]}`)),
    `el FAQ visible y el de schema tienen las mismas 7 preguntas (${visibles.length}/${faq.length})`);
  for (const clave of ['faq.q6', 'faq.a6', 'faq.q7', 'faq.a7']) {
    check(en.has(clave) && es.has(clave) && en.get(clave) !== es.get(clave), `${clave} presente y traducida`);
  }
  check(/SmartScreen/.test(en.get('faq.a6')) && /Open Anyway/.test(en.get('faq.a6')),
    'faq.a6 explica el aviso de Windows y el de macOS');

  // /es/: el schema generado esta en espanol y apunta a las paginas en espanol.
  for (const [pagina, prefijo] of [['es/index.html', 'landing'], ['es/models.html', 'models'], ['es/whitepaper.html', 'whitepaper']]) {
    const html = leer(pagina);
    const datos = ldDe(html);
    const json = JSON.stringify(datos);
    check(!/"inLanguage":"en"/.test(json), `${pagina}: ningun nodo declara inLanguage "en"`);
    const migas = nodo(datos, 'BreadcrumbList');
    if (migas) {
      check(migas.itemListElement.every(m => m.item.startsWith('https://mika5.xyz/es/'))
        && migas.itemListElement[0].name === 'Inicio',
        `${pagina}: las migas estan en espanol y apuntan a /es/`);
    }
    const articulo = nodo(datos, 'Article') || nodo(datos, 'TechArticle');
    if (articulo) {
      check(articulo.inLanguage === 'es' && articulo.url.startsWith('https://mika5.xyz/es/'),
        `${pagina}: el articulo declara es y su URL en espanol`);
    }
    const appEs = nodo(datos, 'SoftwareApplication');
    if (appEs) {
      check(appEs.description === es.get(`${prefijo}.meta.description`), `${pagina}: SoftwareApplication descrita en espanol`);
    }
  }

  // Contraste AA del texto sobre el fondo de la pagina (#0B0F14). El violeta
  // de marca #7C3AED da 3,37:1: vale para el logo, no para texto.
  const luminancia = (hex) => {
    const c = hex.replace('#', '').match(/../g).map(x => parseInt(x, 16) / 255)
      .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contraste = (a, b) => {
    const [x, y] = [luminancia(a), luminancia(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  for (const pagina of PAGINAS_AUDITADAS) {
    const colores = [...new Set([...leer(pagina).matchAll(/\btext-\[(#[0-9A-Fa-f]{6})\]/g)].map(m => m[1]))];
    const bajos = colores.filter(c => contraste(c, '#0B0F14') < 4.5);
    check(bajos.length === 0, `${pagina}: todo color de texto llega a 4,5:1 sobre el fondo (${bajos.join(', ') || 'ninguno bajo'})`);
  }
}

// llms.txt: lo que enlaza del propio sitio son las URLs del sitemap, ni una mas.
const llms = fs.readFileSync(path.join(WEB, 'llms.txt'), 'utf8');
const enlacesPropios = [...llms.matchAll(/\]\((https:\/\/mika5\.xyz\/[^)]*)\)/g)].map(m => m[1]);
check(/^# MIKA5\n\n> /.test(llms) && enlacesPropios.slice().sort().join() === urls.slice().sort().join(),
  `llms.txt describe el sitio y enlaza las mismas ${urls.length} URLs que el sitemap`);
const versionDeLaLanding = /"softwareVersion": "([\d.]+)"/.exec(leer('landing.html'))[1];
check(llms.includes(`MIKA5 Community ${versionDeLaLanding}`) && llms.includes(`/releases/tag/v${versionDeLaLanding}`),
  `llms.txt anuncia la misma version que la landing (${versionDeLaLanding})`);

{
  const landing = leer('landing.html');
  check(!/class="scroll-smooth"/.test(landing)
    && /@media \(prefers-reduced-motion: no-preference\) \{\s*html \{ scroll-behavior: smooth; \}/.test(landing)
    && /@media \(prefers-reduced-motion: no-preference\) \{\s*\.pulse-dot \{ animation:/.test(landing),
    'la landing respeta la preferencia de menos movimiento');
  check(/<meta name="referrer" content="strict-origin-when-cross-origin">/.test(landing)
    && /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/.test(landing),
    'la landing fija la politica de referencia y abre antes la conexion de las fuentes');
  let reglas = null;
  try { reglas = JSON.parse(/<script type="speculationrules">([\s\S]*?)<\/script>/.exec(landing)[1]); } catch (_) {}
  check(reglas && reglas.prefetch[0].eagerness === 'moderate' && !reglas.prerender,
    'las reglas de precarga son JSON valido y solo precargan, con cautela');
}

// Canonical exacto por pagina. Cada documento tiene la suya: comparar contra
// la raiz habria dado por buenas models.html y whitepaper.html sin mirarlas.
const CANONICAL_BY_FILE = {
  'landing.html': 'https://mika5.xyz/',
  'models.html': 'https://mika5.xyz/models.html',
  'whitepaper.html': 'https://mika5.xyz/whitepaper.html'
};
const ORIGEN = 'https://mika5.xyz';

// Igualdad de origen sin startsWith(): 'https://mika5.xyz.ejemplo.com' empieza
// por la cadena esperada y no es el mismo sitio.
function mismoOrigen(valor) {
  try {
    return new URL(valor).origin === ORIGEN;
  } catch (e) {
    return false;
  }
}
check(!mismoOrigen('https://mika5.xyz.ejemplo.com/'),
  'la comprobacion de origen rechaza un dominio que solo comparte prefijo');
check(mismoOrigen(CANONICAL_BY_FILE['landing.html']),
  'la comprobacion de origen acepta el dominio real');

const PAGINAS = [['landing.html', landing], ['models.html', models], ['whitepaper.html', paper]];
for (const [archivo, html] of PAGINAS) {
  const esperado = CANONICAL_BY_FILE[archivo];
  const canonical = (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];
  check(canonical === esperado, `${archivo}: canonical exacto (${canonical})`);
  const ogUrl = (html.match(/<meta property="og:url" content="([^"]*)"/) || [])[1];
  check(ogUrl === esperado, `${archivo}: og:url exacto (${ogUrl})`);
}

// JSON-LD: se analiza de verdad, no por expresion regular. Una regex sobre
// `"url": "..."` no ve @id, mainEntityOfPage, el JSON minificado ni las
// estructuras anidadas, y no detecta un bloque sintacticamente invalido.
const RAIZ = CANONICAL_BY_FILE['landing.html'];

function bloquesLd(html) {
  return [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]);
}
function nodosLd(html, archivo) {
  const nodos = [];
  const bloques = bloquesLd(html);
  check(bloques.length > 0, `${archivo}: declara al menos un bloque JSON-LD`);
  bloques.forEach((crudo, i) => {
    let datos;
    try {
      datos = JSON.parse(crudo);
    } catch (e) {
      check(false, `${archivo}: el bloque JSON-LD ${i + 1} es JSON valido (${e.message})`);
      return;
    }
    check(true, `${archivo}: el bloque JSON-LD ${i + 1} es JSON valido`);
    const grafo = datos['@graph'] || [datos];
    grafo.forEach(n => nodos.push(n));
  });
  return nodos;
}

const nodosLanding = nodosLd(landing, 'landing.html');
// Solo estos tres representan el sitio y deben apuntar a la raiz canonica.
// Logos, descargas y paginas secundarias tienen URLs propias y no se tocan.
const TIPOS_RAIZ = ['Organization', 'WebSite', 'SoftwareApplication'];
for (const tipo of TIPOS_RAIZ) {
  const nodo = nodosLanding.find(n => n['@type'] === tipo);
  check(!!nodo, `landing.html: el JSON-LD declara un nodo ${tipo}`);
  if (nodo) {
    check(nodo.url === RAIZ, `landing.html: ${tipo}.url es la raiz canonica (${nodo.url})`);
    // El @id es un identificador con fragmento, no la URL canonica: se valida
    // que sea del mismo origen y que el fragmento sea el unico anadido.
    if (nodo['@id']) {
      let id = null;
      try { id = new URL(nodo['@id']); } catch (e) { /* invalida */ }
      check(!!id && id.origin === ORIGEN && id.pathname === '/' && /^#[\w-]+$/.test(id.hash),
        `landing.html: ${tipo}.@id es del origen canonico con fragmento valido (${nodo['@id']})`);
    }
  }
}
// Ninguna pagina puede anunciar la URL duplicada dentro de sus datos
// estructurados, ni en url, ni en @id, ni en mainEntityOfPage, ni en un item.
for (const [archivo, html] of PAGINAS) {
  const nodos = nodosLd(html, archivo);
  const duplicadas = [];
  const visitar = valor => {
    if (typeof valor === 'string' && /\/landing\.html/.test(valor)) duplicadas.push(valor);
    else if (Array.isArray(valor)) valor.forEach(visitar);
    else if (valor && typeof valor === 'object') Object.values(valor).forEach(visitar);
  };
  nodos.forEach(visitar);
  check(duplicadas.length === 0,
    `${archivo}: el JSON-LD no referencia /landing.html (${duplicadas.join(', ') || 'ninguna'})`);
  // mainEntityOfPage, donde exista, tiene que ser exactamente la URL canonica
  // de esa pagina. No basta con que comparta dominio.
  for (const nodo of nodos) {
    if (!nodo.mainEntityOfPage) continue;
    const valor = typeof nodo.mainEntityOfPage === 'string'
      ? nodo.mainEntityOfPage : nodo.mainEntityOfPage['@id'];
    check(valor === CANONICAL_BY_FILE[archivo],
      `${archivo}: mainEntityOfPage es la canonica exacta de la pagina (${valor})`);
  }
  // Toda URL absoluta del propio dominio dentro del JSON-LD tiene que serlo de
  // verdad, no de un dominio que solo comparta prefijo.
  const propias = [];
  const recorrer = valor => {
    if (typeof valor === 'string' && /^https?:\/\/[^/]*mika5\.xyz/i.test(valor)) propias.push(valor);
    else if (Array.isArray(valor)) valor.forEach(recorrer);
    else if (valor && typeof valor === 'object') Object.values(valor).forEach(recorrer);
  };
  nodos.forEach(recorrer);
  const impostoras = propias.filter(u => !mismoOrigen(u));
  check(impostoras.length === 0,
    `${archivo}: ninguna URL simula el dominio canonico (${impostoras.join(', ') || 'ninguna'})`);
}
// Los enlaces internos de inicio usan la raiz, no la URL duplicada.
for (const [archivo, html] of [['models.html', models], ['whitepaper.html', paper]]) {
  check(/href="\/"/.test(html), `${archivo}: el enlace de inicio usa la raiz canonica`);
  check(!/href="landing\.html"/.test(html), `${archivo}: ningun enlace interno a /landing.html`);
}
// hreflang solo vale si cada idioma tiene su URL. Antes no la tenia y no se
// declaraba; ahora existen las paginas de web/es/ y cada hreflang ha de apuntar
// a un documento que exista (la reciprocidad se comprueba mas arriba).
for (const [archivo, html] of [['landing.html', landing], ['models.html', models], ['whitepaper.html', paper]]) {
  const destinos = [...html.matchAll(/<link rel="alternate" hreflang="[^"]+" href="([^"]+)">/g)].map(m => m[1]);
  const huerfanos = destinos.filter(u => {
    const ruta = u.replace(/^https:\/\/mika5\.xyz\//, '');
    if (ruta === '') return false;                 // raiz = landing.html
    return !fs.existsSync(path.join(WEB, ruta.endsWith('/') ? `${ruta}index.html` : ruta));
  });
  check(destinos.length === 3 && destinos.every(mismoOrigen) && huerfanos.length === 0,
    `${archivo}: cada hreflang apunta a una pagina que existe (${huerfanos.join(', ') || 'ninguna huerfana'})`);
}

// Ningun modelo puede promocionarse en la landing sin ficha en el Model Guide.
//
// La comparacion es estructural, no textual: cada modelo promocionado lleva
// data-model-id en la landing, y su fila canonica del Model Guide lleva el
// mismo atributo. Buscar el identificador como subcadena no servia: aparecer
// en una nota, en una advertencia o dentro de otra cadena mas larga habria
// contado como ficha.
// Se extraen como Array, no como Set: un Set esconderia un duplicado, que es
// justo uno de los fallos que hay que detectar.
function idsDeModelo(html) {
  return [...html.matchAll(/\bdata-model-id="([^"]+)"/g)].map(m => m[1]);
}
function duplicados(lista) {
  const vistos = new Set(), repetidos = new Set();
  for (const id of lista) (vistos.has(id) ? repetidos : vistos).add(id);
  return [...repetidos];
}

// Conteos del catalogo editorial de v0.3.1. Cambiarlos exige actualizarlos
// aqui a proposito: una version futura con otro catalogo hara fallar la suite
// hasta que alguien confirme la cifra nueva.
const MODELOS_LANDING_V030 = 15;
const FICHAS_GUIA_V030 = 26;

const idsLanding = idsDeModelo(landing);
const idsGuia = idsDeModelo(models);
check(idsLanding.length === MODELOS_LANDING_V030,
  `la landing declara ${MODELOS_LANDING_V030} ocurrencias de modelo (${idsLanding.length})`);
check(new Set(idsLanding).size === MODELOS_LANDING_V030,
  `la landing declara ${MODELOS_LANDING_V030} identificadores unicos (${new Set(idsLanding).size})`);
check(idsGuia.length === FICHAS_GUIA_V030,
  `el Model Guide declara ${FICHAS_GUIA_V030} filas canonicas (${idsGuia.length})`);
check(new Set(idsGuia).size === FICHAS_GUIA_V030,
  `el Model Guide declara ${FICHAS_GUIA_V030} identificadores unicos (${new Set(idsGuia).size})`);
check(duplicados(idsLanding).length === 0,
  `la landing no repite ningun identificador (${duplicados(idsLanding).join(', ') || 'ninguno'})`);
check(duplicados(idsGuia).length === 0,
  `el Model Guide no repite ninguna ficha (${duplicados(idsGuia).join(', ') || 'ninguno'})`);

// Un mismo elemento no puede llevar dos data-model-id: el navegador se queda
// con uno y la extraccion con otro.
const dobleAtributo = [['landing.html', landing], ['models.html', models]]
  .flatMap(([archivo, html]) => [...html.matchAll(/<[a-z]+\b[^>]*>/gi)]
    .filter(m => (m[0].match(/\bdata-model-id=/g) || []).length > 1)
    .map(m => `${archivo}: ${m[0].slice(0, 60)}`));
check(dobleAtributo.length === 0,
  `ningun elemento lleva data-model-id duplicado (${dobleAtributo.join(' | ') || 'ninguno'})`);

const conjuntoGuia = new Set(idsGuia);
const sinFicha = idsLanding.filter(id => !conjuntoGuia.has(id));
check(sinFicha.length === 0,
  `todo modelo de la landing tiene ficha exacta (${sinFicha.join(', ') || 'ninguno ausente'})`);

// El identificador declarado tiene que coincidir con el texto que ve el
// usuario. En la landing es el contenido de la propia pildora; en el Model
// Guide, el texto de la primera celda de la fila.
const desajustesLanding = [...landing.matchAll(/data-model-id="([^"]+)"[^>]*>([^<]*)</g)]
  .filter(m => m[1] !== m[2].trim());
check(desajustesLanding.length === 0,
  `landing.html: el identificador coincide con el texto visible (${desajustesLanding.map(m => m[1]).join(', ') || 'sin desajustes'})`);

const desajustesGuia = [...models.matchAll(/<tr data-model-id="([^"]+)"><td[^>]*>([^<]*)</g)]
  .filter(m => m[1] !== m[2].trim());
check(desajustesGuia.length === 0,
  `models.html: cada fila coincide con el texto de su primera celda (${desajustesGuia.map(m => m[1]).join(', ') || 'sin desajustes'})`);
const filasConTexto = [...models.matchAll(/<tr data-model-id="([^"]+)"><td[^>]*>([^<]*)</g)].length;
check(filasConTexto === FICHAS_GUIA_V030,
  `las ${FICHAS_GUIA_V030} filas canonicas exponen su identificador en la primera celda (${filasConTexto})`);

// El enlace de privacidad del pie: se comprueban por separado el enlace y su
// destino, sin depender del orden de los atributos.
const ENLACE_PRIVACIDAD = /<a\b(?=[^>]*\bhref="#privacy")(?=[^>]*\bdata-i18n="footer\.privacy")[^>]*>/;
check(ENLACE_PRIVACIDAD.test(landing),
  'el enlace de privacidad apunta a #privacy');
const destinosPrivacidad = (landing.match(/\bid="privacy"/g) || []).length;
check(destinosPrivacidad === 1,
  `existe exactamente un destino #privacy (${destinosPrivacidad})`);

// Prueba negativa insensible al orden de los atributos: se localiza el anchor
// con la propia expresion de validacion y se rompe el href *dentro* de la
// etiqueta encontrada. Mutar con una regex que exija href antes de data-i18n
// dejaria de funcionar en cuanto alguien reordenase los atributos.
function romperHrefPrivacidad(html) {
  const m = ENLACE_PRIVACIDAD.exec(html);
  if (!m) return html;
  const roto = m[0].replace('href="#privacy"', 'href="#"');
  return html.slice(0, m.index) + roto + html.slice(m.index + m[0].length);
}
const landingRoto = romperHrefPrivacidad(landing);
check(landingRoto !== landing, 'la prueba negativa altera realmente el markup');
check(!ENLACE_PRIVACIDAD.test(landingRoto),
  'con href="#" la validacion del enlace de privacidad falla, como debe');

// La misma mutacion sobre un anchor con los atributos en orden inverso tiene
// que seguir funcionando.
const anchorInvertido = '<a data-i18n="footer.privacy" class="x" href="#privacy">Privacy</a>';
check(ENLACE_PRIVACIDAD.test(anchorInvertido),
  'la validacion acepta el enlace con los atributos en orden inverso');
check(!ENLACE_PRIVACIDAD.test(romperHrefPrivacidad(anchorInvertido)),
  'la mutacion rompe el enlace tambien con los atributos en orden inverso');

// =====================================================================
// Fixture: el contrato exige data-model-id exacto, y nada mas cuenta.
// =====================================================================
const FIXTURE_GUIA = `
  <p>El modelo <code>mistral-small:latest</code> se evaluo y no se incluyo en
     el catalogo editorial de esta version.</p>
  <table><tbody>
    <tr data-model-id="qwen2.5:7b"><td>qwen2.5:7b</td><td>Chat</td></tr>
    <tr data-model-id="llama3.2:3b"><td>llama3.2:3b</td><td>Chat</td></tr>
  </tbody></table>`;
const idsFixture = new Set(idsDeModelo(FIXTURE_GUIA));

check(FIXTURE_GUIA.includes('mistral-small:latest'),
  'el fixture contiene el identificador exacto en prosa');
check(!idsFixture.has('mistral-small:latest'),
  'la presencia exacta en prosa no cuenta como ficha');
check(idsFixture.has('qwen2.5:7b') && idsFixture.size === 2,
  'solo las filas con data-model-id cuentan como ficha');
for (const variante of ['qwen2.5:7', 'qwen2', 'llama3.2']) {
  check(!idsFixture.has(variante), `un prefijo como «${variante}» no cuenta como ficha`);
}
for (const variante of ['qwen2.5:7b-extra', 'qwen2.5:7bb', 'llama3.2:3b-instruct']) {
  check(!idsFixture.has(variante), `un sufijo adicional como «${variante}» no cuenta como ficha`);
}
// Y la comparacion real usada por el contrato rechaza los tres casos.
const casosRechazados = ['mistral-small:latest', 'qwen2.5:7', 'qwen2.5:7b-extra']
  .filter(id => !idsFixture.has(id));
check(casosRechazados.length === 3,
  'prosa, prefijo y sufijo se rechazan por igual; solo el identificador exacto satisface el contrato');
// Un modelo promocionado sin ficha se detecta como ausente.
check([...['modelo-sin-ficha:7b']].filter(id => !conjuntoGuia.has(id)).length === 1,
  'un modelo de la landing sin ficha se detecta como ausente');

// Todo ancla interna referenciada existe como id en su pagina.
for (const [archivo, html] of [['landing.html', landing], ['models.html', models], ['whitepaper.html', paper]]) {
  const anclas = [...html.matchAll(/href="#([a-zA-Z0-9-]+)"/g)].map(m => m[1]);
  const rotas = [...new Set(anclas)].filter(a => !new RegExp(`id="${a}"`).test(html));
  check(rotas.length === 0, `${archivo}: sin anclas internas rotas (${rotas.join(', ') || 'ninguna'})`);
}

// --- Novedades de v0.3.1 ---
check(/id="whatsnew"/.test(landing), 'la landing publica el bloque de novedades de v0.3.1');
const CLAVES_NOVEDADES = ['new.header', 'new.cloud', 'new.context', 'new.actions', 'new.composer',
  'new.empty', 'new.projects', 'new.code', 'new.menu', 'new.scroll', 'new.a11y', 'new.tests'];
for (const base of CLAVES_NOVEDADES) {
  for (const sufijo of ['title', 'desc']) {
    const clave = `${base}.${sufijo}`;
    check(en.has(clave) && es.has(clave) && en.get(clave) !== es.get(clave),
      `${clave} presente y traducida`);
  }
}
// El aislamiento de pruebas no puede venderse como funcion de usuario.
check(/engineering detail rather than a feature/i.test(en.get('new.tests.desc') || '')
  && /detalle de ingenier[ií]a m[aá]s que una funci[oó]n/i.test(es.get('new.tests.desc') || ''),
  'el aislamiento de pruebas se presenta como calidad de ingenieria, no como funcion');

// --- Avisos por plataforma ---
for (const clave of ['dl.win.warning', 'dl.mac.warning', 'dl.linux.warning']) {
  check(en.has(clave) && es.has(clave) && en.get(clave) !== es.get(clave),
    `${clave} presente y traducido`);
}
check(/Authenticode/.test(en.get('dl.win.warning')) && /SmartScreen/.test(en.get('dl.win.warning')),
  'el aviso de Windows menciona Authenticode y SmartScreen');
check(/App Store/.test(en.get('dl.mac.warning')) && /notarized/i.test(en.get('dl.mac.warning')),
  'el aviso de macOS niega App Store y declara la falta de notarizacion');
check(/x86-64/.test(en.get('dl.linux.warning')) && /no ARM build/i.test(en.get('dl.linux.warning')),
  'el aviso de Linux acota la arquitectura publicada');

// --- Enlaces de release ---
const RELEASE = 'https://github.com/mika5app/mika5-releases/releases/download/v0.3.2';
const ENLAZADOS = [
  'MIKA5-Setup-0.3.2-win-x64.exe', 'MIKA5-Portable-0.3.2-win-x64.exe',
  'MIKA5-0.3.2-mac-arm64.dmg', 'MIKA5-0.3.2-mac-x64.dmg',
  'MIKA5-0.3.2-linux-x86_64.AppImage', 'MIKA5-0.3.2-linux-amd64.deb',
  'MIKA5-0.3.2-linux-x86_64.rpm', 'MIKA5-0.3.2-source.tar.gz',
  'SHA256SUMS.txt', 'BUILDING.md', 'COMMUNITY.md', 'BUILD-METADATA.json', 'LICENSE'
];
for (const asset of ENLAZADOS) {
  check(landing.includes(`${RELEASE}/${asset}`), `la landing enlaza ${asset}`);
}
check(ENLAZADOS.length === 13, `se enlazan 13 assets de los 15 publicados (${ENLAZADOS.length})`);
// Los dos ZIP de macOS se dejan publicados pero sin enlace, de forma deliberada.
for (const zip of ['MIKA5-0.3.2-mac-arm64.zip', 'MIKA5-0.3.2-mac-x64.zip']) {
  check(!landing.includes(zip), `${zip} deliberadamente sin enlace directo`);
}
check(/15 assets/.test(en.get('dl.extras.note')) && /15 assets/.test(es.get('dl.extras.note')),
  'la nota declara los 15 assets publicados');
check(/14 of them/.test(en.get('dl.extras.note')) && /14 de ellos/.test(es.get('dl.extras.note')),
  'la nota declara las 14 entradas de checksum');
// Ninguna pagina puede enlazar una release anterior.
for (const [archivo, html] of [['landing.html', landing], ['models.html', models], ['whitepaper.html', paper]]) {
  check(!/download\/v0\.[123]\.0\//.test(html) && !/0\.2\.0-(win|mac|linux)/.test(html),
    `${archivo}: cero enlaces a releases anteriores`);
}

// --- Etiquetas del roadmap: cada elemento clasificado ---
const IMPLEMENTADOS = ['implCross', 'implConsent', 'implCapabilities', 'implVisual',
  'implCancel', 'implScope', 'implExport'];
for (const nombre of IMPLEMENTADOS) {
  const clave = `whitepaper.roadmap.${nombre}`;
  check(/>Implemented in v0\.3\.1</.test(wp.en.get(clave) || ''),
    `${clave} etiquetado como implementado (EN)`);
  check(/>Implementado en v0\.3\.1</.test(wp.es.get(clave) || ''),
    `${clave} etiquetado como implementado (ES)`);
}
// Todo punto del roadmap lleva exactamente una etiqueta de estado.
const ESTADOS_EN = /Implemented in v0\.3\.1|Planned|Experimental|Not included in Community/;
const puntosRoadmap = [...wp.en.keys()]
  .filter(k => /^whitepaper\.roadmap\.(impl|streaming|dragdrop|tools|bm25|modelui|exportkb|routing|plugins|sync|mobile|agents|teams|vllm)/.test(k))
  .filter(k => !/Intro$/.test(k));
const sinEstado = puntosRoadmap.filter(k => !ESTADOS_EN.test(wp.en.get(k) || ''));
check(sinEstado.length === 0, `todo punto del roadmap lleva estado (${sinEstado.join(', ') || 'ninguno sin etiqueta'})`);
check(puntosRoadmap.length >= 19, `el roadmap clasifica ${puntosRoadmap.length} elementos`);

// --- Servidor: deploy/nginx/mika5.xyz.conf ---
// Lo que decide como responde el sitio publicado. Se probo en nginx 1.24 con
// curl y cargando las paginas bajo su CSP; aqui se protege lo que no puede
// romperse sin que nadie lo note.
console.log('\n=== Configuracion de nginx del sitio ===');
{
  const conf = fs.readFileSync(path.join(ROOT, 'deploy', 'nginx', 'mika5.xyz.conf'), 'utf8');
  const activo = conf.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  check(/location \/ \{\s*try_files \$uri \$uri\/ =404;\s*\}/.test(activo),
    'nginx: una direccion inexistente responde 404, no la portada');
  check(/server_name www\.mika5\.xyz;[\s\S]*?return 301 https:\/\/mika5\.xyz\$request_uri;/.test(activo)
    && /listen 80;[\s\S]*?return 301 https:\/\/mika5\.xyz\$request_uri;/.test(activo),
    'nginx: www y http redirigen a https://mika5.xyz');
  check(['application/javascript', 'text/css', 'image/svg+xml', 'text/plain'].every(t => new RegExp(`gzip_types[^;]*${t.replace(/[/+]/g, '\\$&')}`).test(activo)),
    'nginx: comprime JavaScript, CSS, SVG y texto');
  check(/~\^text\/html\s+epoch;/.test(activo) && /expires \$mika5_expires;/.test(activo),
    'nginx: el HTML se revalida y los estaticos llevan caducidad');
  // add_header dentro de un location anula todas las del servidor.
  const bloquesLocation = [...activo.matchAll(/^\s*location\b[^{;]*\{[^}]*\}/gm)].map(m => m[0]);
  check(bloquesLocation.length > 0 && bloquesLocation.every(b => !/add_header/.test(b)),
    'nginx: ningun location redefine cabeceras (perderia las de seguridad)');
  for (const cabecera of ['Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy', 'Content-Security-Policy', 'X-Frame-Options']) {
    check(new RegExp(`add_header ${cabecera} "[^"]+" always;`).test(activo), `nginx: envia ${cabecera} tambien en errores`);
  }
  // La CSP nombra todo origen externo que las paginas cargan; un CDN nuevo en
  // una pagina sin anadirlo aqui dejaria la pagina sin estilos o sin script.
  const csp = /add_header Content-Security-Policy "([^"]+)"/.exec(activo)[1];
  const directiva = (nombre) => ((new RegExp(`(?:^|; )${nombre} ([^;]+)`).exec(csp) || [])[1] || '').split(/\s+/);
  const paginasPublicas = [...PAGINAS_AUDITADAS, 'es/index.html', 'es/models.html', 'es/whitepaper.html'];
  for (const pagina of paginasPublicas) {
    const html = leer(pagina);
    const origen = (url) => new URL(url).origin;
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="(https:\/\/[^"]+)"/g)].map(m => origen(m[1]));
    const estilos = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="(https:\/\/[^"]+)"|<link\b[^>]*\bhref="(https:\/\/[^"]+)"[^>]*\brel="stylesheet"/g)].map(m => origen(m[1] || m[2]));
    const formularios = [...html.matchAll(/<form\b[^>]*\baction="(https:\/\/[^"]+)"/g)].map(m => origen(m[1]));
    const faltan = [
      ...scripts.filter(o => !directiva('script-src').includes(o)),
      ...estilos.filter(o => !directiva('style-src').includes(o)),
      ...formularios.filter(o => !directiva('form-action').includes(o))
    ];
    check(faltan.length === 0, `nginx: la CSP permite lo que carga ${pagina} (${faltan.join(', ') || 'nada falta'})`);
  }
}

// --- Tailwind compilado, no el Play CDN ---
// El CDN descargaba un compilador y construia los estilos en el navegador de
// cada visitante: unos segundos de primer contenido en movil. web/tailwind.css
// es la misma version con el mismo tema, y tiene que estar al dia con las
// paginas, o una clase nueva saldria sin estilo en produccion.
console.log('\n=== Tailwind compilado ===');
{
  const { execFileSync } = require('child_process');
  const os = require('os');
  const paquete = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check(paquete.devDependencies.tailwindcss === '3.4.17',
    `tailwindcss fijado a la version exacta que servia el CDN (${paquete.devDependencies.tailwindcss})`);
  for (const pagina of [...PAGINAS_AUDITADAS, 'es/index.html', 'es/models.html', 'es/whitepaper.html']) {
    const html = leer(pagina);
    const cabeza = html.slice(0, html.indexOf('</head>'));
    check(!/cdn\.tailwindcss\.com/.test(html), `${pagina}: no carga el Play CDN de Tailwind`);
    // Despues de los estilos propios, donde el CDN insertaba los suyos: mismo orden de cascada.
    check(/<\/style>\s*(?:<!--[\s\S]*?-->\s*)?<link rel="stylesheet" href="\/tailwind\.css">\s*$/.test(cabeza),
      `${pagina}: enlaza /tailwind.css despues de sus estilos propios`);
  }
  const cli = path.join(ROOT, 'node_modules', 'tailwindcss', 'lib', 'cli.js');
  check(fs.existsSync(cli), 'tailwindcss esta instalado (npm ci instala las devDependencies)');
  const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-tailwind-'));
  try {
    const salida = path.join(temporal, 'tailwind.css');
    execFileSync(process.execPath, [cli, '-c', 'tailwind.web.config.js', '-o', salida, '--minify'], { cwd: ROOT, stdio: 'pipe' });
    const enRepo = fs.readFileSync(path.join(WEB, 'tailwind.css'), 'utf8').replace(/\r\n?/g, '\n');
    check(fs.readFileSync(salida, 'utf8') === enRepo,
      'web/tailwind.css esta al dia con las paginas (npm run build:web-css)');
  } finally {
    fs.rmSync(temporal, { recursive: true, force: true });
  }
}

console.log(`\n${'='.repeat(46)}`);
console.log(`Website i18n tests passed (${passed} comprobaciones)`);
console.log(`${'='.repeat(46)}`);
