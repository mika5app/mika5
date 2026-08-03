'use strict';

// DOM mínimo para las pruebas del renderer.
//
// Por qué existe: las suites de UI necesitan ejecutar funciones del renderer
// (que crean nodos, leen clases y despachan eventos) sin abrir Electron y sin
// añadir dependencias al gate. Sólo implementa lo que las pruebas ejercitan.
//
// Vivía dentro de visual-ui-shell.test.js; se extrajo al añadir la suite de
// conversación para no mantener dos copias divergentes.

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

module.exports = { createDocument, matches, matchesSimple };
