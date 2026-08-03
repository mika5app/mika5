// test/visual-ui-conversation.test.js — Acciones de chat, compositor y estado
// vacío son contrato de interacción, no adorno.
//
// Run: node test/visual-ui-conversation.test.js
//
// Por qué existe: los tres bloques tienen invariantes que se rompen sin ruido.
// Un botón fuera de .item-actions vuelve a quedar inalcanzable con Tab; cambiar
// la clase de una acción hace que borrar también abra el chat; un `cancelar` mal
// cableado borraría igual; el compositor se desalinea en cuanto una de las dos
// columnas cambia de padding; el estado vacío puede volver a literales en
// español; y los divisores blancos reaparecen en cuanto alguien escribe un color
// a mano en vez de usar el token.
//
// No abre Electron, no usa red, no instala dependencias y no toca userData.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readRendererSource, normalizeEol } = require('./helpers/renderer-source');
const { createDocument } = require('./helpers/mini-dom');

const ROOT = path.join(__dirname, '..');
let passed = 0;

function check(condition, message) {
  assert(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}

const leer = rel => normalizeEol(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const indexHtml = leer('src/renderer/index.html');
const stylesCss = leer('src/renderer/styles.css');
const i18nSource = leer('src/renderer/i18n.js');
const renderer = readRendererSource(path.join(ROOT, 'src/renderer/app.js'));

const bloqueEs = i18nSource.slice(i18nSource.indexOf('  es: {'), i18nSource.indexOf('  en: {'));
const bloqueEn = i18nSource.slice(i18nSource.indexOf('  en: {'));

// Bloque de una regla CSS, para asertar sobre su contenido y no sobre el archivo.
function reglaCss(fuente, selector) {
  const inicio = fuente.indexOf(`${selector} {`);
  if (inicio < 0) return '';
  return fuente.slice(inicio, fuente.indexOf('}', inicio));
}

// =====================================================================
// Acciones de chat
// =====================================================================

function montarSidebar({ chats, activeChatId = null, confirmar = true }) {
  const doc = createDocument();
  const chatList = doc.createElement('div');
  chatList.setAttribute('id', 'chatList');
  doc.body.appendChild(chatList);

  const llamadas = { openChat: [], deleteChat: [], updateChat: [], confirmaciones: [], prompts: [] };

  const harness = new Function('deps', `
    const document = deps.document;
    const el = id => document.getElementById(id);
    const t = deps.t;
    const Store = deps.Store;
    const withTimeout = deps.withTimeout;
    const openChat = deps.openChat;
    const mikaConfirm = deps.mikaConfirm;
    const mikaPrompt = deps.mikaPrompt;
    const mikaSelect = deps.mikaSelect;
    const showToast = deps.showToast;
    const console = deps.console;
    const _contextWarningShown = new Map();
    const _contextSavePrompted = new Map();
    const chatDrafts = new Map();
    const QUICK_CHAT_ID = 'quick-chat';
    const PROJECT_ICONS = ['📁'];
    const PROJECT_COLORS = ['#3b82f6'];
    let activeProjectId = 'p1';
    let activeChatId = deps.activeChatId;
    ${renderer.slice('buildChatActionButton')}
    ${renderer.slice('refreshChats')}
    return { refreshChats };
  `)({
    document: doc,
    t: key => key,
    Store: {
      listChats: async () => chats,
      listProjects: async () => [{ id: 'p1', name: 'Uno' }, { id: 'p2', name: 'Dos' }],
      updateChat: async (id, payload) => { llamadas.updateChat.push({ id, payload }); return { ok: true }; },
      deleteChat: async id => { llamadas.deleteChat.push(id); return { ok: true }; },
      createChat: async () => ({ ok: true, id: 'nuevo' })
    },
    withTimeout: promise => promise,
    openChat: async id => { llamadas.openChat.push(id); },
    mikaConfirm: async (titulo) => { llamadas.confirmaciones.push(titulo); return confirmar; },
    mikaPrompt: async () => { llamadas.prompts.push(true); return null; },
    mikaSelect: async () => null,
    showToast: () => {},
    console: { warn() {}, log() {} },
    activeChatId
  });

  return { doc, chatList, harness, llamadas };
}

async function accionesTests() {
  console.log('\n=== Acciones de chat: contenedor, foco y seguridad ===');

  const s = montarSidebar({ chats: [{ id: 'c1', title: 'Chat uno' }, { id: 'c2', title: 'Chat dos' }] });
  await s.harness.refreshChats();

  const fila = s.chatList.children[0];
  const contenedor = fila.children.find(n => n.classList.contains('item-actions'));
  check(Boolean(contenedor), 'la fila usa un contenedor .item-actions real');

  const botones = contenedor.children.filter(n => n.tagName === 'button');
  check(botones.length === 3, `los tres botones viven dentro de .item-actions (${botones.length})`);
  check(fila.children.filter(n => n.tagName === 'button').length === 0,
    'ningún botón cuelga suelto de la fila');
  check(botones.every(b => b.classList.contains('btn-icon')),
    'las acciones conservan .btn-icon: el filtro de click sigue funcionando');

  for (const boton of botones) {
    const etiqueta = boton.getAttribute('aria-label');
    check(Boolean(etiqueta) && etiqueta.length > 2 && boton.title === etiqueta,
      `acción con nombre accesible y tooltip (${etiqueta})`);
    const glifo = boton.children[0];
    check(Boolean(glifo) && glifo.getAttribute('aria-hidden') === 'true',
      `el glifo de ${etiqueta} es decorativo, no el nombre accesible`);
  }
  check(botones.map(b => b.getAttribute('aria-label')).join(',') ===
    'action.renameChat,action.moveChat,action.deleteChat',
    'las etiquetas salen de i18n en el orden editar · mover · eliminar');

  const separador = contenedor.children.find(n => n.classList.contains('item-actions-separator'));
  const indices = contenedor.children.map(n => n.className);
  check(Boolean(separador)
    && indices.indexOf('item-actions-separator') > indices.findIndex(c => c.includes('item-action-move'))
    && indices.indexOf('item-actions-separator') < indices.findIndex(c => c.includes('item-action-danger')),
    'un separador aísla eliminar de mover');
  const destructivo = botones[2];
  check(destructivo.classList.contains('item-action-danger'),
    'la acción destructiva lleva su propia clase de peligro');

  // Tamaños y revelado: declarados en CSS, no en estilos inline.
  const reglaBotones = reglaCss(indexHtml, '.item-actions .btn-icon');
  check(/min-width:\s*32px/.test(reglaBotones) && /min-height:\s*32px/.test(reglaBotones),
    'el área interactiva declara 32×32 px como mínimo');
  check(/\.item:focus-within \.item-actions/.test(indexHtml),
    'focus-within revela las acciones');
  check(/@media \(hover: none\)\s*\{\s*\.item-actions \{ opacity: 1; \}/.test(indexHtml),
    'sin puntero las acciones quedan visibles');
  const reglaActions = reglaCss(indexHtml, '.item-actions');
  check(/display:\s*flex/.test(reglaActions) && !/display:\s*none/.test(reglaActions),
    'las acciones siguen en el DOM: alcanzables con Tab');
  check(/\.item-actions \.btn-icon:focus-visible/.test(indexHtml),
    'las acciones tienen foco visible');

  // Click en una acción nunca abre el chat.
  for (const boton of botones) {
    s.llamadas.openChat.length = 0;
    s.doc.dispatch(boton, 'click', { target: boton });
    check(s.llamadas.openChat.length === 0,
      `click en ${boton.getAttribute('aria-label')} no abre el chat`);
  }
  s.doc.dispatch(fila, 'click', { target: fila.children[0] });
  check(s.llamadas.openChat.length === 1 && s.llamadas.openChat[0] === 'c1',
    'click en el título sí abre el chat');

  // Eliminar: confirmación obligatoria en ambos sentidos.
  const cancelado = montarSidebar({ chats: [{ id: 'c1', title: 'Chat uno' }], confirmar: false });
  await cancelado.harness.refreshChats();
  const borrarCancelado = cancelado.chatList.children[0]
    .children.find(n => n.classList.contains('item-actions'))
    .children.filter(n => n.tagName === 'button')[2];
  await borrarCancelado.onclick({ preventDefault() {}, stopPropagation() {}, target: borrarCancelado });
  check(cancelado.llamadas.confirmaciones.length === 1, 'eliminar siempre pasa por mikaConfirm');
  check(cancelado.llamadas.deleteChat.length === 0, 'cancelar no borra nada');

  const confirmado = montarSidebar({ chats: [{ id: 'c1', title: 'Chat uno' }], confirmar: true });
  await confirmado.harness.refreshChats();
  const borrar = confirmado.chatList.children[0]
    .children.find(n => n.classList.contains('item-actions'))
    .children.filter(n => n.tagName === 'button')[2];
  await borrar.onclick({ preventDefault() {}, stopPropagation() {}, target: borrar });
  check(confirmado.llamadas.deleteChat.length === 1 && confirmado.llamadas.deleteChat[0] === 'c1',
    'confirmar llama a Store.deleteChat con el chat correcto');
}

// =====================================================================
// Compositor
// =====================================================================

function compositorTests() {
  console.log('\n=== Compositor: mismo eje que la conversación ===');

  const EJE = 'max(var(--spacing-lg), calc((100% - var(--conversation-max)) / 2))';
  const reglaMensajes = reglaCss(indexHtml, '.messages-container');
  const reglaEntrada = reglaCss(indexHtml, '.input-area');
  check(reglaMensajes.includes(EJE), 'la conversación centra su columna con la expresión compartida');
  check(reglaEntrada.includes(EJE), 'el compositor usa exactamente la misma expresión');
  check(/max-width:\s*var\(--conversation-max\)/.test(reglaCss(indexHtml, '.input-box')),
    '.input-box se limita al ancho de conversación');
  check(/max-width:\s*var\(--conversation-max\)/.test(reglaCss(indexHtml, '#footerStatus')),
    'el pie comparte el ancho del compositor');
  check(/\.message\s*\{[^}]*max-width:\s*900px/.test(indexHtml)
    && /--conversation-max:\s*900px/.test(indexHtml),
    'la columna declarada y el ancho de mensaje coinciden (900px)');

  // El compositor no flota ni se superpone: sigue siendo hermano en el flujo.
  check(!/position:\s*(fixed|sticky|absolute)/.test(reglaEntrada),
    'el compositor no flota sobre la conversación');
  check(/flex-shrink:\s*0/.test(reglaEntrada) && /max-height:\s*45vh/.test(reglaEntrada),
    'el crecimiento del compositor sigue acotado a 45vh');
  check(/overflow-y:\s*auto/.test(reglaMensajes) && /flex:\s*1 1 0%/.test(reglaMensajes),
    'la conversación conserva su propio scroll: el último mensaje no queda tapado');
  check(/\.chat-area\s*\{[^}]*flex-direction:\s*column/.test(indexHtml),
    'conversación y compositor siguen apilados en el mismo flujo');

  // Un solo contenedor para entrada, acciones y estados.
  const markupInput = indexHtml.slice(indexHtml.indexOf('<div class="input-box">'),
    indexHtml.indexOf('id="footerStatus"'));
  for (const id of ['input', 'btnSend', 'btnStop', 'attachBtn']) {
    check(markupInput.includes(`id="${id}"`), `#${id} vive dentro de .input-box`);
  }
  check(indexHtml.includes('id="attachmentPreview"') && indexHtml.includes('id="replyPreview"'),
    'adjuntos y reply preview se conservan');

  // Autogrow y límites: la lógica no cambia.
  check(/\.input-textarea\s*\{[^}]*max-height:\s*200px/.test(indexHtml),
    'el textarea conserva su límite de crecimiento');
  check(renderer.text.includes('updateSendButtonState'), 'updateSendButtonState sigue en uso');
  check(/scrollHeight/.test(renderer.slice('wire')) || renderer.text.includes('input.style.height'),
    'el autogrow del compositor sigue presente');
  check(renderer.text.includes("el('btnStop')") || renderer.text.includes('btnStop'),
    'el estado de cancelación sigue cableado');
  check(renderer.slice('updateSendButtonState').includes('disabled'),
    'el estado disabled del botón de envío se conserva');

  // Superficie y foco del compositor.
  const reglaCaja = reglaCss(indexHtml, '.input-box');
  check(/background:\s*var\(--surface-composer\)/.test(reglaCaja),
    'el compositor usa su token de superficie');
  check(/border:\s*1px solid var\(--message-border\)/.test(reglaCaja),
    'el borde del compositor sale del token, no de un blanco suelto');
  check(!/box-shadow:\s*0 0 20px/.test(reglaCaja), 'se retiró la sombra pesada');
  check(/border-color:\s*var\(--composer-focus\)/.test(reglaCss(indexHtml, '.input-box:focus-within')),
    'el foco del compositor tiene token propio');
  check(/color:\s*var\(--text-secondary\)/.test(reglaCss(indexHtml, '.input-textarea::placeholder')),
    'el placeholder usa el color secundario, no un gris arbitrario');
}

// =====================================================================
// Estado vacío
// =====================================================================

// t() devuelve texto, no la clave: así se comprueba que el estado vacío toma
// cada cadena de i18n en vez de incrustarla.
const DICCIONARIO = {
  'empty.title': 'Empieza',
  'empty.subtitle': 'Subtitulo',
  'empty.ctaStart': 'Escribir',
  'empty.noChatTitle': 'Sin chat',
  'empty.noChatSubtitle': 'Crea uno',
  'empty.ctaNewChat': 'Nuevo chat',
  'empty.suggestion1': 'Sugerencia uno',
  'empty.suggestion2': 'Sugerencia dos',
  'empty.suggestion3': 'Sugerencia tres',
  'chat.loadError': 'Error de carga'
};

function montarEstadoVacio({ variant = 'empty-chat', mensajes = [] } = {}) {
  const doc = createDocument();
  const chat = doc.createElement('div');
  chat.setAttribute('id', 'chat');
  const input = doc.createElement('textarea');
  input.setAttribute('id', 'input');
  input.disabled = true;
  doc.body.append(chat, input);

  const orden = [];
  const llamadas = { newChat: 0, updateSendButtonState: 0 };

  const harness = new Function('deps', `
    const document = deps.document;
    const el = id => document.getElementById(id);
    const t = deps.t;
    const newChat = deps.newChat;
    const updateSendButtonState = deps.updateSendButtonState;
    const loadOlderMessages = () => {};
    const appendMsg = () => {};
    const enhanceMessageImages = () => {};
    let chatOldestLoadedOffset = 0;
    ${renderer.slice('renderEmptyState')}
    ${renderer.slice('renderMessagesSafe')}
    return { renderEmptyState, renderMessagesSafe };
  `)({
    document: doc,
    t: key => (DICCIONARIO[key] !== undefined ? DICCIONARIO[key] : key),
    newChat: () => { llamadas.newChat++; },
    updateSendButtonState: () => { llamadas.updateSendButtonState++; orden.push('updateSendButtonState'); }
  });

  const inputFocus = input.focus.bind(input);
  input.focus = () => { orden.push('focus'); inputFocus(); };

  return { doc, chat, input, harness, orden, llamadas, variant, mensajes };
}

function estadoVacioTests() {
  console.log('\n=== Estado vacío: diseño, i18n y orden contractual ===');

  const e = montarEstadoVacio();
  e.harness.renderEmptyState(e.chat, 'empty-chat');
  const estado = e.chat.children[0];
  check(Boolean(estado) && estado.classList.contains('empty-state'), 'se genera .empty-state');
  const clases = estado.children.map(n => n.className);
  check(clases.includes('empty-logo'), 'incluye identidad visual (.empty-logo)');
  check(clases.includes('empty-title') && clases.includes('empty-subtitle'),
    'incluye título y subtítulo');
  const cta = estado.children.find(n => n.classList.contains('empty-cta'));
  check(Boolean(cta), 'incluye CTA principal');
  const chips = estado.children.find(n => n.classList.contains('suggestion-chips'));
  check(Boolean(chips) && chips.children.length > 0 && chips.children.length <= 3,
    `incluye hasta 3 sugerencias (${chips ? chips.children.length : 0})`);
  check(chips.children.every(c => c.classList.contains('suggestion-chip')),
    'las sugerencias reutilizan .suggestion-chip');

  const textos = [
    estado.children.find(n => n.classList.contains('empty-title')).textContent,
    estado.children.find(n => n.classList.contains('empty-subtitle')).textContent,
    cta.textContent,
    ...chips.children.map(c => c.textContent)
  ];
  const esperados = [
    DICCIONARIO['empty.title'], DICCIONARIO['empty.subtitle'], DICCIONARIO['empty.ctaStart'],
    DICCIONARIO['empty.suggestion1'], DICCIONARIO['empty.suggestion2'], DICCIONARIO['empty.suggestion3']
  ];
  check(textos.join('|') === esperados.join('|'),
    'todos los textos vienen de t(), sin literales');
  const fuenteEstado = renderer.slice('renderEmptyState');
  check(!/['"][A-ZÁÉÍÓÚÑ][^'"]{6,}['"]/.test(fuenteEstado.replace(/t\('[^']+'\)/g, '')),
    'el estado vacío no incrusta frases en español');

  // El CTA reutiliza la ruta existente en cada variante.
  const chipTexto = chips.children[0].textContent;
  e.doc.dispatch(chips.children[0], 'click', { target: chips.children[0] });
  check(e.input.value === chipTexto && e.doc.activeElement === e.input,
    'una sugerencia rellena y enfoca el compositor');
  e.doc.dispatch(cta, 'click', { target: cta });
  check(e.doc.activeElement === e.input && e.llamadas.newChat === 0,
    'con chat abierto el CTA enfoca el compositor');

  const sinChat = montarEstadoVacio();
  sinChat.harness.renderEmptyState(sinChat.chat, 'no-chat');
  const estadoSinChat = sinChat.chat.children[0];
  const ctaSinChat = estadoSinChat.children.find(n => n.classList.contains('empty-cta'));
  check(ctaSinChat.textContent === DICCIONARIO['empty.ctaNewChat'], 'la variante sin chat ofrece crear uno');
  sinChat.doc.dispatch(ctaSinChat, 'click', { target: ctaSinChat });
  check(sinChat.llamadas.newChat === 1, 'el CTA usa la ruta real newChat(), sin duplicarla');
  check(!estadoSinChat.children.some(n => n.classList.contains('suggestion-chips')),
    'sin chat abierto no se ofrecen sugerencias de escritura');

  // Orden contractual: pintar, habilitar, enfocar, recalcular.
  const flujo = montarEstadoVacio();
  flujo.harness.renderMessagesSafe([], null, false);
  check(flujo.chat.children[0].classList.contains('empty-state'),
    'un chat sin mensajes pinta el estado vacío');
  check(flujo.input.disabled === false, 'el input queda habilitado');
  check(flujo.doc.activeElement === flujo.input, 'el input queda enfocado');
  check(flujo.orden.join(' > ') === 'focus > updateSendButtonState',
    `el orden pintar → habilitar → enfocar → recalcular se conserva (${flujo.orden.join(' > ')})`);
  check(flujo.llamadas.updateSendButtonState === 1, 'updateSendButtonState se ejecuta una vez');

  // Sidebar y paridad de idiomas.
  check(renderer.slice('refreshChats').includes("t('sidebar.noChats')"),
    'el marcador del sidebar usa sidebar.noChats vía t()');
  const CLAVES = [
    'empty.title', 'empty.subtitle', 'empty.ctaStart', 'empty.noChatTitle',
    'empty.noChatSubtitle', 'empty.ctaNewChat', 'empty.suggestion1',
    'empty.suggestion2', 'empty.suggestion3', 'chat.loadError',
    'action.renameChat', 'action.moveChat', 'action.deleteChat', 'sidebar.noChats'
  ];
  for (const clave of CLAVES) {
    check(bloqueEs.includes(`'${clave}':`) && bloqueEn.includes(`'${clave}':`),
      `${clave} existe en es y en`);
  }
  const claves = txt => new Set([...txt.matchAll(/'([\w.]+)':/g)].map(m => m[1]));
  const soloEs = [...claves(bloqueEs)].filter(k => !claves(bloqueEn).has(k));
  const soloEn = [...claves(bloqueEn)].filter(k => !claves(bloqueEs).has(k));
  check(soloEs.length === 0 && soloEn.length === 0,
    `es y en mantienen paridad completa (${soloEs.concat(soloEn).join(',') || 'sin huecos'})`);
}

// =====================================================================
// Modo oscuro de la conversación
// =====================================================================

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

// Claridad HSL: comparar luminancias relativas en tonos casi negros da saltos
// enormes y no dice nada sobre lo que se ve. La claridad sí.
function claridad(valor) {
  const { r, g, b } = typeof valor === 'string' ? aRgb(valor) : valor;
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  return ((max + min) / 2) * 100;
}

function modoOscuroTests() {
  console.log('\n=== Conversación: profundidad y contraste ===');

  const rootBlock = indexHtml.slice(indexHtml.indexOf(':root {'), indexHtml.indexOf('.light-theme {'));
  const rootTokens = leerTokens(rootBlock);
  const lightBlock = indexHtml.slice(indexHtml.indexOf('.light-theme {'), indexHtml.indexOf('* {'));
  const lightTokens = Object.assign(Object.create(null), rootTokens, leerTokens(lightBlock));

  for (const tema of [{ nombre: 'oscuro', tokens: rootTokens }, { nombre: 'claro', tokens: lightTokens }]) {
    const get = nombre => {
      const valor = resolver(tema.tokens, nombre);
      assert(valor, `falta el token ${nombre} en el tema ${tema.nombre}`);
      return valor;
    };
    const canvas = get('--surface-canvas');
    const mensaje = get('--surface-message');
    const compositor = get('--surface-composer');

    const pares = [
      ['texto principal sobre el mensaje', get('--text-main'), mensaje, 4.5],
      ['texto secundario sobre el mensaje', get('--text-secondary'), mensaje, 4.5],
      ['texto principal sobre el compositor', get('--text-main'), compositor, 4.5],
      ['placeholder sobre el compositor', get('--text-secondary'), compositor, 4.5],
      ['texto secundario sobre el lienzo', get('--text-secondary'), canvas, 4.5],
      ['foco del compositor', get('--composer-focus'), compositor, 3],
      ['acción destructiva', get('--danger-text'), componer(get('--danger-surface'), mensaje), 3]
    ];
    for (const [etiqueta, frente, fondo, minimo] of pares) {
      const ratio = contraste(frente, fondo);
      check(ratio >= minimo, `${tema.nombre}: ${etiqueta} ${ratio.toFixed(2)}:1 (mínimo ${minimo})`);
    }

    // Profundidad: superficies por encima del lienzo, sin saltar a gris medio.
    for (const [etiqueta, superficie] of [['mensajes', mensaje], ['compositor', compositor]]) {
      const delta = claridad(superficie) - claridad(canvas);
      check(delta >= 3 && delta <= 12,
        `${tema.nombre}: la superficie de ${etiqueta} sube ${delta.toFixed(1)} puntos de claridad sobre el lienzo`);
    }

    // Divisores: perceptibles, nunca una línea blanca sólida.
    const divisor = aRgb(get('--divider-subtle'));
    check(divisor.a >= 0.08 && divisor.a <= 0.12,
      `${tema.nombre}: el divisor mantiene alfa ${divisor.a} en el rango 0.08–0.12`);
    check(divisor.a < 1, `${tema.nombre}: el divisor no es un color sólido`);
    const bordeCompuesto = componer(get('--message-border'), mensaje);
    const ratioBorde = contraste(bordeCompuesto, mensaje);
    check(ratioBorde >= 1.1 && ratioBorde <= 3,
      `${tema.nombre}: el borde de los mensajes se percibe sin gritar (${ratioBorde.toFixed(2)}:1)`);

    check(!/^#0{6}$/i.test(canvas) && !/^#0{6}$/i.test(mensaje) && !/^#0{6}$/i.test(compositor),
      `${tema.nombre}: ninguna superficie es negro puro`);
  }

  // El claro define sus propios valores; no es la inversión del oscuro.
  const propios = ['--surface-message', '--surface-composer', '--message-border', '--danger-text']
    .filter(nombre => resolver(rootTokens, nombre) !== resolver(lightTokens, nombre));
  check(propios.length === 4, 'el modo claro declara sus propios valores de conversación');

  // Usuario e IA siguen diferenciados cromáticamente.
  const reglaUsuario = reglaCss(indexHtml, '.msg.user');
  const reglaAsistente = reglaCss(indexHtml, '.msg.assistant');
  check(/rgba\(73, 194, 244/.test(reglaUsuario) && /border-right:\s*3px solid var\(--accent\)/.test(reglaUsuario),
    'el mensaje de usuario conserva su acento');
  check(/background:\s*var\(--surface-message\)/.test(reglaAsistente)
    && !/rgba\(73, 194, 244/.test(reglaAsistente),
    'el mensaje del asistente usa la superficie neutra: sigue distinguiéndose del usuario');

  // Divisores heredados del navegador.
  check(/\.msg-content hr\s*\{[^}]*border-top:\s*1px solid var\(--divider-subtle\)/.test(indexHtml),
    'el <hr> del markdown deja de ser la línea blanca por defecto');
  check(/\.model-change-line\s*\{[^}]*background:\s*var\(--divider-subtle\)/.test(indexHtml),
    'el divisor de cambio de modelo usa el token');
  check(!/background:\s*#000000|background:\s*black\b/i.test(indexHtml),
    'no aparece negro puro como fondo general');

  // Los bloques de código son del Commit 3: no se tocan aquí.
  check(/\.code-block-wrapper\s*\{[^}]*background:\s*#1e1e1e/.test(indexHtml),
    'los estilos de bloques de código quedan intactos para el Commit 3');
}

// =====================================================================

async function run() {
  await accionesTests();
  compositorTests();
  estadoVacioTests();
  modoOscuroTests();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Visual UI conversation tests passed (${passed} comprobaciones)`);
  console.log(`${'='.repeat(40)}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
