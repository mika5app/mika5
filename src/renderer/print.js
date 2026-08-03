// src/renderer/print.js — Documento de impresión aislado.
//
// Dos fases, y el orden importa:
//
//   inspect(html)  sanea en memoria y devuelve las URLs remotas SIN tocar el
//                  documento. Nada se inserta, así que el navegador no pide
//                  nada a la red.
//   render({html, embeddedImages})  vuelve a sanear, sustituye cada URL remota
//                  por su data: URI y sólo entonces escribe en el DOM.
//
// Si se insertara primero y se sustituyera después, el navegador ya habría
// lanzado la petición: en este contenido las imágenes generadas llevan enlaces
// firmados y esa petición filtraría la firma.

(function printPage() {
  'use strict';

  const ALLOWED_TAGS = [
    'article', 'section', 'main', 'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table',
    'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'strong', 'em', 'del',
    'hr', 'br'
  ];
  const ALLOWED_ATTR = [
    'href', 'src', 'alt', 'title', 'class', 'target', 'rel', 'colspan', 'rowspan'
  ];
  const SANITIZE_CONFIG = {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [
      'script', 'iframe', 'object', 'embed', 'form', 'input', 'button',
      'textarea', 'select', 'option', 'svg', 'math', 'style'
    ],
    FORBID_ATTR: ['style', 'srcdoc', 'formaction'],
    ALLOW_UNKNOWN_PROTOCOLS: false
  };

  const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,/i;

  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href');
      try {
        const parsed = new URL(href || '', document.baseURI);
        if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) node.removeAttribute('href');
      } catch (_) {
        node.removeAttribute('href');
      }
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  // Un href http/https en un PDF es texto: no genera petición. Un src sí.
  // Por eso las imágenes se tratan aparte y sin excepciones de protocolo.
  function clasificarSrc(valor) {
    const src = String(valor || '');
    if (!src) return { tipo: 'vacio' };
    if (DATA_IMAGE.test(src)) return { tipo: 'data' };
    let parsed;
    try {
      parsed = new URL(src, document.baseURI);
    } catch (_) {
      return { tipo: 'invalido' };
    }
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return { tipo: 'remoto', url: parsed.href };
    }
    return { tipo: 'invalido' };
  }

  function sanear(html) {
    return DOMPurify.sanitize(String(html || ''), SANITIZE_CONFIG);
  }

  // Fragmento desconectado del documento: <img> dentro de un template no
  // dispara carga de recursos.
  function comoFragmento(sanitized) {
    const plantilla = document.createElement('template');
    plantilla.innerHTML = sanitized;
    return plantilla.content;
  }

  // FASE A. Sin efectos sobre el documento y sin red.
  function inspect(html) {
    try {
      const sanitized = sanear(html);
      const fragmento = comoFragmento(sanitized);
      const remotas = [];
      for (const img of fragmento.querySelectorAll('img')) {
        const clasificado = clasificarSrc(img.getAttribute('src'));
        if (clasificado.tipo === 'remoto' && !remotas.includes(clasificado.url)) {
          remotas.push(clasificado.url);
        }
      }
      return { ok: true, remoteImages: remotas };
    } catch (error) {
      return { ok: false, error: 'INSPECT_FAILED' };
    }
  }

  // FASE B. Sustituye antes de insertar. Si algo remoto sobrevive, falla.
  function render(payload) {
    const html = payload && payload.html;
    const embedded = (payload && payload.embeddedImages) || {};
    try {
      const sanitized = sanear(html);
      const fragmento = comoFragmento(sanitized);

      for (const img of fragmento.querySelectorAll('img')) {
        const clasificado = clasificarSrc(img.getAttribute('src'));
        if (clasificado.tipo === 'data') continue;
        if (clasificado.tipo === 'remoto') {
          const dataUri = Object.prototype.hasOwnProperty.call(embedded, clasificado.url)
            ? embedded[clasificado.url]
            : null;
          if (typeof dataUri !== 'string' || !DATA_IMAGE.test(dataUri)) {
            return { ok: false, error: 'REMOTE_IMAGE_UNRESOLVED' };
          }
          img.setAttribute('src', dataUri);
          continue;
        }
        // vacío, protocolo desconocido, blob:, file:, javascript:
        img.removeAttribute('src');
      }

      // Verificación final antes de insertar: ni un solo origen de red.
      for (const img of fragmento.querySelectorAll('img')) {
        const src = img.getAttribute('src');
        if (src && !DATA_IMAGE.test(src)) {
          return { ok: false, error: 'REMOTE_IMAGE_UNRESOLVED' };
        }
      }

      const raiz = document.getElementById('print-root');
      raiz.textContent = '';
      raiz.appendChild(fragmento);
      return { ok: true, images: raiz.querySelectorAll('img').length };
    } catch (error) {
      return { ok: false, error: 'RENDER_FAILED' };
    }
  }

  async function settle() {
    await document.fonts?.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { ok: true };
  }

  window.MIKA5Print = { inspect, render, settle };
}());
