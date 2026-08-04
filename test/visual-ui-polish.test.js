// test/visual-ui-polish.test.js — Iconos de proyecto, bloques de código, menú
// nativo y scrollbar del sidebar.
//
// Run: node test/visual-ui-polish.test.js
//
// Por qué existe: los cuatro puntos de este bloque fallan en silencio. El icono
// de un proyecto dependía de su posición en la lista, así que borrar otro
// proyecto repintaba todos; un colapso mal hecho recortaría el código exportado;
// `Menu.setApplicationMenu(null)` deja Windows y Linux sin Ctrl+C/V/X/A; y una
// regla de scrollbar sin acotar apaga también la de la conversación.
//
// No abre Electron, no usa red, no instala dependencias y no toca userData.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readRendererSource, normalizeEol } = require('./helpers/renderer-source');
const { createDocument } = require('./helpers/mini-dom');
const { buildApplicationMenuTemplate, shouldHideMenuBar } = require('../src/main/application-menu');

const ROOT = path.join(__dirname, '..');
let passed = 0;

function check(condition, message) {
  assert(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}

const leer = rel => normalizeEol(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const indexHtml = leer('src/renderer/index.html');
const mainJs = leer('src/main/main.js');
const i18nSource = leer('src/renderer/i18n.js');
const renderer = readRendererSource(path.join(ROOT, 'src/renderer/app.js'));

const bloqueEs = i18nSource.slice(i18nSource.indexOf('  es: {'), i18nSource.indexOf('  en: {'));
const bloqueEn = i18nSource.slice(i18nSource.indexOf('  en: {'));

function reglaCss(fuente, selector) {
  const inicio = fuente.indexOf(`${selector} {`);
  if (inicio < 0) return '';
  return fuente.slice(inicio, fuente.indexOf('}', inicio));
}

// =====================================================================
// Iconos y colores de proyecto
// =====================================================================

function visualHarness() {
  return new Function('deps', `
    const QUICK_CHAT_ID = 'quick-chat';
    const PROJECT_ICONS = ${JSON.stringify(['📁', '🏠', '💼', '🎯', '📚', '🔬', '🎨', '💻', '🌐', '🧠', '⚡', '🔧', '📊', '🎮', '🏗️', '📝'])};
    const PROJECT_COLORS = ${JSON.stringify(['#3b82f6', '#22c55e', '#ef4444', '#eab308', '#a855f7', '#06b6d4', '#f97316', '#ec4899'])};
    const QUICK_CHAT_VISUAL = { icon: '💬', color: '#60a5fa' };
    const PROJECT_VISUAL_FALLBACK_ID = 'proyecto-sin-id';
    ${renderer.slice('projectVisualHash')}
    ${renderer.slice('projectVisualDefaults')}
    ${renderer.slice('resolveProjectVisual')}
    ${renderer.slice('applyProjectVisual')}
    return { projectVisualDefaults, resolveProjectVisual, applyProjectVisual };
  `)({});
}

function proyectosTests() {
  console.log('\n=== Proyectos: identidad estable, elección manual intacta ===');
  const api = visualHarness();

  // El fallback depende del id, no de la posición.
  const proyectos = [
    { id: 'p-alpha', name: 'Alpha' },
    { id: 'p-beta', name: 'Beta' },
    { id: 'p-gamma', name: 'Gamma' }
  ];
  const antes = proyectos.map(p => api.resolveProjectVisual(p));
  check(antes.every(v => v.icon && v.color), 'todo proyecto obtiene icono y color');

  const reordenados = [proyectos[2], proyectos[0], proyectos[1]];
  const despuesReorden = reordenados.map(p => api.resolveProjectVisual(p));
  check(despuesReorden.every(v => {
    const original = antes[proyectos.findIndex(p => p.id === reordenados[despuesReorden.indexOf(v)].id)];
    return v.icon === original.icon && v.color === original.color;
  }), 'reordenar la lista no cambia icono ni color');

  const sinBeta = [proyectos[0], proyectos[2]];
  const despuesBorrado = sinBeta.map(p => api.resolveProjectVisual(p));
  check(despuesBorrado[0].icon === antes[0].icon && despuesBorrado[0].color === antes[0].color
    && despuesBorrado[1].icon === antes[2].icon && despuesBorrado[1].color === antes[2].color,
    'borrar otro proyecto no cambia el fallback de los demás');

  const repetido = api.resolveProjectVisual({ id: 'p-alpha' });
  check(repetido.icon === antes[0].icon && repetido.color === antes[0].color,
    'el mismo id da siempre el mismo par icono/color');

  // Sidebar y diálogo de mover comparten helper: mismo resultado.
  const enSidebar = api.resolveProjectVisual({ id: 'p-beta', name: 'Beta' });
  const enDialogo = api.resolveProjectVisual({ id: 'p-beta', name: 'Beta' });
  check(enSidebar.icon === enDialogo.icon && enSidebar.color === enDialogo.color,
    'sidebar y diálogo de mover coinciden');
  check(renderer.slice('loadProjects').includes('resolveProjectVisual(p)')
    && renderer.text.includes('const visual = resolveProjectVisual(pr);'),
    'ambos contextos llaman al mismo helper');

  // Lo guardado gana y no se persiste ningún fallback.
  const conIcono = api.resolveProjectVisual({ id: 'p-alpha', icon: '🚀' });
  check(conIcono.icon === '🚀' && conIcono.color === antes[0].color,
    'un icono guardado gana al fallback y no arrastra el color');
  const conColor = api.resolveProjectVisual({ id: 'p-alpha', color: '#123456' });
  check(conColor.color === '#123456' && conColor.icon === antes[0].icon,
    'un color guardado gana al fallback');
  const fuenteResolve = renderer.slice('resolveProjectVisual');
  check(!/updateProject|setAppState/.test(fuenteResolve),
    'resolver el visual no persiste nada');
  check(renderer.slice('showProjectStylePicker').includes('Store.updateProject'),
    'el picker manual sigue guardando la elección con Store.updateProject');

  // Quick Chat conserva su identidad propia.
  const qc = api.resolveProjectVisual({ id: 'quick-chat' });
  check(qc.icon === '💬' && qc.color === '#60a5fa' && qc.isQuickChat === true,
    'Quick Chat mantiene su icono y color reservados');

  // Proyecto antiguo sin id: estable y sin índice.
  const sinId1 = api.resolveProjectVisual({ name: 'Antiguo' });
  const sinId2 = api.resolveProjectVisual({ name: 'Otro antiguo' });
  check(sinId1.icon === sinId2.icon && sinId1.color === sinId2.color,
    'un proyecto sin id usa un fallback estable y documentado');
  check(renderer.text.includes("const PROJECT_VISUAL_FALLBACK_ID = 'proyecto-sin-id';"),
    'el fallback sin id está declarado explícitamente');
  check(!/PROJECT_ICONS\[\s*(userIdx|i)\s*%/.test(renderer.text)
    && !/PROJECT_COLORS\[\s*(userIdx|i)\s*%/.test(renderer.text),
    'ya no queda ninguna asignación por posición en la lista');

  // La píldora se pinta por clase y variable, no con cssText repetido.
  const doc = createDocument();
  const nodo = api.applyProjectVisual(doc.createElement('span'), { icon: '📁', color: '#3b82f6' }, { interactive: true });
  check(nodo.classList.contains('project-icon-btn'), 'la píldora usa la clase compartida');
  check(nodo.style.getPropertyValue('--project-color') === '#3b82f6',
    'el color viaja por variable CSS, no por cssText');
  check(/\.project-icon-btn\s*\{[^}]*--project-color/.test(indexHtml),
    'la clase existe en la hoja de estilos y consume la variable');
  check(!renderer.slice('loadProjects').includes('style.cssText = `background:'),
    'el cssText inline de la píldora desapareció del sidebar');
}

// =====================================================================
// Bloques de código
// =====================================================================

function bloquesHarness(doc) {
  return new Function('deps', `
    const document = deps.document;
    const t = deps.t;
    const showToast = deps.showToast;
    const navigator = deps.navigator;
    const console = deps.console;
    let _codeBlockSeq = 0;
    ${renderer.slice('countCodeLines')}
    const CODE_BLOCK_COLLAPSE_THRESHOLD = ${(() => {
      const match = /const CODE_BLOCK_COLLAPSE_THRESHOLD = (\d+);/.exec(renderer.text);
      assert(match, 'el umbral de colapso debe estar declarado');
      return match[1];
    })()};
    ${renderer.slice('addCopyButtonsToCodeBlocks')}
    return { addCopyButtonsToCodeBlocks, countCodeLines, CODE_BLOCK_COLLAPSE_THRESHOLD };
  `)({
    document: doc,
    t: (key, params) => (params && params.count !== undefined ? `${key}:${params.count}` : key),
    showToast: () => {},
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    console: { warn() {} }
  });
}

function montarBloque(lineas, lenguaje = 'js') {
  const doc = createDocument();
  const host = doc.createElement('div');
  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  if (lenguaje) code.className = `language-${lenguaje}`;
  code.textContent = Array.from({ length: lineas }, (_, i) => `linea ${i + 1}`).join('\n');
  pre.appendChild(code);
  host.appendChild(pre);
  doc.body.appendChild(host);
  return { doc, host, pre, code };
}

function codigoTests() {
  console.log('\n=== Bloques de código: metadatos, colapso y exportación ===');

  const corto = montarBloque(5, 'python');
  const api = bloquesHarness(corto.doc);
  api.addCopyButtonsToCodeBlocks(corto.host);

  const wrapper = corto.host.children[0];
  check(wrapper.classList.contains('code-block-wrapper'), 'el bloque queda envuelto');
  const header = wrapper.children[0];
  check(header.classList.contains('code-block-header'), 'la cabecera se crea una vez');

  api.addCopyButtonsToCodeBlocks(corto.host);
  const cabeceras = corto.host.querySelectorAll('.code-block-header');
  check(cabeceras.length === 1, `dos llamadas no duplican la cabecera (${cabeceras.length})`);
  check(corto.host.querySelectorAll('.code-block-wrapper').length === 1,
    'dos llamadas no crean un segundo wrapper');

  const lang = wrapper.querySelector('.code-block-lang');
  check(lang.textContent === 'python', 'la cabecera muestra el lenguaje real');
  const lineas = wrapper.querySelector('.code-block-lines');
  check(lineas.textContent === 'code.lines:5', `el conteo de líneas es correcto (${lineas.textContent})`);

  const sinLenguaje = montarBloque(3, null);
  const api2 = bloquesHarness(sinLenguaje.doc);
  api2.addCopyButtonsToCodeBlocks(sinLenguaje.host);
  check(sinLenguaje.host.querySelector('.code-block-lang').textContent === 'code.plainText',
    'sin clase de lenguaje se usa un fallback localizado');
  check(!renderer.slice('addCopyButtonsToCodeBlocks').includes('highlightAuto'),
    'no se reintroduce autodetección de lenguaje');

  // Colapso.
  const toggle = wrapper.querySelector('.code-block-toggle');
  const copiar = wrapper.querySelector('.copy-code-btn');
  check(Boolean(toggle) && Boolean(copiar), 'la cabecera ofrece colapsar y copiar');
  check(toggle.getAttribute('aria-label') && copiar.getAttribute('aria-label'),
    'ambos botones tienen nombre accesible');
  check(toggle.getAttribute('aria-controls') === corto.pre.id && Boolean(corto.pre.id),
    'el toggle apunta al bloque que controla');
  check(toggle.getAttribute('aria-expanded') === 'true' && !wrapper.classList.contains('collapsed'),
    'un bloque corto nace expandido');

  const textoAntes = corto.pre.textContent;
  corto.doc.dispatch(toggle, 'click', { target: toggle });
  check(wrapper.classList.contains('collapsed') && toggle.getAttribute('aria-expanded') === 'false',
    'colapsar cambia aria-expanded');
  check(corto.pre.textContent === textoAntes,
    'colapsar no altera el texto: el código sigue completo en el DOM');
  check(toggle.textContent === 'code.expand', 'la etiqueta del botón cambia a expandir');
  corto.doc.dispatch(toggle, 'click', { target: toggle });
  check(!wrapper.classList.contains('collapsed') && corto.pre.textContent === textoAntes,
    'expandir devuelve el estado sin tocar el contenido');

  const largo = montarBloque(60, 'js');
  const api3 = bloquesHarness(largo.doc);
  api3.addCopyButtonsToCodeBlocks(largo.host);
  const wrapperLargo = largo.host.children[0];
  check(Number(api.CODE_BLOCK_COLLAPSE_THRESHOLD) === 40,
    `el umbral documentado es 40 líneas (${api.CODE_BLOCK_COLLAPSE_THRESHOLD})`);
  check(wrapperLargo.classList.contains('collapsed'),
    'un bloque por encima del umbral nace colapsado');
  check(largo.pre.textContent.split('\n').length === 60,
    'el bloque colapsado conserva sus 60 líneas en el DOM');
  check(wrapperLargo.querySelector('.code-block-toggle').getAttribute('aria-expanded') === 'false',
    'el estado inicial se refleja en aria-expanded');

  // Copiar entrega el contenido completo aunque esté colapsado.
  const copias = [];
  const conPortapapeles = montarBloque(60, 'js');
  const api4 = new Function('deps', `
    const document = deps.document;
    const t = deps.t;
    const showToast = deps.showToast;
    const navigator = deps.navigator;
    const console = deps.console;
    let _codeBlockSeq = 0;
    ${renderer.slice('countCodeLines')}
    const CODE_BLOCK_COLLAPSE_THRESHOLD = 40;
    ${renderer.slice('addCopyButtonsToCodeBlocks')}
    return { addCopyButtonsToCodeBlocks };
  `)({
    document: conPortapapeles.doc,
    t: key => key,
    showToast: () => {},
    navigator: { clipboard: { writeText: texto => { copias.push(texto); return Promise.resolve(); } } },
    console: { warn() {} }
  });
  api4.addCopyButtonsToCodeBlocks(conPortapapeles.host);
  const botonCopiar = conPortapapeles.host.querySelector('.copy-code-btn');
  conPortapapeles.doc.dispatch(botonCopiar, 'click', { target: botonCopiar });
  check(copias.length === 1 && copias[0].split('\n').length === 60,
    'copiar entrega el código completo estando colapsado');

  // Exportación: parte del markdown del mensaje, no del DOM decorado.
  const fuenteExport = renderer.slice('buildExportHTML');
  check(fuenteExport.includes('renderExportMarkdown(m.content)'),
    'la exportación renderiza el contenido original del mensaje');
  check(!fuenteExport.includes('code-block-wrapper') && !fuenteExport.includes('collapsed'),
    'la exportación no depende del estado visual del bloque');
  const fuenteMarkdown = renderer.slice('renderExportMarkdown');
  check(/button/.test(fuenteMarkdown) && /replace\(/.test(fuenteMarkdown),
    'la exportación sigue eliminando elementos interactivos');
  const fuenteBloques = renderer.slice('addCopyButtonsToCodeBlocks');
  check(!/collapsed/.test(fuenteExport) && !fuenteBloques.includes('setAppState')
    && !fuenteBloques.includes('updateChat'),
    'el estado de colapso no se persiste en mensajes ni base de datos');
  check(renderer.slice('compileChatAsMarkdown').includes('msg.content')
    || renderer.text.includes('compileChatAsMarkdown'),
    'el markdown compilado parte del contenido original');

  // i18n de la cabecera.
  for (const clave of ['code.plainText', 'code.lines', 'code.copy', 'code.collapse', 'code.expand']) {
    check(bloqueEs.includes(`'${clave}':`) && bloqueEn.includes(`'${clave}':`),
      `${clave} existe en es y en`);
  }
  check(!fuenteBloques.includes('"Copiar"') && !fuenteBloques.includes("'Copiar'"),
    'la cabecera ya no lleva literales en español');
}

// =====================================================================
// Menú nativo
// =====================================================================

function rolesDe(submenu = []) {
  return submenu.filter(item => item.role).map(item => item.role);
}

function menuTests() {
  console.log('\n=== Menú nativo: atajos vivos, barra fuera del camino ===');

  for (const platform of ['win32', 'linux']) {
    const template = buildApplicationMenuTemplate({ platform, isDevelopment: false });
    const edicion = template.find(m => m.role === 'editMenu');
    check(Boolean(edicion), `${platform}: existe el menú de edición`);
    const roles = rolesDe(edicion.submenu);
    for (const rol of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
      check(roles.includes(rol), `${platform}: conserva el rol ${rol}`);
    }
    check(!template.some(m => m.role === 'appMenu'),
      `${platform}: sin menú de aplicación de macOS`);
    const vista = template.find(m => m.role === 'viewMenu');
    check(!rolesDe(vista.submenu).includes('toggleDevTools'),
      `${platform}: en producción no se exponen las devtools`);
    const ventana = template.find(m => m.role === 'windowMenu');
    check(rolesDe(ventana.submenu).includes('minimize'), `${platform}: conserva la gestión de ventana`);
    check(shouldHideMenuBar(platform) === true, `${platform}: la barra se oculta`);
  }

  const dev = buildApplicationMenuTemplate({ platform: 'win32', isDevelopment: true });
  check(rolesDe(dev.find(m => m.role === 'viewMenu').submenu).includes('toggleDevTools'),
    'en desarrollo sí aparecen recarga y devtools');

  const mac = buildApplicationMenuTemplate({ platform: 'darwin', isDevelopment: false });
  const appMenu = mac.find(m => m.role === 'appMenu');
  check(Boolean(appMenu), 'macOS conserva el menú de aplicación');
  for (const rol of ['quit', 'hide', 'about']) {
    check(rolesDe(appMenu.submenu).includes(rol), `macOS: conserva el rol ${rol}`);
  }
  const edicionMac = rolesDe(mac.find(m => m.role === 'editMenu').submenu);
  for (const rol of ['copy', 'paste', 'selectAll', 'undo']) {
    check(edicionMac.includes(rol), `macOS: edición conserva ${rol}`);
  }
  check(shouldHideMenuBar('darwin') === false, 'macOS no oculta la barra global del sistema');

  // Sólo roles nativos: nada declarado sin implementación real detrás.
  const todosLosItems = mac.concat(buildApplicationMenuTemplate({ platform: 'win32' }))
    .flatMap(m => m.submenu || []);
  check(todosLosItems.every(item => item.role || item.type === 'separator'),
    'la plantilla sólo usa roles nativos y separadores');

  // Integración en main.js.
  check(mainJs.includes("require(\"./application-menu\")"), 'main.js usa la fábrica');
  check(mainJs.includes('Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate('),
    'main.js registra el menú construido por la fábrica');
  check(!/setApplicationMenu\(\s*null\s*\)/.test(mainJs),
    'no se usa setApplicationMenu(null) como atajo');
  check(/autoHideMenuBar:\s*shouldHideMenuBar\(process\.platform\)/.test(mainJs),
    'la ventana declara autoHideMenuBar según la plataforma');
  check(/if \(shouldHideMenuBar\(process\.platform\)\) win\.setMenuBarVisibility\(false\)/.test(mainJs),
    'la barra se oculta tras crear la ventana');
  check(mainJs.includes("win.webContents.on('context-menu'"),
    'el menú contextual existente sigue en su sitio');

  // La fábrica es pura: probarla no arranca la aplicación.
  const fuenteMenu = leer('src/main/application-menu.js');
  check(!/require\(['"]electron['"]\)/.test(fuenteMenu),
    'application-menu.js no importa electron');
  // Los comentarios sí nombran Menu para explicar por qué existe el módulo: se
  // comprueba el código, no la documentación.
  const codigoMenu = fuenteMenu
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter(linea => !linea.trim().startsWith('//'))
    .join(' ');
  check(!/(^|[^\w])app\.|BrowserWindow|(^|[^\w])Menu\./.test(codigoMenu),
    'application-menu.js no toca app, ventanas ni Menu');
}

// =====================================================================
// Scrollbar del sidebar
// =====================================================================

function scrollbarTests() {
  console.log('\n=== Scrollbar del sidebar: sutil en reposo, visible al usar ===');

  const reglaSidebar = reglaCss(indexHtml, '.sidebar-content');
  check(/scrollbar-width:\s*thin/.test(reglaSidebar), 'declara scrollbar-width: thin');
  check(/scrollbar-gutter:\s*stable/.test(reglaSidebar),
    'reserva el canal: la lista no se desplaza al aparecer la barra');
  check(!/width:\s*\d/.test(reglaSidebar), 'no se toca el ancho estructural del sidebar');
  check(/--sidebar-width:\s*280px/.test(indexHtml), 'el ancho del sidebar sigue siendo el mismo');

  const reposo = reglaCss(indexHtml, '.sidebar-content::-webkit-scrollbar-thumb');
  check(/background:\s*transparent/.test(reposo), 'en reposo el pulgar es transparente');
  check(/\.sidebar-content:hover::-webkit-scrollbar-thumb/.test(indexHtml)
    && /\.sidebar-content:focus-within::-webkit-scrollbar-thumb/.test(indexHtml),
    'se revela en hover y en focus-within');
  check(/\.sidebar-content:hover,\s*\n?\s*\.sidebar-content:focus-within \{[^}]*scrollbar-color/.test(indexHtml)
    || /scrollbar-color:\s*var\(--divider-subtle\)/.test(indexHtml),
    'también se revela en el motor no-WebKit vía scrollbar-color');

  check(/@media \(hover: none\)[^}]*\{[\s\S]{0,220}sidebar-content::-webkit-scrollbar-thumb \{ background: var\(--border-subtle\)/.test(indexHtml),
    'sin puntero la barra queda visible');
  check(/@media \(forced-colors: active\)[\s\S]{0,220}sidebar-content/.test(indexHtml),
    'con colores forzados se mantiene la affordance del sistema');

  // La regla global no se toca: conversación, modales y <pre> conservan la suya.
  const global = reglaCss(indexHtml, '::-webkit-scrollbar-thumb');
  check(/background:\s*var\(--border-color/.test(global),
    'la scrollbar global mantiene su pulgar visible');
  check(!/\.messages-container::-webkit-scrollbar/.test(indexHtml),
    'no se añaden reglas de scrollbar a la conversación');
  check(!/\.modal[^{]*::-webkit-scrollbar/.test(indexHtml) && !/pre::-webkit-scrollbar/.test(indexHtml),
    'ni a modales ni a los bloques pre');
}

// =====================================================================
// Contraste de los tokens nuevos
// =====================================================================

function aRgb(valor) {
  const hex = valor.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const v = hex[1];
    return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16), a: 1 };
  }
  const rgba = valor.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/);
  if (rgba) return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] };
  throw new Error(`color no reconocido: ${valor}`);
}

function componer(color, fondo) {
  const c = aRgb(color);
  const f = aRgb(fondo);
  return {
    r: Math.round(c.r * c.a + f.r * (1 - c.a)),
    g: Math.round(c.g * c.a + f.g * (1 - c.a)),
    b: Math.round(c.b * c.a + f.b * (1 - c.a)),
    a: 1
  };
}

function luminancia(color) {
  const { r, g, b } = typeof color === 'string' ? aRgb(color) : color;
  const canales = [r, g, b].map(x => x / 255)
    .map(x => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * canales[0] + 0.7152 * canales[1] + 0.0722 * canales[2];
}

function contraste(a, b) {
  const [alto, bajo] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (alto + 0.05) / (bajo + 0.05);
}

function leerTokens(bloque) {
  const tokens = Object.create(null);
  for (const linea of bloque.split('\n')) {
    const match = linea.match(/^\s*(--[\w-]+):\s*([^;]+);/);
    if (match) tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

function resolver(tokens, nombre, vistos = new Set()) {
  const valor = tokens[nombre];
  if (!valor || vistos.has(nombre)) return valor || null;
  vistos.add(nombre);
  const indirecto = valor.match(/^var\((--[\w-]+)\)$/);
  return indirecto ? resolver(tokens, indirecto[1], vistos) : valor;
}

function contrasteTests() {
  console.log('\n=== Contraste del bloque de código ===');

  const rootTokens = leerTokens(indexHtml.slice(indexHtml.indexOf(':root {'), indexHtml.indexOf('.light-theme {')));
  const lightTokens = Object.assign(Object.create(null), rootTokens,
    leerTokens(indexHtml.slice(indexHtml.indexOf('.light-theme {'), indexHtml.indexOf('* {'))));

  for (const tema of [{ nombre: 'oscuro', tokens: rootTokens }, { nombre: 'claro', tokens: lightTokens }]) {
    const get = nombre => {
      const valor = resolver(tema.tokens, nombre);
      assert(valor, `falta el token ${nombre} en el tema ${tema.nombre}`);
      return valor;
    };
    const superficie = get('--surface-code');
    const cabecera = componer(get('--surface-code-header'), superficie);
    const pares = [
      ['código sobre el bloque', get('--code-text'), superficie, 4.5],
      ['metadatos sobre la cabecera', get('--code-meta'), cabecera, 4.5],
      ['botón copiar sobre la cabecera', get('--code-meta'), cabecera, 4.5],
      ['foco del bloque', get('--code-focus-ring'), superficie, 3],
      ['foco del bloque sobre su cabecera', get('--code-focus-ring'), cabecera, 3]
    ];
    for (const [etiqueta, frente, fondo, minimo] of pares) {
      const ratio = contraste(frente, fondo);
      check(ratio >= minimo, `${tema.nombre}: ${etiqueta} ${ratio.toFixed(2)}:1 (mínimo ${minimo})`);
    }
    check(!/^#0{6}$/i.test(superficie), `${tema.nombre}: el bloque de código no es negro puro`);
  }

  check(resolver(rootTokens, '--surface-code') !== resolver(lightTokens, '--surface-code'),
    'el tema claro define su propia superficie de código');
  check(!/background:\s*#1e1e1e/.test(indexHtml),
    'el gris aislado #1e1e1e desaparece de la escala');
  check(!/\.code-block-header\s*\{[^}]*border-bottom:[^;]*(#fff|white)/i.test(indexHtml),
    'la cabecera no usa bordes blancos');
}

// =====================================================================

function run() {
  proyectosTests();
  codigoTests();
  menuTests();
  scrollbarTests();
  contrasteTests();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Visual UI polish tests passed (${passed} comprobaciones)`);
  console.log(`${'='.repeat(40)}`);
}

run();
