// test/visual-ui-shell.test.js — El shell visual (barra superior, aviso cloud y
// contexto activo del sidebar) es contrato, no decoración.
//
// Run: node test/visual-ui-shell.test.js
//
// Por qué existe: los tres componentes de este bloque tienen invariantes que se
// rompen en silencio. Un ID renombrado deja un listener huérfano; un segundo
// banner cloud vuelve a duplicar el aviso; el cierre del banner podría filtrarse
// entre proveedores o sobrevivir a una revocación de consentimiento; el estado
// activo podría marcarse en dos filas a la vez o quedarse sólo en el color.
// Nada de eso tumbaría una prueba existente.
//
// No abre Electron, no usa red, no instala dependencias y no toca userData: el
// renderer se inspecciona como fuente y sus funciones se evalúan sobre un DOM
// mínimo declarado aquí mismo.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readRendererSource, normalizeEol } = require('./helpers/renderer-source');
const consentApi = require('../src/renderer/cloud-consent.js');

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

// =====================================================================
// DOM mínimo
// =====================================================================
// Sólo lo que estas pruebas ejercitan. Un DOM completo no aporta señal y
// arrastraría una dependencia que el gate no admite.

function matchesSimple(node, selector) {
  const sel = selector.trim();
  if (!sel) return false;
  if (sel.startsWith('#')) return node.id === sel.slice(1);
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  const attr = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (attr) {
    return attr[2] === undefined
      ? node.getAttribute(attr[1]) !== null
      : node.getAttribute(attr[1]) === attr[2];
  }
  return node.tagName === sel.toLowerCase();
}

function matches(node, selector) {
  return String(selector).split(',').some(part => matchesSimple(node, part));
}

function createDocument() {
  const documentListeners = Object.create(null);

  class ClassList {
    constructor(node) { this.node = node; this.set = new Set(); }
    add(...names) { names.forEach(n => n && this.set.add(n)); }
    remove(...names) { names.forEach(n => this.set.delete(n)); }
    contains(name) { return this.set.has(name); }
    toggle(name, force) {
      const on = force === undefined ? !this.set.has(name) : Boolean(force);
      if (on) this.set.add(name); else this.set.delete(name);
      return on;
    }
    toString() { return Array.from(this.set).join(' '); }
  }

  class Element {
    constructor(tagName) {
      this.tagName = String(tagName).toLowerCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = Object.create(null);
      this.listeners = Object.create(null);
      this.classList = new ClassList(this);
      this.style = { cssText: '' };
      this.dataset = Object.create(null);
      this._text = '';
      this.id = '';
      this.disabled = false;
      this.hidden = false;
      this.onclick = null;
      this.title = '';
      this.type = '';
      this.focused = false;
    }

    get className() { return this.classList.toString(); }
    set className(value) {
      this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
    }

    get textContent() {
      if (this.children.length === 0) return this._text;
      return this._text + this.children.map(c => c.textContent).join('');
    }
    set textContent(value) {
      this.children.forEach(c => { c.parentNode = null; });
      this.children = [];
      this._text = String(value);
    }

    set innerHTML(value) {
      this.children.forEach(c => { c.parentNode = null; });
      this.children = [];
      this._text = String(value);
    }
    get innerHTML() { return this._text; }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    append(...nodes) { nodes.forEach(n => this.appendChild(n)); }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter(c => c !== this);
      this.parentNode = null;
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'id') this.id = String(value);
    }
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null;
    }
    removeAttribute(name) { delete this.attributes[name]; }
    hasAttribute(name) { return name in this.attributes; }

    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    }

    focus() {
      doc.activeElement = this;
    }

    descendants() {
      const out = [];
      const walk = node => node.children.forEach(child => { out.push(child); walk(child); });
      walk(this);
      return out;
    }

    querySelectorAll(selector) {
      return this.descendants().filter(node => matches(node, selector));
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    closest(selector) {
      let node = this;
      while (node) {
        if (node.tagName && matches(node, selector)) return node;
        node = node.parentNode;
      }
      return null;
    }
  }

  const doc = {
    activeElement: null,
    body: new Element('body'),
    createElement: tag => new Element(tag),
    addEventListener(type, handler) {
      (documentListeners[type] = documentListeners[type] || []).push(handler);
    },
    getElementById(id) {
      return doc.body.descendants().find(node => node.id === id) || null;
    },
    querySelectorAll(selector) { return doc.body.querySelectorAll(selector); },
    querySelector(selector) { return doc.body.querySelector(selector); },
    dispatch(target, type, extra = {}) {
      const event = Object.assign({
        type,
        target,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; }
      }, extra);
      let node = target;
      while (node) {
        (node.listeners?.[type] || []).forEach(h => h(event));
        if (type === 'click' && node.onclick && node === target) node.onclick(event);
        if (event.propagationStopped) return event;
        node = node.parentNode;
      }
      (documentListeners[type] || []).forEach(h => h(event));
      return event;
    }
  };

  doc.Element = Element;
  return doc;
}

function makeAppState(initial = {}) {
  const store = Object.assign(Object.create(null), initial);
  return {
    store,
    getAppState: async key => (key in store ? store[key] : null),
    setAppState: async (key, value) => { store[key] = value; }
  };
}

// =====================================================================
console.log('\n=== Barra superior: estructura e IDs ===');
// =====================================================================

const IDS_PRESERVADOS = [
  'mobileSidebarToggle', 'activeTitle', 'modelTrigger', 'modelOptions', 'modelSelect',
  'providerTrigger', 'providerOptions', 'currentProviderName', 'privacyIndicator',
  'privacyBadge', 'themeToggle', 'rtStatus', 'btnConfigApiKey', 'btnPull', 'btnPullLocal',
  'btnSaveChatDoc', 'btnExportChat', 'btnContextToggle', 'btnLangToggle', 'revokeCloudConsent',
  'cloudInputBanner', 'footerStatus'
];
for (const id of IDS_PRESERVADOS) {
  const apariciones = indexHtml.split(`id="${id}"`).length - 1;
  check(apariciones === 1, `#${id} sigue existiendo exactamente una vez`);
}

const todosLosIds = (indexHtml.match(/\sid="([^"]+)"/g) || [])
  .map(fragment => fragment.match(/id="([^"]+)"/)[1]);
const idsDuplicados = todosLosIds.filter((id, i) => todosLosIds.indexOf(id) !== i);
check(idsDuplicados.length === 0,
  `ningún ID duplicado en index.html (${idsDuplicados.join(', ') || 'ninguno'})`);

// El select nativo es contrato con las pruebas de integración: sigue presente y
// fuera de la vista, nunca eliminado.
check(/<select id="modelSelect"/.test(indexHtml), '#modelSelect sigue en el markup');
const reglaModelSelect = indexHtml.slice(indexHtml.indexOf('#modelSelect {'));
check(/opacity:\s*0/.test(reglaModelSelect.slice(0, 200))
  && /pointer-events:\s*none/.test(reglaModelSelect.slice(0, 200)),
  '#modelSelect permanece oculto (opacity 0 + pointer-events none)');

check(indexHtml.includes('id="btnMoreActions"'), 'existe el botón de más acciones');
const disparador = indexHtml.slice(
  indexHtml.indexOf('id="btnMoreActions"') - 200,
  indexHtml.indexOf('id="btnMoreActions"') + 400);
check(/aria-haspopup="true"/.test(disparador), 'el disparador declara aria-haspopup');
check(/aria-expanded="false"/.test(disparador), 'el disparador arranca con aria-expanded="false"');
check(/aria-controls="moreActionsMenu"/.test(disparador), 'el disparador declara aria-controls');
check(/aria-label="[^"]+"/.test(disparador), 'el disparador tiene nombre accesible');

const inicioMenu = indexHtml.indexOf('id="moreActionsMenu"');
const finMenu = indexHtml.indexOf('</div>\n                </div>\n            </div>', inicioMenu);
const bloqueMenu = indexHtml.slice(inicioMenu, finMenu > 0 ? finMenu : inicioMenu + 6000);
check(/role="menu"/.test(bloqueMenu), 'el contenedor declara role="menu"');
check(/\shidden(\s|>)/.test(bloqueMenu.slice(0, 300)), 'el menú arranca cerrado (hidden)');

const SECUNDARIOS_EN_MENU = [
  'btnConfigApiKey', 'rtStatus', 'btnPull', 'btnPullLocal', 'btnSaveChatDoc',
  'btnExportChat', 'btnContextToggle', 'btnLangToggle', 'revokeCloudConsent'
];
for (const id of SECUNDARIOS_EN_MENU) {
  check(bloqueMenu.includes(`id="${id}"`), `#${id} vive dentro del menú de más acciones`);
}

// Los principales quedan fuera del menú: si alguno cayera dentro, la barra
// perdería su foco visual sin que nada más lo notase.
const PRINCIPALES_FUERA = ['modelTrigger', 'providerTrigger', 'privacyBadge', 'themeToggle', 'activeTitle'];
for (const id of PRINCIPALES_FUERA) {
  check(!bloqueMenu.includes(`id="${id}"`), `#${id} permanece como control principal`);
}

for (const boton of bloqueMenu.match(/<button[^>]*>/g) || []) {
  const id = (boton.match(/id="([^"]+)"/) || [])[1] || '(sin id)';
  check(/aria-label="[^"]+"/.test(boton), `el botón ${id} del menú declara aria-label`);
}

check(!indexHtml.includes('id="cloudWarning"'),
  'el segundo banner cloud del header ya no existe');
// Ninguna regla de la barra (tampoco las responsive) puede fijar `height`: con
// altura fija, el contenido se recorta en vez de crecer.
check(!/\.main-header\s*\{[^}]*(?<!min-)(?<!max-)height:\s*\d/.test(indexHtml),
  'la barra usa altura mínima, no una altura fija');
check(/\.main-header\s*\{[^}]*min-height:/.test(indexHtml),
  'la barra declara min-height');
check(/\.header-toolbar\s*\{[^}]*flex:\s*0 1 auto/.test(indexHtml),
  'la barra de controles cede espacio en vez de bloquear el layout');
check(/\.header-section\s*\{[^}]*min-width:\s*0/.test(indexHtml),
  'la zona elástica declara min-width: 0');

// =====================================================================
console.log('\n=== Barra superior: comportamiento del menú ===');
// =====================================================================

function montarMenu() {
  const doc = createDocument();
  const header = doc.createElement('div');
  header.className = 'main-header';
  doc.body.appendChild(header);

  const modelOptions = doc.createElement('div');
  modelOptions.setAttribute('id', 'modelOptions');
  modelOptions.classList.add('model-options', 'open');
  const modelTrigger = doc.createElement('div');
  modelTrigger.setAttribute('id', 'modelTrigger');
  modelTrigger.setAttribute('aria-expanded', 'true');
  const providerOptions = doc.createElement('div');
  providerOptions.setAttribute('id', 'providerOptions');
  providerOptions.style.display = 'block';
  header.append(modelTrigger, modelOptions, providerOptions);

  const wrapper = doc.createElement('div');
  wrapper.classList.add('more-actions');
  const trigger = doc.createElement('button');
  trigger.setAttribute('id', 'btnMoreActions');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'moreActionsMenu');
  const menu = doc.createElement('div');
  menu.setAttribute('id', 'moreActionsMenu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  const activaciones = [];
  const items = ['btnConfigApiKey', 'btnPull', 'btnSaveChatDoc', 'btnExportChat'].map((id, index) => {
    const item = doc.createElement('button');
    item.setAttribute('id', id);
    item.setAttribute('role', 'menuitem');
    item.addEventListener('click', () => activaciones.push(id));
    if (index === 0) item.style.display = 'none'; // oculto: no debe recibir foco
    if (index === 2) item.disabled = true;        // deshabilitado: tampoco
    menu.appendChild(item);
    return item;
  });

  wrapper.append(trigger, menu);
  header.appendChild(wrapper);

  const el = id => doc.getElementById(id);
  const api = new Function('deps', `
    const document = deps.document;
    const el = deps.el;
    ${renderer.slice('moreActionsItems')}
    ${renderer.slice('closeMoreActionsMenu')}
    ${renderer.slice('openMoreActionsMenu')}
    ${renderer.slice('wireMoreActionsMenu')}
    wireMoreActionsMenu();
    return { moreActionsItems, closeMoreActionsMenu, openMoreActionsMenu };
  `)({ document: doc, el });

  return { doc, trigger, menu, items, activaciones, api, modelOptions, providerOptions };
}

{
  const m = montarMenu();
  check(m.menu.hidden === true && m.trigger.getAttribute('aria-expanded') === 'false',
    'el menú arranca cerrado');

  m.doc.dispatch(m.trigger, 'click');
  check(m.menu.hidden === false && m.trigger.getAttribute('aria-expanded') === 'true',
    'el click abre el menú y aria-expanded pasa a true');
  check(m.activaciones.length === 0,
    'abrir el menú no ejecuta ninguna acción');
  check(!m.modelOptions.classList.contains('open') && m.providerOptions.style.display === 'none',
    'abrir el menú cierra el selector de modelos y el de proveedor: no se solapan');

  m.doc.dispatch(m.trigger, 'click');
  check(m.menu.hidden === true && m.trigger.getAttribute('aria-expanded') === 'false',
    'el segundo click cierra el menú');
}

{
  const m = montarMenu();
  m.doc.dispatch(m.trigger, 'click');
  m.doc.dispatch(m.menu, 'keydown', { key: 'Escape' });
  check(m.menu.hidden === true && m.trigger.getAttribute('aria-expanded') === 'false',
    'Escape cierra el menú');
  check(m.doc.activeElement === m.trigger, 'Escape devuelve el foco al disparador');
}

{
  const m = montarMenu();
  m.doc.dispatch(m.trigger, 'click');
  const fuera = m.doc.createElement('div');
  m.doc.body.appendChild(fuera);
  m.doc.dispatch(fuera, 'click');
  check(m.menu.hidden === true, 'un click fuera cierra el menú');
}

{
  const m = montarMenu();
  m.doc.dispatch(m.trigger, 'click');
  m.doc.dispatch(m.menu, 'click', { target: m.items[1] });
  check(m.menu.hidden === true, 'activar una acción cierra el menú');
}

{
  const m = montarMenu();
  m.doc.dispatch(m.trigger, 'keydown', { key: 'ArrowDown' });
  check(m.menu.hidden === false, 'ArrowDown sobre el disparador abre el menú');
  check(m.doc.activeElement === m.items[1],
    'el foco entra en el primer elemento navegable (ni oculto ni deshabilitado)');

  m.doc.dispatch(m.menu, 'keydown', { key: 'ArrowDown' });
  check(m.doc.activeElement === m.items[3], 'ArrowDown avanza saltando los no navegables');
  m.doc.dispatch(m.menu, 'keydown', { key: 'ArrowDown' });
  check(m.doc.activeElement === m.items[1], 'ArrowDown cicla al principio');
  m.doc.dispatch(m.menu, 'keydown', { key: 'ArrowUp' });
  check(m.doc.activeElement === m.items[3], 'ArrowUp cicla al final');
  m.doc.dispatch(m.menu, 'keydown', { key: 'End' });
  check(m.doc.activeElement === m.items[3], 'End va al último');
  m.doc.dispatch(m.menu, 'keydown', { key: 'Home' });
  check(m.doc.activeElement === m.items[1], 'Home va al primero');
  check(m.activaciones.length === 0, 'navegar por teclado no ejecuta acciones');
}

check(/\.more-actions-menu\s*\{[^}]*overflow-y:\s*auto/.test(indexHtml),
  'el menú desplaza su propio contenido en vez de quedar cortado');
check(/\.more-actions-menu\s*\{[^}]*z-index:\s*1200/.test(indexHtml),
  'el menú se dibuja por encima del selector de modelos (z-index 1100)');
check(/\.more-actions-trigger:focus-visible/.test(indexHtml)
  && /\.more-actions-menu :focus-visible/.test(indexHtml),
  'disparador y elementos del menú tienen foco visible');

// =====================================================================
console.log('\n=== Aviso cloud: superficie única y cierre recordado ===');
// =====================================================================

check((indexHtml.match(/class="cloud-input-banner"/g) || []).length === 1,
  'sólo hay una superficie detallada de aviso cloud en el markup');
check(!stylesCss.includes('.cloud-warning {'),
  'el estilo del banner retirado ya no existe');
check(indexHtml.includes('id="cloudBannerDismiss"'), 'el banner tiene botón de cierre');
check(/id="cloudBannerDismiss"[^>]*aria-label="[^"]+"/.test(indexHtml),
  'el botón de cierre tiene nombre accesible');
check(/\.cloud-input-banner-dismiss:focus-visible/.test(stylesCss)
  && /\.cloud-input-banner-dismiss:hover/.test(stylesCss),
  'el cierre declara estados hover y focus-visible');

const fuenteUpdatePrivacy = renderer.slice('updatePrivacyUI');
const fuenteBanner = renderer.slice('renderCloudInputBanner');
check(!fuenteUpdatePrivacy.includes(".split(':')") && !fuenteBanner.includes(".split(':')"),
  'el aviso no se construye partiendo una traducción por ":"');
check(fuenteBanner.includes('textContent') && !fuenteBanner.includes('innerHTML'),
  'el aviso se compone con nodos y textContent, no con innerHTML');
check(renderer.text.includes('const CLOUD_BANNER_SCHEMA_VERSION = 1;'),
  'la clave del banner declara versión de esquema');

const CLAVES_NUEVAS = ['footer.cloudCompact', 'header.moreActions', 'cloudBanner.provider', 'cloudBanner.dismiss'];
const bloqueEs = i18nSource.slice(i18nSource.indexOf('  es: {'), i18nSource.indexOf('  en: {'));
const bloqueEn = i18nSource.slice(i18nSource.indexOf('  en: {'));
for (const clave of CLAVES_NUEVAS) {
  check(bloqueEs.includes(`'${clave}'`), `i18n es define ${clave}`);
  check(bloqueEn.includes(`'${clave}'`), `i18n en define ${clave}`);
}
check(!/'footer\.cloudCompact':\s*'[^']*:/.test(bloqueEs),
  'el texto del pie cloud no depende de contener ":"');

function montarCloud({ provider = 'openai', privacy = 'cloud', projectId = 'project-a', state = {} } = {}) {
  const doc = createDocument();
  const crear = (id, tag = 'div') => {
    const node = doc.createElement(tag);
    node.setAttribute('id', id);
    doc.body.appendChild(node);
    return node;
  };
  const nodes = {
    privacyIndicator: crear('privacyIndicator'),
    privacyBadge: crear('privacyBadge', 'span'),
    btnConfigApiKey: crear('btnConfigApiKey', 'button'),
    currentProviderName: crear('currentProviderName', 'span'),
    cloudInputBanner: crear('cloudInputBanner'),
    cloudInputBannerBody: crear('cloudInputBannerBody', 'span'),
    cloudBannerDismiss: crear('cloudBannerDismiss', 'button'),
    footerStatus: crear('footerStatus'),
    revokeCloudConsent: crear('revokeCloudConsent', 'button')
  };
  const appState = makeAppState(state);
  const toasts = [];
  const harness = new Function('deps', `
    const document = deps.document;
    const window = deps.window;
    const t = deps.t;
    const showToast = deps.showToast;
    const console = deps.console;
    const buildCloudConsentKey = deps.consent.buildCloudConsentKey;
    const cloudProjectScope = deps.consent.projectScope;
    const normalizeStoredConsent = deps.consent.normalizeStoredConsent;
    const el = id => document.getElementById(id);
    const QUICK_CHAT_ID = 'quick-chat';
    let currentProvider = deps.provider;
    let providerPrivacy = deps.privacy;
    let activeProjectId = deps.projectId;
    const CLOUD_BANNER_SCHEMA_VERSION = 1;
    ${renderer.slice('cloudConsentProjectId')}
    ${renderer.slice('readCloudConsent')}
    ${renderer.slice('providerDisplayName')}
    ${renderer.slice('cloudBannerStateKey')}
    ${renderer.slice('cloudConsentFingerprint')}
    ${renderer.slice('readCloudBannerDismissal')}
    ${renderer.slice('clearCloudBannerDismissal')}
    ${renderer.slice('dismissCloudInputBanner')}
    ${renderer.slice('renderCloudInputBanner')}
    ${renderer.slice('renderPrivacyBadge')}
    ${renderer.slice('updatePrivacyUI')}
    ${renderer.slice('revokeCloudConsent')}
    return {
      updatePrivacyUI, dismissCloudInputBanner, revokeCloudConsent,
      cloudBannerStateKey, cloudConsentFingerprint,
      switchTo(nextProvider, nextProject) {
        currentProvider = nextProvider;
        activeProjectId = nextProject;
      }
    };
  `)({
    document: doc,
    window: { mika5: { getAppState: appState.getAppState, setAppState: appState.setAppState } },
    t: (key, params) => (params && params.provider ? `${key}:${params.provider}` : key),
    showToast: (message, type) => toasts.push({ message, type }),
    console: { warn() {}, log() {} },
    consent: consentApi,
    provider,
    privacy,
    projectId
  });
  return { doc, nodes, appState, harness, toasts };
}

const esperar = () => new Promise(resolve => setImmediate(resolve));

async function cloudTests() {
  {
    const c = montarCloud();
    check(c.harness.cloudBannerStateKey('openai', 'project-a') === 'ui:cloudBanner:v1:openai:project:project-a',
      'la clave de persistencia es ui:cloudBanner:v1:<provider>:<projectScope>');
    check(c.harness.cloudBannerStateKey('openai', null) === 'ui:cloudBanner:v1:openai:global',
      'sin proyecto la clave cae en el ámbito global');
  }

  {
    const c = montarCloud();
    c.harness.updatePrivacyUI();
    await esperar();
    check(c.nodes.cloudInputBanner.classList.contains('visible'),
      'sin cierre previo el aviso se muestra');
    check(c.nodes.cloudInputBannerBody.textContent.includes('cloudBanner.provider'),
      'el cuerpo del aviso se compone desde i18n');
    check(c.nodes.privacyBadge.className.includes('cloud'),
      'el indicador compacto de privacidad sigue disponible');

    await c.harness.dismissCloudInputBanner();
    check(!c.nodes.cloudInputBanner.classList.contains('visible'),
      'el cierre oculta el aviso');
    check(c.nodes.privacyBadge.className.includes('cloud'),
      'el cierre no oculta el indicador de privacidad');
    const guardado = JSON.parse(c.appState.store['ui:cloudBanner:v1:openai:project:project-a']);
    check(guardado.schemaVersion === 1 && typeof guardado.fingerprint === 'string',
      'el cierre se persiste en appState con huella del estado de seguridad');
    check(Object.keys(c.appState.store).every(key => !key.startsWith('cloud-consent:')),
      'el cierre no crea ni modifica ningún consentimiento');

    c.harness.updatePrivacyUI();
    await esperar();
    check(!c.nodes.cloudInputBanner.classList.contains('visible'),
      'el cierre persiste entre repintados del mismo proveedor y proyecto');
  }

  {
    const c = montarCloud();
    c.harness.updatePrivacyUI();
    await esperar();
    await c.harness.dismissCloudInputBanner();

    c.harness.switchTo('anthropic', 'project-a');
    c.harness.updatePrivacyUI();
    await esperar();
    check(c.nodes.cloudInputBanner.classList.contains('visible'),
      'otro proveedor no hereda el cierre');

    c.harness.switchTo('openai', 'project-b');
    c.harness.updatePrivacyUI();
    await esperar();
    check(c.nodes.cloudInputBanner.classList.contains('visible'),
      'otro proyecto no hereda el cierre');

    c.harness.switchTo('openai', 'project-a');
    c.harness.updatePrivacyUI();
    await esperar();
    check(!c.nodes.cloudInputBanner.classList.contains('visible'),
      'al volver al par original el cierre sigue vigente');
  }

  {
    const consent = JSON.stringify({
      providerId: 'openai',
      projectScope: 'project:project-a',
      categories: { message: true, history: false, projectInstructions: false, textAttachments: false, imageAttachments: false, ragContext: false },
      schemaVersion: 1,
      grantedAt: '2026-01-01T00:00:00.000Z'
    });
    const c = montarCloud({ state: { 'cloud-consent:v1:openai:project:project-a': consent } });
    c.harness.updatePrivacyUI();
    await esperar();
    await c.harness.dismissCloudInputBanner();
    c.harness.updatePrivacyUI();
    await esperar();
    check(!c.nodes.cloudInputBanner.classList.contains('visible'),
      'con consentimiento vigente el cierre se respeta');

    // El estado de seguridad cambia: se autoriza una categoría nueva.
    c.appState.store['cloud-consent:v1:openai:project:project-a'] = JSON.stringify({
      providerId: 'openai',
      projectScope: 'project:project-a',
      categories: { message: true, history: true, projectInstructions: false, textAttachments: false, imageAttachments: false, ragContext: false },
      schemaVersion: 1,
      grantedAt: '2026-01-01T00:00:00.000Z'
    });
    c.harness.updatePrivacyUI();
    await esperar();
    check(c.nodes.cloudInputBanner.classList.contains('visible'),
      'el aviso reaparece cuando cambian las categorías autorizadas');
  }

  {
    const consent = JSON.stringify({
      providerId: 'openai',
      projectScope: 'project:project-a',
      categories: { message: true, history: false, projectInstructions: false, textAttachments: false, imageAttachments: false, ragContext: false },
      schemaVersion: 1,
      grantedAt: '2026-01-01T00:00:00.000Z'
    });
    const c = montarCloud({ state: { 'cloud-consent:v1:openai:project:project-a': consent } });
    c.harness.updatePrivacyUI();
    await esperar();
    await c.harness.dismissCloudInputBanner();
    await c.harness.revokeCloudConsent();
    await esperar();
    check(!c.appState.store['ui:cloudBanner:v1:openai:project:project-a'],
      'revocar el consentimiento invalida el cierre del aviso');
    check(c.nodes.cloudInputBanner.classList.contains('visible'),
      'tras revocar, el aviso vuelve a mostrarse');
    check(c.appState.store['cloud-consent:v1:openai:project:project-a'] === '',
      'revocar sigue borrando el consentimiento');
  }

  // El indicador tenía dos iconos: el prefijo del JS y el que ya traía la
  // traducción. Fuente única: icono estructural en el DOM, i18n sin emojis.
  {
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    const CLAVES_SIN_ICONO = [
      'privacy.private', 'privacy.cloud',
      'cloudConsent.authorized', 'cloudConsent.authorizedBadge'
    ];
    for (const bloque of [['es', bloqueEs], ['en', bloqueEn]]) {
      for (const clave of CLAVES_SIN_ICONO) {
        const linea = bloque[1].split('\n').find(l => l.includes(`'${clave}':`));
        check(Boolean(linea) && !EMOJI.test(linea.split(':').slice(1).join(':')),
          `i18n ${bloque[0]}: ${clave} no lleva icono en el texto`);
      }
    }
    check(bloqueEs.includes("'cloudConsent.authorizedBadge': 'Cloud autorizado'")
      && bloqueEn.includes("'cloudConsent.authorizedBadge': 'Cloud authorized'"),
      'el badge compacto existe en ambos idiomas');

    const fuenteBadge = renderer.slice('renderPrivacyBadge');
    check(!fuenteUpdatePrivacy.includes('innerHTML'),
      'el indicador ya no se compone concatenando HTML');
    check(!/\+\s*t\('privacy\./.test(fuenteUpdatePrivacy),
      'ningún prefijo de icono se concatena sobre la traducción');
    check((fuenteBadge.match(/'☁️'/g) || []).length === 1
      && (fuenteBadge.match(/'🔒'/g) || []).length === 1,
      'cada estado declara su icono una sola vez');

    for (const [privacy, provider, iconoEsperado] of [
      ['private', 'local', '🔒'],
      ['cloud', 'openai', '☁️']
    ]) {
      const c = montarCloud({ provider, privacy });
      c.harness.updatePrivacyUI();
      await esperar();
      const badge = c.nodes.privacyBadge;
      const iconos = badge.children.filter(n => n.classList.contains('privacy-badge-icon'));
      const texto = badge.children.filter(n => n.classList.contains('privacy-badge-text'));
      check(iconos.length === 1 && iconos[0].textContent === iconoEsperado,
        `${privacy}: exactamente un icono de estado (${iconos.map(n => n.textContent).join('')})`);
      check((badge.textContent.match(/☁️/gu) || []).length <= 1,
        `${privacy}: como mucho un icono cloud visible`);
      check(texto.length === 1 && !EMOJI.test(texto[0].textContent) && texto[0].textContent.length <= 24,
        `${privacy}: texto corto y sin icono (${texto.map(n => n.textContent).join('')})`);
      check(iconos[0].getAttribute('aria-hidden') === 'true',
        `${privacy}: el icono no se anuncia dos veces al lector de pantalla`);
      check(Boolean(c.nodes.privacyIndicator.getAttribute('data-tooltip')),
        `${privacy}: el tooltip explicativo sigue presente`);
    }

    // Con consentimiento guardado el badge sigue siendo compacto y de un icono.
    const conConsentimiento = montarCloud({
      state: {
        'cloud-consent:v1:openai:project:project-a': JSON.stringify({
          providerId: 'openai', projectScope: 'project:project-a',
          categories: { message: true, history: false, projectInstructions: false, textAttachments: false, imageAttachments: false, ragContext: false },
          schemaVersion: 1, grantedAt: '2026-01-01T00:00:00.000Z'
        })
      }
    });
    conConsentimiento.harness.updatePrivacyUI();
    await esperar();
    const badgeAuth = conConsentimiento.nodes.privacyBadge;
    check(badgeAuth.children.filter(n => n.classList.contains('privacy-badge-icon')).length === 1
      && (badgeAuth.textContent.match(/☁️/gu) || []).length === 1,
      'autorizado: un solo icono cloud');
    check(conConsentimiento.nodes.privacyIndicator.getAttribute('data-tooltip') === 'cloudConsent.authorized',
      'autorizado: el tooltip lleva la frase completa');
    check(/\.privacy-badge-text\s*\{[^}]*text-overflow:\s*ellipsis/.test(stylesCss),
      'el truncado recorta el texto, no el icono');
  }

  {
    const c = montarCloud({ provider: 'local', privacy: 'private' });
    c.harness.updatePrivacyUI();
    await esperar();
    check(!c.nodes.cloudInputBanner.classList.contains('visible'),
      'en modo privado no hay aviso cloud');
    check(c.nodes.footerStatus.textContent === 'footer.tagline',
      'el pie privado conserva su texto');
  }

  {
    const c = montarCloud();
    c.harness.updatePrivacyUI();
    await esperar();
    check(c.nodes.footerStatus.textContent.startsWith('footer.cloudCompact'),
      'el pie identifica el modo sin repetir el aviso');
    check(!c.nodes.footerStatus.textContent.includes('privacy.inputWarning'),
      'el pie no repite el texto de advertencia del banner');
  }
}

// =====================================================================
// El modal de consentimiento no se toca: su contrato es el orden de botones.
// =====================================================================

function modalTests() {
  console.log('\n=== Consentimiento: el modal sigue intacto ===');
  const doc = createDocument();
  const construir = new Function('deps', `
    const document = deps.document;
    const t = deps.t;
    const summarizeCloudScope = deps.summarizeCloudScope;
    ${renderer.slice('requestCloudConsentChoice')}
    return requestCloudConsentChoice;
  `)({
    document: doc,
    t: key => key,
    summarizeCloudScope: consentApi.summarizeCloudScope
  });

  construir('OpenAI', consentApi.buildCloudDataScope({ message: true, history: true, historyMessageCount: 3 }), null);
  const modal = doc.getElementById('cloudConsentModal');
  check(Boolean(modal), 'el modal de consentimiento sigue construyéndose');
  const botones = modal.querySelectorAll('button');
  check(botones.length === 3, 'el modal conserva sus tres botones');
  check(botones[0].textContent === 'cloudConsent.once'
    && botones[1].textContent === 'cloudConsent.persist'
    && botones[2].textContent === 'action.cancel',
    'el orden contractual once/persist/cancel no cambia');
  const cuerpo = modal.textContent;
  check(cuerpo.includes('cloudConsent.category.message') && cuerpo.includes('cloudConsent.category.history'),
    'el modal sigue declarando las categorías de datos que saldrán del dispositivo');
}

// =====================================================================
// Sidebar: proyecto y chat activos
// =====================================================================

function sidebarTests() {
  console.log('\n=== Sidebar: contexto activo inequívoco ===');

  function montarSidebar({ projects, chats, activeProjectId, activeChatId }) {
    const doc = createDocument();
    const projectList = doc.createElement('div');
    projectList.setAttribute('id', 'projectList');
    const chatList = doc.createElement('div');
    chatList.setAttribute('id', 'chatList');
    doc.body.append(projectList, chatList);

    const harness = new Function('deps', `
      const document = deps.document;
      const el = id => document.getElementById(id);
      const t = deps.t;
      const Store = deps.Store;
      const withTimeout = deps.withTimeout;
      const QUICK_CHAT_ID = 'quick-chat';
      const PROJECT_ICONS = ['📁'];
      const PROJECT_COLORS = ['#3b82f6'];
      const activeProjectId = deps.activeProjectId;
      const activeChatId = deps.activeChatId;
      ${renderer.slice('loadProjects')}
      ${renderer.slice('refreshChats')}
      return { loadProjects, refreshChats };
    `)({
      document: doc,
      t: key => key,
      Store: {
        listProjects: async () => projects,
        listChats: async () => chats
      },
      withTimeout: promise => promise,
      activeProjectId,
      activeChatId
    });

    return { doc, projectList, chatList, harness };
  }

  return (async () => {
    const s = montarSidebar({
      projects: [{ id: 'p1', name: 'Uno' }, { id: 'p2', name: 'Dos' }, { id: 'p3', name: 'Tres' }],
      chats: [{ id: 'c1', title: 'Chat 1' }, { id: 'c2', title: 'Chat 2' }],
      activeProjectId: 'p2',
      activeChatId: 'c2'
    });
    await s.harness.loadProjects();
    await s.harness.refreshChats();

    const proyectos = s.projectList.children;
    const proyectosActivos = proyectos.filter(node => node.classList.contains('active'));
    check(proyectosActivos.length === 1, 'exactamente un proyecto queda activo');
    check(proyectosActivos[0].textContent.includes('Dos'), 'el activo es el proyecto seleccionado');
    check(proyectosActivos[0].getAttribute('aria-current') === 'true',
      'el proyecto activo declara aria-current="true"');
    check(proyectos.filter(node => node.getAttribute('aria-current') === 'true').length === 1,
      'ningún otro proyecto conserva aria-current');

    const chats = s.chatList.children;
    const chatsActivos = chats.filter(node => node.classList.contains('active'));
    check(chatsActivos.length === 1, 'exactamente un chat queda activo');
    check(chatsActivos[0].getAttribute('aria-current') === 'true',
      'el chat activo declara aria-current="true"');
    check(chats.filter(node => node.getAttribute('aria-current') === 'true').length === 1,
      'ningún otro chat conserva aria-current');
    check(chats.every(node => node.classList.contains('active') === (node.getAttribute('aria-current') === 'true')),
      'aria-current y .active coinciden siempre');

    const sinChats = montarSidebar({
      projects: [{ id: 'p1', name: 'Uno' }],
      chats: [],
      activeProjectId: 'p1',
      activeChatId: null
    });
    await sinChats.harness.refreshChats();
    const marcador = sinChats.chatList.children[0];
    check(Boolean(marcador) && marcador.classList.contains('item-placeholder'),
      'la lista vacía pinta un marcador identificable');
    check(!marcador.classList.contains('active'),
      'el marcador "Sin chats todavía" nunca queda activo');
    check(marcador.getAttribute('aria-current') === null,
      'el marcador no declara aria-current');
    check(marcador.getAttribute('aria-disabled') === 'true',
      'el marcador se anuncia como no seleccionable');

    // Seleccionar un proyecto debe mover el indicador sin releer la lista: el
    // smoke visual encontró la lista congelada en el estado inicial.
    const marcado = new Function('deps', `
      const document = deps.document;
      const el = id => document.getElementById(id);
      ${renderer.slice('markActiveProject')}
      return markActiveProject;
    `)({ document: s.doc });
    marcado('p3');
    const trasMarcar = s.projectList.children;
    check(trasMarcar.filter(n => n.classList.contains('active')).length === 1
      && trasMarcar.find(n => n.classList.contains('active')).dataset.projectId === 'p3',
      'seleccionar otro proyecto mueve el marcado sin repintar la lista');
    check(trasMarcar.filter(n => n.getAttribute('aria-current') === 'true').length === 1,
      'el aria-current viaja con el marcado');
    check(renderer.slice('selectProject').includes('markActiveProject(projectId)'),
      'selectProject marca el proyecto abierto');
    check(renderer.slice('loadProjects').includes('div.dataset.projectId = p.id'),
      'cada fila de proyecto lleva su id para poder marcarse');

    // El indicador compacto no puede crecer sin límite: la frase larga vive en
    // el tooltip, no dentro de la píldora.
    check(/\.privacy-badge\s*\{[^}]*max-width:/.test(stylesCss)
      && /\.privacy-badge-text\s*\{[^}]*text-overflow:\s*ellipsis/.test(stylesCss),
      'el indicador de privacidad trunca en vez de desbordar la barra');
    check(/\.privacy-indicator\s*\{[^}]*overflow:\s*hidden/.test(stylesCss),
      'el contenedor del indicador recorta su contenido');
    check(fuenteUpdatePrivacy.includes("t('cloudConsent.authorizedBadge')")
      && fuenteUpdatePrivacy.includes("data-tooltip', t('cloudConsent.authorized')"),
      'la autorización usa etiqueta corta en el badge y frase completa en el tooltip');
    check(bloqueEs.includes("'cloudConsent.authorizedBadge'") && bloqueEn.includes("'cloudConsent.authorizedBadge'"),
      'la etiqueta corta existe en es y en');
    check(/#currentProviderName\s*\{[^}]*text-overflow:\s*ellipsis/.test(indexHtml),
      'el nombre del proveedor también trunca');
    // El disparador debe encoger con su envoltorio: el smoke lo pilló pintando
    // 26px por encima del indicador de privacidad a 800px de ancho.
    check(/\.provider-trigger\s*\{[^}]*max-width:\s*100%/.test(stylesCss)
      && /\.provider-trigger\s*\{[^}]*overflow:\s*hidden/.test(stylesCss),
      'el disparador de proveedor no desborda su contenedor');
    check(/\.model-trigger\s*\{[^}]*max-width:\s*100%/.test(indexHtml),
      'el disparador de modelo tampoco desborda');
    check(/@media \(max-width: 900px\)\s*\{[^@]*#themeLabel\s*\{\s*display:\s*none/.test(indexHtml),
      'por debajo de 900px la barra entra en modo compacto');

    // Estilo: hover y activo no pueden resolverse con la misma regla.
    check(/\.item:hover:not\(\.active\)/.test(indexHtml),
      'el hover excluye al activo: son reglas distintas');
    check(/\.item\.active\s*\{[^}]*box-shadow:\s*inset/.test(indexHtml),
      'el activo lleva indicador lateral, no sólo color');
    check(/\.item\.active\s*\{[^}]*font-weight:\s*600/.test(indexHtml),
      'el activo refuerza con peso tipográfico');
    check(/\.item\.active\s*\{[^}]*transition:\s*none/.test(indexHtml),
      'el activo no anima: la lista se repinta entera y parpadearía');
  })();
}

// =====================================================================
// Contraste real de los tokens usados en este bloque
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
  if (rgba) {
    return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] };
  }
  throw new Error(`color no reconocido: ${valor}`);
}

// Una capa translúcida sobre un fondo: sin componer, el ratio sería ficticio.
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
  const canales = [r, g, b]
    .map(x => x / 255)
    .map(x => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * canales[0] + 0.7152 * canales[1] + 0.0722 * canales[2];
}

function contraste(a, b) {
  const [alto, bajo] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (alto + 0.05) / (bajo + 0.05);
}

function contrasteTests() {
  console.log('\n=== Contraste real de los tokens del shell ===');

  const rootBlock = indexHtml.slice(indexHtml.indexOf(':root {'), indexHtml.indexOf('.light-theme {'));
  const rootTokens = leerTokens(rootBlock);
  const lightBlock = indexHtml.slice(indexHtml.indexOf('.light-theme {'), indexHtml.indexOf('* {'));
  const lightTokens = Object.assign(Object.create(null), rootTokens, leerTokens(lightBlock));

  const temas = [
    { nombre: 'oscuro', tokens: rootTokens },
    { nombre: 'claro', tokens: lightTokens }
  ];

  for (const tema of temas) {
    const get = nombre => {
      const valor = resolver(tema.tokens, nombre);
      assert(valor, `falta el token ${nombre} en el tema ${tema.nombre}`);
      return valor;
    };
    const base = get('--bg-base');
    const header = get('--surface-header');
    const elevated = get('--surface-elevated');
    const activeSurface = get('--active-surface');

    const pares = [
      ['texto principal sobre la barra', get('--text-main'), header, 4.5],
      ['texto secundario sobre la barra', get('--text-secondary'), header, 4.5],
      ['texto principal sobre el menú', get('--text-main'), elevated, 4.5],
      ['texto secundario sobre el menú', get('--text-secondary'), elevated, 4.5],
      ['texto del elemento activo', get('--text-main'), activeSurface, 4.5],
      ['texto del aviso cloud', get('--warning-text'), componer(get('--warning-surface'), base), 4.5],
      ['indicador de activo', get('--active-indicator'), activeSurface, 3],
      ['borde del aviso cloud', componer(get('--warning-border'), base), base, 3],
      ['anillo de foco sobre la barra', get('--focus-ring'), header, 3],
      ['anillo de foco sobre el menú', get('--focus-ring'), elevated, 3]
    ];

    for (const [etiqueta, frente, fondo, minimo] of pares) {
      const ratio = contraste(frente, fondo);
      check(ratio >= minimo,
        `${tema.nombre}: ${etiqueta} ${ratio.toFixed(2)}:1 (mínimo ${minimo})`);
    }

    // La superficie activa debe distinguirse del hover: si colapsan, el estado
    // activo deja de leerse en la lista.
    const hover = get('--bg-hover');
    check(Math.abs(luminancia(activeSurface) - luminancia(hover)) > 0.005,
      `${tema.nombre}: la superficie activa no colapsa con el hover`);
  }

  // El modo claro no puede limitarse a copiar los valores del oscuro.
  const distintos = ['--surface-header', '--surface-elevated', '--active-surface', '--warning-text']
    .filter(nombre => resolver(rootTokens, nombre) !== resolver(lightTokens, nombre));
  check(distintos.length === 4, 'el modo claro define sus propios valores para los tokens del shell');

  // Fondo general y bordes de los componentes tocados.
  check(!/--surface-header:\s*#000000/i.test(indexHtml) && !/--bg-base:\s*#000000/i.test(indexHtml),
    'ningún fondo general es negro puro');
  const bloquesTocados = [
    ['.main-header', indexHtml],
    ['.more-actions-menu', indexHtml],
    ['.item.active', indexHtml],
    ['.cloud-input-banner', stylesCss]
  ];
  for (const [selector, fuente] of bloquesTocados) {
    const inicio = fuente.indexOf(`${selector} {`);
    const bloque = fuente.slice(inicio, fuente.indexOf('}', inicio));
    check(inicio >= 0 && !/border[^;]*(#fff|#ffffff|white|rgba\(255,\s*255,\s*255,\s*1\))/i.test(bloque),
      `${selector} no usa bordes blancos sólidos`);
  }

  // La alerta baja de saturación respecto al naranja anterior (#fb923c).
  const anterior = aRgb('#fb923c');
  const nuevo = aRgb(resolver(rootTokens, '--warning-text'));
  const saturacion = c => {
    const max = Math.max(c.r, c.g, c.b) / 255;
    const min = Math.min(c.r, c.g, c.b) / 255;
    return max === 0 ? 0 : (max - min) / max;
  };
  check(saturacion(nuevo) < saturacion(anterior),
    `la alerta baja de saturación (${saturacion(nuevo).toFixed(3)} < ${saturacion(anterior).toFixed(3)})`);
}

// =====================================================================

async function run() {
  await cloudTests();
  modalTests();
  await sidebarTests();
  contrasteTests();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Visual UI shell tests passed (${passed} comprobaciones)`);
  console.log(`${'='.repeat(40)}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
