#!/usr/bin/env node
'use strict';

// Genera las páginas en español del sitio público: web/es/*.html.
//
//   node scripts/build-web-es.js          escribe web/es/
//   node scripts/build-web-es.js --check  falla si web/es/ no está al día
//
// Por qué existe: el sitio cambiaba de idioma con JavaScript sobre una única
// dirección. Un buscador o un motor de respuestas que no ejecuta el script
// sólo veía inglés, y `/es` devolvía la portada en inglés. Aquí cada página
// sale ya escrita en español, con su propia dirección, a partir del MISMO
// diccionario que usa el conmutador: no hay un segundo sitio que mantener.
//
// Sin dependencias: las páginas marcan todo su texto traducible con
// `data-i18n`, `data-i18n-html` y `data-i18n-attr`, y eso basta para
// reescribirlas sin un DOM.

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const ORIGEN = 'https://mika5.xyz';

// Página fuente (inglés) → página generada (español).
const PAGINAS = [
  { fuente: 'landing.html', salida: 'es/index.html', en: `${ORIGEN}/`, es: `${ORIGEN}/es/`, prefijo: 'landing' },
  { fuente: 'models.html', salida: 'es/models.html', en: `${ORIGEN}/models.html`, es: `${ORIGEN}/es/models.html`, prefijo: 'models' },
  { fuente: 'whitepaper.html', salida: 'es/whitepaper.html', en: `${ORIGEN}/whitepaper.html`, es: `${ORIGEN}/es/whitepaper.html`, prefijo: 'whitepaper' }
];

const escaparTexto = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escaparAtributo = (t) => escaparTexto(t).replace(/"/g, '&quot;');

/** Diccionario de la página: el objeto `STRINGS` de su script en línea. */
function leerDiccionario(html) {
  const inicio = html.indexOf('const STRINGS = {');
  const fin = html.indexOf('\n};', inicio);
  if (inicio < 0 || fin < 0) throw new Error('la página no declara STRINGS');
  const bloque = html.slice(inicio, fin + 3);
  return { inicio, fin: fin + 3, STRINGS: new Function(`${bloque}; return STRINGS;`)() };
}

/** Sustituye el contenido de cada elemento con `data-i18n-html` por su valor. */
function aplicarHtml(html, es) {
  const abre = /<([a-z0-9]+)\b[^>]*\bdata-i18n-html="([^"]+)"[^>]*>/g;
  let salida = '';
  let cursor = 0;
  let m;
  while ((m = abre.exec(html)) !== null) {
    const [etiquetaAbierta, etiqueta, clave] = m;
    const valor = es[clave];
    const desde = m.index + etiquetaAbierta.length;
    // Cierre que corresponde: se cuentan las aperturas anidadas de la misma etiqueta.
    const paso = new RegExp(`<${etiqueta}\\b[^>]*>|</${etiqueta}>`, 'g');
    paso.lastIndex = desde;
    let nivel = 1;
    let hasta = -1;
    let t;
    while ((t = paso.exec(html)) !== null) {
      nivel += t[0][1] === '/' ? -1 : 1;
      if (nivel === 0) { hasta = t.index; break; }
    }
    if (hasta < 0) throw new Error(`data-i18n-html="${clave}" sin cierre`);
    salida += html.slice(cursor, desde) + (valor === undefined ? html.slice(desde, hasta) : valor);
    cursor = hasta;
    abre.lastIndex = hasta;
  }
  return salida + html.slice(cursor);
}

// Preguntas de los datos estructurados que no tienen traducción, por página.
construir.sinTraducir = {};

function construir(pagina, htmlFuente) {
  const { inicio, fin, STRINGS } = leerDiccionario(htmlFuente);
  const es = STRINGS.es;
  let cuerpo = htmlFuente.slice(0, inicio);
  const diccionario = htmlFuente.slice(inicio, fin);
  let resto = htmlFuente.slice(fin);

  // Texto: cada nodo `data-i18n` es una hoja (el conmutador usa textContent).
  cuerpo = cuerpo.replace(/(<[a-z0-9]+\b[^>]*\bdata-i18n="([^"]+)"[^>]*>)([^<]*)(<\/)/g,
    (todo, abre, clave, _texto, cierra) => (es[clave] === undefined ? todo : abre + escaparTexto(es[clave]) + cierra));
  cuerpo = aplicarHtml(cuerpo, es);
  // Atributos: data-i18n-attr="alt:clave.uno;aria-label:clave.dos".
  cuerpo = cuerpo.replace(/<[a-z0-9]+\b[^>]*\bdata-i18n-attr="([^"]+)"[^>]*>/g, (etiqueta, pares) => {
    let nueva = etiqueta;
    for (const par of pares.split(';')) {
      const [atributo, clave] = par.split(':').map(x => x.trim());
      if (!atributo || es[clave] === undefined) continue;
      const patron = new RegExp(`(\\s${atributo}=")[^"]*(")`);
      if (patron.test(nueva)) nueva = nueva.replace(patron, `$1${escaparAtributo(es[clave])}$2`);
    }
    return nueva;
  });

  // Metadatos: los mismos que el conmutador reescribe en el navegador.
  const meta = (clave) => es[`${pagina.prefijo}.meta.${clave}`];
  const fijar = (patron, valor) => {
    if (valor === undefined) return;
    if (!patron.test(cuerpo)) throw new Error(`${pagina.fuente}: no se encontró ${patron}`);
    cuerpo = cuerpo.replace(patron, (_t, antes, despues) => antes + escaparAtributo(valor) + despues);
  };
  if (meta('title') !== undefined) cuerpo = cuerpo.replace(/<title>[^<]*<\/title>/, `<title>${escaparTexto(meta('title'))}</title>`);
  fijar(/(<meta name="description" content=")[^"]*(")/, meta('description'));
  fijar(/(<meta property="og:title" content=")[^"]*(")/, meta('ogTitle'));
  fijar(/(<meta property="og:description" content=")[^"]*(")/, meta('ogDescription'));
  fijar(/(<meta name="twitter:title" content=")[^"]*(")/, meta('twitterTitle'));
  fijar(/(<meta name="twitter:description" content=")[^"]*(")/, meta('twitterDescription'));

  // Dirección propia. Las etiquetas hreflang ya nombran las dos y no cambian.
  const unaVez = (antes, despues) => {
    if (cuerpo.split(antes).length !== 2) throw new Error(`${pagina.fuente}: se esperaba una vez «${antes}»`);
    cuerpo = cuerpo.replace(antes, despues);
  };
  unaVez('<html lang="en">', '<html lang="es" data-lang="es">');
  // El botón de idioma nombra el idioma al que cambia: aquí, inglés.
  cuerpo = cuerpo.replace(/(<button\b[^>]*\bid="(?:lang-toggle|mobile-lang-toggle)"[^>]*>)\s*ES\s*(<\/button>)/g, '$1EN$2');
  unaVez(`<link rel="canonical" href="${pagina.en}">`, `<link rel="canonical" href="${pagina.es}">`);
  unaVez(`<meta property="og:url" content="${pagina.en}">`, `<meta property="og:url" content="${pagina.es}">`);
  unaVez('<meta property="og:locale" content="en_US">', '<meta property="og:locale" content="es_ES">');
  unaVez('<meta property="og:locale:alternate" content="es_ES">', '<meta property="og:locale:alternate" content="en_US">');
  unaVez('<!DOCTYPE html>', `<!DOCTYPE html>\n<!-- Generated by scripts/build-web-es.js from web/${pagina.fuente}. Do not edit: edit the source and run the script. -->`);

  // Preguntas frecuentes de los datos estructurados, en el idioma de la página.
  // Cada pregunta y respuesta se busca en el diccionario por su texto inglés:
  // es el mismo texto que la página enseña, así que tiene clave y traducción.
  const claveDe = new Map(Object.entries(STRINGS.en).map(([clave, valor]) => [String(valor).replace(/\s+/g, ' ').trim(), clave]));
  const traducir = (texto) => {
    const clave = claveDe.get(String(texto).replace(/\s+/g, ' ').trim());
    return clave !== undefined && es[clave] !== undefined ? es[clave] : null;
  };
  const sinTraducir = [];
  // El resto de los datos estructurados también se escribe en español aquí.
  // El conmutador del navegador lo hace al cambiar de idioma, pero un buscador
  // o un motor de respuestas lee el HTML sin ejecutar scripts: sin esto, /es/
  // declaraba `inLanguage: "en"` y migas en inglés que apuntaban a las páginas
  // inglesas. Una clave que falte detiene la generación.
  const enEspanol = new Map(PAGINAS.map(p => [p.en, p.es]));
  const exigir = (clave) => {
    if (meta(clave) === undefined) throw new Error(`${pagina.fuente}: falta ${pagina.prefijo}.meta.${clave} en español`);
    return meta(clave);
  };
  const MIGAS = ['crumbHome', 'crumbGuide'];
  cuerpo = cuerpo.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g, (todo, abre, json, cierra) => {
    const datos = JSON.parse(json);
    let tocado = false;
    for (const nodo of datos['@graph'] || [datos]) {
      if (nodo['@type'] === 'Article' || nodo['@type'] === 'TechArticle') {
        nodo.headline = exigir('ldHeadline');
        nodo.description = exigir('description');
        nodo.inLanguage = 'es';
        for (const campo of ['url', 'mainEntityOfPage']) {
          if (enEspanol.has(nodo[campo])) nodo[campo] = enEspanol.get(nodo[campo]);
        }
        tocado = true;
      }
      if (nodo['@type'] === 'BreadcrumbList') {
        nodo.itemListElement.forEach((miga, i) => {
          if (MIGAS[i] === undefined || !enEspanol.has(miga.item)) {
            throw new Error(`${pagina.fuente}: miga ${i + 1} sin equivalente en español`);
          }
          miga.name = exigir(MIGAS[i]);
          miga.item = enEspanol.get(miga.item);
        });
        tocado = true;
      }
      if (nodo['@type'] === 'SoftwareApplication') {
        nodo.description = exigir('description');
        tocado = true;
      }
      if (nodo['@type'] !== 'FAQPage') continue;
      for (const pregunta of nodo.mainEntity) {
        const q = traducir(pregunta.name);
        const a = traducir(pregunta.acceptedAnswer.text);
        if (q === null || a === null) { sinTraducir.push(pregunta.name); continue; }
        pregunta.name = q;
        pregunta.acceptedAnswer.text = a;
        tocado = true;
      }
    }
    return tocado ? `${abre}\n${JSON.stringify(datos, null, 2)}\n    ${cierra}` : todo;
  });
  construir.sinTraducir[pagina.fuente] = sinTraducir;

  // La página vive un nivel más abajo: los recursos compartidos se piden al
  // padre, y «inicio» es la portada en español.
  const subir = (texto) => texto
    .replace(/\b(href|src)="(icon-64\.png|icon-180\.png|favicon\.ico|favicon\.svg|favicon-16\.png|favicon-32\.png)"/g, '$1="../$2"')
    .replace(/\bhref="\/"/g, 'href="/es/"');
  return subir(cuerpo) + diccionario + subir(resto);
}

function generar() {
  return PAGINAS.map((pagina) => ({
    pagina,
    html: construir(pagina, fs.readFileSync(path.join(WEB, pagina.fuente), 'utf8'))
  }));
}

if (require.main === module) {
  const comprobar = process.argv.includes('--check');
  let desfasadas = 0;
  for (const { pagina, html } of generar()) {
    const destino = path.join(WEB, pagina.salida);
    if (comprobar) {
      const actual = fs.existsSync(destino) ? fs.readFileSync(destino, 'utf8') : null;
      if (actual !== html) { desfasadas += 1; console.error(`DESFASADA  web/${pagina.salida}`); }
      continue;
    }
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, html);
    console.log(`escrita  web/${pagina.salida}  (${html.length} caracteres)`);
    for (const pregunta of construir.sinTraducir[pagina.fuente] || []) console.log(`   sin traducir en datos estructurados: ${pregunta}`);
  }
  if (comprobar) {
    if (desfasadas) { console.error('Ejecuta: node scripts/build-web-es.js'); process.exit(1); }
    console.log('web/es/ está al día');
  }
}

module.exports = { PAGINAS, ORIGEN, construir, generar };
