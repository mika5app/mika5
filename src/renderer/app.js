let activeProjectId = null;
let activeChatId = null;
let isGenerating = false;
let activeRequestId = null;
let chatAttachments = [];
let replyToMessage = null; // { role, content, msgId } for WhatsApp-style reply
const chatDrafts = new Map(); // chatId -> { attachments: [], inputText: '', replyTo: null }
const AUTOMATIC_MODEL_ID = '__automatic__';
// Modos de plan visual que pueden producir una imagen. Es el dominio de los planes,
// distinto de los intents de routing que se validan en las barreras de send().
const GENERATIVE_VISUAL_MODES = ['image-generation', 'image-edit', 'image-variation'];
const visualContextMemory = {
  entries: [],
  lastUserImage: null,
  lastUploadedImage: null,
  lastGeneratedImage: null,
  lastAnalyzedImage: null,
  lastVisualAnalysis: null
};
let pendingVisualAction = null;
const {
  createRequestContext,
  shouldRenderRequestOutput,
  resolveRequestDestination
} = window.MIKA5RequestContext;
const {
  buildCloudDataScope,
  buildCloudConsentKey,
  consentCoversScope,
  mergeConsentScope,
  summarizeCloudScope,
  normalizeStoredConsent,
  projectScope: cloudProjectScope
} = window.MIKA5CloudConsent;

function currentRequestView() {
  return { chatId: activeChatId, projectId: activeProjectId, providerId: currentProvider };
}

function registerVisualEvent({ chatId, role, origin, images = [], sourceVisualEntryId = null }) {
  const createdAt = Date.now();
  const entry = {
    id: `visual-${createdAt}-${visualContextMemory.entries.length + 1}`,
    chatId,
    role,
    origin,
    createdAt,
    ...(images.length ? { images } : {}),
    ...(sourceVisualEntryId ? { sourceVisualEntryId } : {})
  };
  visualContextMemory.entries.push(entry);
  return entry;
}

function registerVisualImage({ chatId, role, origin, image, sourceVisualEntryId = null }) {
  const entry = registerVisualEvent({ chatId, role, origin, images: [image], sourceVisualEntryId });
  const imageRef = {
    ...image,
    id: image.id || `${entry.id}-image-1`,
    visualEntryId: entry.id,
    chatId,
    role,
    origin,
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt
  };
  entry.images = [imageRef];
  if (origin === 'user-upload') {
    visualContextMemory.lastUploadedImage = imageRef;
    visualContextMemory.lastUserImage = imageRef;
  } else if (origin === 'image-generation' || origin === 'image-edit' || origin === 'image-variation') {
    visualContextMemory.lastGeneratedImage = imageRef;
  }
  return imageRef;
}

// Origen de un adjunto restaurado según quién lo envió. Un adjunto del usuario
// vuelve a ser 'user-upload'; uno del asistente, una imagen generada.
function restoredAttachmentOrigin(role) {
  return role === 'assistant' ? 'image-generation' : 'user-upload';
}

/**
 * Reconstruye una imagen persistida dentro de la memoria visual.
 *
 * Conserva el `visualEntryId` original: acuñar uno nuevo rompería el vínculo con
 * las acciones visuales selladas contra esa identidad, y una acción pendiente
 * legítima se cancelaría por `source-visual-entry`.
 */
function restoreVisualImage({ chatId, role, attachment, createdAt }) {
  if (!attachment || (!attachment.base64 && !attachment.url)) return null;
  const origin = restoredAttachmentOrigin(role);
  const timestamp = Number(createdAt) || Date.now();
  const entryId = attachment.visualEntryId || `visual-restored-${timestamp}-${visualContextMemory.entries.length + 1}`;
  const imageRef = {
    name: attachment.name || 'imagen',
    type: 'image',
    mediaType: attachment.mediaType || null,
    base64: attachment.base64 || null,
    url: attachment.url || null,
    id: `${entryId}-image-1`,
    visualEntryId: entryId,
    chatId,
    role,
    origin,
    createdAt: timestamp,
    updatedAt: timestamp,
    restored: true
  };
  visualContextMemory.entries.push({
    id: entryId, chatId, role, origin, createdAt: timestamp, images: [imageRef]
  });
  if (origin === 'user-upload') {
    visualContextMemory.lastUploadedImage = imageRef;
    visualContextMemory.lastUserImage = imageRef;
  } else {
    visualContextMemory.lastGeneratedImage = imageRef;
  }
  return imageRef;
}

// Al salir de un chat su contexto visual deja de ser válido: una petición en el
// chat nuevo no puede operar sobre la imagen del anterior.
function resetVisualContextForChat() {
  visualContextMemory.entries.length = 0;
  visualContextMemory.lastUserImage = null;
  visualContextMemory.lastUploadedImage = null;
  visualContextMemory.lastGeneratedImage = null;
  visualContextMemory.lastAnalyzedImage = null;
  visualContextMemory.lastVisualAnalysis = null;
}

/**
 * Rehidrata el contexto visual al abrir un chat.
 *
 * Sin esto la persistencia era solo cosmética: tras reiniciar MIKA5 la miniatura
 * volvía a verse, pero "ahora ponlo verde" no encontraba ninguna imagen de
 * referencia y el router degradaba a chat normal.
 *
 * Se recorre en orden cronológico para que `lastUserImage` y
 * `lastGeneratedImage` queden apuntando a las MÁS RECIENTES, igual que en una
 * sesión viva.
 */
function rehydrateVisualContextFromMessages(messages, chatId) {
  resetVisualContextForChat(chatId);
  const ordered = (Array.isArray(messages) ? [...messages] : [])
    .sort((a, b) => (Number(a?.created_at) || 0) - (Number(b?.created_at) || 0));
  let restored = 0;
  for (const message of ordered) {
    for (const attachment of parseStoredAttachments(message?.attachments)) {
      if (restoreVisualImage({
        chatId,
        role: message.role,
        attachment,
        createdAt: message.created_at
      })) restored++;
    }
  }
  return restored;
}

function terminalImageAnswer(images) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('Alibaba no devolvió ninguna imagen');
  }
  return images.map(url => `![Imagen generada](${url})`).join('\n\n');
}

function sanitizeMessageForClipboard(content) {
  let sanitized = String(content || '');
  sanitized = sanitized.replace(
    /!\[([^\]]*)\]\(\s*(?:https:\/\/[^)\s]+|data:image\/(?:png|jpeg|jpg|webp|bmp);base64,[^)\s]+)\s*\)/gi,
    (_match, alt) => {
      const label = String(alt || '').trim();
      return label ? `[Imagen: ${label}]` : '[Imagen generada por MIKA5]';
    }
  );
  return sanitized.replace(/https:\/\/[^\s<>"')\]]+/gi, (url) => (
    /dashscope|aliyuncs\.com|OSSAccessKeyId=|Signature=|Expires=/i.test(url)
      ? '[URL de imagen firmada omitida]'
      : url
  ));
}

function sanitizeRemoteErrorMessage(message) {
  let sanitized = String(message || '');
  sanitized = sanitized
    .replace(/Error invoking remote method ['"]ai:(?:generate-image|chat)['"]:\s*(?:Error:\s*)?/gi, '')
    .replace(/TypeError:\s*fetch failed/gi, '')
    .replace(/\b(?:UND_ERR_CONNECT_TIMEOUT|ConnectTimeoutError|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\b/gi, '')
    .replace(/attempted addresses?:[\s\S]*/gi, '')
    .replace(/https:\/\/[^\s"'<>]+/gi, '[URL omitida]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[API_KEY]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[IP omitida]')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, '')
    .trim();
  return sanitized || 'No se pudo completar la solicitud con el proveedor actual.';
}

function registerLastVisualAnalysis({ chatId, sourceImageRef, analysisText }) {
  const controlledText = String(analysisText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  visualContextMemory.lastVisualAnalysis = {
    chatId,
    sourceImageRef,
    analysisText: controlledText,
    suggestions: [],
    updatedAt: Date.now()
  };
  return visualContextMemory.lastVisualAnalysis;
}
// ============================================
// Detectar si el modelo soporta visión
// ============================================
// Contrato de capacidades del proveedor activo. Se refresca desde el proceso
// principal; nunca se infiere aquí. Mientras no haya llegado, se asume el
// contrato vacío: bloquear de más es recuperable, enviar una imagen que el
// adapter descarta en silencio no lo es (AUD-006).
let providerCapabilities = null;

async function refreshProviderCapabilities() {
  try {
    providerCapabilities = await window.mika5?.ai?.getCapabilities?.() || null;
  } catch (_) {
    providerCapabilities = null;
  }
  return providerCapabilities;
}

function providerSupportsVision() {
  return providerCapabilities?.vision === true;
}

// Pista sincrónica para pintar la UI (habilitar el botón de adjuntar, etc.),
// derivada de `data-vision`, que la lista de modelos escribe a partir del
// `supportsVision` que devuelve el adapter. No hay heurística por nombre:
// "kimi", "glm" o "claude-3" ya no autorizan nada por sí solos.
// NO es una autorización: la decisión real la toma visionBlockReason().
function modelSupportsVision(modelName) {
  if (!modelName) return false;
  if (modelName === AUTOMATIC_MODEL_ID) return false;
  const sel = el("modelSelect");
  if (!sel) return false;
  const opt = Array.from(sel.options).find(o => o.value === modelName);
  return opt?.dataset.vision === '1';
}

/**
 * Motivo por el que no se puede adjuntar una imagen con el modelo actual,
 * o null si sí se puede.
 *
 * La resolución la hace el proceso principal con el MISMO código que la barrera
 * de los adapters (`ai:resolve-vision` → resolveVisionSupport). El renderer no
 * guarda allowlists ni políticas propias: si las guardara, acabarían divergiendo
 * y la UI autorizaría algo que la red rechaza (o al revés).
 *
 * Fail-closed: si el IPC falla, se bloquea.
 */
// El proveedor viaja SIEMPRE explícito. Si se dejara que el proceso principal
// use `this.currentProvider`, un cambio de proveedor mientras el IPC está en
// vuelo evaluaría el modelo de OpenAI contra las capacidades de otro proveedor.
async function visionBlockReason({ provider, model } = {}) {
  // Automático es un alias del router: su modelo real se resuelve en send().
  if (!model || model === AUTOMATIC_MODEL_ID) return null;
  try {
    const resolution = await window.mika5?.ai?.resolveVision?.({ provider, model });
    if (!resolution) return 'No se pudo verificar si el modelo acepta imágenes. La imagen no se adjunta.';
    return resolution.supported ? null : (resolution.message || 'Este modelo no acepta imágenes.');
  } catch (_) {
    return 'No se pudo verificar si el modelo acepta imágenes. La imagen no se adjunta.';
  }
}

// Identidad de una operación de adjuntado, capturada ANTES de cualquier await.
// Stage 0A ya fijó que una operación asíncrona conserva la identidad con la que
// empezó; adjuntar una imagen no es excepción.
function captureAttachmentContext() {
  return {
    chatId: activeChatId,
    providerId: currentProvider,
    model: el("modelSelect")?.value || ''
  };
}

function attachmentContextChanged(context) {
  return activeChatId !== context.chatId
    || currentProvider !== context.providerId
    || (el("modelSelect")?.value || '') !== context.model;
}

// Imágenes que el usuario intentó adjuntar y fueron rechazadas por capacidad.
// Rechazar el adjunto no basta: si el texto sobrevive ("analiza esto") y se
// permite enviar, el modelo contesta sin haber visto nada y la respuesta se lee
// como si sí la hubiera visto. Eso es la misma omisión engañosa de AUD-006,
// una pantalla más tarde. Por eso el envío se bloquea hasta resolverlo.
let rejectedImageAttachments = [];
let rejectedImageSeq = 0;

// Identidad por CONTENIDO. Dos archivos distintos pueden llamarse `producto.png`
// y todas las imágenes pegadas comparten nombre genérico, así que el nombre no
// sirve. Y tiene que ser estable entre intentos: una huella aleatoria por
// operación haría que volver a pegar la misma imagen nunca resolviera el rechazo
// anterior, dejándolo bloqueando hasta pulsar ✕.
// El hash unifica además ambos orígenes: el mismo contenido pegado o elegido
// desde el disco es la misma intención.
// Falla en cerrado si no hay WebCrypto: sin hash no hay identidad fiable, y una
// huella ambigua es peor que ninguna — dos imágenes distintas podrían colisionar
// y resolver el rechazo equivocado, que es el mismo fallo que esto previene.
// Electron sirve el renderer desde un contexto seguro, así que este camino no
// debería darse nunca en producción.
async function imageContentFingerprint(file) {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('WEBCRYPTO_UNAVAILABLE');
  }
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

// Una intención de adjuntar rechazada sobrevive al cambio de modelo. Borrarla
// automáticamente reabría AUD-006 un paso más tarde: el registro desaparecía,
// la imagen nunca llegó a `chatAttachments`, el texto seguía ahí y "analiza
// esto" salía sin imagen. Solo dos acciones EXPLÍCITAS la resuelven:
// volver a adjuntar el mismo archivo con éxito, o pulsar ✕.
function recordRejectedImage({ chatId, providerId, model, fingerprint, name, reason }) {
  const existing = rejectedImageAttachments.find(current =>
    current.chatId === chatId
    && current.providerId === providerId
    && current.model === model
    && current.fingerprint === fingerprint
  );
  if (existing) {
    existing.reason = reason;
    return existing;
  }
  const recorded = {
    id: `rej-${++rejectedImageSeq}`,
    chatId,
    providerId,
    model,
    fingerprint,
    name,
    reason
  };
  rejectedImageAttachments.push(recorded);
  return recorded;
}

// Getter puro: leer el estado no lo destruye. Una purga escondida aquí hacía
// imposible razonar sobre cuándo y por qué desapareció un rechazo.
function pendingRejectedImages(chatId) {
  return rejectedImageAttachments.filter(item => item.chatId === chatId);
}

// El rechazo se registró contra un par (proveedor, modelo) concreto. Las
// capacidades pertenecen al par, no al modelo suelto: dos proveedores pueden
// publicar el mismo modelId.
function rejectionMatchesCurrentTarget(item) {
  return item.providerId === currentProvider
    && item.model === (el("modelSelect")?.value || '');
}

function rejectionNotice(item) {
  return rejectionMatchesCurrentTarget(item)
    ? item.reason
    : `Cambió el modelo. Vuelve a adjuntar ${item.name} para analizarla, o descártala para enviar solo texto.`;
}

function clearRejectedImages(chatId = null) {
  rejectedImageAttachments = chatId === null
    ? []
    : rejectedImageAttachments.filter(item => item.chatId !== chatId);
}

// Resolución explícita nº1: la misma imagen se adjuntó con éxito.
function resolveRejectedImage(chatId, fingerprint) {
  const before = rejectedImageAttachments.length;
  rejectedImageAttachments = rejectedImageAttachments.filter(
    item => !(item.chatId === chatId && item.fingerprint === fingerprint)
  );
  return rejectedImageAttachments.length !== before;
}

// Resolución explícita nº2: la usuaria descarta la intención. Por id, porque
// nombre y hasta fingerprint pueden repetirse entre operaciones distintas.
function discardRejectedImage(id) {
  const index = rejectedImageAttachments.findIndex(item => item.id === id);
  if (index >= 0) rejectedImageAttachments.splice(index, 1);
  renderAttachmentPreview();
  updateSendButtonState();
}

// Punto único al que llaman TODOS los caminos de selección de modelo. El
// <select> se fija por código, así que 'change' no se dispara nunca y un
// listener sobre él no serviría de nada. NO borra rechazos: solo repinta, para
// que el aviso pase a "vuelve a adjuntar" cuando el modelo nuevo sí acepta.
function onSelectedModelChanged() {
  renderAttachmentPreview();
  updateSendButtonState();
  iniciarMotorConModeloElegido();
}

// En un motor gestionable, elegir un modelo es lo que lo pone en marcha: el
// proceso principal arranca el motor con ese modelo, o lo cambia si ya tenía
// otro. Con un servidor que lanzó el usuario no hay nada que cambiar y el
// proceso principal lo rechaza; aquí no es un error que enseñar.
async function iniciarMotorConModeloElegido() {
  const motor = providerReadiness && providerReadiness.engine;
  const modelo = el('modelSelect') ? el('modelSelect').value : '';
  if (!motor || !motor.managed || !modelo || typeof window.mika5.ai.selectEngineModel !== 'function') return;
  try {
    await window.mika5.ai.selectEngineModel(currentProvider, modelo);
  } catch (_) {
    return;
  }
  await loadRuntime();
}

/**
 * Camino ÚNICO por el que una imagen entra al chat. Lo usan el selector de
 * archivos y el pegado desde el portapapeles; no debe existir ningún otro.
 * Tener dos copias del flujo era lo que permitía que un punto de entrada
 * olvidara resolver el rechazo pendiente sin que ningún test lo notara.
 *
 * Devuelve:
 *   { ok: true, attachment }              adjuntada, rechazo previo resuelto
 *   { ok: false, code: 'unsupported-type' | 'blocked' | 'aborted' | 'error' }
 */
async function processImageAttachment({
  file, source = 'file', displayName, chatId, providerId, model
}) {
  const mediaType = supportedVisionMediaType(file);
  if (!mediaType) return { ok: false, code: 'unsupported-type' };
  const name = displayName || file.name || (source === 'paste' ? 'imagen pegada' : 'imagen');

  // El contrato promete un resultado, no una excepción: `file.arrayBuffer()`,
  // `crypto.subtle.digest()`, `docFileToBase64()` y `registerVisualImage()`
  // pueden lanzar, y una promesa rechazada dejaría a los wrappers sin saber qué
  // decirle a la usuaria.
  try {
    const context = { chatId, providerId, model };
    // Huella y capacidad se resuelven en paralelo: ambas son awaits y ninguna
    // depende de la otra.
    const [fingerprint, blocked] = await Promise.all([
      imageContentFingerprint(file),
      visionBlockReason({ provider: providerId, model })
    ]);
    // Reverificación tras los awaits: la usuaria pudo cambiar de chat, proveedor
    // o modelo mientras la sonda o el IPC estaban en vuelo.
    if (attachmentContextChanged(context)) return { ok: false, code: 'aborted' };

    if (blocked) {
      const recorded = recordRejectedImage({
        chatId, providerId, model, fingerprint, name, reason: blocked
      });
      return { ok: false, code: 'blocked', reason: blocked, rejected: recorded };
    }

    const base64 = await docFileToBase64(file);
    if (attachmentContextChanged(context)) return { ok: false, code: 'aborted' };

    const attachment = registerVisualImage({
      chatId,
      role: 'user',
      origin: 'user-upload',
      image: { name, type: 'image', base64, mediaType }
    });
    chatAttachments.push(attachment);
    // Resolución explícita nº1, en el camino productivo: adjuntar con éxito la
    // misma imagen satisface la intención que quedó pendiente.
    resolveRejectedImage(chatId, fingerprint);
    return { ok: true, attachment, fingerprint };
  } catch (error) {
    // Solo el tipo de error: nunca bytes, base64 ni contenido de la imagen.
    console.warn('Image attachment processing failed:', error?.message === 'WEBCRYPTO_UNAVAILABLE'
      ? 'WEBCRYPTO_UNAVAILABLE'
      : (error?.name || 'Error'));
    return { ok: false, code: 'error' };
  }
}

(function addImageStyles() {
  const style = document.createElement('style');
  style.textContent = '.embedded-image{margin:12px 0;border-radius:8px;overflow:hidden;border:1px solid var(--border-subtle,#14213F);display:inline-block;max-width:100%}.embedded-image img{max-width:100%;max-height:400px;object-fit:contain;cursor:zoom-in;transition:transform .2s}.embedded-image img:hover{transform:scale(1.02)}.msg.user .embedded-image{border-color:var(--accent,#49C2F4)}.image-modal{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.9);display:flex;align-items:center;justify-content:center;cursor:zoom-out}.image-modal img{max-width:90vw;max-height:90vh;object-fit:contain;border-radius:8px}.embedded-image-preview{max-width:120px;max-height:120px;border-radius:6px;margin:4px;border:1px solid var(--border-subtle,#14213F);display:inline-block;object-fit:contain;background:var(--bg-card,#070C1A);padding:2px;cursor:zoom-in;transition:transform .15s}.embedded-image-preview:hover{transform:scale(1.05);border-color:var(--accent,#49C2F4)}.msg.user .embedded-image-preview{border-color:var(--accent,#49C2F4)}';
  document.head.appendChild(style);
  const attachmentStyle = document.createElement('style');
  attachmentStyle.textContent = '.msg-unsaved{margin-top:6px;font-size:11px;color:var(--danger,#e5534b);border:1px dashed var(--danger,#e5534b);border-radius:4px;padding:3px 8px;display:inline-flex;align-items:center;gap:8px}.msg-unsaved-ok{color:var(--ok,#3fb950);border-color:var(--ok,#3fb950)}.msg-unsaved-retry{font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}.msg-unsaved-retry:disabled{opacity:.6;cursor:wait}.msg-attachments{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.msg-attachment{display:flex;flex-direction:column;align-items:center;gap:2px;max-width:132px}.msg-attachment-name{font-size:10px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:128px}';
  document.head.appendChild(attachmentStyle);
  const imageUxStyle = document.createElement('style');
  imageUxStyle.textContent = '.image-viewer-frame{display:inline-flex;flex-direction:column;background:var(--bg-card,#070C1A)}.image-controls{display:flex;gap:8px;align-items:center;padding:8px;background:rgba(0,0,0,.2)}.image-action-btn{border:1px solid var(--border-subtle,#14213F);border-radius:6px;background:var(--bg-hover,#0D1630);color:var(--text-main,#fff);padding:5px 10px;cursor:pointer;font-size:12px}.image-action-btn:hover:not(:disabled){border-color:var(--accent,#49C2F4)}.image-action-btn:disabled{opacity:.6;cursor:wait}.image-modal{padding:24px;cursor:default}.image-modal-panel{position:relative;display:flex;flex-direction:column;align-items:center;gap:12px;max-width:95vw;max-height:95vh}.image-modal-panel>img{max-width:95vw;max-height:85vh}.image-modal-close{position:absolute;top:-16px;right:-16px;width:36px;height:36px;border:0;border-radius:50%;background:#fff;color:#111;font-size:24px;line-height:1;cursor:pointer}.image-modal-actions{display:flex;justify-content:center}';
  document.head.appendChild(imageUxStyle);
})();

function closeImageViewer() {
  document.getElementById('imageModal')?.remove();
}

function suggestedImageDownloadName({ model = '', name = '' } = {}) {
  const timestamp = new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const safeModel = String(model || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  if (safeModel) return `mika5-${safeModel}-${timestamp}.png`;
  const safeName = String(name || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  return safeName || `imagen-mika5-${timestamp}.png`;
}

async function downloadImageFromSrc(src, name, button = null) {
  if (!window.mika5?.files?.downloadImage) {
    showToast('La descarga de imágenes no está disponible', 'error');
    return;
  }
  if (button) button.disabled = true;
  try {
    const result = await window.mika5.files.downloadImage({ src, suggestedName: name });
    if (result?.ok) {
      showToast('Imagen guardada correctamente', 'success');
    } else if (!result?.canceled) {
      showToast(result?.error || 'No se pudo guardar la imagen', 'error');
    }
  } catch (_) {
    showToast('No se pudo guardar la imagen', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function openImageViewer(src, name) {
  closeImageViewer();
  const modal = document.createElement('div');
  modal.id = 'imageModal';
  modal.className = 'image-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Visor de imagen');
  modal.addEventListener('click', event => {
    if (event.target === modal) closeImageViewer();
  });

  const panel = document.createElement('div');
  panel.className = 'image-modal-panel';
  panel.addEventListener('click', event => event.stopPropagation());

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'image-modal-close';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Cerrar visor');
  closeButton.addEventListener('click', closeImageViewer);

  const img = document.createElement('img');
  img.src = src;
  img.alt = name || 'Imagen';

  const modalActions = document.createElement('div');
  modalActions.className = 'image-modal-actions';
  const downloadButton = document.createElement('button');
  downloadButton.type = 'button';
  downloadButton.className = 'image-action-btn';
  downloadButton.textContent = 'Descargar';
  downloadButton.addEventListener('click', () => downloadImageFromSrc(src, name, downloadButton));
  modalActions.appendChild(downloadButton);
  const externalHref = safeExternalHref(src);
  if (externalHref?.startsWith('https:')) {
    const browserButton = document.createElement('button');
    browserButton.type = 'button';
    browserButton.className = 'image-action-btn';
    browserButton.textContent = 'Abrir en navegador';
    browserButton.addEventListener('click', () => window.mika5.openExternal(externalHref));
    modalActions.appendChild(browserButton);
  }

  panel.append(closeButton, img, modalActions);
  modal.appendChild(panel);
  document.body.appendChild(modal);
  closeButton.focus();
}

function enhanceMessageImages(container, messageContext = {}) {
  if (!container) return;
  for (const img of container.querySelectorAll('img')) {
    if (img.dataset.imageEnhanced === 'true') continue;
    img.dataset.imageEnhanced = 'true';
    img.dataset.zoomable = 'true';
    img.loading = 'lazy';

    const suggestedName = suggestedImageDownloadName({
      model: messageContext.model,
      name: img.alt
    });
    img.dataset.downloadName = suggestedName;

    const frame = document.createElement('span');
    frame.className = 'embedded-image image-viewer-frame';
    img.parentNode.insertBefore(frame, img);
    frame.appendChild(img);

    const controls = document.createElement('span');
    controls.className = 'image-controls';

    const viewButton = document.createElement('button');
    viewButton.type = 'button';
    viewButton.className = 'image-action-btn';
    viewButton.textContent = 'Ver grande';
    viewButton.addEventListener('click', () => openImageViewer(img.currentSrc || img.src, suggestedName));

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = 'image-action-btn';
    downloadButton.textContent = 'Descargar';
    downloadButton.addEventListener('click', () => {
      downloadImageFromSrc(img.currentSrc || img.src, suggestedName, downloadButton);
    });

    controls.append(viewButton, downloadButton);
    frame.appendChild(controls);
  }
}

// Event delegation: click on zoomable images opens modal
document.addEventListener('click', (e) => {
  const img = e.target.closest('img[data-zoomable]');
  if (!img) return;
  e.preventDefault();
  e.stopPropagation();
  openImageViewer(img.currentSrc || img.src, img.dataset.downloadName || img.alt);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeImageViewer();
});

let conversationHistory = []; // Historial completo

// ============================================
// Anti-freeze navigation state
// ============================================
let isSwitchingView = false;
let abortController = null;
let pendingTimeouts = [];
let pendingRafs = [];

function cancelPendingOperations() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  pendingTimeouts.forEach(clearTimeout);
  pendingRafs.forEach(cancelAnimationFrame);
  pendingTimeouts = [];
  pendingRafs = [];
}


function withTimeout(promise, ms, label, signal) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      const err = new Error(`Timeout: ${label || 'operación'} (${ms}ms)`);
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
  });

  const aborted = new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });

  return Promise.race([promise, timeout, aborted]).finally(() => clearTimeout(t));
}

async function safeViewChange(operation) {
  if (isSwitchingView) {
    console.warn('[safeViewChange] Already switching, skipped');
    return;
  }
  isSwitchingView = true;

  // limpia estado visual + cancela operaciones pendientes
  resetViewState();

  // nuevo controller para esta navegación
  const controller = new AbortController();
  abortController = controller;

  try {
    setUiBusy(true);
    return await operation(controller.signal);
  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.error('error durante safeViewChange', err);
      showToast('Error inesperado', 'error');
    }
    // Don't re-throw — callers should not crash if a view change fails
  } finally {
    if (abortController === controller) abortController = null;
    setUiBusy(false);
    isSwitchingView = false;
  }
}

// AI provider state
let currentProvider = 'local';
// Catálogo oficial del proveedor elegido. Lo da el proceso principal.
let providerLibraryUrl = null;
let providerPrivacy = 'private'; // 'private' | 'cloud'

function formatBytesRenderer(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

const el = (id) => document.getElementById(id);

let _uiBusyTimer = null;
function setUiBusy(busy) {
  document.body.classList.toggle('ui-busy', !!busy);

  const ids = ['projectList', 'chatList'];
  for (const id of ids) {
    const node = el(id);
    if (node) node.style.pointerEvents = busy ? 'none' : '';
  }

  // Safety: auto-unlock after 10s to prevent permanent freeze
  if (_uiBusyTimer) { clearTimeout(_uiBusyTimer); _uiBusyTimer = null; }
  if (busy) {
    _uiBusyTimer = setTimeout(() => {
      console.warn('[setUiBusy] Auto-unlock after 10s timeout');
      setUiBusy(false);
      isSwitchingView = false;
    }, 10000);
  }
}

function resetViewState() {
  // Cancela cualquier trabajo pendiente / in-flight
  cancelPendingOperations();
  // Save draft before clearing attachments
  if (activeChatId) {
    const inputEl = el("input");
    const inputText = inputEl ? inputEl.value : '';
    if (chatAttachments.length > 0 || inputText.trim() || replyToMessage) {
      chatDrafts.set(activeChatId, {
        attachments: [...chatAttachments],
        inputText,
        replyTo: replyToMessage ? { ...replyToMessage } : null
      });
    }
  }

  // Limpia adjuntos del chat actual
  chatAttachments = [];

  // Una acción visual pendiente pertenece al chat y proyecto donde se creó: cambiar de
  // vista la invalida. resetViewState es el punto central de openChat y selectProject.
  pendingVisualAction = null;

  // Cierra pickers flotantes si existen
  try {
    document.querySelectorAll('.project-style-picker').forEach((p) => p.remove());
  } catch (_) {}

  // Resetea scroll del chat para evitar "saltos" al cambiar vista
  const chatEl = el('chat');
  if (chatEl) chatEl.scrollTop = 0;
}

// ============================================
// Modal replacements for prompt/confirm
// (Electron blocks window.prompt and confirm)
// ============================================
let _mikaPromptResolve = null;
let _mikaConfirmResolve = null;
let _mikaSelectResolve = null;

function mikaPrompt(title, message, defaultValue) {
  return new Promise((resolve) => {
    _mikaPromptResolve = resolve;
    const modal = el('mikaPromptModal');
    const titleEl = el('mikaPromptTitle');
    const msgEl = el('mikaPromptMessage');
    const input = el('mikaPromptInput');
    if (titleEl) titleEl.textContent = title || 'Ingresa un valor';
    if (msgEl) msgEl.textContent = message || '';
    if (input) { input.value = defaultValue || ''; }
    if (modal) modal.style.display = 'flex';
    if (input) setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}
function mikaPromptOk() {
  const input = el('mikaPromptInput');
  const val = input ? input.value : '';
  el('mikaPromptModal').style.display = 'none';
  if (_mikaPromptResolve) { _mikaPromptResolve(val); _mikaPromptResolve = null; }
}
function mikaPromptCancel() {
  el('mikaPromptModal').style.display = 'none';
  if (_mikaPromptResolve) { _mikaPromptResolve(null); _mikaPromptResolve = null; }
}

function mikaConfirm(title, message, okLabel) {
  return new Promise((resolve) => {
    _mikaConfirmResolve = resolve;
    const modal = el('mikaConfirmModal');
    const titleEl = el('mikaConfirmTitle');
    const msgEl = el('mikaConfirmMessage');
    const okBtn = el('mikaConfirmOkBtn');
    if (titleEl) titleEl.textContent = title || 'Confirmar';
    if (msgEl) msgEl.textContent = message || '¿Estás seguro?';
    if (okBtn) okBtn.textContent = okLabel || t('action.accept') || 'Aceptar';
    if (modal) modal.style.display = 'flex';
  });
}
function mikaConfirmOk() {
  el('mikaConfirmModal').style.display = 'none';
  if (_mikaConfirmResolve) { _mikaConfirmResolve(true); _mikaConfirmResolve = null; }
}
function mikaConfirmCancel() {
  el('mikaConfirmModal').style.display = 'none';
  if (_mikaConfirmResolve) { _mikaConfirmResolve(false); _mikaConfirmResolve = null; }
}

function mikaSelect(title, options) {
  // options: [{label, value, icon?, color?}]
  return new Promise((resolve) => {
    _mikaSelectResolve = resolve;

    // Always create a fresh modal to avoid stale DOM issues
    const existing = document.getElementById('mikaSelectModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'mikaSelectModal';
    modal.className = 'modal';
    modal.style.cssText = 'display:flex;position:fixed;inset:0;z-index:9000;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';

    const box = document.createElement('div');
    box.className = 'modal-content';
    box.style.cssText = 'background:var(--bg-sidebar,#000208);border:1px solid var(--border-subtle,#14213F);border-radius:14px;padding:0;min-width:320px;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5);animation:modalFadeIn 0.15s ease-out;overflow:hidden;';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border-subtle,#14213F);';
    const titleEl = document.createElement('h3');
    titleEl.style.cssText = 'margin:0;font-size:15px;font-weight:600;color:var(--text-main,#eef3ff);';
    titleEl.textContent = title || 'Seleccionar';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.style.cssText = 'background:transparent;border:none;color:var(--text-muted,#a9b4d0);font-size:18px;cursor:pointer;padding:4px 8px;border-radius:6px;line-height:1;';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => { modal.remove(); if (_mikaSelectResolve) { _mikaSelectResolve(null); _mikaSelectResolve = null; } };
    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    // Options container
    const container = document.createElement('div');
    container.style.cssText = 'padding:8px;max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;';

    if (!options || options.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:20px;text-align:center;color:var(--text-muted,#a9b4d0);font-size:13px;';
      empty.textContent = 'No hay opciones disponibles';
      container.appendChild(empty);
    } else {
      options.forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;background:var(--bg-base,#04070F);border:1px solid var(--border-subtle,#14213F);color:var(--text-main,#eef3ff);padding:12px 14px;border-radius:8px;cursor:pointer;font-size:14px;text-align:left;transition:all 0.15s;';

        // Icon/color indicator
        if (opt.icon || opt.color) {
          // Misma píldora que el sidebar, por clase: sin cssText duplicado.
          btn.appendChild(applyProjectVisual(document.createElement('span'), {
            icon: opt.icon || '📁',
            color: opt.color || '#3b82f6'
          }));
        }

        const labelSpan = document.createElement('span');
        labelSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        labelSpan.textContent = opt.label;
        btn.appendChild(labelSpan);

        btn.onmouseenter = () => { btn.style.background = 'var(--bg-hover,#0D1630)'; btn.style.borderColor = 'var(--accent,#2d8cff)'; };
        btn.onmouseleave = () => { btn.style.background = 'var(--bg-base,#04070F)'; btn.style.borderColor = 'var(--border-subtle,#14213F)'; };
        btn.onclick = () => {
          modal.remove();
          if (_mikaSelectResolve) { _mikaSelectResolve(opt.value); _mikaSelectResolve = null; }
        };
        container.appendChild(btn);
      });
    }

    // Cancel button
    const footer = document.createElement('div');
    footer.style.cssText = 'padding:8px 8px 12px;border-top:1px solid var(--border-subtle,#14213F);';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.style.cssText = 'width:100%;background:transparent;border:1px solid var(--border-subtle,#14213F);color:var(--text-muted,#a9b4d0);padding:10px;border-radius:8px;cursor:pointer;font-size:13px;transition:all 0.15s;';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.onmouseenter = () => { cancelBtn.style.color = 'var(--text-main,#eef3ff)'; cancelBtn.style.borderColor = 'var(--text-muted,#a9b4d0)'; };
    cancelBtn.onmouseleave = () => { cancelBtn.style.color = 'var(--text-muted,#a9b4d0)'; cancelBtn.style.borderColor = 'var(--border-subtle,#14213F)'; };
    cancelBtn.onclick = () => { modal.remove(); if (_mikaSelectResolve) { _mikaSelectResolve(null); _mikaSelectResolve = null; } };
    footer.appendChild(cancelBtn);

    box.appendChild(header);
    box.appendChild(container);
    box.appendChild(footer);
    modal.appendChild(box);

    // Click backdrop to cancel
    modal.addEventListener('click', (e) => {
      if (e.target === modal) { modal.remove(); if (_mikaSelectResolve) { _mikaSelectResolve(null); _mikaSelectResolve = null; } }
    });

    document.body.appendChild(modal);
  });
}
function mikaSelectCancel() {
  const modal = document.getElementById('mikaSelectModal');
  if (modal) modal.remove();
  if (_mikaSelectResolve) { _mikaSelectResolve(null); _mikaSelectResolve = null; }
}

// Handle Enter key in prompt modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && el('mikaPromptModal')?.style.display === 'flex') {
    e.preventDefault();
    mikaPromptOk();
  }
  if (e.key === 'Escape') {
    if (el('mikaPromptModal')?.style.display === 'flex') mikaPromptCancel();
    if (el('mikaConfirmModal')?.style.display === 'flex') mikaConfirmCancel();
    if (el('mikaSelectModal')) mikaSelectCancel();
    if (el('exportModal')?.style.display === 'flex') closeExportModal();
    if (el('apiKeyModal')?.style.display === 'flex') closeApiKeyModal();
    if (el('privacyInfoModal')?.style.display === 'flex') el('privacyInfoModal').style.display = 'none';
  }
});

function setBtnPullText(text) {
  const label = el("btnPullLabel");
  if (label) label.textContent = text;
  else if (el("btnPull")) el("btnPull").textContent = text;
}

function syncModelDropdown() {
  const select = el("modelSelect");
  const optionsContainer = el("modelOptions");
  const currentSpan = el("currentModel");
  const trigger = el("modelTrigger");
  if (!select || !optionsContainer || !currentSpan) return;
  const selectedVal = select.value;
  const options = Array.from(select.options);
  if (currentProvider === 'local') {
    providerPrivacy = options.find(option => option.value === selectedVal)?.dataset.source === 'cloud' ? 'cloud' : 'private';
    updatePrivacyUI();
  }
  optionsContainer.replaceChildren();
  options.forEach(opt => {
    const div = document.createElement("div");
    const source = opt.dataset.source || 'local';
    div.className = "model-option " + (source === 'local' ? 'local-model' : 'cloud-model') + (opt.value === selectedVal ? " selected" : "");
    div.dataset.value = opt.value;

    const info = document.createElement('div');
    info.className = 'model-info';
    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = opt.textContent;
    const meta = document.createElement('span');
    meta.className = 'model-meta';

    if (source === 'local') {
      const badge = document.createElement('span'); badge.className = 'badge local'; badge.textContent = '🔒 Local';
      const size = document.createElement('span'); size.className = 'size'; size.textContent = opt.dataset.sizeFormatted || '';
      const caps = document.createElement('span'); caps.className = 'caps'; caps.textContent = opt.dataset.caps || '';
      meta.appendChild(badge); meta.appendChild(size); meta.appendChild(caps);
    } else {
      const badge = document.createElement('span');
      badge.className = 'badge cloud';
      badge.textContent = opt.dataset.billingMode === 'token-plan' ? '☁️ Cloud / Token Plan' : '☁️ Cloud';
      const speed = document.createElement('span');
      speed.className = 'speed';
      speed.textContent = opt.dataset.providerName || opt.dataset.speed || 'Disponible';
      meta.appendChild(badge); meta.appendChild(speed);
    }

    info.appendChild(name); info.appendChild(meta);

    const status = document.createElement('span');
    status.className = 'status-indicator';
    if (source === 'local') {
      if (opt.dataset.size && Number(opt.dataset.size) > 0) {
        status.classList.add('downloaded');
        status.textContent = '✓ Descargado';
      } else {
        status.textContent = 'No descargado';
      }
    } else {
      status.textContent = opt.dataset.providerName || opt.dataset.speed || 'Disponible';
    }

    div.appendChild(info);
    div.appendChild(status);

    div.onclick = (e) => {
      e.stopPropagation();
      select.value = opt.value;
      currentSpan.textContent = opt.textContent;
      optionsContainer.classList.remove("open");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
      optionsContainer.querySelectorAll(".model-option").forEach(o => o.classList.toggle("selected", o.dataset.value === opt.value));
      // Persist selected model
      if (opt.value) {
        window.mika5.setAppState("lastModel", opt.value).catch(() => {});
      }
      onSelectedModelChanged();
    };
    optionsContainer.appendChild(div);
  });
  const selectedOpt = options.find(o => o.value === selectedVal);
  currentSpan.textContent = selectedOpt ? selectedOpt.textContent : (options[0] && options[0].value === "" ? options[0].textContent : "Selecciona modelo");
  if (select.disabled) currentSpan.textContent = "Ollama offline";
}

// === Storage Adapter (Fase 1) ===
const Store = {
  async listProjects() {
    return await window.mika5.db.listProjects();
  },
  async createProject(name) {
    return await window.mika5.db.createProject({ name, description: "" });
  },
  async updateProject(id, payload) {
    return await window.mika5.db.updateProject(id, payload);
  },
  async deleteProject(id) {
    return await window.mika5.db.deleteProject(id);
  },
  async listChats(projectId) {
    return await window.mika5.db.listChats(projectId);
  },
  async createChat(projectId, title) {
    return await window.mika5.db.createChat({ projectId, title });
  },
  async updateChat(chatId, payload) {
    return await window.mika5.db.updateChat(chatId, payload);
  },
  async listMessages(chatId, opts) {
    return await window.mika5.db.listMessages(chatId, opts);
  },
  async countMessages(chatId) {
    return await window.mika5.db.countMessages(chatId);
  },
  async addMessage(chatId, role, content, replyToId, model, attachments) {
    const hadAttachments = Array.isArray(attachments) && attachments.length > 0;
    const result = await window.mika5.db.addMessage({
      chatId, role, content,
      replyToId: replyToId || null,
      model: model || null,
      attachments: hadAttachments ? attachments : null
    });
    // El aviso NO vive aquí: lo dan persistUserTurn / persistAssistantTurn,
    // que son quienes conocen el turno. Duplicarlo daría dos toasts por fallo.
    if (result && result.ok === false) console.warn('addMessage rechazado:', result.error);
    return result;
  },
  async clearChat(chatId) {
    return await window.mika5.db.clearChat(chatId);
  },
  async deleteChat(chatId) {
    return await window.mika5.db.deleteChat(chatId);
  }
};

// -------------------------------
// guarda un documento en Knowledge
// -------------------------------
async function saveDocument({ projectId, title, content, mimeType = "text/markdown", chatId }) {
  if (!projectId) {
    console.warn("saveDocument: projectId requerido");
    return { ok: false, error: "NO_PROJECT" };
  }
  const payload = {
    projectId,
    title: title || "Documento",
    content: content || "",
    mimeType
  };
  if (chatId) payload.chatId = chatId;
  const resp = await window.mika5.db.addKnowledgeFromText(payload);
  return resp;
}

// ----------------------------------------------
// adjuntos: lectura y previsualización
// ----------------------------------------------
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "UTF-8");
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is "data:image/png;base64,xxxx" — extract just the base64 part
      const b64 = reader.result.split(',')[1] || reader.result;
      resolve(b64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function isImageFile(file) {
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(file.name);
}

function supportedVisionMediaType(file) {
  const type = String(file.type || '').toLowerCase();
  if (['image/png', 'image/jpeg', 'image/webp'].includes(type)) return type;
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' })[ext] || '';
}

// ----------------------------------------------
// Document extraction: DOCX, XLSX, PPTX, PDF, CSV, etc.
// These are Office Open XML formats (ZIP containing XML)
// ----------------------------------------------
const DOCUMENT_EXTS = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|csv|tsv|rtf|odt|ods|odp|html|htm)$/i;
const OOXML_EXTS = /\.(docx|xlsx|pptx|odt|ods|odp)$/i;
const LEGACY_BINARY_EXTS = /\.(doc|xls|ppt)$/i;
const TRUE_BINARY_EXTS = /\.(zip|rar|7z|tar|gz|exe|dll|so|bin|mp3|mp4|avi|mov|mkv|woff|woff2|ttf|eot|ico|db|sqlite)$/i;

function isDocumentFile(file) {
  return DOCUMENT_EXTS.test(file.name);
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Extract text from a ZIP-based Office file (docx, xlsx, pptx)
 * Uses the built-in DecompressionStream API or manual ZIP parsing
 */
async function docFileToBase64(file) {
  const buffer = await readFileAsArrayBuffer(file);
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function extractTextFromDocument(file) {
  const ext = (file.name.match(/\.(\w+)$/i) || [])[1]?.toLowerCase();

  // CSV/TSV — just read as text
  if (ext === 'csv' || ext === 'tsv') {
    return await readFileAsText(file);
  }

  // RTF — strip RTF commands, return plain text
  if (ext === 'rtf') {
    const raw = await readFileAsText(file);
    return extractTextFromRTF(raw);
  }

  // PDF — robust server-side extraction, vision OCR for scanned, fallback to manual parser
  if (ext === 'pdf') {
    // Leer una sola vez como ArrayBuffer y derivar base64 si es necesario
    const buffer = await readFileAsArrayBuffer(file);

    const tryOCR = async () => {
      const model = el("modelSelect")?.value;
      console.log('[PDF OCR] intentando con modelo:', model);
      const ocrText = await extractTextFromScannedPDF(buffer, model);
      if (ocrText && ocrText.trim()) return ocrText;
      throw new Error('PDF_NO_TEXT');
    };

    if (window.mika5?.extractPDF) {
      try {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        }
        const base64 = btoa(binary);
        const result = await window.mika5.extractPDF(base64);
        console.log('[PDF] extractPDF result:', result?.ok, result?.error, 'chars:', result?.text?.length);
        if (result?.ok && result.text?.trim()) return result.text;
        // PDF sin texto extraíble (posiblemente escaneado) — intentar OCR
        try {
          return await tryOCR();
        } catch (ocrErr) {
          if (ocrErr.message === 'PDF_SCANNED_NO_VISION' || ocrErr.message === 'PDF_LIB_UNAVAILABLE') throw ocrErr;
          throw new Error('PDF_NO_TEXT');
        }
      } catch (e) {
        console.log('[PDF] extractPDF catch:', e.message);
        if (e.message === 'PDF_NO_TEXT' || e.message === 'PDF_SCANNED_NO_VISION' || e.message === 'PDF_LIB_UNAVAILABLE') throw e;
        // pdf-parse lanzó excepción — intentar OCR antes de rendirse
        try {
          return await tryOCR();
        } catch (ocrErr) {
          if (ocrErr.message === 'PDF_SCANNED_NO_VISION' || ocrErr.message === 'PDF_LIB_UNAVAILABLE') throw ocrErr;
        }
      }
    }
    const manualText = await extractTextFromPDF(buffer);
    console.log('[PDF] manual parser chars:', manualText?.length);
    if (!manualText?.trim()) {
      try { return await tryOCR(); } catch (ocrErr) {
        if (ocrErr.message === 'PDF_SCANNED_NO_VISION' || ocrErr.message === 'PDF_LIB_UNAVAILABLE') throw ocrErr;
        throw new Error('PDF_NO_TEXT');
      }
    }
    return manualText;
  }

  // Word (.doc, .docx) — server-side extraction via mammoth
  if (ext === 'doc' || ext === 'docx') {
    if (window.mika5?.extractWord) {
      try {
        const base64 = await docFileToBase64(file);
        const result = await window.mika5.extractWord(base64);
        if (result?.ok && result.text) return result.text;
      } catch (_) {}
    }
    // Fallback for .docx only: regex-based XML extraction
    if (ext === 'docx') {
      const buffer = await readFileAsArrayBuffer(file);
      const entries = await unzipEntries(buffer);
      return extractTextFromDOCX(entries);
    }
    throw new Error('LEGACY_FORMAT');
  }

  // Excel (.xls, .xlsx) — server-side extraction via SheetJS
  if (ext === 'xls' || ext === 'xlsx') {
    if (window.mika5?.extractSpreadsheet) {
      try {
        const base64 = await docFileToBase64(file);
        const result = await window.mika5.extractSpreadsheet(base64);
        if (result?.ok && result.text) return result.text;
      } catch (_) {}
    }
    // Fallback for .xlsx only: regex-based XML extraction
    if (ext === 'xlsx') {
      const buffer = await readFileAsArrayBuffer(file);
      const entries = await unzipEntries(buffer);
      return extractTextFromXLSX(entries);
    }
    throw new Error('LEGACY_FORMAT');
  }

  // PowerPoint (.ppt, .pptx)
  if (ext === 'pptx') {
    const buffer = await readFileAsArrayBuffer(file);
    const entries = await unzipEntries(buffer);
    return extractTextFromPPTX(entries);
  }
  if (ext === 'ppt') {
    throw new Error('LEGACY_FORMAT');
  }

  // ODF formats (odt, ods, odp)
  if (OOXML_EXTS.test(file.name)) {
    const buffer = await readFileAsArrayBuffer(file);
    const entries = await unzipEntries(buffer);
    if (ext === 'odt' || ext === 'ods' || ext === 'odp') return extractTextFromODF(entries);
  }
  // HTML — read as text
  if (ext === 'html' || ext === 'htm') {
    return await readFileAsText(file);
  }

  throw new Error('UNSUPPORTED_FORMAT');
}

/**
 * Minimal ZIP parser — extracts file entries from a ZIP ArrayBuffer
 * Supports DEFLATE and STORE compression (covers 99% of Office files)
 */
async function unzipEntries(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const entries = {};

  // Find End of Central Directory record (scan from end)
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file');

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdEntries = view.getUint16(eocdOffset + 10, true);

  let pos = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (pos + 46 > bytes.length) break;
    if (view.getUint32(pos, true) !== 0x02014b50) break;

    const compression = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const nameBytes = bytes.slice(pos + 46, pos + 46 + nameLen);
    const fileName = new TextDecoder().decode(nameBytes);

    // Read data from local file header
    if (localHeaderOffset + 30 <= bytes.length) {
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const rawData = bytes.slice(dataStart, dataStart + compressedSize);

      if (compression === 0) {
        // STORE — no compression
        entries[fileName] = rawData;
      } else if (compression === 8) {
        // DEFLATE — use DecompressionStream if available, else raw inflate
        try {
          entries[fileName] = await inflateData(rawData);
        } catch (e) {
          // Skip entries that fail to decompress
          console.warn(`Failed to decompress: ${fileName}`, e.message);
        }
      }
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Inflate DEFLATE-compressed data using DecompressionStream API
 */
async function inflateData(compressedBytes) {
  if (typeof DecompressionStream === 'undefined') {
    if (typeof pako !== 'undefined') return pako.inflateRaw(compressedBytes);
    throw new Error('No decompression available');
  }

  // Try deflate-raw first, then deflate (zlib), then gzip
  const formats = ['deflate-raw', 'deflate', 'gzip'];
  for (const fmt of formats) {
    try {
      const ds = new DecompressionStream(fmt);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();

      // Write and close in background, catch errors
      const writePromise = writer.write(compressedBytes).then(() => writer.close()).catch(() => {});

      const chunks = [];
      let done = false;
      while (!done) {
        const result = await reader.read();
        if (result.value) chunks.push(result.value);
        done = result.done;
      }
      await writePromise;

      const total = chunks.reduce((s, c) => s + c.length, 0);
      if (total === 0) continue; // empty result, try next format
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
      return out;
    } catch (_) {
      continue; // try next format
    }
  }

  // All formats failed — try pako as last resort
  if (typeof pako !== 'undefined') return pako.inflateRaw(compressedBytes);
  throw new Error('Decompression failed for all formats');
}

/**
 * Extract text from DOCX (word/document.xml)
 */
function extractTextFromDOCX(entries) {
  const docXml = entries['word/document.xml'];
  if (!docXml) throw new Error('No document.xml found in DOCX');

  const xmlStr = new TextDecoder().decode(docXml);
  const paragraphs = [];

  // Parse <w:p> paragraphs containing <w:t> text nodes
  const pRegex = /<w:p[\s>][^]*?<\/w:p>/g;
  const tRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  let pMatch;

  while ((pMatch = pRegex.exec(xmlStr)) !== null) {
    const pXml = pMatch[0];
    let paraText = '';
    let tMatch;
    tRegex.lastIndex = 0;
    while ((tMatch = tRegex.exec(pXml)) !== null) {
      paraText += tMatch[1];
    }
    // Also check for tabs and breaks
    if (/<w:tab\s*\/?>/.test(pXml)) paraText = paraText.replace(/\t/g, '\t') || paraText;
    if (paraText || /<w:br\s*\/?>/.test(pXml)) {
      paragraphs.push(paraText);
    }
  }

  // Also try to extract from headers/footers
  for (const [name, data] of Object.entries(entries)) {
    if (/^word\/(header|footer)\d*\.xml$/.test(name)) {
      const hfXml = new TextDecoder().decode(data);
      let hfText = '';
      tRegex.lastIndex = 0;
      let m;
      while ((m = tRegex.exec(hfXml)) !== null) {
        hfText += m[1];
      }
      if (hfText.trim()) paragraphs.unshift(`[${name.includes('header') ? 'Encabezado' : 'Pie'}] ${hfText.trim()}`);
    }
  }

  const text = paragraphs.join('\n');
  if (!text.trim()) throw new Error('No text content found in DOCX');
  return text;
}

/**
 * Extract text from XLSX (xl/sharedStrings.xml + xl/worksheets/sheet*.xml)
 */
function extractTextFromXLSX(entries) {
  // 1. Parse shared strings
  const sharedStrings = [];
  const ssXml = entries['xl/sharedStrings.xml'];
  if (ssXml) {
    const ssStr = new TextDecoder().decode(ssXml);
    const siRegex = /<si[^>]*>([\s\S]*?)<\/si>/g;
    const tInnerRegex = /<t[^>]*>([^<]*)<\/t>/g;
    let siMatch;
    while ((siMatch = siRegex.exec(ssStr)) !== null) {
      let cellText = '';
      let tMatch;
      tInnerRegex.lastIndex = 0;
      while ((tMatch = tInnerRegex.exec(siMatch[1])) !== null) {
        cellText += tMatch[1];
      }
      sharedStrings.push(cellText);
    }
  }

  // 2. Parse each worksheet
  const sheets = [];
  const sheetNames = Object.keys(entries)
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort();

  for (const sheetName of sheetNames) {
    const sheetData = entries[sheetName];
    if (!sheetData) continue;
    const sheetStr = new TextDecoder().decode(sheetData);
    const rows = [];

    const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
    const cellRegex = /<c\s+[^>]*?(?:t="([^"]*)")?[^>]*>[\s\S]*?(?:<v>([^<]*)<\/v>)?[\s\S]*?<\/c>/g;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(sheetStr)) !== null) {
      const cells = [];
      let cellMatch;
      cellRegex.lastIndex = 0;
      while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
        const type = cellMatch[1]; // 's' = shared string, 'b' = boolean, else number
        const rawValue = cellMatch[2] || '';
        if (type === 's' && sharedStrings[parseInt(rawValue, 10)] !== undefined) {
          cells.push(sharedStrings[parseInt(rawValue, 10)]);
        } else {
          cells.push(rawValue);
        }
      }
      if (cells.some(c => c.trim())) {
        rows.push(cells.join('\t'));
      }
    }

    const sheetNum = sheetName.match(/sheet(\d+)/)?.[1] || '?';
    if (rows.length > 0) {
      sheets.push(`--- Hoja ${sheetNum} ---\n${rows.join('\n')}`);
    }
  }

  const text = sheets.join('\n\n');
  if (!text.trim()) throw new Error('No text content found in XLSX');
  return text;
}

/**
 * Extract text from PPTX (ppt/slides/slide*.xml)
 */
function extractTextFromPPTX(entries) {
  const slides = [];
  const slideNames = Object.keys(entries)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
      const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
      return na - nb;
    });

  const aTextRegex = /<a:t>([^<]*)<\/a:t>/g;

  for (const slideName of slideNames) {
    const slideData = entries[slideName];
    if (!slideData) continue;
    const slideStr = new TextDecoder().decode(slideData);
    const texts = [];
    let m;
    aTextRegex.lastIndex = 0;
    while ((m = aTextRegex.exec(slideStr)) !== null) {
      if (m[1].trim()) texts.push(m[1]);
    }
    const slideNum = slideName.match(/slide(\d+)/)?.[1] || '?';
    if (texts.length > 0) {
      slides.push(`--- Diapositiva ${slideNum} ---\n${texts.join('\n')}`);
    }
  }

  const text = slides.join('\n\n');
  if (!text.trim()) throw new Error('No text content found in PPTX');
  return text;
}

/**
 * Extract text from ODF formats (content.xml)
 */
function extractTextFromODF(entries) {
  const contentXml = entries['content.xml'];
  if (!contentXml) throw new Error('No content.xml found');

  const xmlStr = new TextDecoder().decode(contentXml);
  // Extract text between XML tags, stripping all markup
  const text = xmlStr
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) throw new Error('No text content found');
  return text;
}

/**
 * Extract text from RTF
 */
function extractTextFromRTF(rtfContent) {
  // Strip RTF control words and groups, keep text
  let text = rtfContent
    .replace(/\{\\[^{}]*\}/g, '')        // remove nested groups like {\fonttbl...}
    .replace(/\\[a-z]+\d*\s?/gi, '')     // remove control words
    .replace(/[{}]/g, '')                 // remove remaining braces
    .replace(/\\\'([0-9a-f]{2})/gi, function(_, hex) { return String.fromCharCode(parseInt(hex, 16)); })
    .replace(/\\./g, '')                  // remove remaining escapes
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) throw new Error('No text content found in RTF');
  return text;
}

/**
 * PDF text extraction (async) — uses DecompressionStream for FlateDecode
 * Handles compressed and uncompressed text-based PDFs
 */
async function extractTextFromPDF(buffer) {
  const bytes = new Uint8Array(buffer);
  const raw = new TextDecoder('latin1').decode(bytes);
  const textBlocks = [];

  // Helper: extract text operators from a decoded stream
  function extractTextOps(content) {
    const blocks = [];
    // Tj operator: (text) Tj
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let m;
    while ((m = tjRegex.exec(content)) !== null) {
      blocks.push(decodePDFString(m[1]));
    }
    // TJ operator: [(text) num (text) ...] TJ
    const tjArrayRegex = /\[([^\]]*)\]\s*TJ/gi;
    while ((m = tjArrayRegex.exec(content)) !== null) {
      const parts = [];
      const innerRegex = /\(([^)]*)\)/g;
      let im;
      while ((im = innerRegex.exec(m[1])) !== null) {
        parts.push(decodePDFString(im[1]));
      }
      if (parts.length) blocks.push(parts.join(''));
    }
    return blocks;
  }

  // Find all stream...endstream sections
  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
  let sMatch;

  while ((sMatch = streamRegex.exec(raw)) !== null) {
    let streamContent = sMatch[1];

    // Check if the stream is FlateDecode compressed
    const prelude = raw.substring(Math.max(0, sMatch.index - 300), sMatch.index);
    if (/\/FlateDecode/.test(prelude)) {
      // Extract raw compressed bytes
      const streamStart = sMatch.index + sMatch[0].indexOf('\n') + 1;
      const streamEnd = sMatch.index + sMatch[0].length - 'endstream'.length;
      // Trim trailing whitespace/newlines from stream end
      let actualEnd = streamEnd;
      while (actualEnd > streamStart && (bytes[actualEnd - 1] === 0x0A || bytes[actualEnd - 1] === 0x0D || bytes[actualEnd - 1] === 0x20)) {
        actualEnd--;
      }
      const streamBytes = bytes.slice(streamStart, actualEnd);

      try {
        const inflated = await inflateData(streamBytes);
        streamContent = new TextDecoder('latin1').decode(inflated);
      } catch (_) {
        continue; // inflateData already tries all formats; skip this stream
      }
    }

    textBlocks.push(...extractTextOps(streamContent));
  }

  // Also try uncompressed BT...ET text blocks directly in raw PDF
  const btRegex = /BT\s([\s\S]*?)ET/g;
  let btMatch;
  while ((btMatch = btRegex.exec(raw)) !== null) {
    textBlocks.push(...extractTextOps(btMatch[1]));
  }

  const text = textBlocks.join(' ')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,;:!?])/g, '$1')
    .trim();

  if (!text) {
    throw new Error('PDF_NO_TEXT');
  }
  return text;
}

function decodePDFString(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

// ============================================
// OCR para PDFs escaneados via modelo de visión
// ============================================

async function waitForPdfjsLib() {
  if (window.pdfjsLib) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, 10000);
    const onReady = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('pdfjsReady', onReady); };
    window.addEventListener('pdfjsReady', onReady, { once: true });
  });
}

/**
 * Extrae texto de un PDF escaneado: renderiza cada página como imagen,
 * la envía al modelo de visión para OCR, y descarta la imagen antes de
 * la siguiente página (memoria O(1) en imágenes).
 * @param {ArrayBuffer} arrayBuffer - datos del PDF ya leídos
 * @param {string} model - nombre del modelo de visión a usar
 * @param {number} maxPages - máximo de páginas a procesar
 * @returns {Promise<string>} texto extraído
 */
async function extractTextFromScannedPDF(arrayBuffer, model, maxPages = 20) {
  if (!model || !modelSupportsVision(model)) {
    throw new Error('PDF_SCANNED_NO_VISION');
  }

  const providerId = currentProvider;
  const projectId = activeProjectId || QUICK_CHAT_ID;
  const chatId = activeChatId || 'pdf-ocr';
  await waitForPdfjsLib();
  if (!window.pdfjsLib) throw new Error('PDF_LIB_UNAVAILABLE');

  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  try {
    const totalPages = pdf.numPages;
    const pageCount = Math.min(totalPages, maxPages);

    if (pageCount === 0) throw new Error('PDF_NO_PAGES');
    const batchContext = createRequestContext({ chatId, projectId, providerId, selectedModel: model });
    const batchScope = buildCloudDataScope({ message: true, imageAttachments: true,
      imageNames: [`PDF escaneado (${pageCount} páginas)`] });
    if (!await ensureCloudConsent(batchContext, batchScope)) throw new Error('OCR cancelado por el usuario');
    const authorization = requestAuthorizations.get(batchContext.requestId);
    requestAuthorizations.delete(batchContext.requestId);

    showToast(`OCR: procesando ${pageCount} página${pageCount > 1 ? 's' : ''}…`, "info");

    const extractedTexts = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      // Liberar pixel buffer inmediatamente
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();

      try {
        const context = createRequestContext({ ...batchContext, requestId: `${batchContext.requestId}:${i}` });
        requestAuthorizations.set(context.requestId, { ...authorization, requestContext: context });
        const result = await sendAIChat({
          requestId: context.requestId, providerId, model,
          messages: [{
            role: 'user',
            content: `Extrae TODO el texto visible de esta imagen de documento escaneado. Devuelve SOLO el texto extraído, sin comentarios ni explicaciones. Si hay tablas, represéntalas en formato texto alineado. Página ${i} de ${totalPages}.`
          }],
          // El canvas produce JPEG: se declara el tipo para que cualquier adapter
          // (Ollama, OpenAI, Anthropic) pueda construir su bloque de imagen.
          images: [{ mediaType: 'image/jpeg', base64 }]
        });
        if (result?.message?.content) {
          extractedTexts.push(result.message.content.trim());
        }
      } catch (pageErr) {
        console.warn(`OCR error en página ${i}:`, pageErr);
      }
    }


    if (extractedTexts.length === 0) throw new Error('PDF_OCR_FAILED');

    showToast(`OCR completado: ${extractedTexts.length} de ${pageCount} páginas extraídas`, "success");
    return extractedTexts.join('\n\n--- Página ---\n\n');
  } finally { await pdf.destroy(); }
}

/**
 * Maneja errores de extracción de documentos con mensajes consistentes.
 */
function handleDocExtractionError(docErr, fileName) {
  const map = {
    LEGACY_FORMAT:         { msg: `${fileName}: formato antiguo. Guárdalo como .docx/.xlsx/.pptx`, level: 'warning' },
    PDF_SCANNED_NO_VISION: { msg: `${fileName}: PDF escaneado. Selecciona un modelo con visión (llava, gpt-4o, etc.) para OCR`, level: 'warning' },
    PDF_LIB_UNAVAILABLE:   { msg: `${fileName}: no se pudo cargar el motor PDF. Reinicia la aplicación`, level: 'error' },
    PDF_OCR_FAILED:        { msg: `${fileName}: OCR no pudo extraer texto del PDF`, level: 'error' },
    PDF_NO_PAGES:          { msg: `${fileName}: el PDF no contiene páginas`, level: 'warning' },
    PDF_NO_TEXT:            { msg: `${fileName}: PDF sin texto extraíble`, level: 'warning' },
    UNSUPPORTED_FORMAT:    { msg: `${fileName}: formato no soportado`, level: 'warning' },
  };
  const entry = map[docErr.message];
  if (entry) {
    showToast(entry.msg, entry.level);
  } else {
    console.warn('Document extraction error:', docErr);
    showToast(`Error al leer ${fileName}`, 'error');
  }
}

function renderAttachmentPreview() {
  const container = el("attachmentPreview");
  if (!container) return;
  container.replaceChildren();
  // Las imágenes rechazadas se muestran junto a los adjuntos reales, marcadas
  // como NO adjuntadas. Que desaparezcan sin rastro es lo que hacía creer al
  // usuario que la imagen había viajado.
  const rejected = pendingRejectedImages(activeChatId);
  if (chatAttachments.length === 0 && rejected.length === 0) {
    container.style.display = "none";
    updateSendButtonState();
    return;
  }
  container.style.display = "flex";
  rejected.forEach(item => {
    const div = document.createElement("div");
    div.className = "preview-item preview-item-rejected";
    div.style.cssText = "border:1px solid var(--danger,#d33);opacity:.85;";
    div.title = rejectionNotice(item);

    const nameSpan = document.createElement("span");
    nameSpan.style.cssText = "font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;";
    nameSpan.textContent = rejectionMatchesCurrentTarget(item)
      ? `🚫 ${item.name} — no adjuntada`
      : `🚫 ${item.name} — no adjuntada · vuelve a adjuntarla`;
    div.appendChild(nameSpan);

    const removeSpan = document.createElement("span");
    removeSpan.className = "preview-remove";
    removeSpan.textContent = "×";
    removeSpan.title = 'Descartar y poder enviar solo texto';
    removeSpan.onclick = (e) => {
      e.preventDefault();
      discardRejectedImage(item.id);
    };
    div.appendChild(removeSpan);
    container.appendChild(div);
  });
  chatAttachments.forEach((att, i) => {
    const div = document.createElement("div");
    div.className = "preview-item";
    
    if (att.type === 'image' && att.base64) {
      const img = document.createElement("img");
      img.src = `data:image/png;base64,${att.base64}`;
      img.style.cssText = "width:40px;height:40px;object-fit:cover;border-radius:4px;";
      img.alt = att.name || 'Imagen adjunta';
      div.appendChild(img);
    }
    
    const nameSpan = document.createElement("span");
    nameSpan.style.cssText = "font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80px;";
    const docIcon = /\.(docx?|xlsx?|pptx?|pdf|rtf|odt|ods|odp|csv|tsv)$/i.test(att.name) ? '📄 ' : '';
    nameSpan.textContent = att.type === 'image'
      ? `Adjunto: ${att.name || 'Imagen'}`
      : docIcon + att.name;
    div.appendChild(nameSpan);
    
    const removeSpan = document.createElement("span");
    removeSpan.className = "preview-remove";
    removeSpan.setAttribute("data-index", i);
    removeSpan.textContent = "×";
    removeSpan.onclick = (e) => {
      e.preventDefault();
      removeAttachment(parseInt(e.currentTarget.getAttribute("data-index"), 10));
    };
    div.appendChild(removeSpan);
    
    container.appendChild(div);
  });
  updateSendButtonState();
}

function removeAttachment(index) {
  if (index < 0 || index >= chatAttachments.length) return;
  chatAttachments.splice(index, 1);
  renderAttachmentPreview();
}

function updateSendButtonState() {
  const sendBtn = el("btnSend");
  const input = el("input");
  const hasText = input && input.value.trim().length > 0;
  const hasAttachments = chatAttachments.length > 0;
  if (sendBtn) sendBtn.disabled = isGenerating || (!hasText && !hasAttachments);
}

// ----------------------------------------------
// renderiza markdown (código, listas, negrita, etc.) en mensajes
// ----------------------------------------------
function renderMarkdown(text) {
  const raw = (text || "").toString().trim();
  if (!raw) return "";
  if (typeof marked === "undefined") return raw.replace(/</g, "&lt;").replace(/\n/g, "<br>");
  try {
    let html = marked.parse(raw);
    if (!html) return raw.replace(/</g, "&lt;").replace(/\n/g, "<br>");
    // Parse first, then sanitize with the vendored DOM parser and explicit allowlist.
    html = sanitizeHtml(html);
    return html;
  } catch (e) {
    return raw.replace(/</g, "&lt;").replace(/\n/g, "<br>");
  }
}

const MARKDOWN_ALLOWED_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img',
  'strong', 'em', 'del', 'hr', 'br', 'span'
];
const MARKDOWN_ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'class', 'target', 'rel', 'role', 'aria-label',
  'loading', 'data-zoomable', 'colspan', 'rowspan'
];
let markdownSanitizerConfigured = false;
const approvedRemoteImages = new Set();

function rememberApprovedImages(urls) {
  for (const value of urls) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password) approvedRemoteImages.add(value);
    } catch (_) {}
  }
  while (approvedRemoteImages.size > 1000) approvedRemoteImages.delete(approvedRemoteImages.values().next().value);
}

function configureMarkdownSanitizer() {
  if (markdownSanitizerConfigured || typeof DOMPurify === 'undefined') return;
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      const rawHref = node.getAttribute('href');
      try {
        const parsed = new URL(rawHref || '', document.baseURI);
        if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) node.removeAttribute('href');
      } catch (_) {
        node.removeAttribute('href');
      }
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.tagName === 'IMG') {
      const rawSrc = node.getAttribute('src') || '';
      const allowedData = /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,/i.test(rawSrc);
      let allowedHttps = false;
      try {
        const url = new URL(rawSrc);
        allowedHttps = url.protocol === 'https:' && !url.username && !url.password;
      } catch (_) {}
      if (allowedHttps && !approvedRemoteImages.has(rawSrc)) {
        // A model's Markdown must not silently contact a tracking endpoint.
        // Keep the image accessible through an explicit external-link click.
        const link = document.createElement('a');
        link.href = rawSrc;
        link.textContent = `Ver imagen externa: ${node.getAttribute('alt') || new URL(rawSrc).hostname}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        node.removeAttribute('src');
        node.replaceWith(link);
      } else if (!allowedData && !allowedHttps) node.removeAttribute('src');
    }
  });
  markdownSanitizerConfigured = true;
}

// La sanitización por expresiones regulares sobre HTML es evitable: basta un
// payload que el parser del navegador interprete distinto que el regex. Se
// delega en DOMPurify, que parsea de verdad y aplica una allowlist explícita.
function sanitizeHtml(html) {
  // Fail-closed: sin sanitizador NO se devuelve HTML sin limpiar. Quien llama
  // (renderMarkdown) degrada a texto escapado.
  if (typeof DOMPurify === 'undefined') {
    throw new Error('DOMPurify no está disponible');
  }
  configureMarkdownSanitizer();
  return DOMPurify.sanitize(String(html || ''), {
    ALLOWED_TAGS: MARKDOWN_ALLOWED_TAGS,
    ALLOWED_ATTR: MARKDOWN_ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [
      'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea',
      'select', 'option', 'svg', 'math', 'style'
    ],
    FORBID_ATTR: ['style', 'srcdoc', 'formaction'],
    ALLOW_UNKNOWN_PROTOCOLS: false
  });
}

function safeExternalHref(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : null;
  } catch (_) {
    return null;
  }
}

document.addEventListener('click', event => {
  const link = event.target.closest?.('.msg-content a[href], .message-content a[href]');
  if (!link) return;
  event.preventDefault();
  const href = safeExternalHref(link.getAttribute('href'));
  if (href) window.mika5.openExternal(href);
});

function wrapTablesResponsive(container) {
  if (!container) return;
  const tables = Array.from(container.querySelectorAll('table'));
  for (const table of tables) {
    // Skip if already wrapped
    if (table.parentNode?.classList?.contains('table-responsive')) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'table-responsive';
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }
}

function highlightCodeBlocks(container) {
  if (!container || typeof hljs === "undefined") return;
  container.querySelectorAll("pre code").forEach((block) => {
    try {
      // Skip already highlighted
      if (block.classList.contains("hljs")) return;
      const lang = (block.className.match(/language-(\w+)/) || [])[1];
      if (lang && hljs.getLanguage(lang)) {
        block.innerHTML = hljs.highlight(block.textContent, { language: lang }).value;
      }
      // REMOVED: hljs.highlightAuto() — it's extremely expensive and freezes UI
      // on chats with many code blocks
      block.classList.add("hljs");
    } catch (_) {}
  });
}

// Umbral de colapso: por encima de 40 líneas el bloque nace colapsado. Es la
// altura a partir de la cual un volcado de código empuja la conversación fuera
// de pantalla; por debajo, colapsar molesta más que ayuda.
const CODE_BLOCK_COLLAPSE_THRESHOLD = 40;

let _codeBlockSeq = 0;

function countCodeLines(text) {
  const contenido = String(text || '').replace(/\n$/, '');
  if (!contenido) return 0;
  return contenido.split('\n').length;
}

function addCopyButtonsToCodeBlocks(container) {
  if (!container) return;

  // Usar Array.from para evitar problemas de NodeList dinámica
  const pres = Array.from(container.querySelectorAll("pre"));

  pres.forEach((pre) => {
    try {
      // Skip if already wrapped — idempotencia: dos llamadas, una sola cabecera.
      if (pre.parentNode && pre.parentNode.classList && pre.parentNode.classList.contains('code-block-wrapper')) return;
    const code = pre.querySelector("code");
    const langMatch = code && code.className.match(/language-(\w+)/);
    // Sin autodetección: sólo la clase que ya trae el markdown. Detectar el
    // lenguaje a ojo costaba congelar la UI en chats largos.
    const lang = langMatch ? langMatch[1] : null;
    const lineas = countCodeLines((code || pre).textContent);

    // Guardar referencia al padre ANTES de mover el nodo
    const originalParent = pre.parentNode;
    if (!originalParent) return;

    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";

    const header = document.createElement("div");
    header.className = "code-block-header";

    const meta = document.createElement("div");
    meta.className = "code-block-meta";

    const langSpan = document.createElement("span");
    langSpan.className = "code-block-lang";
    langSpan.textContent = lang || t('code.plainText');

    const linesSpan = document.createElement("span");
    linesSpan.className = "code-block-lines";
    linesSpan.textContent = t('code.lines', { count: lineas });

    meta.appendChild(langSpan);
    meta.appendChild(linesSpan);

    const actions = document.createElement("div");
    actions.className = "code-block-actions";

    const bodyId = `code-block-${(++_codeBlockSeq)}`;
    pre.id = bodyId;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "code-block-toggle";
    toggle.setAttribute("aria-controls", bodyId);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-code-btn";
    btn.textContent = t('code.copy');
    btn.setAttribute("aria-label", t('code.copy'));
    btn.addEventListener("click", () => {
      // Siempre el contenido completo, esté colapsado o no: el código nunca sale
      // del DOM, sólo se recorta su altura visible.
      const text = (pre.querySelector("code") || pre).textContent;
      navigator.clipboard.writeText(text).then(
        () => showToast(t('toast.codeCopied'), "success"),
        () => showToast("Error al copiar", "error")
      );
    });

    const applyCollapsed = (colapsado) => {
      wrapper.classList.toggle("collapsed", colapsado);
      toggle.setAttribute("aria-expanded", String(!colapsado));
      const etiqueta = colapsado ? t('code.expand') : t('code.collapse');
      toggle.textContent = etiqueta;
      toggle.setAttribute("aria-label", etiqueta);
    };

    toggle.addEventListener("click", () => {
      applyCollapsed(!wrapper.classList.contains("collapsed"));
    });

    actions.appendChild(toggle);
    actions.appendChild(btn);
    header.appendChild(meta);
    header.appendChild(actions);
    wrapper.appendChild(header);

    // Insert wrapper where pre is, THEN move pre into wrapper
    originalParent.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    // El estado vive en el DOM, no en el mensaje ni en la base de datos.
    applyCollapsed(lineas > CODE_BLOCK_COLLAPSE_THRESHOLD);
    } catch (e) {
      console.warn('addCopyButtonsToCodeBlocks: skipped block', e.message);
    }
  });
}


// ----------------------------------------------
// genera un texto concatenado de un chat completo
// ----------------------------------------------
function compileChatAsMarkdown(messages) {
  let md = "";
  for (const msg of messages) {
    const prefix =
      msg.role === "user"
        ? "**Usuario:**"
        : msg.role === "assistant"
        ? "**Asistente:**"
        : `**${msg.role}:**`;
    md += `${prefix}\n\n${msg.content || ""}\n\n---\n\n`;
  }
  return md;
}

// Toast discreto (éxito / error)
function showToast(message, type = "success") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }
  // Limit visible toasts to avoid stacking overflow
  const MAX_TOASTS = 3;
  while (container.children.length >= MAX_TOASTS) {
    container.firstElementChild.remove();
  }
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  const duration = type === 'error' ? 4000 : 2500;
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, duration);
  return toast;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Segunda búsqueda, por significado, cuando la de palabras no encontró nada.
//
// La primera búsqueda recorre todos los documentos buscando las palabras de la
// pregunta. Si el usuario pregunta con otras palabras que las del documento
// —«¿cuándo prescribe una deuda?» frente a «extinción de las obligaciones»—
// no hay coincidencia, y sin esto se volvía a enviar el principio de los
// documentos. Aquí se comparan los significados, sobre los mismos documentos y
// con el mismo alcance. Necesita el modelo de embeddings; si no está o tarda,
// se sigue con lo que ya había, que no es peor que antes.
async function completarPorSignificado(chunks, { projectId, chatId, includeProjectScope, pregunta, maxChars }) {
  if (!Array.isArray(chunks) || !chunks.length || chunks[0].selection === 'relevance') return chunks;
  const totales = new Map(chunks.map(c => [c.title, c.doc_chunks || 0]));
  const hayMas = [...totales.values()].reduce((a, b) => a + b, 0) > chunks.length;
  if (!hayMas || !String(pregunta || '').trim()) return chunks;
  try {
    const respuesta = await withTimeout(
      window.mika5.rag.query(projectId, pregunta, 8, { chatId, includeProjectScope }),
      8000, 'buscar en los documentos'
    );
    const hallados = (respuesta && respuesta.ok && respuesta.chunks) || [];
    if (!hallados.length) return chunks;
    let usados = 0;
    const elegidos = [];
    for (const h of hallados) {
      const largo = String(h.chunk_text || '').length;
      if (elegidos.length && usados + largo > maxChars) continue;
      elegidos.push({
        title: h.title, chunk_index: h.chunk_index, chunk_text: h.chunk_text,
        doc_chunks: totales.get(h.title) || 0, selection: 'relevance'
      });
      usados += largo;
    }
    return elegidos.sort((a, b) => String(a.title).localeCompare(String(b.title)) || a.chunk_index - b.chunk_index);
  } catch (e) {
    console.warn('[KNOWLEDGE] búsqueda por significado no disponible:', e?.message || e);
    return chunks;
  }
}

// Presupuesto de contexto que se envía al modelo, en caracteres.
//
// La conversación entera vive en SQLite y no tiene límite de mensajes. Lo que
// sí tiene techo es lo que viaja en cada petición: mandar todo el historial
// siempre desbordaría la ventana del modelo y encarecería cada turno. Se
// conservan los mensajes más recientes que caben, y como mínimo los dos
// últimos intercambios aunque sean largos.
//
// Antes había además un límite por NÚMERO de mensajes: aviso a los 25, un
// diálogo que detenía el envío a los 30 y recorte a los 40. No medía nada
// real —cuarenta mensajes cortos caben de sobra— e interrumpía conversaciones
// normales pidiendo guardarlas, cuando guardar no cambiaba nada: el historial
// se relee de la base de datos en cada envío.
const MAX_CONTEXT_CHARS_GENERAL = 32000;
const MIN_RECENT_PAIRS = 2;

// Un motor local con la ventana pequeña declara un presupuesto menor en su
// contrato (`contextBudget`). Nunca lo amplía: sólo puede bajar el general.
function presupuestoDeContexto(clave, general) {
  const propio = Number(providerCapabilities?.contextBudget?.[clave]);
  return Number.isFinite(propio) && propio > 0 ? Math.min(general, propio) : general;
}

function trimContextToBudget(messages) {
  const MAX_CONTEXT_CHARS = presupuestoDeContexto('historyChars', MAX_CONTEXT_CHARS_GENERAL);
  const totalChars = messages.reduce((sum, m) => sum + (m.content || '').length, 0);
  if (totalChars <= MAX_CONTEXT_CHARS) return messages;

  let charCount = 0;
  let cutIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    charCount += (messages[i].content || '').length;
    cutIndex = i;
    const keptMessages = messages.length - i;
    if (charCount > MAX_CONTEXT_CHARS && keptMessages >= MIN_RECENT_PAIRS * 2) {
      cutIndex = i + 1;
      break;
    }
  }
  const trimmed = messages.slice(cutIndex);
  if (cutIndex > 0) {
    trimmed.unshift({
      role: 'system',
      content: `[Previous ${cutIndex} messages omitted to fit context window.]`
    });
  }
  return trimmed;
}

// Texto localizado del estado de un proveedor, construido SÓLO a partir del
// código estable y de los metadatos permitidos. El mensaje técnico del
// proveedor no cruza el puente: se queda en el log del proceso principal.
function describirEstadoProveedor(disp) {
  // Arrancando o cargando el modelo no hay error que contar. Y si lo que
  // impide usar el proveedor es el motor local, se dice eso: es más útil que
  // «no se pudo contactar con el servidor».
  if (!disp) return '';
  if (disp.readiness === 'starting' || disp.readiness === 'loading-model') return '';
  const codigoMotor = disp.engine && disp.engine.errorCode;
  if (codigoMotor) {
    const claveMotor = `provider.error.${codigoMotor}`;
    const textoMotor = t(claveMotor);
    if (textoMotor !== claveMotor) return textoMotor;
  }
  if (!disp.errorCode) return '';
  const clave = `provider.error.${disp.errorCode}`;
  const traducido = t(clave);
  if (traducido !== clave) return traducido;
  // Código sin texto propio: se cae al del estado, que siempre existe. Nunca
  // se enseña el código crudo ni el mensaje del proveedor.
  const porEstado = t(`provider.state.${disp.uiState || 'unknown'}`);
  return Number.isInteger(disp.httpStatus)
    ? `${porEstado} (HTTP ${disp.httpStatus})`
    : porEstado;
}

// Preparación del proveedor activo: la disponibilidad de siempre más en qué
// punto está el usuario y qué puede hacer. `autoStart` deja que el proceso
// principal ponga en marcha un motor local parado; sólo se pide para el
// proveedor seleccionado, nunca para todos.
//
// Si la preparación falla se cae a la disponibilidad sola: sin estados de
// arranque ni acción guiada, pero con el catálogo y el estado reales.
let providerReadiness = null;
let readinessPollTimer = null;

// De dónde salió el fichero de un modelo, en palabras.
function origenDeModelo(origen) {
  if (!origen) return '';
  return origen === 'manual' ? t('engine.origin.manual') : origen;
}

// Texto del motor local, si lo que impide usar el proveedor es el motor.
function describirMotor(disp) {
  const codigo = disp && disp.engine && disp.engine.errorCode;
  if (!codigo) return '';
  const clave = `provider.error.${codigo}`;
  const traducido = t(clave);
  return traducido === clave ? '' : traducido;
}

// Qué decir en el selector de modelos cuando está vacío.
function textoSelectorVacio(disp, uiState) {
  if (esperandoMotor(disp.readiness)) return t(`provider.readinessDetail.${disp.readiness}`);
  return describirMotor(disp) || t(`provider.selectEmpty.${uiState}`);
}

async function consultarPreparacion() {
  if (typeof window.mika5.ai.getReadiness === 'function') {
    try {
      return await window.mika5.ai.getReadiness(undefined, { autoStart: true });
    } catch (e) {
      console.warn('getReadiness failed:', e?.message || e);
    }
  }
  return window.mika5.ai.getAvailability();
}

// Arrancando o cargando el modelo: el proveedor está en camino.
function esperandoMotor(readiness) {
  return readiness === 'starting' || readiness === 'loading-model';
}

// Mientras un motor arranca o carga el modelo no hay nada que el usuario
// pueda hacer salvo esperar, así que la interfaz vuelve a preguntar sola.
// Un único temporizador, y sólo si el proveedor sigue siendo el mismo.
let readinessPollDesde = 0;
let readinessPollEnCurso = false;

function programarSondeoDePreparacion(enEspera) {
  clearTimeout(readinessPollTimer);
  readinessPollTimer = null;
  if (!enEspera) {
    readinessPollDesde = 0;
    return;
  }
  if (!readinessPollDesde) readinessPollDesde = Date.now();
  // Cada dos segundos al principio; si la carga se alarga, cada cinco. El
  // techo de la espera lo pone el proceso principal, que retira un motor que
  // no termina de cargar: aquí no hay un bucle sin final.
  const espera = Date.now() - readinessPollDesde < 30000 ? 2000 : 5000;
  const proveedor = currentProvider;
  readinessPollTimer = setTimeout(async () => {
    // Una consulta a la vez: si la anterior no ha vuelto, no se apila otra.
    if (currentProvider !== proveedor || readinessPollEnCurso) return;
    readinessPollEnCurso = true;
    try {
      await loadRuntime();
    } finally {
      readinessPollEnCurso = false;
    }
  }, espera);
}

// Acción guiada del menú. La etiqueta sale del código de acción; si el
// proveedor está listo, el botón no existe.
function renderProviderAction(disp) {
  const boton = el('btnProviderAction');
  if (!boton) return;
  const accion = disp && disp.action;
  const clave = `provider.action.${accion}`;
  const etiqueta = accion ? t(clave) : clave;
  // Configurar la clave ya tiene su entrada propia en este menú para los
  // proveedores cloud: repetirla aquí sólo alargaba el menú.
  const repetida = accion === 'configure-key' || accion === 'configure-provider';
  if (!accion || etiqueta === clave || repetida) {
    boton.style.display = 'none';
    delete boton.dataset.action;
    return;
  }
  boton.dataset.action = accion;
  boton.style.display = '';
  const texto = boton.querySelector('.more-actions-item-label');
  if (texto) texto.textContent = etiqueta;
  boton.setAttribute('aria-label', etiqueta);
  boton.title = etiqueta;
}

async function runProviderAction(accion = providerReadiness && providerReadiness.action) {
  switch (accion) {
    case 'configure-key':
    case 'configure-provider':
      showApiKeyModal();
      break;
    case 'configure-engine':
      await showEngineModal();
      break;
    case 'approve-engine':
      await approveEngine();
      break;
    case 'start-engine':
      await startLocalEngine();
      break;
    case 'download-model':
      el('btnPull')?.click();
      break;
    case 'install-engine':
      await showEngineModal();
      break;
    case 'start-service':
    case 'retry':
      await loadRuntime();
      break;
    default:
  }
}

const ACCIONES_DE_CONFIGURACION = ['configure-key', 'configure-provider', 'configure-engine', 'approve-engine'];

// La aprobación se pide en un diálogo nativo del proceso principal, con la
// ruta real y la huella del programa. Aquí sólo se refleja el resultado.
async function approveEngine() {
  try {
    const resultado = await window.mika5.ai.approveEngine(currentProvider);
    renderEngineModal(resultado?.engine);
    if (resultado?.errorCode) showToast(t(`provider.error.${resultado.errorCode}`), 'error');
  } catch (e) {
    showToast(t('provider.error.ENGINE_APPROVAL_REQUIRED'), 'error');
  }
  await loadRuntime();
}

function guiarPreparacion() {
  const accion = providerReadiness && providerReadiness.action;
  if (!providerReadiness || providerReadiness.readiness !== 'needs-setup') return;
  if (!ACCIONES_DE_CONFIGURACION.includes(accion)) return;
  const aviso = showToast(t(`provider.setupHint.${accion}`), 'warning');
  if (!aviso) return;
  aviso.dataset.providerAction = accion;
  aviso.setAttribute('role', 'button');
  aviso.style.cursor = 'pointer';
  // El contenedor de avisos deja pasar los clics a lo que hay debajo; este
  // aviso en concreto sí tiene que recibirlos.
  aviso.style.pointerEvents = 'auto';
  aviso.addEventListener('click', () => { runProviderAction(accion); });
}

async function startLocalEngine() {
  try {
    await window.mika5.ai.startEngine(currentProvider);
  } catch (e) {
    showToast(t('provider.error.ENGINE_SPAWN_FAILED'), 'error');
  }
  await loadRuntime();
}

// --- Aviso de versión nueva ---
// Sólo informa. La consulta sale porque el usuario pulsa «Buscar versión
// nueva» o porque activó el aviso al abrir; por defecto no sale ninguna.
const UPDATE_AUTO_KEY = 'updates.autoCheck';
let updateInfo = null;

function renderUpdateModal(info, buscando = false) {
  const estado = el('updateStatus');
  const notas = el('updateNotes');
  const abrir = el('updateOpenButton');
  if (el('updateInstalled')) el('updateInstalled').textContent = info?.installed ? `v${info.installed}` : '—';
  if (el('updateLatest')) el('updateLatest').textContent = info?.ok ? `v${info.latest}` : '—';
  if (estado) {
    if (buscando) estado.textContent = t('update.checking');
    else if (!info?.ok) estado.textContent = t(`update.error.${info?.errorCode || 'UPDATE_SOURCE_UNREACHABLE'}`);
    else estado.textContent = info.updateAvailable ? t('update.available') : t('update.current');
  }
  if (notas) {
    // Texto plano: las notas vienen de fuera y nunca se interpretan como HTML.
    notas.textContent = info?.ok && info.updateAvailable ? info.notes : '';
    notas.style.display = notas.textContent ? '' : 'none';
  }
  if (abrir) abrir.style.display = info?.ok && info.updateAvailable ? '' : 'none';
}

async function checkForUpdates(mostrar) {
  const modal = el('updateModal');
  if (mostrar && modal) {
    modal.style.display = 'flex';
    renderUpdateModal(updateInfo, true);
    try {
      const auto = el('updateAutoCheck');
      if (auto) auto.checked = (await window.mika5.getAppState(UPDATE_AUTO_KEY)) === '1';
    } catch (_) {}
  }
  try {
    updateInfo = await window.mika5.app.checkForUpdates();
  } catch (e) {
    updateInfo = { ok: false, errorCode: 'UPDATE_SOURCE_UNREACHABLE' };
  }
  if (mostrar) {
    renderUpdateModal(updateInfo);
  } else if (updateInfo?.ok && updateInfo.updateAvailable) {
    // Al abrir, con el aviso activado: un aviso pulsable, nunca un diálogo.
    const aviso = showToast(t('update.toast').replace('{v}', updateInfo.latest), 'info');
    if (aviso) {
      aviso.style.cursor = 'pointer';
      aviso.style.pointerEvents = 'auto';
      aviso.setAttribute('role', 'button');
      aviso.addEventListener('click', () => {
        if (modal) modal.style.display = 'flex';
        renderUpdateModal(updateInfo);
      });
    }
  }
  return updateInfo;
}

// Enlaces del proyecto. Lista cerrada: el renderer no abre una URL arbitraria.
const PROJECT_LINKS = Object.freeze({
  source: 'https://github.com/mika5app/mika5-releases/releases',
  issues: 'https://github.com/mika5app/mika5-releases/issues',
  license: 'https://github.com/mika5app/mika5-releases/blob/main/LICENSE'
});

function openProjectLink(cual) {
  if (PROJECT_LINKS[cual]) window.mika5.openExternal(PROJECT_LINKS[cual]);
}

function closeUpdateModal() {
  const modal = el('updateModal');
  if (modal) modal.style.display = 'none';
}

function openUpdatePage() {
  if (updateInfo?.ok && updateInfo.url) window.mika5.openExternal(updateInfo.url);
}

async function setUpdateAutoCheck(activo) {
  try {
    await window.mika5.setAppState(UPDATE_AUTO_KEY, activo ? '1' : '');
  } catch (_) {}
}

// Sólo si el usuario lo activó. Sin esa decisión, abrir MIKA5 no hace ninguna
// petición para buscar versiones.
async function checkForUpdatesOnStartup() {
  try {
    if ((await window.mika5.getAppState(UPDATE_AUTO_KEY)) !== '1') return;
  } catch (_) {
    return;
  }
  await checkForUpdates(false);
}

// --- Motor local (llama.cpp, BitNet) ---
function renderEngineModal(engine) {
  const ejecutable = el('engineExecutablePath');
  const lista = el('engineExecutableSelect');
  const modelos = el('engineModelsInfo');
  const estado = el('engineStatus');
  const iniciar = el('engineStartButton');
  const instalar = el('engineInstallButton');
  const guia = el('engineGuideButton');
  const descarga = el('engineDownloadSection');
  const encontrados = (engine && engine.executables) || [];
  const disponibles = (engine && engine.models) || [];

  if (ejecutable) ejecutable.textContent = engine?.executable || t('engine.executable.none');
  const sistema = el('engineSystem');
  if (sistema) sistema.textContent = engine?.platform ? `${t('engine.system')} ${engine.platform} ${engine.arch || ''}`.trim() : '';
  const seccionModelos = el('engineModelsSection');
  if (seccionModelos) seccionModelos.style.display = engine?.requiresModel ? '' : 'none';
  const manual = el('engineManualModelSection');
  if (manual) manual.style.display = engine?.requiresModel ? '' : 'none';
  // Una frase que diga qué falta, en vez de un panel de rutas.
  const resumen = el('engineSummary');
  if (resumen) {
    let paso = 'engine.step.ready';
    if (!engine?.executable) {
      // Lo primero es lo que el usuario puede hacer con un clic. Si MIKA5 no
      // tiene todavía un motor preparado para este sistema, se dice sin
      // rodeos; cómo compilarlo queda en la configuración avanzada.
      if (engine?.setup?.engineAvailable) paso = 'engine.step.oneclick';
      else if (engine?.canInstall) paso = 'engine.step.install';
      else paso = engine?.experimental ? 'engine.step.experimental' : 'engine.step.missing';
    }
    else if (!engine.executableApproved) paso = 'engine.step.approve';
    else if (engine.requiresModel && !(engine.models || []).length) paso = 'engine.step.model';
    resumen.textContent = t(paso).replace('{p}', providerDisplayName(currentProvider).replace(/\s*\(Local\)$/, ''));
  }
  // Motor que se compila: se dice qué herramientas hay y cuáles faltan, en vez
  // de un botón de instalar que no existe.
  const requisitos = el('engineRequirements');
  if (requisitos) {
    const lista = (!engine?.executable && engine?.requirements) || [];
    requisitos.textContent = lista.length
      ? `${t('engine.requirements')} ${lista.map(r => `${r.found ? '✓' : '✗'} ${t(`engine.tool.${r.id}`)}`).join(' · ')}`
      : '';
    requisitos.style.display = lista.length ? '' : 'none';
  }
  const direccion = el('engineEndpoint');
  if (direccion) {
    direccion.textContent = engine?.endpoint ? `${t('engine.endpoint')} ${engine.endpoint}` : '';
  }
  // «Instalar y comenzar»: un botón para todo lo que falta.
  const preparar = el('enginePrepareButton');
  const preparando = engine?.setupStatus?.state === 'running';
  if (preparar) {
    const listo = engine?.state === 'running' && engine?.ready;
    preparar.style.display = engine?.setup?.possible && !listo && !preparando ? '' : 'none';
    preparar.textContent = t(engine?.setup?.steps?.length ? 'engine.prepare' : 'engine.prepare.start');
  }
  renderEngineSetup(engine?.setupStatus);
  renderEngineCatalog(engine);
  // Con varios motores instalados se elige entre los encontrados.
  if (lista) {
    lista.replaceChildren();
    lista.style.display = encontrados.length > 1 ? '' : 'none';
    for (const ruta of encontrados) {
      const opcion = document.createElement('option');
      opcion.value = ruta;
      opcion.textContent = ruta;
      lista.appendChild(opcion);
    }
    if (engine?.executable) lista.value = engine.executable;
  }
  const aprobar = el('engineApproveButton');
  if (aprobar) aprobar.style.display = engine?.executable && !engine?.executableApproved ? '' : 'none';
  if (instalar) instalar.style.display = !engine?.executable && engine?.canInstall ? '' : 'none';
  if (guia) {
    guia.style.display = !engine?.executable && engine?.guideUrl ? '' : 'none';
    guia.dataset.url = engine?.guideUrl || '';
  }
  if (modelos) {
    modelos.textContent = disponibles.length
      ? t('engine.models.found').replace('{n}', String(disponibles.length))
      : t('engine.models.none');
  }
  if (descarga) descarga.style.display = engine?.executable && engine?.canDownload ? '' : 'none';
  if (iniciar) iniciar.disabled = !engine?.canStart;
  if (estado) {
    const clave = `provider.error.${engine?.errorCode}`;
    const texto = engine?.errorCode ? t(clave) : '';
    estado.textContent = texto && texto !== clave ? texto : (engine?.canStart ? t('engine.ready') : '');
  }
}

// Avance de «Instalar y comenzar», en una frase.
function renderEngineSetup(estado) {
  const linea = el('engineSetupProgress');
  if (!linea) return;
  const enCurso = estado && estado.state === 'running';
  linea.style.display = enCurso ? '' : 'none';
  if (!enCurso) return;
  const avance = estado.total
    ? ` ${formatBytesRenderer(estado.received)} / ${formatBytesRenderer(estado.total)} (${Math.floor((estado.received / estado.total) * 100)} %)`
    : '';
  linea.textContent = t(`engine.setup.${estado.step || 'start'}`) + avance;
}

let engineSetupTimer = null;

// Sigue la preparación hasta que termina; al acabar, el motor ya está
// arrancando y el selector de modelos lo refleja.
function seguirPreparacionDeMotor() {
  clearTimeout(engineSetupTimer);
  const proveedor = currentProvider;
  engineSetupTimer = setTimeout(async () => {
    let estado;
    try {
      estado = await window.mika5.ai.engineSetupStatus(proveedor);
    } catch (_) {
      return;
    }
    if (estado.state === 'running') {
      renderEngineSetup(estado);
      seguirPreparacionDeMotor();
      return;
    }
    if (estado.state === 'failed') showToast(t(`provider.error.${estado.errorCode}`), 'error');
    if (estado.state === 'done') {
      showToast(t('engine.setup.done'), 'success');
      closeEngineModal();
    } else if (currentProvider === proveedor) {
      try { renderEngineModal(await window.mika5.ai.describeEngine(proveedor)); } catch (_) {}
    }
    if (currentProvider === proveedor) await loadRuntime();
  }, 1000);
}

// La autorización se pide en un diálogo nativo del proceso principal, con la
// lista de lo que se va a descargar y cuánto ocupa.
async function prepareEngineFromModal() {
  try {
    const resultado = await window.mika5.ai.prepareEngine(currentProvider);
    if (resultado?.canceled) return;
    if (!resultado?.ok) {
      showToast(t(`provider.error.${resultado?.errorCode || 'ENGINE_SETUP_UNAVAILABLE'}`), 'error');
      return;
    }
    renderEngineModal(await window.mika5.ai.describeEngine(currentProvider));
    seguirPreparacionDeMotor();
  } catch (e) {
    showToast(t('provider.error.ENGINE_SETUP_UNAVAILABLE'), 'error');
  }
}

// Catálogo de modelos recomendados. Sólo se ofrece lo que falta por bajar.
function renderEngineCatalog(engine) {
  const seccion = el('engineCatalogSection');
  const lista = el('engineCatalogSelect');
  if (!seccion || !lista) return;
  const pendientes = ((engine && engine.catalog) || []).filter(m => !m.installed);
  const descargando = engine?.download?.state === 'downloading';
  seccion.style.display = engine?.executable && pendientes.length && !descargando ? '' : 'none';
  lista.replaceChildren();
  for (const m of pendientes) {
    const opcion = document.createElement('option');
    opcion.value = m.id;
    opcion.textContent = `${m.label} — ${formatBytesRenderer(m.size)}`;
    lista.appendChild(opcion);
  }
  renderModelDownload(engine?.download);
}

let modelDownloadTimer = null;

function renderModelDownload(estado) {
  const caja = el('engineDownloadProgress');
  if (!caja) return;
  const activa = estado?.state === 'downloading';
  caja.style.display = activa ? '' : 'none';
  if (!activa) return;
  const porcentaje = estado.total ? Math.floor((estado.received / estado.total) * 100) : 0;
  if (el('engineDownloadBar')) el('engineDownloadBar').value = porcentaje;
  if (el('engineDownloadText')) {
    el('engineDownloadText').textContent = `${estado.label}: ${formatBytesRenderer(estado.received)} / ${formatBytesRenderer(estado.total)} (${porcentaje} %)`;
  }
}

// Sigue una descarga hasta que termina. Un único temporizador; al acabar se
// refresca el diálogo y el selector de modelos, donde aparece el modelo nuevo.
function seguirDescargaDeModelo() {
  clearTimeout(modelDownloadTimer);
  modelDownloadTimer = setTimeout(async () => {
    let estado;
    try {
      estado = await window.mika5.ai.modelDownloadStatus();
    } catch (_) {
      return;
    }
    if (estado.state === 'downloading') {
      renderModelDownload(estado);
      seguirDescargaDeModelo();
      return;
    }
    if (estado.state === 'done') showToast(t('engine.catalog.done'), 'success');
    else if (estado.state === 'failed') showToast(t(`provider.error.${estado.errorCode}`), 'error');
    try {
      renderEngineModal(await window.mika5.ai.describeEngine(currentProvider));
    } catch (_) {}
    await loadRuntime();
  }, 1000);
}

async function downloadCatalogModelFromModal() {
  const id = el('engineCatalogSelect')?.value;
  if (!id) return;
  try {
    const resultado = await window.mika5.ai.downloadCatalogModel(currentProvider, id);
    if (resultado?.canceled) return;
    if (!resultado?.ok) {
      showToast(t(`provider.error.${resultado?.errorCode || 'MODEL_DOWNLOAD_FAILED'}`), 'error');
      return;
    }
    renderEngineModal(await window.mika5.ai.describeEngine(currentProvider));
    if (!resultado.already) seguirDescargaDeModelo();
    else await loadRuntime();
  } catch (e) {
    showToast(t('provider.error.MODEL_DOWNLOAD_FAILED'), 'error');
  }
}

async function cancelModelDownload() {
  try {
    await window.mika5.ai.cancelModelDownload();
  } catch (_) {}
}

async function selectEngineExecutable(ruta) {
  try {
    renderEngineModal(await window.mika5.ai.selectEngineExecutable(currentProvider, ruta));
    await loadRuntime();
  } catch (e) {
    showToast(t('provider.error.ENGINE_EXECUTABLE_NOT_ALLOWED'), 'error');
  }
}

// Instalar pide autorización en un diálogo nativo del proceso principal. Aquí
// sólo se enseña que está en curso y qué pasó.
async function installEngineFromModal() {
  const boton = el('engineInstallButton');
  const estado = el('engineStatus');
  if (boton) boton.disabled = true;
  if (estado) estado.textContent = t('engine.install.running');
  try {
    const resultado = await window.mika5.ai.installEngine(currentProvider);
    renderEngineModal(resultado?.engine);
    if (resultado?.ok) showToast(t('engine.install.done'), 'success');
    else if (!resultado?.canceled) showToast(t(`provider.error.${resultado?.errorCode || 'ENGINE_INSTALL_FAILED'}`), 'error');
  } catch (e) {
    showToast(t('provider.error.ENGINE_INSTALL_FAILED'), 'error');
  } finally {
    if (boton) boton.disabled = false;
  }
  await loadRuntime();
}

function openEngineGuide() {
  const url = el('engineGuideButton')?.dataset.url;
  if (url) window.mika5.openExternal(url);
}

async function downloadEngineModelFromModal() {
  const repo = (el('engineDownloadInput')?.value || '').trim();
  if (!repo) return;
  try {
    const resultado = await window.mika5.ai.downloadEngineModel(currentProvider, repo);
    if (resultado?.canceled) return;
    if (resultado?.errorCode) {
      showToast(t(`provider.error.${resultado.errorCode}`), 'error');
      return;
    }
    closeEngineModal();
    showToast(t('engine.download.started'), 'success');
  } catch (e) {
    showToast(t('provider.error.ENGINE_SPAWN_FAILED'), 'error');
  }
  await loadRuntime();
}

async function showEngineModal() {
  const modal = el('engineModal');
  if (!modal) return;
  const titulo = el('engineModalTitle');
  if (titulo) titulo.textContent = `${t('engine.title')} — ${providerDisplayName(currentProvider)}`;
  modal.style.display = 'flex';
  try {
    const engine = await window.mika5.ai.describeEngine(currentProvider);
    renderEngineModal(engine);
    if (engine?.setupStatus?.state === 'running') seguirPreparacionDeMotor();
    else if (engine?.download?.state === 'downloading') seguirDescargaDeModelo();
  } catch (e) {
    renderEngineModal(null);
  }
}

function closeEngineModal() {
  const modal = el('engineModal');
  if (modal) modal.style.display = 'none';
}

async function chooseEngineFile(kind) {
  try {
    const resultado = await window.mika5.ai.chooseEngineFile(currentProvider, kind);
    renderEngineModal(resultado?.engine);
    if (resultado?.errorCode) showToast(t(`provider.error.${resultado.errorCode}`), 'error');
  } catch (e) {
    showToast(t('provider.error.ENGINE_PATH_INVALID'), 'error');
  }
}

async function startEngineFromModal() {
  closeEngineModal();
  await startLocalEngine();
}

async function loadRuntime() {
  // Disponibilidad del proveedor activo, con los estados separados. Antes esto
  // era `status()`, que para todo proveedor cloud devolvía `ok: !!apiKey`: la
  // píldora podía anunciar «Conectado» mientras el selector quedaba vacío y
  // deshabilitado, y un runtime sin credencial no podía estar disponible nunca.
  let disp;
  try {
    disp = await consultarPreparacion();
  } catch (e) {
    // Si el propio canal falla no se sabe nada del proveedor. Se dice eso, no
    // que esté caído: el error es de la aplicación, no del servidor remoto.
    disp = {
      configured: false, reachable: null, authenticated: null,
      modelsAvailable: 0, models: [], canAttempt: false, ready: false,
      uiState: 'configuration-required', errorCode: 'PROVIDER_UNAVAILABLE', httpStatus: null
    };
  }

  const statusEl = el("rtStatus");
  // Ocho estados. «Conectado» exige evidencia de que el servidor contestó Y de
  // que el servicio respondió bien: un 404, un 429 o un 500 prueban que hay
  // alguien al otro lado y no que se pueda trabajar, así que tienen estado
  // propio y no se pintan en verde.
  const uiState = disp.uiState || 'unknown';
  // Arrancando o cargando el modelo: ni conectado ni caído, en camino. Tiene
  // prioridad sobre el estado de disponibilidad, que durante el arranque dice
  // «sin conexión» y sería verdad a medias.
  const readiness = disp.readiness || null;
  const enEspera = esperandoMotor(readiness);
  providerReadiness = disp;
  programarSondeoDePreparacion(enEspera);
  renderProviderAction(disp);
  const CLASE_POR_ESTADO = {
    'connected': 'status-ok',
    'offline': 'status-offline',
    'unknown': 'status-unknown',
    'configuration-required': 'status-unconfigured',
    'authentication-rejected': 'status-offline',
    'authorization-forbidden': 'status-offline',
    'rate-limited': 'status-degraded',
    'provider-error': 'status-degraded'
  };
  // Un motor local gestionado tiene su propio estado. «Sin conexión» no dice
  // nada de un motor que está parado esperando a que se elija un modelo, ni
  // lo distingue de uno que falló o de uno que no está instalado.
  const estadoMotor = disp.engine && disp.engine.status;
  const CLASE_POR_MOTOR = {
    'ready': 'status-ok', 'starting': 'status-loading', 'loading': 'status-loading',
    'stopped': 'status-unconfigured', 'needs-model': 'status-unconfigured',
    'needs-approval': 'status-unconfigured', 'not-installed': 'status-unconfigured', 'error': 'status-offline'
  };
  if (estadoMotor) {
    statusEl.textContent = t(`engine.status.${estadoMotor}`);
    statusEl.className = `status-pill ${CLASE_POR_MOTOR[estadoMotor] || 'status-unknown'}`;
  } else {
    statusEl.textContent = enEspera ? t(`provider.readiness.${readiness}`) : t(`provider.state.${uiState}`);
    statusEl.className = `status-pill ${enEspera ? 'status-loading' : (CLASE_POR_ESTADO[uiState] || 'status-unknown')}`;
  }
  statusEl.dataset.engineStatus = estadoMotor || '';
  statusEl.dataset.providerState = uiState;
  statusEl.dataset.providerReadiness = readiness || '';
  // El tooltip se compone de textos localizados a partir del código, nunca del
  // mensaje del proveedor: un error técnico puede arrastrar rutas, endpoints o
  // fragmentos de credencial, y el título de un elemento es visible y copiable.
  const rotuloError = describirEstadoProveedor(disp);
  if (rotuloError) statusEl.title = rotuloError;
  else statusEl.removeAttribute('title');
  // Con el motor sirviendo, el rótulo dice qué motor ejecuta el modelo y de
  // dónde salió el fichero: son cosas distintas y no deben leerse como una.
  if (estadoMotor === 'ready' && disp.engine.selectedModel) {
    statusEl.title = t('engine.identity')
      .replace('{engine}', disp.engine.label || '')
      .replace('{origin}', origenDeModelo(disp.engine.modelOrigin));
  }

  // El punto del disparador lleva el estado completo, no un booleano: marcar
  // «offline» un proveedor que está sin verificar era decir que está caído.
  const moreActionsTrigger = el("btnMoreActions");
  if (moreActionsTrigger) moreActionsTrigger.dataset.providerState = uiState;

  el("modelSelect").replaceChildren();
  // Se puebla con `canAttempt`, no con `ready`: un catálogo declarado por el
  // adaptador basta para ofrecer los modelos, aunque nadie haya verificado que
  // el proveedor responda. Lo que no se hace es llamar «listo» a eso.
  //
  // Y `canAttempt` es la ÚNICA condición. Antes había además un
  // `configured && reachable !== false && authenticated !== false`, que se
  // saltaba la comprobación de errores que impiden usar el proveedor: con un
  // 429, un 403 o un 500 la credencial es válida y el servidor responde, así
  // que esa segunda mitad daba verde y llenaba el selector de modelos que
  // ninguna petición iba a poder usar. La píldora decía «límite alcanzado» y
  // el desplegable ofrecía trece modelos: dos respuestas distintas a la misma
  // pregunta. No se reconstruye `canAttempt` a partir de sus ingredientes.
  if (disp.canAttempt) {
    // El catálogo ya viene con la disponibilidad: pedirlo otra vez repetiría la
    // misma consulta al proveedor.
    const modelsRes = { models: disp.models || [] };

    // Normalizar la respuesta a un array de objetos { name, size, sizeFormatted, capabilities, speed }
    let models = [];
    const mapper = (raw) => {
      if (!raw) return null;
      if (typeof raw === 'string') return { name: raw };
      const name = raw.name || raw.id || raw.model || raw.tag || String(raw);
      const size = raw.size || raw.bytes || raw.modelSize || 0;
      const sizeFormatted = raw.sizeFormatted || raw.size_human || (size ? formatBytesRenderer(Number(size)) : '');
      const capabilities = raw.capabilities || raw.caps || raw.tags || [];
      const speed = raw.speed || raw.latency || raw.quality || '';
      // Modelo de un motor local: su procedencia es una descripción, no parte
      // del nombre.
      const description = raw.origin
        ? t('engine.origin').replace('{origin}', origenDeModelo(raw.origin))
        : (raw.description || raw.info || '');
      return {
        name,
        privacy: raw.privacy,
        size,
        sizeFormatted,
        capabilities,
        speed,
        description,
        taskType: raw.taskType || 'chat',
        label: raw.label,
        compatibility: raw.compatibility,
        supportsVision: raw.supportsVision === true
      };
    };

    if (Array.isArray(modelsRes)) models = modelsRes.map(mapper).filter(Boolean);
    else if (modelsRes && Array.isArray(modelsRes.models)) models = modelsRes.models.map(mapper).filter(Boolean);
    else if (modelsRes && Array.isArray(modelsRes.tags)) models = modelsRes.tags.map(mapper).filter(Boolean);

    // Filter out embedding-only models that don't support chat
    // Keep :cloud models (kimi-k2.5:cloud, glm-5:cloud, etc.)
    models = models.filter(m => {
      if (m.taskType && !['chat', 'vision'].includes(m.taskType)) return false;
      const n = (m.name || '').toLowerCase();
      if (n.includes(':cloud')) return true; // always keep cloud models
      return !/^(nomic-embed|bge-|e5-|gte-|mxbai-embed|snowflake-arctic-embed|all-minilm)/i.test(n) 
             && !(/embed/i.test(n) && !n.includes('code'));
    });

    if (models.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = t(`provider.selectEmpty.${uiState}`);
      el("modelSelect").appendChild(opt);
    } else {
      if (currentProvider === 'alibaba') {
        const automatic = document.createElement('option');
        automatic.value = AUTOMATIC_MODEL_ID;
        automatic.textContent = 'Automático';
        automatic.dataset.source = 'cloud';
        automatic.dataset.providerName = 'Alibaba Cloud Model Studio / Router de capacidades';
        automatic.dataset.billingMode = 'token-plan';
        automatic.dataset.taskType = 'automatic';
        el("modelSelect").appendChild(automatic);
      }
      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.name;
        opt.textContent = m.label || m.name;
        opt.dataset.source = (currentProvider === 'llamacpp' || currentProvider === 'bitnet' || (currentProvider === 'local' && m.privacy !== 'cloud') ? 'local' : 'cloud');
        if (m.size) opt.dataset.size = String(m.size);
        if (m.sizeFormatted) opt.dataset.sizeFormatted = m.sizeFormatted;
        if (m.capabilities && Array.isArray(m.capabilities)) opt.dataset.caps = m.capabilities.join(' • ');
        // Modelo de un motor local: se dice si está comprobado que carga o no.
        if (m.compatibility) opt.dataset.caps = t(`engine.compat.${m.compatibility}`);
        if (m.speed) opt.dataset.speed = m.speed;
        if (m.description) opt.dataset.description = m.description;
        if (m.supportsVision) opt.dataset.vision = '1';
        opt.dataset.taskType = m.taskType;
        if (currentProvider === 'alibaba') {
          opt.dataset.providerName = 'Alibaba Cloud Model Studio';
          opt.dataset.billingMode = 'token-plan';
        }
        el("modelSelect").appendChild(opt);
      }
    }
  } else {
    // Con los estados separados el motivo deja de ser un misterio: antes las
    // tres situaciones se leían igual, «Proveedor no disponible».
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = textoSelectorVacio(disp, uiState);
    el("modelSelect").appendChild(opt);
    el("modelSelect").disabled = true;
    const pullLocal = el("btnPullLocal");
    if (pullLocal) pullLocal.disabled = true;
    syncModelDropdown();
    return;
  }

  el("modelSelect").disabled = false;

  // Restore last used model
  try {
    const lastModel = await window.mika5.getAppState("lastModel");
    if (lastModel && lastModel !== AUTOMATIC_MODEL_ID) {
      const sel = el("modelSelect");
      const available = Array.from(sel.options).map(o => o.value);
      if (available.includes(lastModel)) {
        sel.value = lastModel;
      }
    }
  } catch (_) {}

  // En un motor gestionable manda el modelo con el que arrancó, no el último
  // que se usó con cualquier proveedor.
  const modeloDelMotor = disp.engine && disp.engine.selectedModel;
  if (modeloDelMotor && Array.from(el("modelSelect").options).some(o => o.value === modeloDelMotor)) {
    el("modelSelect").value = modeloDelMotor;
  } else if (disp.engine && disp.engine.managed && !disp.engine.external) {
    // El motor no tiene ningún modelo elegido. No se enseña el primero de la
    // lista —ni el último que se usó con otro proveedor— como si estuviese
    // cargado: hasta que el usuario elija uno, el selector lo dice.
    const sinElegir = document.createElement('option');
    sinElegir.value = '';
    sinElegir.textContent = t('engine.pickModel');
    el("modelSelect").insertBefore(sinElegir, el("modelSelect").firstChild);
    el("modelSelect").value = '';
  }

  const pullLocal = el("btnPullLocal");
  const pullLibrary = el("btnPull");
  if (pullLocal) {
    pullLocal.disabled = (currentProvider !== 'local');
    pullLocal.style.display = currentProvider === 'alibaba' ? 'none' : '';
  }
  if (pullLibrary) pullLibrary.style.display = providerLibraryUrl ? '' : 'none';
  syncModelDropdown();
}

// --- AI provider helpers ---
async function loadProvider() {
  try {
    const provider = await window.mika5.ai.getCurrentProvider();
    if (provider && provider.id) {
      currentProvider = provider.id;
      providerLibraryUrl = provider.libraryUrl || null;
      if (provider.credentialSessionOnly) showToast('Las claves de proveedores funcionan sólo durante esta sesión: el almacén seguro del sistema no está disponible.', 'warning');
      providerPrivacy = provider.privacy || (provider.privacy === 'private' ? 'private' : 'cloud');
      // El contrato viaja con el proveedor: sin ida y vuelta extra por IPC.
      providerCapabilities = provider.capabilities || await refreshProviderCapabilities();
      updatePrivacyUI();
    }
  } catch (e) {
    console.warn('loadProvider failed:', e);
  }
}

function cloudConsentProjectId(projectId) {
  return projectId && projectId !== QUICK_CHAT_ID ? projectId : null;
}

async function readCloudConsent(providerId, projectId) {
  const key = buildCloudConsentKey(providerId, cloudConsentProjectId(projectId));
  return normalizeStoredConsent(await window.mika5.getAppState(key));
}

function requestCloudConsentChoice(providerLabel, scope, storedConsent) {
  return new Promise(resolve => {
    const previous = document.getElementById('cloudConsentModal');
    if (previous) previous.remove();
    const modal = document.createElement('div');
    modal.id = 'cloudConsentModal';
    modal.className = 'modal';
    modal.style.display = 'flex';
    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '560px';
    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('h3');
    title.textContent = t('cloudConsent.title', { provider: providerLabel });
    header.appendChild(title);
    const body = document.createElement('div');
    body.className = 'modal-body';
    const intro = document.createElement('p');
    intro.textContent = t('cloudConsent.intro');
    body.appendChild(intro);
    const list = document.createElement('ul');
    for (const item of summarizeCloudScope(scope)) {
      const row = document.createElement('li');
      const newlyRequested = !storedConsent?.categories?.[item.category];
      const count = item.count ? ` (${item.count})` : '';
      const safeNames = (item.names || []).slice(0, 5);
      row.textContent = `${t(item.labelKey)}${count}${safeNames.length ? `: ${safeNames.join(', ')}` : ''}`;
      if (newlyRequested && storedConsent) row.append(t('cloudConsent.newCategory'));
      list.appendChild(row);
    }
    body.appendChild(list);
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:20px;';
    const finish = choice => {
      modal.remove();
      resolve(choice);
    };
    for (const [choice, label, className] of [
      ['once', t('cloudConsent.once'), 'btn-icon'],
      ['persist', t('cloudConsent.persist'), 'btn-primary'],
      ['cancel', t('action.cancel'), 'btn-icon']
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = label;
      button.addEventListener('click', () => finish(choice));
      actions.appendChild(button);
    }
    body.appendChild(actions);
    content.append(header, body);
    modal.appendChild(content);
    document.body.appendChild(modal);
  });
}

// Authorization is attached to the immutable request identity, never to the
// provider currently selected after an await. No credential or prompt is kept.
const requestAuthorizations = new Map();

async function ensureCloudConsent(requestContext, scope) {
  const resolved = await window.mika5.ai.resolvePrivacy({
    providerId: requestContext.providerId, model: requestContext.selectedModel
  });
  if (currentProvider === requestContext.providerId && el('modelSelect')?.value === requestContext.selectedModel) {
    providerPrivacy = resolved.privacy;
    updatePrivacyUI();
  }
  const consentProjectId = cloudConsentProjectId(requestContext.projectId);
  const effectiveScope = { ...scope, providerId: requestContext.providerId,
    projectScope: cloudProjectScope(consentProjectId) };
  let consent = null;
  if (resolved.privacy === 'cloud') {
    const key = buildCloudConsentKey(requestContext.providerId, consentProjectId);
    const stored = normalizeStoredConsent(await window.mika5.getAppState(key));
    if (!consentCoversScope(stored, effectiveScope)) {
      const label = requestContext.providerId === 'local' ? 'Ollama Cloud' : providerDisplayName(requestContext.providerId);
      const choice = await requestCloudConsentChoice(label, effectiveScope, stored);
      if (choice === 'cancel') return false;
      consent = mergeConsentScope(stored, effectiveScope, effectiveScope);
      if (choice === 'persist') {
        const saved = await window.mika5.setAppState(key, JSON.stringify(consent));
        if (!saved?.ok) showToast('El permiso se aplicará sólo a esta solicitud; no se pudo guardar.', 'warning');
      }
    } else consent = stored;
  }
  requestAuthorizations.set(requestContext.requestId, { requestContext, scope: effectiveScope, consent });
  // Abandoned requests must not retain unbounded authorization records.
  while (requestAuthorizations.size > 100) requestAuthorizations.delete(requestAuthorizations.keys().next().value);
  return true;
}

async function sendAuthorizedAI(method, payload) {
  let authorization = requestAuthorizations.get(payload.requestId);
  if (!authorization) {
    const context = createRequestContext({ requestId: payload.requestId,
      chatId: activeChatId || 'provider-test', projectId: activeProjectId || QUICK_CHAT_ID,
      providerId: payload.providerId || currentProvider, selectedModel: payload.model });
    const scope = buildEffectiveCloudScope(context, payload, {
      historyMessageCount: Math.max(0, (payload.messages?.length || 1) - 1)
    });
    if (!await ensureCloudConsent(context, scope)) throw new Error('Solicitud cancelada por el usuario');
    authorization = requestAuthorizations.get(context.requestId);
  }
  const { requestContext, scope, consent } = authorization;
  requestAuthorizations.delete(requestContext.requestId);
  if (payload.model !== requestContext.selectedModel) throw new Error('El modelo cambió después del consentimiento. Reintenta la solicitud.');
  const result = await window.mika5.ai[method]({ ...payload,
    requestId: requestContext.requestId, providerId: requestContext.providerId,
    projectScope: scope.projectScope, dataScope: scope,
    cloudConsent: consent ? { ...consent, model: payload.model, requestId: requestContext.requestId } : null
  });
  if (method === 'generateImage' || result?.terminalType === 'image') {
    rememberApprovedImages(result?.images || []);
  }
  return result;
}
const sendAIChat = payload => sendAuthorizedAI('chat', payload);
const sendAIImage = payload => sendAuthorizedAI('generateImage', payload);

function buildEffectiveCloudScope(requestContext, payload, metadata = {}) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const imageNames = Array.isArray(metadata.imageNames)
    ? metadata.imageNames.filter(Boolean)
    : [];
  const ragTitles = Array.isArray(metadata.ragDocumentTitles)
    ? [...new Set(metadata.ragDocumentTitles.filter(Boolean))]
    : [];
  return buildCloudDataScope({
    message: true,
    history: Number(metadata.historyMessageCount) > 0,
    historyMessageCount: Number(metadata.historyMessageCount) || 0,
    projectInstructions: Boolean(metadata.projectInstructionsIncluded),
    textAttachments: Array.isArray(metadata.attachmentNames) && metadata.attachmentNames.length > 0,
    attachmentNames: metadata.attachmentNames || [],
    imageAttachments: Boolean(
      (Array.isArray(payload?.images) && payload.images.length)
      || (Array.isArray(payload?.sourceImages) && payload.sourceImages.length)
    ),
    imageNames,
    ragContext: Boolean(metadata.ragContextIncluded && messages.some(message =>
      message.role === 'system' && String(message.content || '').includes(metadata.ragContextMarker || '')
    )),
    ragDocumentTitles: ragTitles,
    ragDocumentCount: ragTitles.length
  });
}

function providerDisplayName(providerId) {
  const key = `provider.${providerId}`;
  const translated = t(key);
  return translated === key
    ? String(providerId || '').charAt(0).toUpperCase() + String(providerId || '').slice(1)
    : translated;
}

async function revokeCloudConsent() {
  if (providerPrivacy !== 'cloud') return;
  const key = buildCloudConsentKey(currentProvider, cloudConsentProjectId(activeProjectId));
  await window.mika5.setAppState(key, '');
  // Ocultar el aviso nunca puede sobrevivir a la retirada del permiso: el
  // estado de seguridad cambió, así que el banner vuelve a mostrarse.
  await clearCloudBannerDismissal(currentProvider, activeProjectId).catch(() => {});
  updatePrivacyUI();
  showToast(t('cloudConsent.revoked'), 'success');
}

// --- Aviso cloud: una sola superficie detallada, con cierre recordado ---
//
// El cierre es decorativo. No toca el consentimiento, no oculta el indicador de
// privacidad y no evita el modal: sólo silencia el banner para el proveedor y el
// proyecto actuales mientras el estado de seguridad no cambie.
const CLOUD_BANNER_SCHEMA_VERSION = 1;

function cloudBannerStateKey(providerId, projectId) {
  if (!providerId) throw new Error('providerId requerido');
  return `ui:cloudBanner:v${CLOUD_BANNER_SCHEMA_VERSION}:${providerId}:${cloudProjectScope(cloudConsentProjectId(projectId))}`;
}

// Huella del estado de seguridad. Si cambian las categorías autorizadas, la
// huella cambia y el aviso reaparece aunque se hubiera cerrado antes.
function cloudConsentFingerprint(consent) {
  if (!consent || !consent.categories) return 'sin-consentimiento';
  const granted = Object.keys(consent.categories)
    .filter(category => consent.categories[category])
    .sort();
  return granted.length ? granted.join('+') : 'sin-categorias';
}

async function readCloudBannerDismissal(providerId, projectId) {
  try {
    const raw = await window.mika5.getAppState(cloudBannerStateKey(providerId, projectId));
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed?.schemaVersion !== CLOUD_BANNER_SCHEMA_VERSION) return null;
    if (!parsed.fingerprint) return null;
    return { fingerprint: String(parsed.fingerprint), dismissedAt: String(parsed.dismissedAt || '') };
  } catch (_) {
    return null;
  }
}

async function clearCloudBannerDismissal(providerId, projectId) {
  if (!providerId) return;
  await window.mika5.setAppState(cloudBannerStateKey(providerId, projectId), '');
}

async function dismissCloudInputBanner() {
  if (providerPrivacy !== 'cloud') return;
  const providerAtDismiss = currentProvider;
  const projectAtDismiss = activeProjectId;
  const consent = await readCloudConsent(providerAtDismiss, projectAtDismiss).catch(() => null);
  const saved = await window.mika5.setAppState(
    cloudBannerStateKey(providerAtDismiss, projectAtDismiss),
    JSON.stringify({
      schemaVersion: CLOUD_BANNER_SCHEMA_VERSION,
      fingerprint: cloudConsentFingerprint(consent),
      dismissedAt: new Date().toISOString()
    })
  );
  if (!saved?.ok) { showToast('No se pudo guardar el cierre del aviso.', 'warning'); return; }
  const banner = el('cloudInputBanner');
  if (banner && currentProvider === providerAtDismiss && activeProjectId === projectAtDismiss) {
    banner.classList.remove('visible');
  }
}

// Nodos separados con textContent: el aviso no depende de que una traducción
// contenga ':' ni de inyectar HTML con el nombre del proveedor.
function renderCloudInputBanner(providerLabel) {
  const body = el('cloudInputBannerBody');
  if (!body) return;
  body.textContent = '';
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '⚠️ ';
  const provider = document.createElement('span');
  provider.className = 'cloud-input-banner-provider';
  provider.textContent = t('cloudBanner.provider', { provider: providerLabel });
  const detail = document.createElement('span');
  detail.textContent = ' ' + t('privacy.inputWarning');
  body.appendChild(icon);
  body.appendChild(provider);
  body.appendChild(detail);
  const dismiss = el('cloudBannerDismiss');
  if (dismiss) {
    dismiss.setAttribute('aria-label', t('cloudBanner.dismiss'));
    dismiss.title = t('cloudBanner.dismiss');
  }
}

// El icono del indicador es estructural: vive aquí, no dentro de la traducción.
// Antes se concatenaba un prefijo en JS sobre un texto i18n que ya traía emoji y
// se veían dos iconos. Una sola fuente de verdad: icono en el DOM, texto en i18n.
function renderPrivacyBadge(badge, state, label) {
  if (!badge) return;
  badge.textContent = '';
  const icon = document.createElement('span');
  icon.className = 'privacy-badge-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = state === 'private' ? '🔒' : '☁️';
  const text = document.createElement('span');
  text.className = 'privacy-badge-text';
  text.textContent = label;
  badge.appendChild(icon);
  badge.appendChild(text);
  badge.className = 'privacy-badge ' + state;
}

function updatePrivacyUI() {
  const indicator = el('privacyIndicator');
  const badge = el('privacyBadge');
  const apiKeyBtn = el('btnConfigApiKey');
  const providerName = el('currentProviderName');
  const inputBanner = el('cloudInputBanner');
  const footerEl = el('footerStatus');
  const revokeButton = el('revokeCloudConsent');

  const providerLabel = currentProvider === 'local' && providerPrivacy === 'cloud'
    ? 'Ollama Cloud' : providerDisplayName(currentProvider);

  // La biblioteca de modelos es la del proveedor elegido. Depende de cuál
  // está elegido, no de si responde, así que se decide aquí y no al final de
  // `loadRuntime()`, que no llega cuando el proveedor no está listo.
  const biblioteca = el('btnPull');
  if (biblioteca) {
    biblioteca.style.display = providerLibraryUrl ? '' : 'none';
    const rotuloBiblioteca = `${t('library.open')} — ${providerLabel}`;
    biblioteca.title = rotuloBiblioteca;
    biblioteca.setAttribute('aria-label', rotuloBiblioteca);
  }
  // «Pull» descarga un modelo con Ollama: fuera de Ollama no hace nada, así
  // que su fila no se enseña.
  const filaPull = el('btnPullLocal')?.closest?.('.more-actions-row');
  if (filaPull) filaPull.style.display = currentProvider === 'local' ? '' : 'none';

  if (providerPrivacy === 'private') {
    if (indicator) {
      indicator.className = 'privacy-indicator private';
      indicator.setAttribute('data-tooltip', t('privacy.tooltipPrivate'));
    }
    renderPrivacyBadge(badge, 'private', t('privacy.private'));
    if (apiKeyBtn) apiKeyBtn.style.display = 'none';
    // El rótulo es el del proveedor ELEGIDO, no «Ollama» para todo lo que sea
    // privado: llama.cpp y BitNet también lo son, y enseñar «Ollama (Local)»
    // con uno de ellos seleccionado decía que la petición iba a otro sitio.
    if (providerName) providerName.textContent = providerLabel;
    if (inputBanner) inputBanner.classList.remove('visible');
    if (footerEl) footerEl.textContent = t('footer.tagline');
    if (revokeButton) revokeButton.style.display = 'none';
  } else {
    if (indicator) {
      indicator.className = 'privacy-indicator cloud';
      indicator.setAttribute('data-tooltip', t('privacy.tooltipCloud'));
    }
    renderPrivacyBadge(badge, 'cloud', t('privacy.cloud'));
    if (apiKeyBtn) apiKeyBtn.style.display = currentProvider === 'local' ? 'none' : '';
    if (providerName) providerName.textContent = providerLabel;
    // El pie deja de repetir el aviso: sólo identifica el modo activo.
    if (footerEl) footerEl.textContent = t('footer.cloudCompact', { provider: providerLabel });
    if (revokeButton) revokeButton.style.display = 'none';
    if (inputBanner) {
      renderCloudInputBanner(providerLabel);
      // Visible por defecto: si la lectura del estado falla, se avisa igual.
      inputBanner.classList.add('visible');
    }
    const providerAtUpdate = currentProvider;
    const projectAtUpdate = activeProjectId;
    Promise.all([
      readCloudConsent(providerAtUpdate, projectAtUpdate),
      readCloudBannerDismissal(providerAtUpdate, projectAtUpdate)
    ]).then(([consent, dismissal]) => {
      if (currentProvider !== providerAtUpdate || activeProjectId !== projectAtUpdate) return;
      if (consent && badge) {
        // El indicador es compacto: la frase completa vive en el tooltip, no
        // dentro de una píldora que empujaría al resto de la barra.
        renderPrivacyBadge(badge, 'cloud', t('cloudConsent.authorizedBadge'));
        if (indicator) indicator.setAttribute('data-tooltip', t('cloudConsent.authorized'));
        if (revokeButton) revokeButton.style.display = '';
      }
      const silenced = Boolean(dismissal) && dismissal.fingerprint === cloudConsentFingerprint(consent);
      if (inputBanner && silenced) inputBanner.classList.remove('visible');
    }).catch(() => {});
  }
}

// Margen que se deja libre bajo el desplegable para que no muera pegado al
// borde inferior de la ventana.
const MARGEN_DESPLEGABLE = 16;

/**
 * Ajusta cuánto puede crecer el desplegable de proveedores antes de desplazarse
 * por dentro.
 *
 * El alto se MIDE, no se adivina. Antes era `max-height: calc(100vh - 96px)`
 * en CSS: una constante que codificaba una suposición sobre dónde empieza el
 * menú. El menú empieza en y=50, así que ese 96 reservaba 46 px de más y los
 * dejaba vacíos en cualquier ventana lo bastante baja como para recortar —
 * media fila de proveedor perdida sin motivo. Y si la cabecera cambia de alto,
 * la constante deja de valer sin que nada avise.
 *
 * Se llama al abrir y al redimensionar con el menú abierto.
 */
function ajustarAltoDesplegableProveedores() {
  const menu = el('providerOptions');
  if (!menu || menu.style.display === 'none' || !menu.style.display) return;
  const arriba = menu.getBoundingClientRect().top;
  // Sin suelo. Una versión anterior ponía `Math.max(120, ...)` para que el menú
  // no quedase ridículo en ventanas muy bajas, y eso rompía justo lo que esta
  // función existe para garantizar: por debajo de cierta altura el suelo ganaba,
  // el menú se comía el margen inferior y acababa saliéndose por abajo.
  //
  // Que el resultado sea utilizable no lo arregla un suelo aquí, sino el límite
  // de la ventana: `ALTO_MINIMO_VENTANA` en main.js está calculado para que a la
  // altura mínima soportada quepa una fila entera de proveedor. Por debajo de
  // eso Electron ya no deja encoger, así que el caso "menú de 20 px" no existe.
  // El único `Math.max` que queda es contra 0, porque un `max-height` negativo
  // no es CSS válido.
  //
  // Se trunca, no se redondea. El menú empieza en una coordenada fraccionaria en
  // cuanto las métricas de fuente no son las de Windows —en Linux arranca en
  // 49,x—, y redondear al alza produce un `max-height` mayor que el hueco real:
  // el menú se come una fracción del margen inferior. Medido en CI bajo Xvfb:
  // dejaba 15 px donde `MARGEN_DESPLEGABLE` declara 16. Truncar nunca excede el
  // espacio disponible.
  const disponible = window.innerHeight - arriba - MARGEN_DESPLEGABLE;
  menu.style.maxHeight = `${Math.max(0, Math.floor(disponible))}px`;
}

/** Abre o cierra el desplegable de proveedores. */
function toggleProviderMenu() {
  const menu = el('providerOptions');
  if (!menu) return;
  const cerrado = menu.style.display === 'none' || !menu.style.display;
  menu.style.display = cerrado ? 'block' : 'none';
  if (cerrado) {
    // El alto se calcula con el menú ya visible: en `display: none` no hay
    // caja que medir y `getBoundingClientRect()` devolvería ceros.
    ajustarAltoDesplegableProveedores();
    menu.scrollTop = 0;
  }
}

window.addEventListener('resize', ajustarAltoDesplegableProveedores);

async function switchProvider(providerId) {
  // El desplegable se cierra AQUÍ, antes de cualquier espera.
  //
  // Estaba al final, después de `await loadRuntime()`. Con un proveedor cloud
  // lento eso son segundos, y en ese hueco el cierre quedaba pendiente: si el
  // usuario volvía a abrir el menú mientras tanto, se le cerraba solo en cuanto
  // llegaba la respuesta. Además el menú se quedaba abierto durante toda la
  // carga, cuando la elección ya estaba hecha.
  const opts = el('providerOptions');
  if (opts) opts.style.display = 'none';

  try {
    const result = await window.mika5.ai.setProvider(providerId);
    currentProvider = providerId;
    providerLibraryUrl = result.libraryUrl || null;
    // El contrato del proveedor anterior no vale para el nuevo.
    await refreshProviderCapabilities();
    // El plan visual pendiente pertenece al proveedor anterior: no se arrastra.
    pendingVisualAction = null;
    providerPrivacy = result.privacy;

    updatePrivacyUI();
    await loadRuntime();
    if (result.privacy === 'cloud') {
      showToast(t('toast.cloudMode'), 'warning');
    } else {
      showToast(t('toast.privateMode'), 'success');
    }
    // El usuario acaba de elegir este proveedor: si le falta algo que sólo él
    // puede aportar, se le dice qué y se le deja a un clic. Es un aviso y no
    // un diálogo que se abra solo: elegir un proveedor no debe tapar la
    // ventana ni impedir elegir otro.
    guiarPreparacion();
  } catch (e) {
    showToast('Error: ' + (e?.message || e), 'error');
  }
}

const QUICK_CHAT_ID = 'quick-chat';

async function ensureQuickChat() {
  // Create the quick-chat project if it doesn't exist
  try {
    const projects = await Store.listProjects();
    if (!projects.find(p => p.id === QUICK_CHAT_ID)) {
      await window.mika5.db.createProject({ name: 'Quick Chat', description: '', _internal: QUICK_CHAT_ID });
    }
  } catch (e) {
    console.warn('ensureQuickChat error:', e);
  }
}

const PROJECT_ICONS = ['📁', '🏠', '💼', '🎯', '📚', '🔬', '🎨', '💻', '🌐', '🧠', '⚡', '🔧', '📊', '🎮', '🏗️', '📝'];
const PROJECT_COLORS = ['#3b82f6', '#22c55e', '#ef4444', '#eab308', '#a855f7', '#06b6d4', '#f97316', '#ec4899'];
const QUICK_CHAT_VISUAL = { icon: '💬', color: '#60a5fa' };
// Identidad estable para proyectos antiguos sin id: no se recurre al índice de
// la lista, que cambia al crear o borrar cualquier otro proyecto.
const PROJECT_VISUAL_FALLBACK_ID = 'proyecto-sin-id';

// Hash determinista (djb2 xor) sobre el identificador del proyecto. La misma
// entrada da siempre el mismo par icono/color, en cualquier orden de lista y en
// cualquier ventana.
function projectVisualHash(identity) {
  const texto = String(identity || PROJECT_VISUAL_FALLBACK_ID);
  let hash = 5381;
  for (let i = 0; i < texto.length; i++) {
    hash = ((hash * 33) ^ texto.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Icono y color por defecto de un proyecto. Depende sólo de su identidad: el
 * cálculo anterior usaba la posición en la lista, así que borrar o crear otro
 * proyecto repintaba los demás.
 */
function projectVisualDefaults(projectId) {
  if (projectId === QUICK_CHAT_ID) return { ...QUICK_CHAT_VISUAL };
  const hash = projectVisualHash(projectId);
  return {
    icon: PROJECT_ICONS[hash % PROJECT_ICONS.length],
    color: PROJECT_COLORS[Math.floor(hash / PROJECT_ICONS.length) % PROJECT_COLORS.length]
  };
}

/**
 * Visual efectivo de un proyecto: lo guardado por la usuaria manda siempre y no
 * se persiste nada aquí. El fallback sólo rellena lo que falta.
 */
function resolveProjectVisual(project) {
  const id = project?.id;
  const defaults = projectVisualDefaults(id);
  return {
    icon: project?.icon || defaults.icon,
    color: project?.color || defaults.color,
    isQuickChat: id === QUICK_CHAT_ID
  };
}

// Una sola fuente para la píldora del icono: antes se repetía el mismo cssText
// en el sidebar y en el diálogo de mover, con riesgo de divergir.
function applyProjectVisual(node, visual, { interactive = false } = {}) {
  node.classList.add('project-icon-btn');
  node.textContent = visual.icon;
  node.style.setProperty('--project-color', visual.color);
  node.style.cursor = interactive ? 'pointer' : 'default';
  return node;
}

async function loadProjects() {
  const projects = await withTimeout(Store.listProjects(), 8000, 'cargar proyectos');
  const list = el("projectList");
  list.replaceChildren();

  // Sort: Quick Chat first, then by created_at desc
  const sorted = projects.toSorted((a, b) => {
    if (a.id === QUICK_CHAT_ID) return -1;
    if (b.id === QUICK_CHAT_ID) return 1;
    return (b.created_at || 0) - (a.created_at || 0);
  });

  for (const p of sorted) {
    const visual = resolveProjectVisual(p);
    const isQC = visual.isQuickChat;
    const projColor = visual.color;
    const projIcon = visual.icon;

    const div = document.createElement("div");
    div.dataset.projectId = p.id;
    const isActiveProject = p.id === activeProjectId;
    div.className = "item project-item" + (isActiveProject ? " active" : "");
    // aria-current viaja con .active: el estado activo no queda sólo en el color.
    if (isActiveProject) div.setAttribute("aria-current", "true");
    else div.removeAttribute("aria-current");

    const iconBtn = applyProjectVisual(document.createElement("span"), visual, { interactive: !isQC });
    if (!isQC) {
      iconBtn.title = "Cambiar icono/color";
      iconBtn.onclick = (e) => { e.stopPropagation(); showProjectStylePicker(p.id, iconBtn, projIcon, projColor); };
    }

    const nameSpan = document.createElement("span");
    nameSpan.textContent = isQC ? (t('project.quickChat') || 'Quick Chat') : p.name;
    nameSpan.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:1.4;";

    div.onclick = (e) => {
      if (e.target.closest('.btn-icon, .knowledge-item-remove, .project-icon-btn')) return;
      if (isSwitchingView) return; // Prevent double-clicks during switch
      selectProject(p.id, isQC ? (t('project.quickChat') || 'Quick Chat') : p.name);
    };

    div.appendChild(iconBtn);
    div.appendChild(nameSpan);

    if (!isQC) {
      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
    renameBtn.className = "btn-icon knowledge-item-remove project-action-btn project-action-btn--rename";
      renameBtn.textContent = "✏️";
      renameBtn.style.cssText = "flex-shrink:0;padding:2px 6px;font-size:12px;";
      renameBtn.onclick = async (e) => {
        e.stopPropagation();
        const name = await mikaPrompt(t('modal.renameProject'), '', p.name);
        if (name == null || name.trim() === "") return;
        await Store.updateProject(p.id, { name: name.trim() });
        await loadProjects();
        if (activeProjectId === p.id) el("activeTitle").textContent = name.trim();
        showToast(t('toast.projectRenamed'), "success");
      };
      const delBtn = document.createElement("button");
      delBtn.type = "button";
    delBtn.className = "btn-icon knowledge-item-remove project-action-btn project-action-btn--delete";
      delBtn.textContent = "🗑";
      delBtn.style.cssText = "flex-shrink:0;padding:2px 6px;font-size:12px;";
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        const yes = await mikaConfirm(t('modal.deleteProject'), t('modal.deleteProjectMsg'), t('action.delete'));
        if (!yes) return;
        try {
          await Store.deleteProject(p.id);
          if (activeProjectId === p.id) { activeProjectId = null; activeChatId = null; el("chat").replaceChildren(); }
          await loadProjects();
          showToast(t('toast.projectDeleted'), "success");
        } catch (_) { showToast(t('toast.errorDelete'), "error"); }
      };
      div.appendChild(renameBtn);
      div.appendChild(delBtn);
    }
    list.appendChild(div);
  }
}

function showProjectStylePicker(projectId, iconBtnEl, currentIcon, currentColor) {
  document.querySelectorAll('.project-style-picker').forEach(p => p.remove());
  
  const picker = document.createElement('div');
  picker.className = 'project-style-picker';
  picker.style.cssText = 'position:absolute;left:0;top:100%;background:var(--bg-sidebar,#000208);border:1px solid var(--border-subtle);border-radius:10px;padding:10px;z-index:60;box-shadow:0 8px 24px rgba(0,0,0,0.4);width:200px;';
  
  // Color row
  const colorLabel = document.createElement('div');
  colorLabel.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:6px;';
  colorLabel.textContent = 'Color';
  picker.appendChild(colorLabel);
  
  const colorRow = document.createElement('div');
  colorRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px;';
  PROJECT_COLORS.forEach(color => {
    const dot = document.createElement('span');
    dot.style.cssText = `width:20px;height:20px;border-radius:6px;background:${color};cursor:pointer;border:2px solid ${color === currentColor ? '#fff' : 'transparent'};transition:transform 0.15s;`;
    dot.onclick = async (e) => {
      e.stopPropagation();
      try { await Store.updateProject(projectId, { color }); } catch(_){}
      picker.remove();
      await loadProjects();
    };
    colorRow.appendChild(dot);
  });
  picker.appendChild(colorRow);
  
  // Icon grid
  const iconLabel = document.createElement('div');
  iconLabel.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:6px;';
  iconLabel.textContent = 'Icono';
  picker.appendChild(iconLabel);
  
  const iconGrid = document.createElement('div');
  iconGrid.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
  PROJECT_ICONS.forEach(icon => {
    const btn = document.createElement('span');
    btn.style.cssText = `width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;font-size:16px;background:${icon === currentIcon ? 'var(--bg-hover,#0D1630)' : 'transparent'};border:1px solid ${icon === currentIcon ? 'var(--accent)' : 'transparent'};`;
    btn.textContent = icon;
    btn.onclick = async (e) => {
      e.stopPropagation();
      try { await Store.updateProject(projectId, { icon }); } catch(_){}
      picker.remove();
      await loadProjects();
    };
    iconGrid.appendChild(btn);
  });
  picker.appendChild(iconGrid);
  
  iconBtnEl.parentElement.style.position = 'relative';
  iconBtnEl.parentElement.appendChild(picker);
  
  setTimeout(() => {
    const close = (e) => { if (!picker.contains(e.target) && e.target !== iconBtnEl) { picker.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 10);
}

// Seleccionar un proyecto no repintaba la lista: el proyecto abierto se quedaba
// sin marcar hasta que algo llamara a loadProjects(). Se marca en el sitio, sin
// releer proyectos por IPC.
function markActiveProject(projectId) {
  const list = el("projectList");
  if (!list) return;
  for (const node of Array.from(list.children)) {
    const isActive = node.dataset.projectId === projectId;
    node.classList.toggle("active", isActive);
    if (isActive) node.setAttribute("aria-current", "true");
    else node.removeAttribute("aria-current");
  }
}

async function selectProject(projectId, name) {
  if (!projectId) { console.warn('[selectProject] Ignored: missing projectId'); return; }
  return safeViewChange(async (signal) => {
    console.log('[selectProject] START', projectId, name);

    // 1. IMMEDIATE SYNCHRONOUS UI CLEANUP
    // (draft already saved by resetViewState in safeViewChange)
    activeProjectId = projectId;
    activeChatId = null;
    chatAttachments = [];
    markActiveProject(projectId);

    const chatEl = el("chat");
    if (chatEl) {
      chatEl.replaceChildren();
    }

    el("activeTitle").textContent = name || "Proyecto";
    el("btnNewChat").disabled = false;
    el("btnSend").disabled = true;
    el("btnSaveChatDoc").disabled = true;
    const exp = el("btnExportChat");
    if (exp) exp.disabled = true;
    renderAttachmentPreview();

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    // 2. LOAD CHATS WITH TIMEOUT
    let chats = [];
    try {
      chats = await withTimeout(Store.listChats(activeProjectId), 5000, 'cargar chats del proyecto', signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn('[selectProject] Error cargando chats:', e);
      chats = [];
    }

    // Update chat list with debounce
    await new Promise((resolve) => {
      const id = setTimeout(async () => {
        try {
          if (!signal.aborted) await refreshChats();
        } catch (e) { console.warn('refreshChats error:', e); }
        resolve();
      }, 0);
      pendingTimeouts.push(id);
    });

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    // 3. OPEN OR CREATE CHAT
    if (!chats || chats.length === 0) {
      console.log('[selectProject] Creating initial chat...');
      try {
        const res = await withTimeout(Store.createChat(activeProjectId, "Chat"), 8000, 'crear chat inicial', signal);
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (res?.ok && res.id) {
          await openChatInternal(res.id, signal);
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.error('[selectProject] Error creating chat:', e);
        if (chatEl) {
          chatEl.replaceChildren();
          renderEmptyState(chatEl, 'no-chat');
        }
      }
    } else {
      console.log('[selectProject] Opening existing chat:', chats[0].id);
      await openChatInternal(chats[0].id, signal);
    }

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    // 4. SAVE STATE + LOAD CONTEXT/KNOWLEDGE (non-blocking, with timeout)
    try {
      await Promise.race([
        window.mika5.setAppState("lastProjectId", activeProjectId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
      ]);
    } catch (e) { console.warn('Error saving state:', e); }

    // Fire-and-forget — don't block UI
    Promise.all([
      loadProjectContext(),
      renderKnowledgeList()
    ]).catch(e => console.warn('Context/knowledge load error:', e));

    console.log('[selectProject] DONE');
  });
}

async function createProject() {
  const name = el("projectName").value.trim();
  if (!name) {
    showToast(t('toast.enterProjectName'), "error");
    el("projectName").focus();
    return;
  }
  const res = await Store.createProject(name);

  if (!res.ok) {
    showToast(t('toast.errorGeneric'), "error");
    return;
  }

  el("projectName").value = "";
  await loadProjects();
  const projects = await Store.listProjects();
  if (projects.length > 0) el("activeTitle").textContent = t('chat.selectProject');
  showToast(t('toast.projectCreated'), "success");
}

// El glifo es decorativo: el nombre accesible viene de i18n, no del emoji.
function buildChatActionButton({ glyph, label, className }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = label;
  button.setAttribute("aria-label", label);
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = glyph;
  button.appendChild(icon);
  return button;
}

async function refreshChats() {
  const list = document.getElementById("chatList");
  if (!list) return;

  list.replaceChildren();
  if (!activeProjectId) return;

  const chats = await withTimeout(Store.listChats(activeProjectId), 8000, 'cargar lista de chats');

  if (chats.length === 0) {
    // Marcador, no elemento seleccionable: nunca puede quedar activo.
    const empty = document.createElement("div");
    empty.className = "item item-placeholder";
    empty.setAttribute("aria-disabled", "true");
    empty.textContent = t('sidebar.noChats');
    list.appendChild(empty);
    return;
  }

  for (const c of chats) {
    const div = document.createElement("div");
    const isActiveChat = c.id === activeChatId;
    div.className = "item" + (isActiveChat ? " active" : "");
    if (isActiveChat) div.setAttribute("aria-current", "true");
    else div.removeAttribute("aria-current");
    div.style.display = "flex";
    div.style.alignItems = "center";
    div.style.gap = "6px";

    const titleSpan = document.createElement("span");
    titleSpan.textContent = c.title || "Chat";
    titleSpan.style.flex = "1";
    titleSpan.style.minWidth = "0";
    titleSpan.style.overflow = "hidden";
    titleSpan.style.textOverflow = "ellipsis";
    // Una sola línea: con las acciones ocupando su sitio, el título envolvía en
    // tres o cuatro renglones y la fila crecía a lo alto.
    titleSpan.style.whiteSpace = "nowrap";
    titleSpan.style.cursor = "pointer";

    // Un contenedor real: las tres acciones se revelan y se recorren juntas, y
    // el glifo queda fuera del nombre accesible (aria-label + title por i18n).
    const actions = document.createElement("div");
    actions.className = "item-actions";

    const renameBtn = buildChatActionButton({
      glyph: "✏️",
      label: t('action.renameChat'),
      className: "btn-icon knowledge-item-remove item-action-rename"
    });

    const moveBtn = buildChatActionButton({
      glyph: "→",
      label: t('action.moveChat'),
      className: "btn-icon item-action-move"
    });

    const delBtn = buildChatActionButton({
      glyph: "×",
      label: t('action.deleteChat'),
      className: "btn-icon knowledge-item-remove item-action-danger"
    });

    const openChatId = c.id;
    div.onclick = (e) => {
      if (e.target.closest('.btn-icon')) return;
      openChat(openChatId);
    };

    renameBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const newTitle = await mikaPrompt(t('modal.renameChat'), '', c.title || 'Chat');
      if (newTitle == null || newTitle.trim() === "") return;
      try {
        const res = await Store.updateChat(c.id, { title: newTitle.trim() });
        if (!res || !res.ok) {
          showToast("Error al renombrar: " + (res?.error || 'desconocido'), "error");
        } else {
          await refreshChats();
          showToast("Chat renombrado", "success");
        }
      } catch (err) {
        showToast("Error al renombrar: " + (err?.message || err), "error");
      }
    };

    moveBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        const projects = await Store.listProjects();
        // QUICK_CHAT_DESTINATION_POLICY: AMBIGUOUS.
        // El comentario histórico decía "can't move TO quick chat", pero el filtro
        // nunca excluyó QUICK_CHAT_ID y el bloque de opciones de abajo le da
        // etiqueta, icono y color propios — es decir, se pintaba a propósito.
        // `updateChat` tampoco lo ha restringido nunca. Sin un requisito de
        // producto confirmado, NO se cambia el comportamiento observable.
        const others = projects.filter((pr) => pr.id !== activeProjectId);

        if (others.length === 0) { 
          showToast(t('toast.noProjects') || 'No hay otros proyectos disponibles', "error"); 
          return; 
        }

        const selectOptions = others.map((pr) => {
          // Mismo helper que el sidebar: el proyecto se ve igual en los dos sitios.
          const visual = resolveProjectVisual(pr);
          return {
            label: visual.isQuickChat ? (t('project.quickChat') || 'Chat rápido') : pr.name,
            value: pr.id,
            icon: visual.icon,
            color: visual.color
          };
        });
        const targetId = await mikaSelect(t('modal.moveChat') || 'Mover chat a:', selectOptions);

        if (!targetId) return;

        const target = others.find(pr => pr.id === targetId);
        if (!target) { showToast("Proyecto no encontrado", "error"); return; }

        console.log('Moviendo chat', c.id, 'a proyecto', target.id);

        const res = await Store.updateChat(c.id, { projectId: target.id });

        if (!res || !res.ok) { 
          showToast("Error al mover: " + (res?.error || 'desconocido'), "error"); 
          return; 
        }

        if (activeChatId === c.id) {
          activeChatId = null;
          el("chat").replaceChildren();
          el("input").disabled = true;
          el("btnSend").disabled = true;
          const saveBtn = el("btnSaveChatDoc");
          if (saveBtn) saveBtn.disabled = true;
          const ex = el("btnExportChat");
          if (ex) ex.disabled = true;
        }

        await refreshChats();
        showToast(`Chat movido a "${target.name}"`, "success");
      } catch (err) {
        showToast("Error al mover: " + (err?.message || err), "error");
      }
    };

    delBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const yes = await mikaConfirm(t('modal.deleteChat'), t('modal.deleteChatMsg'), t('action.delete'));
      if (!yes) return;
      try {
        const wasActive = activeChatId === c.id;
        await Store.deleteChat(c.id);
        // Clean up per-chat tracking state
        chatDrafts.delete(c.id);
        await refreshChats();
        if (wasActive) {
          const chats = await Store.listChats(activeProjectId);
          if (chats && chats.length > 0) {
            await openChat(chats[0].id);
          } else {
            const res = await withTimeout(Store.createChat(activeProjectId, "Chat"), 8000, 'crear chat inicial');
            if (res && res.ok && res.id) await openChat(res.id);
            else {
              activeChatId = null;
              el("chat").replaceChildren();
              el("input").disabled = true;
              el("btnSend").disabled = true;
              el("btnSaveChatDoc").disabled = true;
              const ex = el("btnExportChat");
              if (ex) ex.disabled = true;
            }
          }
        }
        showToast("Chat eliminado", "success");
      } catch (_) {
        showToast("Error al eliminar", "error");
      }
    };

    const separator = document.createElement("span");
    separator.className = "item-actions-separator";
    separator.setAttribute("aria-hidden", "true");

    actions.appendChild(renameBtn);
    actions.appendChild(moveBtn);
    // Separador antes de eliminar: la acción destructiva no queda pegada a mover.
    actions.appendChild(separator);
    actions.appendChild(delBtn);

    div.appendChild(titleSpan);
    div.appendChild(actions);
    list.appendChild(div);
  }
}

// --- Pagination constants ---
const MESSAGES_PAGE_SIZE = 50;
let chatHasOlderMessages = false;
let chatOldestLoadedOffset = 0;

// openChatInternal: used inside safeViewChange (signal-aware, no guard)
async function openChatInternal(chatId, signal) {
  console.log('[openChat] START', chatId);

  // Draft already saved by resetViewState in safeViewChange
  activeChatId = chatId;
  _lastRenderedModel = null;
  chatHasOlderMessages = false;
  chatOldestLoadedOffset = 0;

  const chatEl = el("chat");
  if (chatEl) chatEl.replaceChildren();

  try {
    await refreshChats();
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const totalCount = await withTimeout(Store.countMessages(chatId), 5000, 'contar mensajes', signal);
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');

    let messages;
    if (totalCount > MESSAGES_PAGE_SIZE) {
      // Load only the most recent N messages
      const offset = totalCount - MESSAGES_PAGE_SIZE;
      messages = await withTimeout(
        Store.listMessages(chatId, { limit: MESSAGES_PAGE_SIZE, offset }),
        8000, 'cargar mensajes', signal
      );
      chatOldestLoadedOffset = offset;
      chatHasOlderMessages = offset > 0;
    } else {
      messages = await withTimeout(Store.listMessages(chatId), 8000, 'cargar mensajes', signal);
      chatOldestLoadedOffset = 0;
      chatHasOlderMessages = false;
    }

    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    console.log('[openChat] messages:', messages?.length, 'total:', totalCount);

    // Enrich messages with _replyTo data from DB
    if (messages && messages.length > 0) {
      // Build a local lookup of loaded messages for fast access
      const msgMap = {};
      for (const m of messages) { if (m.id) msgMap[m.id] = m; }

      for (const m of messages) {
        if (m.reply_to_id) {
          // Try local lookup first, then fetch from DB
          const ref = msgMap[m.reply_to_id];
          if (ref) {
            m._replyTo = { role: ref.role, content: ref.content, msgId: ref.id };
          } else {
            try {
              const fetched = await window.mika5.db.getMessage(m.reply_to_id);
              if (fetched) {
                m._replyTo = { role: fetched.role, content: fetched.content, msgId: fetched.id };
              }
            } catch (_) {}
          }
        }
      }
    }

    // Full history needed for AI context (load all for conversationHistory)
    let allMessages;
    if (totalCount > MESSAGES_PAGE_SIZE) {
      allMessages = await withTimeout(Store.listMessages(chatId), 10000, 'cargar historial completo', signal);
    } else {
      allMessages = messages;
    }
    conversationHistory = (allMessages || []).map((m) => ({ role: m.role, content: m.content }));
    // La persistencia no puede ser solo cosmética: al abrir el chat sus imágenes
    // vuelven a ser contexto visual utilizable. Se rehidrata desde el historial
    // COMPLETO, no desde la página pintada: una imagen de una página antigua
    // sigue siendo la referencia válida para "ahora ponlo verde".
    //
    // Barrera de identidad asíncrona: si mientras se cargaba este historial la
    // usuaria abrió otro chat, escribir aquí pisaría el contexto visual del chat
    // que ya está en pantalla con imágenes de otro. Se acota a la rehidratación
    // para no alterar el resto del ciclo de carga (que reactiva el input).
    if (!signal?.aborted && activeChatId === chatId) {
      rehydrateVisualContextFromMessages(allMessages, chatId);
    }

    // Render only the recent page, with "load more" button if needed
    renderMessagesSafe(messages, signal, chatHasOlderMessages);

    el("btnSaveChatDoc").disabled = false;
    const exp = el("btnExportChat");
    if (exp) exp.disabled = false;
    window.mika5.setAppState("lastChatId", activeChatId).catch(() => {});

    // Restore draft if one exists for this chat
    const draft = chatDrafts.get(chatId);
    const inputEl = el("input");
    if (draft) {
      chatAttachments = draft.attachments || [];
      if (inputEl) inputEl.value = draft.inputText || '';
      replyToMessage = draft.replyTo || null;
      chatDrafts.delete(chatId);
      renderAttachmentPreview();
      if (replyToMessage) {
        try {
          const replyBar = document.querySelector('.reply-bar');
          if (!replyBar) {
            // Re-show reply bar if function exists
            if (typeof setReplyTo === 'function') setReplyTo(replyToMessage);
          }
        } catch (_) {}
      }
    } else {
      chatAttachments = [];
      if (inputEl) inputEl.value = '';
      replyToMessage = null;
      renderAttachmentPreview();
      clearReplyTo();
    }
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    console.error("[openChat] ERROR:", error);
    showToast("Error al cargar el chat", "error");
    if (chatEl) {
      chatEl.replaceChildren();
      const loadError = document.createElement("div");
      loadError.className = "empty-chat-hint";
      loadError.textContent = t('chat.loadError');
      chatEl.appendChild(loadError);
    }
  }
  console.log('[openChat] DONE');
}

// Load older messages and prepend to chat
async function loadOlderMessages() {
  if (!activeChatId || !chatHasOlderMessages || chatOldestLoadedOffset <= 0) return;

  const chatEl = el("chat");
  if (!chatEl) return;

  const prevScrollHeight = chatEl.scrollHeight;

  const loadCount = Math.min(MESSAGES_PAGE_SIZE, chatOldestLoadedOffset);
  const newOffset = chatOldestLoadedOffset - loadCount;

  try {
    const olderMsgs = await Store.listMessages(activeChatId, { limit: loadCount, offset: newOffset });
    chatOldestLoadedOffset = newOffset;
    chatHasOlderMessages = newOffset > 0;

    // Sync conversationHistory: prepend older messages so AI has full context
    if (olderMsgs && olderMsgs.length > 0) {
      const olderForHistory = olderMsgs.map(m => ({ role: m.role, content: m.content }));
      conversationHistory = [...olderForHistory, ...conversationHistory];
    }

    // Enrich older messages with _replyTo
    if (olderMsgs && olderMsgs.length > 0) {
      const msgMap = {};
      for (const m of olderMsgs) { if (m.id) msgMap[m.id] = m; }
      for (const m of olderMsgs) {
        if (m.reply_to_id) {
          const ref = msgMap[m.reply_to_id];
          if (ref) {
            m._replyTo = { role: ref.role, content: ref.content, msgId: ref.id };
          } else {
            try {
              const fetched = await window.mika5.db.getMessage(m.reply_to_id);
              if (fetched) {
                m._replyTo = { role: fetched.role, content: fetched.content, msgId: fetched.id };
              }
            } catch (_) {}
          }
        }
      }
    }

    // Remove existing "load more" button
    const existingBtn = chatEl.querySelector('.load-more-btn');
    if (existingBtn) existingBtn.remove();

    // Prepend messages
    const fragment = document.createDocumentFragment();

    // Add new "load more" button if still needed
    if (chatHasOlderMessages) {
      const btn = document.createElement("button");
      btn.className = "load-more-btn";
      btn.textContent = `Cargar mensajes anteriores (${newOffset} restantes)`;
      btn.addEventListener("click", loadOlderMessages);
      fragment.appendChild(btn);
    }

    for (const msg of olderMsgs) {
      try { appendMsg(msg, fragment); } catch (e) { console.warn("appendMsg error:", e.message); }
    }

    chatEl.insertBefore(fragment, chatEl.firstChild?.nextSibling || chatEl.firstChild);

    // Preserve scroll position
    chatEl.scrollTop = chatEl.scrollHeight - prevScrollHeight;
  } catch (e) {
    console.error("[loadOlderMessages] ERROR:", e);
    showToast("Error al cargar mensajes anteriores", "error");
  }
}

// openChat: external use (from chat list clicks) — wrapped in safeViewChange
async function openChat(chatId) {
  const chatEl = el("chat");
  if (activeChatId === chatId && chatEl && chatEl.children.length > 0) return;
  return safeViewChange(async (signal) => {
    await openChatInternal(chatId, signal);
    // Reload context panel when switching chats in quick-chat (per-chat context)
    if (activeProjectId === QUICK_CHAT_ID) {
      Promise.all([loadProjectContext(), renderKnowledgeList()]).catch(() => {});
    }
  });
}

// Estado vacío diseñado. Dos variantes:
//   'empty-chat' — hay chat abierto sin mensajes: el CTA enfoca #input.
//   'no-chat'    — no hay chat seleccionado: el CTA usa newChat().
// El CTA reutiliza siempre la ruta existente; no hay segunda implementación.
function renderEmptyState(container, variant = 'empty-chat') {
  if (!container) return null;
  const isNoChat = variant === 'no-chat';

  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state';

  const logo = document.createElement('img');
  logo.className = 'empty-logo';
  logo.src = './assets/logo.png';
  logo.alt = 'MIKA5';
  wrapper.appendChild(logo);

  const title = document.createElement('div');
  title.className = 'empty-title';
  title.textContent = isNoChat ? t('empty.noChatTitle') : t('empty.title');
  wrapper.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.className = 'empty-subtitle';
  subtitle.textContent = isNoChat ? t('empty.noChatSubtitle') : t('empty.subtitle');
  wrapper.appendChild(subtitle);

  const cta = document.createElement('button');
  cta.type = 'button';
  cta.className = 'btn-primary empty-cta';
  cta.textContent = isNoChat ? t('empty.ctaNewChat') : t('empty.ctaStart');
  cta.addEventListener('click', () => {
    if (isNoChat) {
      newChat();
      return;
    }
    const input = el('input');
    if (input) { input.disabled = false; try { input.focus(); } catch (_) {} }
  });
  wrapper.appendChild(cta);

  if (!isNoChat) {
    const chips = document.createElement('div');
    chips.className = 'suggestion-chips';
    for (const key of ['empty.suggestion1', 'empty.suggestion2', 'empty.suggestion3']) {
      const text = t(key);
      if (!text || text === key) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'suggestion-chip';
      chip.textContent = text;
      chip.addEventListener('click', () => {
        const input = el('input');
        if (!input) return;
        input.disabled = false;
        input.value = text;
        try { input.focus(); } catch (_) {}
        try { updateSendButtonState(); } catch (_) {}
      });
      chips.appendChild(chip);
    }
    if (chips.children.length) wrapper.appendChild(chips);
  }

  container.appendChild(wrapper);
  return wrapper;
}

// renderMessagesSafe: DocumentFragment + abort signal + tracked setTimeout + load-more
function renderMessagesSafe(messages, signal, showLoadMore) {
  const chatEl = el("chat");
  const input = el("input");

  if (!chatEl) {
    if (input) input.disabled = false;
    return;
  }

  chatEl.replaceChildren();

  if (!Array.isArray(messages) || messages.length === 0) {
    // Orden contractual: 1) pintar 2) habilitar 3) enfocar 4) recalcular envío.
    if (messages?.length === 0) {
      renderEmptyState(chatEl, 'empty-chat');
    } else {
      const hint = document.createElement("div");
      hint.className = "empty-chat-hint";
      hint.textContent = t('chat.loadError');
      chatEl.appendChild(hint);
    }
    if (input) { input.disabled = false; try { input.focus(); } catch(e) {} }
    try { updateSendButtonState(); } catch(e) {}
    return;
  }

  // "Load more" button at the top if there are older messages
  if (showLoadMore) {
    const btn = document.createElement("button");
    btn.className = "load-more-btn";
    btn.textContent = `Cargar mensajes anteriores (${chatOldestLoadedOffset} restantes)`;
    btn.addEventListener("click", loadOlderMessages);
    chatEl.appendChild(btn);
  }

  const BATCH_SIZE = 5;
  let index = 0;
  let cancelled = false;

  // Cancel rendering if the signal is aborted (view change during render)
  if (signal) {
    signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
    if (signal.aborted) return;
  }

  function renderBatch() {
    if (cancelled || (signal && signal.aborted)) return;

    const fragment = document.createDocumentFragment();
    const end = Math.min(index + BATCH_SIZE, messages.length);

    for (let i = index; i < end; i++) {
      try {
        appendMsg(messages[i], fragment);
      } catch (e) {
        console.warn("appendMsg error:", e.message);
      }
    }

    if (cancelled || (signal && signal.aborted)) return;

    chatEl.appendChild(fragment);
    index = end;

    if (index < messages.length && !cancelled) {
      const tid = setTimeout(renderBatch, 0);
      pendingTimeouts.push(tid);
    } else if (!cancelled) {
      // All done — single scroll at the end
      chatEl.scrollTop = chatEl.scrollHeight;
      if (input) { input.disabled = false; try { input.focus(); } catch(e) {} }
      try { updateSendButtonState(); } catch(e) {}
    }
  }

  const tid = setTimeout(renderBatch, 0);
  pendingTimeouts.push(tid);
}

// Legacy wrapper for code that still calls renderMessages
function renderMessages(messages) {
  renderMessagesSafe(messages, null);
}

async function loadProjectContext() {
  const input = el("projectContextInput");
  const btnAdd = el("btnAddKnowledge");
  if (!input) return;
  if (!activeProjectId) {
    input.value = "";
    input.disabled = true;
    if (btnAdd) btnAdd.disabled = true;
    return;
  }
  // For quick-chat, require an active chat to enable per-chat context
  if (activeProjectId === QUICK_CHAT_ID && !activeChatId) {
    input.value = "";
    input.disabled = true;
    if (btnAdd) btnAdd.disabled = true;
    return;
  }
  input.disabled = false;
  if (btnAdd) btnAdd.disabled = false;

  // Update placeholder based on context type
  const isChat = activeProjectId === QUICK_CHAT_ID;
  input.placeholder = isChat
    ? (t('context.chatSystemPromptPlaceholder') || 'Define cómo debe comportarse la IA en este chat...')
    : (t('context.systemPromptPlaceholder') || 'Define cómo debe comportarse la IA en este proyecto...');

  try {
    let text;
    if (isChat && activeChatId) {
      text = await window.mika5.db.getChatContext(activeChatId);
    } else {
      text = await window.mika5.db.getProjectContext(activeProjectId);
    }
    input.value = text || "";
  } catch (_) {
    input.value = "";
  }
}

async function saveProjectContext() {
  if (!activeProjectId) return;
  const input = el("projectContextInput");
  if (!input) return;
  try {
    if (activeProjectId === QUICK_CHAT_ID && activeChatId) {
      await window.mika5.db.setChatContext(activeChatId, input.value.trim());
    } else {
      await window.mika5.db.setProjectContext(activeProjectId, input.value.trim());
    }
    showToast("Instrucciones guardadas", "success");
  } catch (_) {
    showToast("Error al guardar", "error");
  }
}

async function renderKnowledgeList() {
  const list = el("knowledgeList");
  if (!list) return;
  list.replaceChildren();
  if (!activeProjectId) {
    list.innerHTML = '<div class="context-hint">Selecciona un proyecto para gestionar la base de conocimiento.</div>';
    return;
  }
  if (activeProjectId === QUICK_CHAT_ID && !activeChatId) {
    list.innerHTML = '<div class="context-hint">Selecciona un chat para gestionar su base de conocimiento.</div>';
    return;
  }
  try {
    // Quick Chat: sólo los documentos del chat. Proyecto normal: los del
    // proyecto MÁS los del chat actual (un chat movido desde Quick Chat trae los
    // suyos, y sin esto quedaban invisibles e imborrables desde el panel).
    const isQuickChatPanel = activeProjectId === QUICK_CHAT_ID;
    const items = await window.mika5.db.listKnowledge(activeProjectId, activeChatId || null, {
      includeProjectScope: !isQuickChatPanel
    });
    if (!items || items.length === 0) {
      list.innerHTML = '<div class="context-hint">Sin archivos. Añade archivos de texto.</div>';
      return;
    }
    for (const it of items) {
      const div = document.createElement("div");
      div.className = "knowledge-item";
      const STATUS_MAP = {
        indexed:  { icon: '✓', color: '#22c55e', titleKey: 'knowledge.statusReady' },
        ready:    { icon: '✓', color: '#22c55e', titleKey: 'knowledge.statusReady' },
        error:    { icon: '✗', color: '#ef4444', titleKey: 'knowledge.statusError' },
        indexing: { icon: '⏳', color: '#eab308', titleKey: 'knowledge.statusPending' },
        pending:  { icon: '⏳', color: '#eab308', titleKey: 'knowledge.statusPending' }
      };
      const s = STATUS_MAP[it.index_status] || STATUS_MAP.pending;
      const statusTitle = s.titleKey === 'knowledge.statusError' ? `${t(s.titleKey)}: ${it.index_error || '?'}` : t(s.titleKey);
      div.innerHTML = `<span class="knowledge-item-status" title="${statusTitle}" style="color:${s.color};margin-right:4px;font-size:0.75rem">${s.icon}</span><span class="knowledge-item-name" title="${(it.title || "").replace(/"/g, "&quot;")}">${escapeHtml(it.title || "Sin título")}</span><button type="button" class="knowledge-item-remove" data-id="${escapeHtml(it.id)}" aria-label="Eliminar">×</button>`;
      div.querySelector(".knowledge-item-remove").onclick = async () => {
        try {
          await window.mika5.db.deleteKnowledge(it.id);
          await renderKnowledgeList();
          showToast("Archivo eliminado del conocimiento", "success");
        } catch (_) {
          showToast("Error al eliminar", "error");
        }
      };
      list.appendChild(div);
    }
  } catch (_) {
    list.innerHTML = '<div class="context-hint">Error al cargar.</div>';
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function applyTranslations() {
  // Apply i18n to static UI elements
  const map = {
    'projectName': { attr: 'placeholder', key: 'sidebar.projectName' },
    'input': { attr: 'placeholder', key: 'chat.placeholder' },
  };
  for (const [id, cfg] of Object.entries(map)) {
    const elem = el(id);
    if (elem) elem[cfg.attr] = t(cfg.key);
  }
  // Footer: por id. El selector estructural dependía de un style inline que ya
  // no existe y dejaba el pie sin traducir.
  const footer = el('footerStatus');
  if (footer && providerPrivacy !== 'cloud') footer.textContent = t('footer.tagline');
  // Section titles
  document.querySelectorAll('.section-title > span').forEach(span => {
    if (span.textContent.includes('PROYECTO') || span.textContent.includes('PROJECT')) span.textContent = t('sidebar.projects');
    if (span.textContent.includes('CHAT') ) span.textContent = t('sidebar.recentChats');
  });
  // Buttons
  const sendBtn = el('btnSend');
  if (sendBtn && !isGenerating) {
    const svgContent = sendBtn.querySelector('svg')?.outerHTML || '';
    sendBtn.innerHTML = svgContent + ' ' + t('action.send');
  }
  const moreActionsBtn = el('btnMoreActions');
  if (moreActionsBtn) {
    moreActionsBtn.setAttribute('aria-label', t('header.moreActions'));
    moreActionsBtn.title = t('header.moreActions');
  }
  // Rótulos que se escriben desde JS: su texto se congela al pintarse, así que
  // cambiar de idioma tiene que repintarlos o se quedan en el idioma anterior.
  renderSessionLabels();
  renderInstalledVersion().catch(e => console.warn('renderInstalledVersion:', e));
}

function toggleContextPanel() {
  const panel = el("contextPanel");
  if (!panel) return;
  panel.classList.toggle("open");
  // Update panel header based on context type
  const headerSpan = panel.querySelector('.context-panel-header span');
  if (headerSpan) {
    headerSpan.textContent = (activeProjectId === QUICK_CHAT_ID)
      ? (t('context.chatTitle') || 'Contexto del chat')
      : (t('context.title') || 'Contexto del proyecto');
  }
  if (panel.classList.contains("open") && activeProjectId) {
    loadProjectContext();
    renderKnowledgeList();
  }
}

async function newChat() {
  if (!activeProjectId) return;

  const res = await withTimeout(Store.createChat(activeProjectId, "Chat"), 8000, 'crear chat inicial');
  if (res?.ok && res.id) {
    await openChat(res.id);
  } else {
    showToast("No se pudo crear el chat.", "error");
  }
}

let _lastRenderedModel = null; // Track last model for change indicators

// Errores atómicos de la BD traducidos a algo accionable. Un turno rechazado no
// se escribe: ni el texto ni la imagen.
const ATTACHMENT_SAVE_ERRORS = {
  ATTACHMENT_TOO_LARGE: 'La imagen supera el máximo permitido. El mensaje no se guardó: reduce su tamaño y reenvíalo.',
  ATTACHMENTS_TOTAL_TOO_LARGE: 'Las imágenes juntas superan el máximo por mensaje. No se guardó nada: envíalas por separado.',
  ATTACHMENTS_PAYLOAD_TOO_LARGE: 'El mensaje con sus imágenes es demasiado grande para guardarse.',
  TOO_MANY_ATTACHMENTS: 'Demasiadas imágenes en un solo mensaje. No se guardó nada.',
  ATTACHMENT_INVALID: 'Una de las imágenes no se pudo guardar y el mensaje se descartó entero para no perderla en silencio.'
};

/**
 * Barrera transaccional del turno del usuario.
 *
 * La BD es el gate PREVIO a cualquier llamada externa. Antes, varios caminos
 * hacían `await Store.addMessage(...)` y seguían aunque devolviera ok:false:
 * el texto y los adjuntos se limpiaban, se llamaba al proveedor y el turno
 * parecía enviado — pero al reiniciar no existía, porque nunca se guardó.
 *
 * Devuelve { ok: true, messageId } o { ok: false, error }.
 * Llama a Store.addMessage exactamente una vez y es el ÚNICO sitio que avisa
 * del fallo: Store.addMessage ya no muestra toast (habría dos por fallo).
 */
async function persistUserTurn({ requestContext, content, model, replyToId, attachments }) {
  const chatId = requestContext?.chatId || activeChatId;
  let result;
  try {
    result = await Store.addMessage(
      chatId, 'user', content, replyToId || null, model || null, attachments || null
    );
  } catch (error) {
    console.warn('persistUserTurn falló:', error?.name || 'Error');
    result = { ok: false, error: 'PERSIST_FAILED' };
  }
  if (result?.ok) return { ok: true, messageId: result.id };
  const error = result?.error || 'PERSIST_FAILED';
  showToast(
    ATTACHMENT_SAVE_ERRORS[error]
      || 'No se pudo guardar el mensaje, así que no se envió. Tu texto y tus adjuntos siguen aquí.',
    'error'
  );
  return { ok: false, error };
}

// Respuestas del asistente que se generaron pero no pudieron guardarse. Se
// conservan durante la sesión para reintentar SOLO la escritura: el proveedor
// ya cobró la petición y no se le vuelve a llamar.
const unsavedAssistantMessages = [];
let unsavedAssistantSeq = 0;
// Promesas en vuelo por entryId. Dos clics simultáneos comparten la misma
// promesa, así que nunca se ejecutan dos INSERT para la misma respuesta.
const unsavedRetryInFlight = new Map();

function findUnsavedEntry(entryId) {
  return unsavedAssistantMessages.find(entry => entry.id === entryId) || null;
}

// El payload se congela al encolar: si `attachments` se mutara después (el
// array vive en el flujo visual), el reintento escribiría algo distinto de lo
// que se mostró.
function freezeAttachmentsSnapshot(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  return attachments.map(item => Object.freeze({ ...item }));
}

function enqueueUnsavedAssistantMessage({
  chatId, content, model, attachments, replyToId, renderedMsgId, error
}) {
  const entry = {
    id: `unsaved-${++unsavedAssistantSeq}`,
    chatId,
    content,
    model: model || null,
    attachments: freezeAttachmentsSnapshot(attachments),
    replyToId: replyToId || null,
    renderedMsgId: renderedMsgId || null,
    error,
    attempts: 0,
    createdAt: Date.now(),
    status: 'pending',
    messageId: null
  };
  unsavedAssistantMessages.push(entry);
  return entry;
}

// Solo se toca el DOM si la burbuja sigue existiendo Y pertenece al chat de la
// entrada. Un reintento que termina con otro chat en pantalla escribe igual,
// pero no altera burbujas ajenas: al reabrir el chat la respuesta vendrá de SQLite.
function unsavedBadgeFor(entry) {
  if (!entry?.renderedMsgId || activeChatId !== entry.chatId) return null;
  const bubble = el("chat")?.querySelector(`[data-msg-id="${entry.renderedMsgId}"]`);
  return bubble?.querySelector('.msg-unsaved') || null;
}

function renderUnsavedBadgeState(entry, state) {
  const badge = unsavedBadgeFor(entry);
  if (!badge) return;
  const label = badge.querySelector('.msg-unsaved-text');
  const button = badge.querySelector('.msg-unsaved-retry');
  if (state === 'retrying') {
    if (label) label.textContent = '⏳ Guardando…';
    if (button) { button.disabled = true; button.textContent = 'Guardando…'; }
    return;
  }
  if (state === 'failed') {
    if (label) label.textContent = '⚠️ No se pudo guardar';
    if (button) { button.disabled = false; button.textContent = 'Reintentar guardado'; }
    return;
  }
  if (state === 'saved') {
    badge.classList.add('msg-unsaved-ok');
    if (button) button.remove();
    if (label) label.textContent = '✅ Guardado';
    // El aviso desaparece solo: dejarlo fijo sugeriría que algo sigue mal.
    const toRemove = badge;
    setTimeout(() => { try { toRemove.remove(); } catch (_) {} }, 2500);
  }
}

// Marcador con estado y control por mensaje. Todo con createElement: el
// contenido es dinámico y no puede pasar por innerHTML.
function markMessageAsUnsaved(entry) {
  if (!entry?.renderedMsgId || activeChatId !== entry.chatId) return null;
  const bubble = el("chat")?.querySelector(`[data-msg-id="${entry.renderedMsgId}"]`);
  if (!bubble || bubble.querySelector('.msg-unsaved')) return null;

  const badge = document.createElement('div');
  badge.className = 'msg-unsaved';
  badge.dataset.unsavedId = entry.id;

  const label = document.createElement('span');
  label.className = 'msg-unsaved-text';
  label.textContent = '⚠️ No guardado — se perderá al reiniciar';
  badge.appendChild(label);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'msg-unsaved-retry';
  button.textContent = 'Reintentar guardado';
  button.setAttribute('aria-label', 'Reintentar guardar esta respuesta');
  button.addEventListener('click', () => {
    // El propio reintento deshabilita el botón; además comparte promesa en vuelo.
    retryUnsavedAssistantMessage(entry.id);
  });
  badge.appendChild(button);

  bubble.appendChild(badge);
  return badge;
}

/**
 * Persistencia del turno del asistente. A diferencia del usuario, aquí el
 * proveedor YA respondió: la respuesta se muestra igual, pero marcada como no
 * guardada para no afirmar que sobrevivirá al reinicio.
 */
async function persistAssistantTurn({
  chatId, content, model, attachments, replyToId, renderedMsgId
}) {
  let result;
  try {
    result = await Store.addMessage(
      chatId, 'assistant', content, replyToId || null, model || null, attachments || null
    );
  } catch (error) {
    console.warn('persistAssistantTurn falló:', error?.name || 'Error');
    result = { ok: false, error: 'PERSIST_FAILED' };
  }
  if (result?.ok) return { ok: true, messageId: result.id };
  const error = result?.error || 'PERSIST_FAILED';
  const entry = enqueueUnsavedAssistantMessage({
    chatId, content, model, attachments, replyToId, renderedMsgId, error
  });
  markMessageAsUnsaved(entry);
  showToast(
    `${ATTACHMENT_SAVE_ERRORS[error] || 'No se pudo guardar la respuesta.'} `
    + 'La respuesta sigue visible pero no se guardó.',
    'error'
  );
  return { ok: false, error, entryId: entry.id };
}

/**
 * Reintenta SOLO la escritura de una respuesta concreta. Nunca vuelve a llamar
 * al proveedor: la respuesta ya se generó y se pagó.
 *
 * Idempotente: si ya hay un intento en vuelo para ese id, devuelve la MISMA
 * promesa en vez de lanzar un segundo INSERT. Si la entrada ya no está en la
 * cola, devuelve un resultado estable sin escribir.
 *
 * La entrada nunca se saca de la cola antes de escribir: solo se elimina tras
 * un éxito confirmado. Una excepción no puede perderla.
 */
function retryUnsavedAssistantMessage(entryId) {
  const inFlight = unsavedRetryInFlight.get(entryId);
  if (inFlight) return inFlight;

  const entry = findUnsavedEntry(entryId);
  if (!entry) return Promise.resolve({ ok: true, alreadyResolved: true });

  const attempt = (async () => {
    entry.status = 'retrying';
    entry.attempts += 1;
    renderUnsavedBadgeState(entry, 'retrying');
    let result;
    try {
      result = await Store.addMessage(
        entry.chatId, 'assistant', entry.content, entry.replyToId,
        entry.model, entry.attachments
      );
    } catch (error) {
      // Una excepción deja la entrada intacta y reintentable.
      console.warn('retryUnsavedAssistantMessage lanzó:', error?.name || 'Error');
      result = { ok: false, error: 'PERSIST_THREW' };
    }
    if (result?.ok) {
      entry.status = 'saved';
      entry.messageId = result.id || null;
      const index = unsavedAssistantMessages.indexOf(entry);
      if (index >= 0) unsavedAssistantMessages.splice(index, 1);
      renderUnsavedBadgeState(entry, 'saved');
      return { ok: true, entryId, messageId: entry.messageId };
    }
    entry.status = 'pending';
    entry.error = result?.error || 'PERSIST_FAILED';
    renderUnsavedBadgeState(entry, 'failed');
    return { ok: false, entryId, error: entry.error, attempts: entry.attempts };
  })().finally(() => {
    unsavedRetryInFlight.delete(entryId);
  });

  unsavedRetryInFlight.set(entryId, attempt);
  return attempt;
}

/**
 * Reintenta todas las pendientes de forma AISLADA: el fallo o la excepción de
 * una no impide procesar las demás.
 */
async function retryAllUnsavedAssistantMessages() {
  const ids = unsavedAssistantMessages.map(entry => entry.id);
  let saved = 0;
  let stillFailing = 0;
  for (const id of ids) {
    let result;
    try {
      result = await retryUnsavedAssistantMessage(id);
    } catch (_) {
      result = { ok: false };
    }
    if (result?.ok) saved++;
    else stillFailing++;
  }
  return { attempted: ids.length, saved, stillFailing };
}

// Forma mínima con la que un adjunto viaja a la BD y vuelve para repintarse.
// Se toma un snapshot ANTES de vaciar chatAttachments: después ya no existe.
function snapshotMessageAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter(item => item && item.type === 'image')
    .map(item => ({
      name: item.name || 'imagen',
      mediaType: item.mediaType || null,
      base64: item.base64 || null,
      url: item.url || null,
      visualEntryId: item.visualEntryId || null
    }));
}

// SQLite devuelve la columna como texto; en memoria ya es un array.
function parseStoredAttachments(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function attachmentPreviewSrc(attachment) {
  if (attachment?.url) return attachment.url;
  if (!attachment?.base64) return null;
  // El mediaType viene de una lista cerrada validada en db.js; aun así se
  // normaliza aquí para no construir un data: con un tipo arbitrario.
  const mediaType = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp']
    .includes(String(attachment.mediaType || '').toLowerCase())
    ? attachment.mediaType
    : 'image/png';
  return `data:${mediaType};base64,${attachment.base64}`;
}

// Miniaturas dentro de la burbuja. Todo con createElement: nada de innerHTML
// con datos que vienen de un archivo del usuario o de la BD.
function appendMessageAttachments(bubble, attachments) {
  const items = (Array.isArray(attachments) ? attachments : [])
    .map(item => ({ ...item, src: attachmentPreviewSrc(item) }))
    .filter(item => item.src);
  if (!items.length) return null;

  const gallery = document.createElement('div');
  gallery.className = 'msg-attachments';
  for (const item of items) {
    const figure = document.createElement('div');
    figure.className = 'msg-attachment';
    if (item.visualEntryId) figure.dataset.visualEntryId = item.visualEntryId;

    const img = document.createElement('img');
    img.className = 'embedded-image-preview';
    img.src = item.src;
    img.alt = item.name || 'Imagen adjunta';
    img.title = item.name || 'Imagen adjunta';
    img.addEventListener('click', () => openImageViewer(item.src, item.name));
    figure.appendChild(img);

    const caption = document.createElement('span');
    caption.className = 'msg-attachment-name';
    caption.textContent = item.name || 'Imagen adjunta';
    figure.appendChild(caption);

    gallery.appendChild(figure);
  }
  bubble.appendChild(gallery);
  return gallery;
}

function appendMsg(msg, target) {
  const role = msg.role;
  const content = msg.content || "";
  const msgModel = msg.model || null;
  const msgId = msg.id || ('msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));

  // Insert model-change indicator if model switched
  const container = target || el("chat");

  // El estado vacío lo pinta `renderMessages()` cuando el chat no tiene
  // mensajes, y sólo esa función lo retiraba, al repintar de cero. Aquí se
  // añade un turno con `appendChild()` sobre el mismo contenedor, así que sin
  // esta línea «Empieza la conversación» y sus sugerencias se quedaban por
  // encima de la conversación recién iniciada hasta que el usuario cambiaba de
  // chat y volvía. Se retira en el primer mensaje que llega, venga del envío,
  // de una respuesta o de una restauración.
  //
  // No aplica cuando `target` es un DocumentFragment —el camino de
  // `renderMessages()`—: allí no hay estado vacío que quitar y la consulta no
  // encuentra nada.
  if (container && typeof container.querySelector === 'function') {
    const vacio = container.querySelector('.empty-state');
    if (vacio) vacio.remove();
  }

  if (msgModel && _lastRenderedModel && msgModel !== _lastRenderedModel && container) {
    const indicator = document.createElement("div");
    indicator.className = "model-change-indicator";
    indicator.innerHTML = `<span class="model-change-line"></span><span class="model-change-label">${escapeHtml(msgModel)}</span><span class="model-change-line"></span>`;
    container.appendChild(indicator);
  }
  if (msgModel) _lastRenderedModel = msgModel;

  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.dataset.msgId = msgId;
  if (msgModel) div.dataset.model = msgModel;

  // Render reply quote if this message is replying to another
  if (msg._replyTo) {
    const quote = document.createElement("div");
    quote.className = "msg-reply-quote";
    quote.innerHTML = `<div class="reply-role">${escapeHtml(msg._replyTo.role === 'user' ? 'Usuario' : 'Asistente')}</div><div class="reply-text">${escapeHtml(msg._replyTo.content || '')}</div>`;
    if (msg._replyTo.msgId) {
      quote.addEventListener("click", () => scrollToMessage(msg._replyTo.msgId));
    }
    div.appendChild(quote);
  }

  const contentEl = document.createElement("div");
  contentEl.className = "msg-content";
  // Persisted attachments came from an explicit upload/generation action;
  // arbitrary URLs in model-authored Markdown receive no such authorization.
  rememberApprovedImages(parseStoredAttachments(msg.attachments ?? msg.images).map(item => item?.url));

  try {
    contentEl.innerHTML = renderMarkdown(content);
    wrapTablesResponsive(contentEl);
    highlightCodeBlocks(contentEl);
    addCopyButtonsToCodeBlocks(contentEl);
    enhanceMessageImages(contentEl, { role, model: msgModel, msgId });
  } catch (e) {
    console.warn('Markdown render error:', e.message);
    contentEl.textContent = content;
  }
  div.appendChild(contentEl);
  // Al recargar el chat, `attachments` llega como TEXT desde SQLite.
  appendMessageAttachments(div, parseStoredAttachments(msg.attachments ?? msg.images));

  // Actions for ALL messages (copy)
  const actions = document.createElement("div");
  actions.className = "msg-actions";

  const copyBtn = document.createElement("button");
  copyBtn.className = "btn-save-message";
  copyBtn.textContent = t('action.copy');
  copyBtn.type = "button";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(sanitizeMessageForClipboard(content)).then(
      () => showToast(t('toast.copied'), "success"),
      () => showToast("Error", "error")
    );
  });
  actions.appendChild(copyBtn);

  // Reply button — WhatsApp-style reply to this message
  const replyBtn = document.createElement("button");
  replyBtn.className = "btn-save-message";
  replyBtn.textContent = "Responder";
  replyBtn.type = "button";
  replyBtn.addEventListener("click", () => {
    setReplyTo({ role, content, msgId });
  });
  actions.appendChild(replyBtn);

  // Save as doc — only for assistant messages
  if (role === "assistant") {
    const btn = document.createElement("button");
    btn.className = "btn-save-message";
    btn.textContent = t('action.saveAsDoc');
    btn.type = "button";
    btn.addEventListener("click", async () => {
      if (!activeProjectId) {
        showToast("Selecciona un proyecto primero", "error");
        return;
      }
      const suggestedTitle = generateSmartTitle(content);
      const title = await mikaPrompt('Guardar como documento', 'Título del documento:', suggestedTitle);
      if (title == null || title.trim() === "") return;
      btn.disabled = true;
      try {
        const savePayload = {
          projectId: activeProjectId,
          title: title.trim(),
          content,
          mimeType: "text/markdown"
        };
        if (activeProjectId === QUICK_CHAT_ID && activeChatId) {
          savePayload.chatId = activeChatId;
        }
        const result = await saveDocument(savePayload);
        if (!result.ok) {
          showToast("Error: " + (result.error || "desconocido"), "error");
          return;
        }
        showToast("Documento guardado en Knowledge.", "success");
        await renderKnowledgeList();
      } finally {
        btn.disabled = false;
      }
    });
    actions.appendChild(btn);
  }

  // Model badge for assistant messages
  if (role === "assistant" && msgModel) {
    const badge = document.createElement("span");
    badge.className = "model-badge";
    badge.textContent = msgModel;
    badge.title = `Respondido por ${msgModel}`;
    actions.appendChild(badge);
  }

  div.appendChild(actions);

  if (container) {
    container.appendChild(div);
    // Only scroll if appending directly to chat (not to fragment)
    if (!target) {
      const chatEl = el("chat");
      if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
    }
  }
  // Devuelve el id para poder marcar la burbuja como "No guardado" si la
  // persistencia de esa respuesta falla después.
  return msgId;
}

function appendGeneratingPlaceholder() {
  const chatEl = el("chat");
  if (!chatEl) return null;
  const div = document.createElement("div");
  div.id = "msg-generating-placeholder";
  div.className = "msg assistant msg-generating";
  div.textContent = "Generando…";
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function removeGeneratingPlaceholder() {
  const placeholder = document.getElementById("msg-generating-placeholder");
  if (placeholder) placeholder.remove();
}

// ============================================
// Reply-to system (WhatsApp-style)
// ============================================
function setReplyTo(msg) {
  replyToMessage = msg;
  const preview = el("replyPreview");
  if (!preview) return;
  el("replyPreviewRole").textContent = msg.role === 'user' ? 'Usuario' : 'Asistente';
  el("replyPreviewText").textContent = msg.content || '';
  preview.style.display = "flex";
  try { el("input").focus(); } catch (_) {}
}

function clearReplyTo() {
  replyToMessage = null;
  const preview = el("replyPreview");
  if (preview) preview.style.display = "none";
}

function scrollToMessage(msgId) {
  const target = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('reply-flash');
  void target.offsetWidth; // force reflow
  target.classList.add('reply-flash');
  setTimeout(() => target.classList.remove('reply-flash'), 1600);
}

// ============================================
// Chat search system (Ctrl+F in chat)
// ============================================
let searchMatches = [];
let searchCurrentIdx = -1;

function openChatSearch() {
  const bar = el("chatSearchBar");
  if (!bar) return;
  bar.style.display = "flex";
  const input = el("chatSearchInput");
  if (input) { input.value = ""; input.focus(); }
  clearSearchHighlights();
  el("chatSearchCount").textContent = "";
}

function closeChatSearch() {
  const bar = el("chatSearchBar");
  if (bar) bar.style.display = "none";
  clearSearchHighlights();
  searchMatches = [];
  searchCurrentIdx = -1;
  el("chatSearchCount").textContent = "";
}

function clearSearchHighlights() {
  const chatEl = el("chat");
  if (!chatEl) return;
  chatEl.querySelectorAll('.msg-search-highlight').forEach(hl => {
    const parent = hl.parentNode;
    parent.replaceChild(document.createTextNode(hl.textContent), hl);
    parent.normalize();
  });
  chatEl.querySelectorAll('.msg.search-match').forEach(m => m.classList.remove('search-match'));
}

function performChatSearch(query) {
  clearSearchHighlights();
  searchMatches = [];
  searchCurrentIdx = -1;
  const countEl = el("chatSearchCount");

  if (!query || query.length < 2) {
    if (countEl) countEl.textContent = "";
    return;
  }

  const chatEl = el("chat");
  if (!chatEl) return;

  const msgs = chatEl.querySelectorAll('.msg .msg-content');
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');

  msgs.forEach(contentEl => {
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
      if (!regex.test(node.textContent)) continue;
      regex.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      const text = node.textContent;
      let m;
      while ((m = regex.exec(text)) !== null) {
        if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
        const span = document.createElement("span");
        span.className = "msg-search-highlight";
        span.textContent = m[1];
        frag.appendChild(span);
        searchMatches.push(span);
        lastIdx = regex.lastIndex;
      }
      if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      node.parentNode.replaceChild(frag, node);
    }

    if (contentEl.querySelector('.msg-search-highlight')) {
      contentEl.closest('.msg')?.classList.add('search-match');
    }
  });

  if (countEl) countEl.textContent = searchMatches.length ? `${searchMatches.length} resultados` : 'Sin resultados';
  if (searchMatches.length > 0) navigateSearch(0);
}

function navigateSearch(idx) {
  if (searchMatches.length === 0) return;
  if (searchMatches[searchCurrentIdx]) searchMatches[searchCurrentIdx].classList.remove('active');
  searchCurrentIdx = ((idx % searchMatches.length) + searchMatches.length) % searchMatches.length;
  const current = searchMatches[searchCurrentIdx];
  current.classList.add('active');
  current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const countEl = el("chatSearchCount");
  if (countEl) countEl.textContent = `${searchCurrentIdx + 1}/${searchMatches.length}`;
}

async function appendControlledIntentResponse(
  userText,
  assistantText,
  model,
  imageAttachments = [],
  requestContext = null
) {
  if (!activeProjectId) {
    showToast(assistantText, 'warning');
    return;
  }
  if (!activeChatId) {
    const created = await withTimeout(Store.createChat(activeProjectId, "Chat"), 8000, 'crear chat inicial');
    if (!created?.ok) {
      showToast("No se pudo crear el chat.", "error");
      return;
    }
    await openChat(created.id);
  }
  const context = requestContext || createRequestContext({
    chatId: activeChatId,
    projectId: activeProjectId,
    providerId: currentProvider,
    selectedModel: model
  });
  const attachmentNames = imageAttachments.map(attachment => attachment.name).filter(Boolean);
  const storedUserText = attachmentNames.length
    ? `${userText}\n\n[Adjuntos: ${attachmentNames.join(', ')}]`
    : userText;
  const controlledAttachments = snapshotMessageAttachments(imageAttachments);
  // Aquí no hay proveedor que llamar, pero el turno tampoco puede pintarse ni
  // limpiar el input si la BD lo rechaza.
  const persistedControlled = await persistUserTurn({
    requestContext: context,
    content: storedUserText || '[Imagen adjunta]',
    model,
    attachments: controlledAttachments
  });
  if (!persistedControlled.ok) return;

  if (shouldRenderRequestOutput(context, currentRequestView())) {
    appendMsg({
      role: 'user', content: userText || '[Imagen adjunta]', attachments: controlledAttachments
    });
  }
  let controlledAssistantId = null;
  if (shouldRenderRequestOutput(context, currentRequestView())) {
    controlledAssistantId = appendMsg({ role: 'assistant', content: assistantText, model });
  }
  await persistAssistantTurn({
    chatId: context.chatId, content: assistantText, model, renderedMsgId: controlledAssistantId
  });
  el("input").value = "";
  chatAttachments = [];
  renderAttachmentPreview();
  updateSendButtonState();
}

function safeAssistantContent(output) {
  const content = String(output || '');
  const inspectableContent = content.replace(/\\/g, '');
  if (/["']type["']\s*:\s*["']tool_use["']|["']name["']\s*:\s*["']generate_image["']/i.test(inspectableContent)) {
    return 'No se pudo generar la imagen: el modelo devolvió una llamada de herramienta sin un plan visual seguro.';
  }
  return content;
}

function buildImageGenerationPromptFromVisualPlan(plan) {
  const lines = ['Genera una imagen nueva basada en el plan visual confirmado.'];
  if (plan?.operations?.length) lines.push(`Cambios: ${plan.operations.join(', ')}.`);
  if (plan?.preserve?.length) lines.push(`Preservar: ${plan.preserve.join(', ')}.`);
  else lines.push('Preservar los elementos principales y el contenido esencial.');
  if (plan?.qualityGoals?.length) lines.push(`Calidad: ${plan.qualityGoals.join(', ')}.`);
  if (plan?.styleGoals?.length) lines.push(`Estilo: ${plan.styleGoals.join(', ')}.`);
  if (plan?.constraints?.length) lines.push(`Restricciones: ${plan.constraints.join(', ')}.`);
  lines.push('No alterar elementos principales salvo lo solicitado. Mantener alta legibilidad.');
  return lines.join('\n');
}

const ROUTING_INSTRUCTION_MAX_CHARS = 500;

// slice() opera sobre code units y partiría un par surrogate (emojis, caracteres
// astrales) dejando un string inválido: se corta por caracteres completos.
function truncateByCharacters(text, maxChars) {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  return characters.slice(0, maxChars).join('').trim();
}

// Una línea de contenido pegado (código, log, stack trace, JSON, config) describe
// datos, no la intención del usuario, así que no debe decidir la herramienta.
function isPastedContentLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^(?: {4,}|\t)/.test(line)) return true;
  if (/^(?:at\s+\S|Traceback\b|File\s+")/.test(trimmed)) return true;
  if (/^[A-Za-z_$][\w$.]*(?:Error|Exception)\b\s*:/.test(trimmed)) return true;
  if (/^[{}[\]()<>]/.test(trimmed) || /[{};]$/.test(trimmed)) return true;
  if (/^[A-Z][A-Z0-9_]{2,}\s*[:=]/.test(trimmed)) return true;
  if (/^(?:[-*+]\s*)?["']?[\w.$-]+["']?\s*[:=]\s*["'{[\d]/.test(trimmed)) return true;
  if (/^(?:\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}:\d{2})/.test(trimmed)) return true;
  if (/^(?:\/\/|#|\/\*|\*\s|--|\+\+\+|---)/.test(trimmed)) return true;
  if (/^(?:function|const|let|var|class|import|export|return|if|for|while|switch|def|async|await|public|private)\b/.test(trimmed)) return true;
  const symbols = (trimmed.match(/[{}()[\];=<>|&$#@`_\\/]/g) || []).length;
  return symbols / trimmed.length > 0.15;
}

// Instrucción de routing separada del contenido. La intención del usuario puede
// estar en cualquier parte del mensaje (antes, después o entre logs), así que se
// conserva toda la prosa del mensaje y se descartan código, logs y stack traces.
// Si la prosa excede el límite se preservan principio y final, porque la petición
// real suele cerrar el mensaje. El texto completo se sigue enviando al modelo y se
// guarda íntegro en la base de datos.
function extractRoutingInstruction(text) {
  const raw = String(text || '').trim();
  if (Array.from(raw).length <= ROUTING_INSTRUCTION_MAX_CHARS) return raw;
  const withoutCodeFences = raw.replace(/```[\s\S]*?(?:```|$)/g, '\n');
  const prose = withoutCodeFences
    .split('\n')
    .filter(line => line.trim() && !isPastedContentLine(line))
    .join('\n')
    .trim();
  if (!prose) {
    // Mensaje sin prosa identificable: se usa el primer párrafo como último recurso.
    const firstParagraph = withoutCodeFences.split(/\n\s*\n/)[0].trim() || raw;
    return truncateByCharacters(firstParagraph, ROUTING_INSTRUCTION_MAX_CHARS);
  }
  const proseCharacters = Array.from(prose);
  if (proseCharacters.length <= ROUTING_INSTRUCTION_MAX_CHARS) return prose;
  // El presupuesto descuenta el separador para no exceder nunca el límite.
  const budget = ROUTING_INSTRUCTION_MAX_CHARS - 1;
  const head = proseCharacters.slice(0, Math.floor(budget / 2)).join('').trim();
  const tail = proseCharacters.slice(-Math.ceil(budget / 2)).join('').trim();
  return `${head}\n${tail}`;
}

const OUTPUT_LIMIT_NOTICE = 'Esta respuesta alcanzó el límite de salida del modelo. Escribe «continúa» para completar la respuesta.';

// Una respuesta cortada por el límite de salida del modelo se conserva íntegra: solo se
// añade un aviso debajo. No se reintenta, no se sustituye el texto por un error y no se
// duplica el contenido, que ya quedó guardado tal como llegó.
async function appendOutputLimitNotice(finishReason, requestContext) {
  // Se lee el campo NORMALIZADO del contrato, no el dialecto de cada proveedor.
  // Antes se comparaba contra 'max_tokens', que solo emite Alibaba: en los otros
  // seis proveedores este aviso no llegaba a dispararse nunca aunque el modelo
  // hubiera truncado la respuesta.
  if (finishReason !== 'length' || !requestContext) return false;
  const destination = resolveRequestDestination(requestContext);
  showToast('La respuesta alcanzó el límite de salida del modelo.', 'info');
  if (shouldRenderRequestOutput(requestContext, currentRequestView())) {
    appendMsg({ role: 'assistant', content: OUTPUT_LIMIT_NOTICE, model: AUTOMATIC_MODEL_ID });
  }
  await Store.addMessage(destination.chatId, 'assistant', OUTPUT_LIMIT_NOTICE, null, AUTOMATIC_MODEL_ID);
  return true;
}

// Fábrica única de acciones visuales pendientes: garantiza que toda acción quede
// sellada con la identidad de su contexto (chat, proyecto, proveedor e imagen fuente).
function createPendingVisualAction({
  type, model, visionModel, visualExecution, plan, visualContext, options, generationPrompt
}) {
  const sourceImage = plan?.sourceImage || visualContext?.imageRef || null;
  return {
    type,
    provider: currentProvider,
    projectId: activeProjectId,
    chatId: activeChatId,
    model,
    visionModel,
    visualExecution,
    plan,
    visualContext,
    sourceImage,
    sourceVisualEntryId: sourceImage?.visualEntryId ?? null,
    options,
    generationPrompt,
    createdAt: Date.now()
  };
}

// Una acción pendiente solo puede ejecutarse en el contexto exacto donde se creó.
// Devuelve el motivo del desajuste, o null si la identidad coincide.
function pendingVisualActionIdentityMismatch(pending) {
  if (!pending) return 'missing-pending';
  if (pending.provider !== currentProvider) return 'provider';
  if (pending.projectId !== activeProjectId) return 'project';
  if (pending.chatId !== activeChatId) return 'chat';
  const expectedSourceImage = pending.plan?.sourceImage || pending.visualContext?.imageRef || null;
  if (!expectedSourceImage || !pending.sourceImage) return 'source-image-missing';
  if (!expectedSourceImage.base64 && !expectedSourceImage.url) return 'source-image-empty';
  if ((pending.sourceVisualEntryId ?? null) !== (expectedSourceImage.visualEntryId ?? null)) {
    return 'source-visual-entry';
  }
  const sameSourceImage = pending.sourceImage === expectedSourceImage
    || ((pending.sourceImage.base64 ?? null) === (expectedSourceImage.base64 ?? null)
      && (pending.sourceImage.url ?? null) === (expectedSourceImage.url ?? null));
  if (!sameSourceImage) return 'source-image-mismatch';
  return null;
}

// Registra la petición generativa que el guard de routing mixto degradó, para que la
// usuaria pueda confirmarla sin repetir la instrucción. No genera nada por sí sola.
async function offerConflictAlternative(route, selectedModel, requestContext) {
  const alternative = route?.conflictAlternative;
  if (!alternative || !requestContext) return;
  if (!GENERATIVE_VISUAL_MODES.includes(alternative.plan?.mode)) return;
  if (alternative.validation?.valid !== true || !alternative.model) return;
  pendingVisualAction = createPendingVisualAction({
    type: alternative.intent,
    model: alternative.model,
    visionModel: route.capabilities?.defaultVisionModel
      || (selectedModel === AUTOMATIC_MODEL_ID ? null : selectedModel),
    visualExecution: alternative.visualExecution,
    plan: alternative.plan,
    visualContext: alternative.visualExecution?.visualContext || route.visualContext,
    options: ['analizar', 'generar'],
    generationPrompt: alternative.generationPrompt
  });
  pendingVisualAction.provider = requestContext.providerId;
  pendingVisualAction.projectId = requestContext.projectId;
  pendingVisualAction.chatId = requestContext.chatId;
  const operations = alternative.plan?.operations?.length
    ? ` (${alternative.plan.operations.join(', ')})`
    : '';
  const offer = `Detecté también una petición de edición sobre la imagen${operations}. Responde 2 para aplicarla, o sigue preguntando.`;
  if (shouldRenderRequestOutput(requestContext, currentRequestView())) {
    appendMsg({ role: 'assistant', content: offer, model: AUTOMATIC_MODEL_ID });
  }
  await Store.addMessage(requestContext.chatId, 'assistant', offer, null, AUTOMATIC_MODEL_ID);
}

// Relleno conversacional admitido alrededor de una confirmación. Lista corta y
// explícita: nada de aquí puede convertir una petición nueva en confirmación.
const PENDING_REPLY_LEAD = '(?:si\\s+|ok\\s+|vale\\s+|dale\\s+|venga\\s+|por favor\\s+)*';
const PENDING_REPLY_TAIL = '(?:\\s+por favor|\\s+gracias)*';

// Confirmaciones de ANÁLISIS.
const PENDING_ANALYZE_PATTERNS = [
  '1',
  'opcion 1',
  '(?:solo\\s+|quiero\\s+|puedes\\s+|prefiero\\s+)?analiza(?:r|rla|rlo|la|lo)?(?:\\s+(?:la|esta|esa)\\s+(?:imagen|foto))?'
];

// Confirmaciones de GENERACIÓN / EDICIÓN.
const PENDING_GENERATE_PATTERNS = [
  '2',
  'opcion 2',
  // generar / genera / crear / crea  (+ "una nueva versión", "otra imagen", …)
  '(?:quiero\\s+|puedes\\s+)?(?:genera|crea)(?:r|me)?(?:\\s+(?:una|otra|la|el)(?:\\s+nueva?)?\\s+(?:version|imagen|foto|logo))?',
  // editar / edita / editarla
  '(?:quiero\\s+|puedes\\s+)?edita(?:r|rla|rlo|la|lo)?(?:\\s+(?:la|esta)\\s+(?:imagen|foto))?',
  // aplícalo / aplicar los cambios
  'aplica(?:r|lo|la)?(?:\\s+(?:los|las)\\s+cambios)?',
  // hazlo / hacelo
  'ha(?:z|ce)(?:lo|la)?'
];

function buildPendingReplyMatcher(patterns) {
  return new RegExp(`^${PENDING_REPLY_LEAD}(?:${patterns.join('|')})${PENDING_REPLY_TAIL}$`);
}

const PENDING_ANALYZE_RE = buildPendingReplyMatcher(PENDING_ANALYZE_PATTERNS);
const PENDING_GENERATE_RE = buildPendingReplyMatcher(PENDING_GENERATE_PATTERNS);

/**
 * Interpreta la respuesta a "¿analizar o generar?".
 * Devuelve 'analyze' | 'generate' | null.
 *
 * Antes solo se aceptaban cuatro cadenas exactas (2 | opcion 2 | generar |
 * genera). Una confirmación natural como "generar una nueva versión" no
 * coincidía: la acción pendiente se cancelaba y la frase se reenrutaba como
 * petición nueva, perdiendo la instrucción original ("rediseña el logo por uno
 * más moderno") y produciendo una imagen casi idéntica.
 *
 * Los patrones están ANCLADOS a la cadena completa, así que una petición que
 * solo contenga la palabra "generar" no se confunde con una confirmación.
 */
function parsePendingVisualActionReply(text) {
  const normalized = String(text || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  if (PENDING_ANALYZE_RE.test(normalized)) return 'analyze';
  if (PENDING_GENERATE_RE.test(normalized)) return 'generate';
  return null;
}

async function handlePendingVisualActionReply(text) {
  if (!pendingVisualAction) return false;
  const intent = parsePendingVisualActionReply(text);
  const analyze = intent === 'analyze';
  const generate = intent === 'generate';
  // Solo una respuesta exacta ejecuta la acción pendiente. Cualquier otro mensaje
  // la cancela y sigue el routing normal: una solicitud nueva nunca se secuestra
  // ni actualiza el plan anterior.
  if (!analyze && !generate) {
    pendingVisualAction = null;
    return false;
  }

  // La acción NO se consume aquí. Antes se ponía a null nada más entrar, así que
  // un fallo de persistencia la destruía: "generar una nueva versión" se perdía y
  // el siguiente mensaje se trataba como solicitud nueva. Solo se consume tras
  // guardar el turno de confirmación y arrancar la ejecución.
  const pending = pendingVisualAction;
  // La confirmación solo vale en el chat, proyecto, proveedor e imagen donde nació la
  // acción. Si algo no coincide se cancela y se consume la respuesta, para que un "2"
  // huérfano no se envíe como chat normal ni ejecute nada.
  const identityMismatch = pendingVisualActionIdentityMismatch(pending);
  if (identityMismatch) {
    pendingVisualAction = null;
    console.warn('Acción visual pendiente cancelada por identidad:', identityMismatch);
    showToast(
      'La acción visual pendiente pertenece a otro chat, proyecto o imagen y fue cancelada.',
      'warning'
    );
    return true;
  }
  if (!activeProjectId) {
    showToast('Selecciona un proyecto para ejecutar la acción visual.', 'warning');
    return true;
  }
  if (!activeChatId) {
    const created = await withTimeout(Store.createChat(activeProjectId, "Chat"), 8000, 'crear chat inicial');
    if (!created?.ok) {
      showToast('No se pudo crear el chat.', 'error');
      return true;
    }
    await openChat(created.id);
  }
  const requestContext = createRequestContext({
    chatId: activeChatId,
    projectId: activeProjectId,
    providerId: currentProvider,
    selectedModel: (generate ? pending.model || pending.visualExecution?.model : pending.visionModel) || AUTOMATIC_MODEL_ID
  });
  const pendingImages = pending.sourceImage ? [pending.sourceImage] : [];
  const pendingPayload = {
    requestId: requestContext.requestId,
    providerId: requestContext.providerId,
    model: requestContext.selectedModel,
    messages: [{ role: 'user', content: text }],
    sourceImages: pendingImages
  };
  const cloudScope = buildEffectiveCloudScope(requestContext, pendingPayload, {
    imageNames: pendingImages.map(image => image.name || t('cloudConsent.sourceImage'))
  });
  if (!await ensureCloudConsent(requestContext, cloudScope)) return true;
  // A) Snapshot; B) gate de persistencia.
  const pendingAttachments = snapshotMessageAttachments(
    pendingImages.map(image => ({ ...image, type: 'image' }))
  );
  const persistedPending = await persistUserTurn({
    requestContext,
    content: text,
    model: AUTOMATIC_MODEL_ID,
    attachments: pendingAttachments
  });
  // D) Sin persistencia la acción sigue viva: se puede reintentar con su
  //    sourceImage y su generationPrompt intactos.
  if (!persistedPending.ok) return true;

  // C) Consumo de la acción + efectos visibles + llamada al proveedor.
  pendingVisualAction = null;
  activeRequestId = requestContext.requestId;
  appendMsg({ role: 'user', content: text, attachments: pendingAttachments });
  el("input").value = "";
  isGenerating = true;
  appendGeneratingPlaceholder();
  try {
    if (pending.provider && pending.provider !== requestContext.providerId) {
      throw new Error('La acción visual pertenece a otro proveedor. Vuelve a seleccionar el proveedor original.');
    }
    if (generate) {
      // Espeja la barrera de executeGenerateImageToolUse: una acción pendiente que no
      // sea generativa nunca puede generar, ni siquiera confirmada por la usuaria.
      if (!GENERATIVE_VISUAL_MODES.includes(pending.plan?.mode)) {
        throw new Error('La acción pendiente no es una tarea generativa');
      }
      const prompt = pending.generationPrompt || buildImageGenerationPromptFromVisualPlan(pending.plan);
      const generationModel = pending.model || pending.visualExecution?.model || null;
      if (!generationModel) {
        throw new Error('El proveedor actual no tiene un modelo de imagen configurado');
      }
      const sourceImage =
        pending.plan?.sourceImage
        || pending.visualContext?.imageRef
        || null;
      const generated = await sendAIImage({
        requestId: requestContext.requestId,
        providerId: requestContext.providerId,
        model: generationModel,
        prompt,
        sourceImages: sourceImage ? [sourceImage] : []
      });
      const answer = terminalImageAnswer(generated.images);
      // registerVisualImage solo toca memoria efímera: sin persistir el imageRef
      // la imagen generada desaparecía del chat al reiniciar.
      const generatedRef = registerVisualImage({
        chatId: requestContext.chatId,
        role: 'assistant',
        origin: pending.plan?.mode === 'image-edit' ? 'image-edit' : 'image-generation',
        sourceVisualEntryId: pending.visualContext?.imageRef?.visualEntryId || null,
        image: {
          type: 'image',
          url: generated.images[0],
          name: 'Imagen generada'
        }
      });
      const generatedAttachments = snapshotMessageAttachments([generatedRef]);
      removeGeneratingPlaceholder();
      let renderedId = null;
      if (shouldRenderRequestOutput(requestContext, currentRequestView())) {
        renderedId = appendMsg({
          role: 'assistant', content: answer, model: generationModel,
          attachments: generatedAttachments
        });
      }
      await persistAssistantTurn({
        chatId: requestContext.chatId, content: answer, model: generationModel,
        attachments: generatedAttachments, renderedMsgId: renderedId
      });
    } else {
      const imageRef = pending.visualContext?.imageRef;
      if (!imageRef) throw new Error('No hay una imagen de referencia disponible para analizar');
      const visionModel = pending.visionModel || null;
      if (!visionModel) throw new Error('El proveedor actual no tiene un modelo de visión configurado');
      const out = await sendAIChat({
        requestId: requestContext.requestId,
        providerId: requestContext.providerId,
        model: visionModel,
        messages: [{
          role: 'user',
          content: 'Analiza la imagen de referencia. Describe su contenido y los elementos relevantes para la edición solicitada, sin afirmar que puedes editarla.'
        }],
        images: [{ base64: imageRef.base64, mediaType: imageRef.mediaType, url: imageRef.url }]
      });
      const answer = safeAssistantContent(out?.message?.content || '');
      if (!answer) throw new Error('Respuesta vacía');
      registerVisualEvent({
        chatId: requestContext.chatId,
        role: 'assistant',
        origin: 'vision-analysis',
        sourceVisualEntryId: imageRef.visualEntryId || null
      });
      visualContextMemory.lastAnalyzedImage = imageRef;
      registerLastVisualAnalysis({
        chatId: requestContext.chatId,
        sourceImageRef: imageRef,
        analysisText: answer
      });
      removeGeneratingPlaceholder();
      if (shouldRenderRequestOutput(requestContext, currentRequestView())) {
        appendMsg({ role: 'assistant', content: answer, model: visionModel });
      }
      await Store.addMessage(requestContext.chatId, 'assistant', answer, null, visionModel);
    }
  } catch (error) {
    removeGeneratingPlaceholder();
    showToast('No se pudo ejecutar la acción visual: ' + sanitizeRemoteErrorMessage(error?.message || error), 'error');
  } finally {
    if (activeRequestId === requestContext.requestId) activeRequestId = null;
    isGenerating = false;
    updateSendButtonState();
  }
  return true;
}

async function send() {
  let model = el("modelSelect").value;
  if (!model) {
    showToast("Selecciona un modelo.", "error");
    return;
  }
  const text = el("input").value.trim();
  const hasAttachments = chatAttachments.length > 0;
  if (!text && !hasAttachments) return;
  // Barrera de envío: hay imágenes que el usuario quiso adjuntar y MIKA5 rechazó.
  // Enviar ahora produciría una respuesta de solo texto que se lee como si la
  // imagen se hubiera analizado. El texto NO se borra: el usuario cambia de
  // modelo y vuelve a adjuntar.
  const rejected = pendingRejectedImages(activeChatId);
  if (rejected.length) {
    const names = rejected.map(item => item.name).join(', ');
    showToast(
      `No se envía: ${names} no se pudo adjuntar. ${rejectionNotice(rejected[0])} `
      + 'Vuelve a adjuntarla con un modelo con visión, o pulsa ✕ sobre ella para enviar solo texto.',
      'error'
    );
    return;
  }
  const originProviderId = currentProvider;
  const originProjectId = activeProjectId;
  if (!originProjectId) {
    showToast("Selecciona un proyecto primero.", "error");
    return;
  }
  let originChatId = activeChatId;
  if (!originChatId) {
    const created = await withTimeout(Store.createChat(originProjectId, "Chat"), 8000, 'crear chat inicial');
    if (!created?.ok) {
      showToast("No se pudo crear el chat.", "error");
      return;
    }
    originChatId = created.id;
    await openChat(originChatId);
  }
  const requestContextFor = selectedModel => createRequestContext({
    chatId: originChatId,
    projectId: originProjectId,
    providerId: originProviderId,
    selectedModel
  });
  if (pendingVisualAction) {
    const handled = await handlePendingVisualActionReply(text);
    if (handled) return;
  }
  {
    const selectedOption = Array.from(el('modelSelect').options).find(option => option.value === model);
    if (selectedOption?.dataset.taskType === 'image-generation') {
      showToast('Este modelo se usa desde Crear imagen, no desde chat.', 'warning');
      return;
    }
    if (selectedOption?.dataset.taskType === 'video-generation') {
      showToast('Este modelo genera video y no puede usarse en chat.', 'warning');
      return;
    }
  }

  // Separate image attachments from text attachments
  const imageAttachments = chatAttachments.filter(a => a.type === 'image');
  let routedImages = imageAttachments;
  const textAttachments = chatAttachments.filter(a => a.type === 'text');
  
  let contentToSend = text;
  if (textAttachments.length) {
    const parts = textAttachments.map((att) => `--- ${att.name} ---\n${att.text}`);
    contentToSend = contentToSend ? contentToSend + "\n\n" + parts.join("\n\n") : parts.join("\n\n");
  }
  if (imageAttachments.length && !contentToSend) {
    contentToSend = "Describe this image.";
  }
  let routedIntent = 'normal-chat';
  let resolvedVisualContext = null;
  let activeVisualRoute = null;
  const routingInstruction = extractRoutingInstruction(text);
  {
    try {
      const route = await window.mika5.ai.routeIntent({
        text: routingInstruction,
        providerId: originProviderId,
        chatId: originChatId,
        // Un documento adjunto en este turno: «analízalo» habla de él, no de
        // una imagen que hubiera antes en el chat.
        hasTextAttachments: textAttachments.length > 0,
        attachments: imageAttachments.map(attachment => ({
          type: 'image',
          mediaType: attachment.mediaType,
          base64: attachment.base64,
          name: attachment.name,
          chatId: originChatId
        })),
        lastUserImage: visualContextMemory.lastUserImage,
        lastUploadedImage: visualContextMemory.lastUploadedImage,
        lastGeneratedImage: visualContextMemory.lastGeneratedImage,
        lastAnalyzedImage: visualContextMemory.lastAnalyzedImage,
        lastVisualAnalysis: visualContextMemory.lastVisualAnalysis,
        currentModel: model === AUTOMATIC_MODEL_ID ? '' : model
      });
      routedIntent = route.intent;
      // Aviso de la aplicación, no del modelo: este proveedor analiza imágenes
      // pero no las edita ni las genera.
      if (route.imageEditUnavailable) showToast(t('image.editUnavailable'), 'info');
      resolvedVisualContext = route.visualContext;
      activeVisualRoute = route;
      if (route.action === 'error') {
        await appendControlledIntentResponse(text, route.message,
          model,
          imageAttachments,
          requestContextFor(model)
        );
        return;
      }
      if (route.action === 'unsupported') {
        if (route.options && route.plan && route.validation?.shouldOfferFallback) {
          pendingVisualAction = createPendingVisualAction({
            type: route.intent,
            model: route.model,
            visionModel: route.capabilities?.defaultVisionModel || (model === AUTOMATIC_MODEL_ID ? null : model),
            visualExecution: route.visualExecution,
            plan: route.plan,
            visualContext: route.visualContext,
            options: route.options,
            generationPrompt: route.generationPrompt
          });
        }
        await appendControlledIntentResponse(text, route.message,
          model,
          imageAttachments,
          requestContextFor(model)
        );
        return;
      }
      // Barrera de último recurso sobre la ruta directa de generación: una solicitud
      // que mezcla análisis y generación nunca ejecuta generateImage desde aquí.
      // Degrada con gracia hacia chat, sin registrar imagen ni guardar Markdown.
      if (route.action === 'generate-image' && route.detailed?.intentConflicts?.analysisAndGeneration) {
        console.error('Bloqueo de routing mixto: análisis y generación en la misma solicitud:', route.detailed.intent);
        showToast('La solicitud mezcla análisis y generación: se responde con análisis, sin generar imagen.', 'warning');
        route.action = 'chat';
        route.intent = route.visualContext?.hasVisualContext ? 'vision-analysis' : 'normal-chat';
        route.model = route.capabilities?.defaultVisionModel
          || (model === AUTOMATIC_MODEL_ID ? null : model);
        routedIntent = route.intent;
      }
      if (route.action === 'generate-image') {
        const requestContext = requestContextFor(route.model);
        const userPrompt = text || 'Crea una imagen';
        const visualExecution = route.visualExecution;
        const sourceImage =
          visualExecution?.plan?.sourceImage
          || route.visualContext?.imageRef
          || null;
        const generationPayload = {
          requestId: requestContext.requestId,
          providerId: requestContext.providerId,
          model: route.model,
          prompt: visualExecution?.generationPrompt || route.modelPrompt || userPrompt,
          sourceImages: sourceImage ? [sourceImage] : []
        };
        const cloudScope = buildEffectiveCloudScope(requestContext, generationPayload, {
          attachmentNames: textAttachments.map(item => item.name),
          imageNames: generationPayload.sourceImages.map(image =>
            image.name || t('cloudConsent.sourceImage'))
        });
        if (!await ensureCloudConsent(requestContext, cloudScope)) return;
        // A) Snapshot; B) persistir antes de nada externo.
        const generativeAttachments = snapshotMessageAttachments(
          generationPayload.sourceImages.map(image => ({ ...image, type: 'image' }))
        );
        const persistedGenerative = await persistUserTurn({
          requestContext,
          content: userPrompt,
          model: route.model,
          attachments: generativeAttachments
        });
        // D) Sin persistencia no hay generateImage ni mensaje fantasma.
        if (!persistedGenerative.ok) return;

        // C) Efectos visibles y llamada solo tras el éxito.
        activeRequestId = requestContext.requestId;
        if (shouldRenderRequestOutput(requestContext, currentRequestView())) {
          appendMsg({ role: 'user', content: userPrompt, attachments: generativeAttachments });
        }
        el("input").value = "";
        chatAttachments = [];
        renderAttachmentPreview();
        isGenerating = true;
        appendGeneratingPlaceholder();
        try {
          if (['image-edit', 'image-variation'].includes(routedIntent)
            && visualExecution?.validation?.valid !== true) {
            throw new Error('No existe un plan visual seguro para generar la nueva imagen');
          }
          const generated = await sendAIImage(generationPayload);
          const answer = terminalImageAnswer(generated.images);
          const sourceVisualEntryId = route.visualContext?.imageRef?.visualEntryId || null;
          const generatedRef = registerVisualImage({
            chatId: requestContext.chatId,
            role: 'assistant',
            origin: routedIntent === 'image-edit'
              ? 'image-edit'
              : routedIntent === 'image-variation' ? 'image-variation' : 'image-generation',
            sourceVisualEntryId,
            image: {
              type: 'image',
              url: generated.images[0],
              name: 'Imagen generada'
            }
          });
          const generatedAttachments = snapshotMessageAttachments([generatedRef]);
          removeGeneratingPlaceholder();
          let renderedId = null;
          if (shouldRenderRequestOutput(requestContext, currentRequestView())) {
            renderedId = appendMsg({
              role: 'assistant', content: answer, model: route.model,
              attachments: generatedAttachments
            });
          }
          await persistAssistantTurn({
            chatId: requestContext.chatId, content: answer, model: route.model,
            attachments: generatedAttachments, renderedMsgId: renderedId
          });
        } catch (error) {
          removeGeneratingPlaceholder();
          const safeReason = sanitizeRemoteErrorMessage(error?.message || error);
          showToast(
            routedIntent === 'image-variation'
              ? 'No se pudo generar la nueva imagen: ' + safeReason
              : 'No se pudo crear la imagen: ' + safeReason,
            'error'
          );
        } finally {
          if (activeRequestId === requestContext.requestId) activeRequestId = null;
          isGenerating = false;
          updateSendButtonState();
        }
        return;
      }
      model = route.model || model;
      if (routedIntent === 'vision-analysis') {
        if (!routedImages.length && route.visualContext?.imageRef) {
          routedImages = [route.visualContext.imageRef];
        }
        // El contenido NO se sustituye por el prompt del routing. `contentToSend`
        // lleva lo que escribió el usuario MÁS el texto de los documentos que
        // adjuntó; el prompt del routing sólo lleva lo escrito. Sustituirlo
        // descartaba el documento adjunto antes de enviarlo: con «analiza el
        // documento» el modelo recibía esas tres palabras y pedía que le
        // pegasen el documento.
        if (originProviderId === 'alibaba') {
          showToast('Usando qwen3.7-plus para analizar imágenes.', 'info');
        }
      }
    } catch (error) {
      showToast('No se pudo determinar la capacidad: ' + (error?.message || error), 'error');
      return;
    }
  }
  window.mika5.setAppState("lastModel", el("modelSelect").value).catch(() => {});
  if (originProviderId === 'alibaba' && routedImages.length && !modelSupportsVision(model)) {
    const suggested = 'qwen3.7-plus';
    const suggestedOption = Array.from(el('modelSelect').options).find(option => option.value === suggested);
    if (suggestedOption) {
      el('modelSelect').value = suggested;
      syncModelDropdown();
    }
    showToast('Este modelo no analiza imágenes. Cambia a qwen3.7-plus, qwen3.8-max-preview o qwen3.6-flash.', 'warning');
    return;
  }

  // Display content for user message — show summary for large text attachments
  let displayContent = text || '';
  if (textAttachments.length > 0) {
    const summaries = textAttachments.map(att => {
      const chars = (att.text || '').length;
      return `**${att.name}** (${chars.toLocaleString()} caracteres)`;
    });
    const attachSummary = summaries.join(' | ');
    displayContent = displayContent
      ? `${displayContent}\n\n${attachSummary}`
      : attachSummary;
  }
  if (imageAttachments.length > 0) {
    const MAX_PREVIEWS = 5;
    const previewsToShow = imageAttachments.slice(0, MAX_PREVIEWS);
    const imagePreviews = previewsToShow.map(att => {
      const mimeType = att.mediaType || 'image/jpeg';
      return `<span class="image-preview-clickable" style="display:inline-block;margin:2px;">`
        + `<img src="data:${mimeType};base64,${att.base64}" `
        + `class="embedded-image-preview" `
        + `loading="lazy" `
        + `data-zoomable="true" `
        + `role="img" aria-label="Imagen adjunta: ${att.name}" `
        + `alt="${att.name}" /></span>`;
    }).join('');
    const overflow = imageAttachments.length > MAX_PREVIEWS
      ? `\n\n*+${imageAttachments.length - MAX_PREVIEWS} imagen(es) mas*`
      : '';
    displayContent = displayContent
      ? `${displayContent}\n\n${imagePreviews}${overflow}`
      : `${imagePreviews}${overflow}`;
  }

  const requestContext = requestContextFor(model);

  // Save lightweight version to DB (no base64 images — they bloat DB and cause layout issues on reload)
  let dbContent = contentToSend;
  if (imageAttachments.length > 0) {
    const imgNames = imageAttachments.map(a => a.name).join(', ');
    dbContent = dbContent
      ? `${dbContent}\n\n[Adjuntos: ${imgNames}]`
      : `[Adjuntos: ${imgNames}]`;
  }

  // Capture reply context before clearing
  const currentReply = replyToMessage ? { ...replyToMessage } : null;

  // If replying, prepend quote context to what the AI sees and to what gets saved
  if (currentReply) {
    const quoteSnippet = (currentReply.content || '').slice(0, 300);
    const replyPrefix = `[En respuesta a ${currentReply.role === 'user' ? 'Usuario' : 'Asistente'}: "${quoteSnippet}"]\n\n`;
    contentToSend = replyPrefix + contentToSend;
    dbContent = replyPrefix + dbContent;
  }

  let wasCanceled = false;
  const sendBtn = el("btnSend");
  const stopBtn = el("btnStop");

  try {
    const msgs = await Store.listMessages(requestContext.chatId);

    // === KNOWLEDGE CONTEXT: Always inject document content ===
    let ragContext = null;
    let knowledgeListContext = null;
    let ragDocumentTitles = [];
    let projectInstructionsIncluded = false;

    // Load chunk text directly from DB (no embeddings, no Ollama, no disk I/O)
    try {
      // El alcance SIEMPRE lleva proyecto + chat actual. Antes se mandaba uno u
      // otro: con sólo el proyecto se colaban los documentos privados de otros
      // chats, y con sólo el chat se perdía el conocimiento del proyecto.
      // El proyecto y el chat salen del requestContext: es el alcance de ESTA
      // solicitud, no el que la interfaz tenga abierto al llegar la respuesta.
      const isQuickChatScope = requestContext.projectId === QUICK_CHAT_ID;
      const kProjId = requestContext.projectId || null;
      const kChatId = requestContext.chatId || null;
      if (kProjId) {
        // Use cached provider privacy (set by loadProvider) — no IPC needed
        const maxRagChars = presupuestoDeContexto('knowledgeChars',
          (typeof providerPrivacy !== 'undefined' && providerPrivacy === 'private') ? 12000 : 24000);

        // Server-side truncation: only returns chunks up to maxRagChars
        // Use complete mode for project-level context to avoid round-robin bias
        const mode = isQuickChatScope ? 'selective' : 'complete';
        // Quick Chat no tiene conocimiento de proyecto: sólo el del chat actual.
        const scopeOpts = { includeProjectScope: !isQuickChatScope };
        // La pregunta viaja con la consulta: de un documento largo se traen
        // los fragmentos que hablan de ella, no los primeros.
        let chunks = await window.mika5.rag.listChunksRaw(kProjId, kChatId, maxRagChars, mode, scopeOpts, dbContent);
        chunks = await completarPorSignificado(chunks, {
          projectId: kProjId, chatId: kChatId, includeProjectScope: scopeOpts.includeProjectScope,
          pregunta: dbContent, maxChars: maxRagChars
        });
        if (chunks && chunks.length > 0) {
          const titles = [...new Set(chunks.map(c => c.title))];
          ragDocumentTitles = titles.filter(Boolean);
          knowledgeListContext = `Documentos en la base de conocimiento del proyecto (${titles.length}):\n${titles.map(t => '- ' + t).join('\n')}`;

          const contextText = chunks.map(c =>
            `[Documento: ${c.title || "Sin título"}] (fragmento ${(c.chunk_index || 0) + 1}${c.doc_chunks ? ` de ${c.doc_chunks}` : ''}):\n${c.chunk_text}`
          ).join("\n\n---\n\n");
          // El modelo recibe una parte de los documentos. Tiene que saberlo, o
          // concluye que lo que no ve no existe y se lo dice así al usuario.
          const totalFragmentos = titles.reduce((suma, titulo) =>
            suma + (chunks.find(c => c.title === titulo)?.doc_chunks || 0), 0);
          const avisoParcial = totalFragmentos > chunks.length
            ? `\n\nIMPORTANTE: los documentos son más largos que lo que cabe aquí. Se muestran ${chunks.length} de ${totalFragmentos} fragmentos${chunks[0].selection === 'relevance' ? ', elegidos por su relación con la pregunta' : ''}. Si la respuesta no está en estos fragmentos, no afirmes que el documento no la contiene: di que no aparece en la parte consultada y pide al usuario que reformule o indique el apartado.`
            : '';
          ragContext = `El usuario tiene los siguientes documentos cargados en la base de conocimiento de este proyecto. Cuando el usuario pregunte sobre "archivos", "documentos", "contexto del proyecto" o el contenido del proyecto, se refiere a ESTE contenido:\n\n${contextText}\n\nFin de los documentos del proyecto. Basa tu respuesta en este contenido.${avisoParcial}`;
        }
      }
    } catch (chunkErr) {
      console.error('[KNOWLEDGE] CRITICAL: Failed to load chunks:', chunkErr);
      // Last resort: try loading knowledge item list only (titles without content)
      try {
        const isQuickChatScope2 = requestContext.projectId === QUICK_CHAT_ID;
        const kProjId2 = requestContext.projectId || null;
        const kChatId2 = requestContext.chatId || null;
        if (kProjId2) {
          const items = await window.mika5.db.listKnowledge(kProjId2, kChatId2, {
            includeProjectScope: !isQuickChatScope2
          });
          const readyItems = (items || []).filter(i => i.index_status === 'ready' || i.index_status === 'indexed');
          if (readyItems.length) {
            knowledgeListContext = `Documentos en la base de conocimiento (${readyItems.length}):\n${readyItems.map(i => '- ' + i.title).join('\n')}\n(El contenido no pudo ser cargado. Informa al usuario que reinicie la aplicación.)`;
          }
        }
      } catch (_) {}
    }

    // Note: RAG semantic search removed — direct chunk injection is more reliable
    // and doesn't depend on Ollama loading the embedding model

    const baseMessages = msgs.map((m) => ({ role: m.role, content: m.content }));
    baseMessages.push({ role: 'user', content: contentToSend });
    conversationHistory = baseMessages;

    // === Contexto enviado al modelo ===
    // Sin límite por número de mensajes: sólo el presupuesto de contexto.
    const trimmedMessages = trimContextToBudget(conversationHistory);
    if (trimmedMessages !== conversationHistory) {
      console.log(`Context trimmed (chars): ${conversationHistory.length} → ${trimmedMessages.length} messages`);
    }

    const systemParts = [];

    // Part 1: Project/chat instructions
    if (requestContext.projectId && requestContext.projectId !== QUICK_CHAT_ID) {
      try {
        const projectPrompt = await window.mika5.db.getProjectContext(requestContext.projectId);
        if (projectPrompt && projectPrompt.trim()) {
          systemParts.push(projectPrompt.trim());
          projectInstructionsIncluded = true;
        }
      } catch (e) {
        console.warn("Project context error:", e);
        showToast(t('toast.contextError') || 'Could not load project instructions', 'warning');
      }
    } else if (requestContext.projectId === QUICK_CHAT_ID && requestContext.chatId) {
      try {
        const chatPrompt = await window.mika5.db.getChatContext(requestContext.chatId);
        if (chatPrompt && chatPrompt.trim()) {
          systemParts.push(chatPrompt.trim());
          projectInstructionsIncluded = true;
        }
      } catch (e) {
        console.warn("Chat context error:", e);
        showToast(t('toast.contextError') || 'Could not load chat instructions', 'warning');
      }
    }

    // Part 2: Knowledge content (ragContext already has document text)
    if (ragContext) systemParts.push(ragContext);
    else if (knowledgeListContext) systemParts.push(knowledgeListContext);

    // Merge into a single system message
    const systemMessages = [];
    if (systemParts.length) {
      systemMessages.push({ role: "system", content: systemParts.join("\n\n") });
    }

    const finalMessages = [...systemMessages, ...trimmedMessages];

    // Add images to the last user message if present (Ollama vision format)
    const payload = { requestId: requestContext.requestId, providerId: requestContext.providerId, model, messages: finalMessages };
    if (activeVisualRoute?.visualExecution) {
      payload.visualExecution = activeVisualRoute.visualExecution;
    }
    if (routedImages.length > 0) {
      // Última barrera antes de la red, resuelta por el proceso principal con el
      // mismo código que la de los adapters. Antes este camino degradaba a
      // "enviar solo el texto" con un aviso: el modelo contestaba sin haber visto
      // la imagen y la respuesta se leía como si sí la hubiera analizado.
      const blocked = await visionBlockReason({ provider: originProviderId, model });
      if (blocked) {
        showToast(
          `No se envía: ${blocked} La imagen sigue adjunta — cambia a un modelo con visión para analizarla.`,
          'error'
        );
        return;
      }
      // Forma descriptiva para todos los proveedores. `local.chat` la reduce al
      // base64 pelado que espera Ollama; los adapters cloud necesitan el mediaType.
      payload.images = routedImages.map(a => ({
        base64: a.base64,
        mediaType: a.mediaType,
        url: a.url
      }));
    }

    const cloudScope = buildEffectiveCloudScope(requestContext, payload, {
      historyMessageCount: msgs.length,
      projectInstructionsIncluded,
      attachmentNames: textAttachments.map(item => item.name),
      imageNames: routedImages.map(image => image.name || t('cloudConsent.sourceImage')),
      ragContextIncluded: Boolean(ragContext),
      ragContextMarker: ragContext || '',
      ragDocumentTitles
    });
    if (!await ensureCloudConsent(requestContext, cloudScope)) return;

    // A) Snapshot. Nada se limpia todavía: si la BD rechaza el turno, el texto
    //    y los adjuntos tienen que seguir donde estaban.
    const userAttachments = snapshotMessageAttachments(routedImages);

    // B) La BD es el gate previo a la red.
    const persisted = await persistUserTurn({
      requestContext,
      content: dbContent,
      model: requestContext.selectedModel,
      replyToId: currentReply?.msgId || null,
      attachments: userAttachments
    });
    // D) Fallo: ni proveedor, ni placeholder, ni limpieza, ni burbuja enviada.
    if (!persisted.ok) return;

    // C) Solo tras persistir: efectos visibles y llamada al proveedor.
    activeRequestId = requestContext.requestId;
    el("input").value = "";
    chatAttachments = [];
    renderAttachmentPreview();
    clearReplyTo();
    if (shouldRenderRequestOutput(requestContext, currentRequestView())) {
      appendMsg({
        role: "user", content: displayContent, _replyTo: currentReply, attachments: userAttachments
      });
    }
    isGenerating = true;
    if (sendBtn) sendBtn.style.display = "none";
    if (stopBtn) {
      stopBtn.style.display = "";
      stopBtn.disabled = false;
      stopBtn.onclick = () => {
        wasCanceled = true;
        showToast(t('toast.generationStopped'), 'info');
        try { window.mika5.ai.abort(requestContext.requestId); } catch (_) {}
        removeGeneratingPlaceholder();
        isGenerating = false;
        if (sendBtn) { sendBtn.style.display = ""; sendBtn.disabled = false; }
        if (stopBtn) stopBtn.style.display = "none";
        updateSendButtonState();
      };
    }
    appendGeneratingPlaceholder();

    try {
      if (wasCanceled) throw new Error('Canceled');
      const out = await sendAIChat(payload);
      if (wasCanceled) throw new Error('Canceled');
      if (!out || !out.message) throw new Error('Respuesta vacía');
      // La respuesta sale de notas tomadas tramo a tramo, no del texto entero
      // de una vez: el usuario tiene que saberlo.
      if (Number(out.readInParts) > 1 && shouldRenderRequestOutput(requestContext, currentRequestView())) {
        showToast(t('toast.readInParts', { n: out.readInParts }), 'info');
      }
      let answer = safeAssistantContent(out.message.content);
      let answerModel = model;
      let terminalImageRef = null;
      if (out.terminalType === 'image') {
        // Una respuesta de análisis o de chat nunca puede materializarse como imagen,
        // aunque el contenido analizado mencione herramientas o modelos visuales.
        // El bloqueo degrada con gracia: la capa de presentación no lanza. Se conserva
        // el texto que devolvió el modelo y no se registra ni se guarda ninguna imagen.
        const allowedTerminalImageIntents = new Set(['image-generation', 'image-edit', 'image-variation']);
        if (!allowedTerminalImageIntents.has(routedIntent)) {
          console.error('Bloqueo de seguridad: imagen terminal en un intent no generativo:', routedIntent);
          showToast('Se bloqueó una imagen inesperada: la solicitud actual era de análisis o chat.', 'warning');
          if (!answer) {
            answer = 'Se bloqueó una imagen inesperada porque la solicitud actual era de análisis o chat.';
          }
        } else {
          const terminalModel = activeVisualRoute?.visualExecution?.model || model || 'modelo-desconocido';
          if (terminalModel === 'modelo-desconocido') {
            console.warn('No se pudo identificar el modelo que generó la imagen terminal.');
          }
          answer = terminalImageAnswer(out.images);
          answerModel = terminalModel;
          terminalImageRef = registerVisualImage({
            chatId: requestContext.chatId,
            role: 'assistant',
            origin: activeVisualRoute?.visualExecution?.plan?.mode === 'image-edit'
              ? 'image-edit'
              : activeVisualRoute?.visualExecution?.plan?.mode === 'image-variation'
                ? 'image-variation'
                : 'image-generation',
            sourceVisualEntryId: activeVisualRoute?.visualExecution?.visualContext?.imageRef?.visualEntryId || null,
            image: { type: 'image', url: out.images[0], name: 'Imagen generada' }
          });
        }
      }
      if (routedIntent === 'vision-analysis' && resolvedVisualContext?.imageRef) {
        registerVisualEvent({
          chatId: requestContext.chatId,
          role: 'assistant',
          origin: 'vision-analysis',
          sourceVisualEntryId: resolvedVisualContext.imageRef.visualEntryId || null
        });
        visualContextMemory.lastAnalyzedImage = resolvedVisualContext.imageRef;
        registerLastVisualAnalysis({
          chatId: requestContext.chatId,
          sourceImageRef: resolvedVisualContext.imageRef,
          analysisText: answer
        });
      }
      // Una imagen terminal llegada por chat también se persiste como adjunto.
      const assistantAttachments = terminalImageRef
        ? snapshotMessageAttachments([terminalImageRef])
        : null;
      let renderedAssistantId = null;
      if (shouldRenderRequestOutput(requestContext, currentRequestView())) {
        renderedAssistantId = appendMsg({
          role: "assistant", content: answer, model: answerModel, attachments: assistantAttachments
        });
      }
      await persistAssistantTurn({
        chatId: requestContext.chatId, content: answer, model: answerModel,
        attachments: assistantAttachments, renderedMsgId: renderedAssistantId
      });

      // La respuesta ya está guardada íntegra: si el modelo la cortó por su límite de
      // salida, solo se avisa debajo para que la usuaria pueda pedir la continuación.
      await appendOutputLimitNotice(out.finishReason, requestContext);

      // El guard de routing mixto degradó la ruta generativa, pero la petición no se
      // pierde: queda ofrecida como acción pendiente que solo se ejecuta si la usuaria
      // la confirma. Aquí no se genera nada ni se registra ninguna imagen.
      await offerConflictAlternative(activeVisualRoute, model, requestContext);

      // Auto-rename chat based on user's first message
      try {
        const allMsgs = await Store.listMessages(requestContext.chatId);
        const chatList = await Store.listChats(requestContext.projectId);
        const thisChat = chatList.find(c => c.id === requestContext.chatId);
        if (thisChat && (thisChat.title === 'Chat' || thisChat.title === 'New Chat') && allMsgs.length <= 3) {
          const firstUserMsg = allMsgs.find(m => m.role === 'user');
          if (firstUserMsg) {
            const autoTitle = firstUserMsg.content.replace(/\s+/g, ' ').trim().substring(0, 40);
            if (autoTitle) {
              await Store.updateChat(requestContext.chatId, { title: autoTitle + (firstUserMsg.content.length > 40 ? '...' : '') });
            }
          }
        }
      } catch (_) {}
    } catch (e) {
      if (wasCanceled) {
        // Don't show error for user-initiated cancel
      } else {
        let msg = e?.message || 'Error desconocido';
        
        if (requestContext.providerId === 'local') {
          console.error('Chat error:', e);
          if (/ECONNREFUSED/i.test(msg)) {
            msg = t('toast.ollamaNotRunning') || 'Ollama no está ejecutándose. Inicia con: ollama serve';
          } else if (/GGML_ASSERT/i.test(msg)) {
            msg = 'Error interno del modelo. Es probable que el modelo no soporte el tipo de datos enviado (ej: imágenes en un modelo sin visión). Prueba otro modelo compatible.';
          } else if (/500.*Internal Server Error/i.test(msg) || /HTTP 500/i.test(msg)) {
            msg = 'El modelo devolvió error 500. Si usas un modelo :cloud, el servidor remoto puede estar caído. Prueba otro modelo.';
          }
        } else {
          msg = sanitizeRemoteErrorMessage(msg);
          if (/401|Unauthorized/i.test(msg)) {
            msg = t('toast.invalidApiKey');
          }
          console.warn('Cloud provider request failed:', msg);
        }
        
        if (shouldRenderRequestOutput(requestContext, currentRequestView())) {
          appendMsg({ role: "assistant", content: `**Error:** ${msg}` });
          showToast(msg, 'error');
        }
      }
    }

    await refreshChats();
  } finally {
    if (activeRequestId === requestContext.requestId) activeRequestId = null;
    removeGeneratingPlaceholder();
    isGenerating = false;
    if (sendBtn) { sendBtn.style.display = ""; sendBtn.disabled = false; }
    if (stopBtn) stopBtn.style.display = "none";
    updateSendButtonState();
  }
}

async function saveChatAsDoc() {
  if (!activeProjectId) {
    showToast("Selecciona un proyecto primero", "error");
    return;
  }
  if (!activeChatId) {
    showToast("Abre un chat.", "error");
    return;
  }
  const msgs = await window.mika5.db.listMessages(activeChatId);
  if (!Array.isArray(msgs) || !msgs.length) {
    showToast("No hay mensajes que guardar.", "error");
    return;
  }

  // Generate a descriptive default title from chat content
  const defaultTitle = generateChatDocTitle(msgs);
  const title = await mikaPrompt('Guardar chat como documento', 'Título del documento:', defaultTitle);
  if (title == null || title.trim() === "") return;

  const activeProjectName = (el("activeTitle") && el("activeTitle").textContent) || "Proyecto";
  const isQuickChat = activeProjectId === QUICK_CHAT_ID;
  const header = `# ${title.trim()}

${isQuickChat ? 'Chat individual' : `Proyecto: ${activeProjectName}`}
Fecha: ${new Date().toISOString()}
Mensajes: ${msgs.length}

---
`;
  const body = compileChatAsMarkdown(msgs);
  const content = header + body;

  const saveBtn = el("btnSaveChatDoc");
  if (saveBtn) saveBtn.disabled = true;
  try {
    const savePayload = {
      projectId: activeProjectId,
      title: title.trim(),
      content,
      mimeType: "text/markdown"
    };
    // In quick-chat, save to the chat's own knowledge base
    if (isQuickChat && activeChatId) {
      savePayload.chatId = activeChatId;
    }
    const result = await saveDocument(savePayload);
    if (!result.ok) {
      showToast("Error: " + (result.error || "desconocido"), "error");
      return;
    }
    showToast("Chat guardado en Knowledge.", "success");
    await renderKnowledgeList();
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function generateChatDocTitle(msgs) {
  // Find the first user message to extract the topic
  const firstUser = msgs.find(m => m.role === 'user');
  if (!firstUser || !firstUser.content) {
    return `Chat - ${new Date().toLocaleDateString()}`;
  }

  // Clean the content: remove file attachments, reply quotes, markdown
  let text = firstUser.content
    .replace(/\[En respuesta a .*?\]\n*/s, '')
    .replace(/\[Adjuntos:.*?\]/g, '')
    .replace(/---\s+.*?\s+---\n/gs, '')
    .replace(/[#*_`~>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return `Chat - ${new Date().toLocaleDateString()}`;
  }

  // Take first meaningful sentence or fragment (up to 60 chars)
  const maxLen = 60;
  if (text.length <= maxLen) {
    return text;
  }

  // Try to cut at a word boundary
  const cut = text.lastIndexOf(' ', maxLen);
  return text.substring(0, cut > 20 ? cut : maxLen) + '...';
}

function generateSmartTitle(content) {
  if (!content) return `Respuesta - ${new Date().toLocaleDateString()}`;

  let text = (content || '').toString();

  // 1. Try to use the first markdown heading
  const headingMatch = text.match(/^#{1,3}\s+(.+)$/m);
  if (headingMatch) {
    const heading = headingMatch[1].replace(/[#*_`~]/g, '').trim();
    if (heading.length >= 5 && heading.length <= 80) return heading;
  }

  // 2. Try the first bold text (often a title/topic)
  const boldMatch = text.match(/\*\*(.{5,80}?)\*\*/);
  if (boldMatch) {
    const bold = boldMatch[1].replace(/[#*_`~]/g, '').trim();
    if (bold.length >= 5) return bold.substring(0, 70);
  }

  // 3. First meaningful line of content
  const lines = text
    .replace(/```[\s\S]*?```/g, '') // remove code blocks
    .replace(/[#*_`~>|]/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 10 && !/^[-=]{3,}$/.test(l));

  if (lines.length > 0) {
    const first = lines[0];
    if (first.length <= 70) return first;
    const cut = first.lastIndexOf(' ', 70);
    return first.substring(0, cut > 20 ? cut : 70) + '...';
  }

  return `Respuesta - ${new Date().toLocaleDateString()}`;
}

async function exportChatToFile() {
  if (!activeChatId) {
    showToast("Abre un chat.", "error");
    return;
  }
  const msgs = await window.mika5.db.listMessages(activeChatId);
  if (!Array.isArray(msgs) || !msgs.length) {
    showToast("No hay mensajes que exportar.", "error");
    return;
  }
  // Show export modal instead of prompt
  const modal = el("exportModal");
  if (modal) modal.style.display = "flex";
}

function closeExportModal() {
  const modal = el("exportModal");
  if (modal) modal.style.display = "none";
}

// --- Export system: standalone HTML builder ---
// Use the same DOM-based allowlist as chat, with a separate inert document CSP.
function renderExportMarkdown(text) {
  const raw = (text || '').toString().trim();
  if (!raw) return '';
  if (typeof marked === 'undefined') return escapeHtml(raw).replace(/\n/g, '<br>');
  try {
    return sanitizeHtml(marked.parse(raw));
  } catch (e) {
    return escapeHtml(raw).replace(/\n/g, '<br>');
  }
}

const EXPORT_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; width: 100%; max-width: 100%; margin: 0; padding: 12px 16px; color: #1a1a1a; font-size: 14px; line-height: 1.7; }
  .export-header { border-bottom: 2px solid #49C2F4; padding-bottom: 12px; margin-bottom: 20px; }
  .export-header h1 { font-size: 20px; margin-bottom: 4px; }
  .export-meta { color: #666; font-size: 12px; }
  .export-meta span { margin-right: 16px; }
  .msg { margin: 12px 0; padding: 10px 14px; border-radius: 4px; page-break-inside: avoid; }
  .msg-user { background: #eef6ff; border-left: 3px solid #49C2F4; }
  .msg-assistant { background: #f8f8f8; border-left: 3px solid #999; }
  .msg-system { background: #fffbeb; border-left: 3px solid #f59e0b; font-style: italic; }
  .role { font-weight: 700; margin-bottom: 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .msg-user .role { color: #2a7ab5; }
  .msg-assistant .role { color: #777; }
  .msg-system .role { color: #b45309; }
  p { margin-bottom: 8px; }
  p:last-child { margin-bottom: 0; }
  strong { font-weight: 700; }
  em { font-style: italic; }
  h2 { font-size: 17px; margin: 14px 0 6px; }
  h3 { font-size: 15px; margin: 12px 0 4px; }
  h4 { font-size: 14px; margin: 10px 0 4px; font-weight: 600; }
  ul, ol { margin: 6px 0; padding-left: 22px; }
  li { margin-bottom: 3px; }
  pre { background: #2d2d2d; color: #d4d4d4; padding: 10px; border-radius: 4px; font-size: 11px; line-height: 1.4; margin: 8px 0; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word; }
  code { font-family: Consolas, 'Courier New', monospace; font-size: 0.9em; }
  p code, li code { background: #e8e8e8; padding: 1px 4px; border-radius: 3px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; font-size: 12px; }
  th { background: #f0f0f0; font-weight: 600; }
  blockquote { border-left: 3px solid #ccc; margin: 8px 0; padding: 6px 12px; color: #555; background: #fafafa; }
  hr { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
  a { color: #2563eb; text-decoration: none; }
  img { max-width: 200px; height: auto; }
  @media print {
    body { margin: 0; padding: 0; }
    .msg { break-inside: avoid; }
    pre { font-size: 10px; }
    .export-header { break-after: avoid; }
  }
`;

function buildExportHTML(msgs, projectName, options = {}) {
  const theme = options.theme || 'light'; // 'light' for HTML/PDF
  const lang = options.lang === 'en' ? 'en' : 'es';
  const labels = lang === 'en'
    ? { user: 'User', assistant: 'Assistant', system: 'System', project: 'Project', date: 'Date', messages: 'messages' }
    : { user: 'Usuario', assistant: 'Asistente', system: 'Sistema', project: 'Proyecto', date: 'Fecha', messages: 'mensajes' };

  let html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src data: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(projectName)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<div class="export-header">
  <h1>${escapeHtml(projectName)}</h1>
  <div class="export-meta">
    <span>${labels.date}: ${new Date().toLocaleString()}</span>
    <span>${msgs.length} ${labels.messages}</span>
  </div>
</div>
`;

  for (const m of msgs) {
    const role = ['user', 'assistant', 'system'].includes(m.role) ? m.role : 'system';
    const roleLabel = labels[role] || role;
    const cls = 'msg-' + role;
    rememberApprovedImages(parseStoredAttachments(m.attachments).map(item => item?.url));
    const safeContent = renderExportMarkdown(m.content);
    html += `<div class="msg ${cls}"><div class="role">${escapeHtml(roleLabel)}</div><div>${safeContent}</div></div>\n`;
  }

  html += `</body></html>`;
  return html;
}

async function doExport(format) {
  closeExportModal();
  if (!activeChatId) return;

  const msgs = await window.mika5.db.listMessages(activeChatId);
  if (!Array.isArray(msgs) || !msgs.length) {
    showToast("No hay mensajes.", "error");
    return;
  }

  const projectName = (el("activeTitle") && el("activeTitle").textContent) || "Chat";
  const md = compileChatAsMarkdown(msgs);
  const base = `chat-${new Date().toISOString().slice(0, 10)}`;
  let content, defaultName, filters;

  if (format === 1) {
    // Markdown
    content = md;
    defaultName = base + ".md";
    filters = [{ name: "Markdown", extensions: ["md"] }];
  } else if (format === 2) {
    // Plain text
    content = md;
    defaultName = base + ".txt";
    filters = [{ name: "Texto", extensions: ["txt"] }];
  } else if (format === 3) {
    // HTML
    content = buildExportHTML(msgs, projectName, { lang: _mika5Lang });
    defaultName = base + ".html";
    filters = [{ name: "HTML", extensions: ["html"] }];
  } else if (format === 4) {
    // Python
    content = "# Chat exportado\n# " + md.split("\n").join("\n# ");
    defaultName = base + ".py";
    filters = [{ name: "Python", extensions: ["py"] }];
  } else if (format === 5) {
    // PDF via printToPDF or HTML fallback
    const pdfHtml = buildExportHTML(msgs, projectName, { lang: _mika5Lang });

    if (window.mika5?.printToPDF) {
      try {
        const result = await window.mika5.printToPDF({ html: pdfHtml, defaultName: base + ".pdf" });
        if (result && result.ok) { showToast(t('toast.exported'), "success"); return; }
        if (result && result.canceled) return;
      } catch (e) {
        console.warn('printToPDF not available:', e);
      }
    }

    // Fallback
    content = pdfHtml;
    defaultName = base + ".html";
    filters = [{ name: "HTML", extensions: ["html"] }];
    showToast(t('toast.pdfFallback'), "info");
  }

  if (!content) return;

  try {
    const result = await window.mika5.saveFile({ defaultName, filters, content, encoding: "utf8" });
    if (result && result.ok) showToast(t('toast.exported'), "success");
    else if (result && result.canceled) { /* cancelled */ }
    else showToast(t('toast.errorExport'), "error");
  } catch (err) {
    console.error("Export error:", err);
    showToast(t('toast.errorExport'), "error");
  }
}

async function pullModel() {
  const sel = el("modelSelect");
  const model = (sel && !sel.disabled && sel.value && sel.value.trim()) ? sel.value.trim() : null;
  let modelName = model;
  if (!modelName) {
    modelName = await mikaPrompt('Descargar modelo', 'Nombre del modelo (ej: llama3.2, qwen2.5:7b)', '');
    if (!modelName || !modelName.trim()) return;
    modelName = modelName.trim();
  }

  const pullBtn = el("btnPullLocal");
  if (pullBtn) {
    pullBtn.disabled = true;
    pullBtn.textContent = "Descargando…";
  }

  const res = await window.mika5.ollama.pull(modelName);

  if (pullBtn) {
    pullBtn.disabled = false;
    pullBtn.textContent = "Pull";
  }

  if (!res.ok) {
    showToast("Falló descarga: " + (res.error || "error desconocido"), "error");
    return;
  }

  await loadRuntime();
  el("modelSelect").value = modelName;
  syncModelDropdown();
  window.mika5.setAppState("lastModel", modelName).catch(() => {});
  if (pullBtn) {
    pullBtn.disabled = false;
    pullBtn.textContent = "Pull";
  }
  showToast("Modelo descargado: " + modelName, "success");
}

// Carga y renderiza la lista de modelos para el proveedor actual
async function loadModelsForCurrentProvider() {
  const provider = (await window.mika5.ai.getCurrentProvider()) || { id: currentProvider, name: currentProvider };
  const modelOptions = el('modelOptions');
  const select = el('modelSelect');
  if (!modelOptions || !select) return;

  modelOptions.replaceChildren();
  select.replaceChildren();

  let res;
  try {
    res = await window.mika5.ai.listModels();
  } catch (e) {
    console.warn('listModels failed:', e);
    res = null;
  }

  let models = [];
  if (Array.isArray(res)) models = res;
  else if (res && Array.isArray(res.models)) models = res.models;

  // Normalizar cada modelo a objeto { name, sizeFormatted, capabilities }
  const mapper = (raw) => {
    if (!raw) return null;
    if (typeof raw === 'string') return { name: raw };
    return {
      name: raw.name || raw.id || raw.model || String(raw),
      sizeFormatted: raw.sizeFormatted || raw.size_human || (raw.size ? formatBytesRenderer(Number(raw.size)) : ''),
      capabilities: raw.capabilities || raw.caps || raw.tags || []
      ,
      supportsVision: raw.supportsVision === true,
      taskType: raw.taskType || 'chat'
    };
  };

  const normalized = models.map(mapper).filter(Boolean)
    .filter(model => provider.id !== 'alibaba' || ['chat', 'vision'].includes(model.taskType));

  if (normalized.length === 0 && provider.id === 'local') {
    modelOptions.innerHTML = `
      <div class="model-option empty">
        <span>No hay modelos locales descargados</span>
        <button onclick="pullModel('llama3.2')" class="btn-primary btn-sm">Descargar llama3.2</button>
      </div>
    `;

    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Sin modelos locales';
    select.appendChild(opt);
    return;
  }

  if (provider.id === 'alibaba') {
    const automatic = document.createElement('option');
    automatic.value = AUTOMATIC_MODEL_ID;
    automatic.textContent = 'Automático';
    automatic.dataset.source = 'cloud';
    automatic.dataset.provider = 'alibaba';
    automatic.dataset.billingMode = 'token-plan';
    automatic.dataset.providerName = 'Alibaba Cloud Model Studio / Router de capacidades';
    automatic.dataset.taskType = 'automatic';
    select.appendChild(automatic);
  }

  for (const m of normalized) {
    const div = document.createElement('div');
    div.className = 'model-option';

    if (provider.id === 'local') {
      div.innerHTML = `
        <div class="model-header">
          <span class="model-name">${escapeHtml(m.name)}</span>
          <span class="model-size">${escapeHtml(m.sizeFormatted || '')}</span>
        </div>
        <div class="model-tags">
          <span class="tag private">🔒 Privado</span>
          ${Array.isArray(m.capabilities) ? m.capabilities.map(c => `<span class="tag">${escapeHtml(c)}</span>`).join('') : ''}
        </div>
      `;
    } else {
      div.innerHTML = `
        <div class="model-header">
          <span class="model-name">${escapeHtml(m.name)}</span>
        </div>
        <div class="model-tags">
          <span class="tag cloud">☁️ ${escapeHtml(provider.name || provider.id)}</span>
          ${provider.id === 'alibaba' ? `<span class="tag">${m.supportsVision ? 'Vision' : 'Text'}</span>` : ''}
        </div>
      `;
    }

    div.onclick = () => selectModel(m.name);
    modelOptions.appendChild(div);

    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = m.name;
    opt.dataset.source = provider.id === 'local' ? 'local' : 'cloud';
    opt.dataset.provider = provider.id;
    opt.dataset.taskType = m.taskType;
    opt.dataset.vision = m.supportsVision ? '1' : '0';
    if (provider.id === 'alibaba') {
      opt.dataset.billingMode = 'token-plan';
      opt.dataset.providerName = m.supportsVision
        ? 'Alibaba Cloud Model Studio / Vision'
        : 'Alibaba Cloud Model Studio / Text';
    }
    if (m.sizeFormatted) opt.dataset.sizeFormatted = m.sizeFormatted;
    if (m.capabilities && Array.isArray(m.capabilities)) opt.dataset.caps = m.capabilities.join(' • ');
    select.appendChild(opt);
  }

  syncModelDropdown();
}

// Asegura que un modelo exista (descarga si es local y falta)
async function ensureModelExists(modelName) {
  if (!modelName) return true;
  let res;
  try {
    res = await window.mika5.ai.listModels();
  } catch (e) {
    res = null;
  }
  let models = [];
  if (Array.isArray(res)) models = res;
  else if (res && Array.isArray(res.models)) models = res.models;

  const exists = models.some(m => (typeof m === 'string' ? m === modelName : (m.name === modelName || m.id === modelName)));
  if (exists) return true;

  showToast(`El modelo ${modelName} no está descargado. Descargando...`, 'info');
  try {
    if (currentProvider === 'local') {
      const r = await window.mika5.ollama.pull(modelName);
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'Pull failed');
      await loadModelsForCurrentProvider();
      showToast(`Modelo ${modelName} descargado.`, 'success');
      return true;
    } else {
      showToast('No es posible descargar modelos del proveedor Cloud desde este cliente.', 'warning');
      return false;
    }
  } catch (e) {
    showToast('Error descargando modelo: ' + (e?.message || e), 'error');
    return false;
  }
}

function selectModel(name) {
  const sel = el('modelSelect');
  const optionsContainer = el('modelOptions');
  const trigger = el('modelTrigger');
  if (sel) sel.value = name;
  syncModelDropdown();
  if (optionsContainer) {
    optionsContainer.classList.remove('open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
  // Persist selected model
  if (name) {
    window.mika5.setAppState("lastModel", name).catch(() => {});
  }
  onSelectedModelChanged();
}

function toggleSidebar() {
  const sidebar = el("sidebar");
  if (!sidebar) return;
  sidebar.classList.toggle("open");
  const isOpen = sidebar.classList.contains("open");
  window.mika5.setAppState("sidebar_collapsed", isOpen ? "" : "1").catch(() => {});
}

// --- Menú "Más acciones" ---
//
// Los controles secundarios ya no compiten por la barra. Conservan sus IDs, sus
// handlers y su estado disabled: el menú sólo cambia dónde viven.
function moreActionsItems(menu) {
  return Array.from(menu.querySelectorAll('[role="menuitem"]'))
    .filter(item => !item.disabled && item.style.display !== 'none');
}

function closeMoreActionsMenu({ restoreFocus = false } = {}) {
  const trigger = el('btnMoreActions');
  const menu = el('moreActionsMenu');
  if (!trigger || !menu) return;
  menu.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) { try { trigger.focus(); } catch (_) {} }
}

function openMoreActionsMenu({ focusFirst = false } = {}) {
  const trigger = el('btnMoreActions');
  const menu = el('moreActionsMenu');
  if (!trigger || !menu) return;
  // Nunca dos superficies desplegadas a la vez: no pueden solaparse.
  const modelOptions = el('modelOptions');
  if (modelOptions) modelOptions.classList.remove('open');
  const modelTrigger = el('modelTrigger');
  if (modelTrigger) modelTrigger.setAttribute('aria-expanded', 'false');
  const providerOptions = el('providerOptions');
  if (providerOptions) providerOptions.style.display = 'none';

  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  if (focusFirst) {
    const items = moreActionsItems(menu);
    if (items.length) { try { items[0].focus(); } catch (_) {} }
  }
}

function wireMoreActionsMenu() {
  const trigger = el('btnMoreActions');
  const menu = el('moreActionsMenu');
  if (!trigger || !menu) return;

  const isOpen = () => trigger.getAttribute('aria-expanded') === 'true';

  // Abrir es sólo abrir: el click no se propaga a ningún elemento del menú.
  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isOpen()) closeMoreActionsMenu();
    else openMoreActionsMenu();
  });

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMoreActionsMenu({ focusFirst: e.key === 'ArrowDown' });
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      closeMoreActionsMenu({ restoreFocus: true });
    }
  });

  menu.addEventListener('keydown', (e) => {
    const items = moreActionsItems(menu);
    const current = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMoreActionsMenu({ restoreFocus: true });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) items[(current + 1 + items.length) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) items[(current - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (items.length) items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      if (items.length) items[items.length - 1].focus();
    } else if (e.key === 'Tab') {
      closeMoreActionsMenu();
    }
  });

  // Ejecutar una acción cierra el menú; el handler propio del botón sigue intacto.
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('[role="menuitem"]')) closeMoreActionsMenu();
  });

  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    if (e.target.closest('#moreActionsMenu, #btnMoreActions')) return;
    closeMoreActionsMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closeMoreActionsMenu({ restoreFocus: true });
  });
}

// --- Salir de la aplicación y versión instalada ---
//
// La acción se llama «Salir de MIKA5» y no «Cerrar sesión» porque no hay sesión
// que cerrar: MIKA5 no tiene cuentas, ni login, ni credencial de usuario en
// ninguna parte del código. Llamarlo «cerrar sesión» prometería una
// invalidación que no ocurre y sugeriría que algo se borra. No se borra nada:
// proyectos, chats, documentos, contexto y credenciales de proveedor siguen en
// SQLite y reaparecen al volver a abrir. Para retirar permisos están «Revocar
// permiso cloud» y la configuración de cada proveedor.
async function quitApp() {
  const confirmado = await mikaConfirm(
    t('app.quitTitle'),
    t('app.quitMessage'),
    t('app.quitConfirm')
  );
  if (!confirmado) return;
  try {
    await window.mika5.app.quit();
  } catch (e) {
    showToast(t('app.quitFailed') + ': ' + (e?.message || e), 'error');
  }
}

async function renderInstalledVersion() {
  const valor = el('appVersionValue');
  if (!valor) return;
  try {
    const info = await window.mika5.app.getVersion();
    // En worktree y en `npm run dev` la aplicación no está empaquetada. Decirlo
    // evita confundir una compilación de desarrollo con una release instalada.
    valor.textContent = info.packaged
      ? `v${info.installed}`
      : `v${info.installed} · ${t('app.versionDev')}`;
  } catch (_) {
    valor.textContent = '—';
  }
}

// El rotulado va aparte del cableado: los oyentes se registran una sola vez,
// pero los textos se repintan en cada cambio de idioma desde applyTranslations.
function renderSessionLabels() {
  const salir = el('btnQuitApp');
  if (salir) {
    const etiqueta = el('btnQuitAppLabel');
    if (etiqueta) etiqueta.textContent = t('app.quitApp');
    salir.setAttribute('aria-label', t('app.quitApp'));
    salir.title = t('app.quitApp');
  }
  const versionLabel = el('appVersionLabel');
  if (versionLabel) versionLabel.textContent = t('app.versionLabel');
}

function wireSessionActions() {
  const salir = el('btnQuitApp');
  if (salir) {
    salir.addEventListener('click', () => {
      quitApp().catch(e => console.warn('quitApp:', e));
    });
  }
  renderSessionLabels();
  renderInstalledVersion().catch(e => console.warn('renderInstalledVersion:', e));
  // Sólo consulta si el usuario activó el aviso; por defecto no sale nada.
  checkForUpdatesOnStartup().catch(e => console.warn('checkForUpdatesOnStartup:', e));
}

// Con un método de entrada (chino, japonés, coreano) Enter CONFIRMA el
// carácter que se está componiendo: no es «enviar». Sin esta comprobación el
// mensaje salía a medias. `keyCode 229` cubre los motores que entregan esa
// tecla con `isComposing` ya a falso.
function confirmaComposicion(e) {
  return e.isComposing === true || e.keyCode === 229;
}

function wire() {
  el("btnCreateProject").onclick = createProject;
  const projInput = el("projectName");
  if (projInput) projInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (confirmaComposicion(e)) return; createProject(); } });

  wireMoreActionsMenu();
  wireSessionActions();

  const cloudBannerDismiss = el("cloudBannerDismiss");
  if (cloudBannerDismiss) {
    cloudBannerDismiss.addEventListener("click", () => {
      dismissCloudInputBanner().catch(e => console.warn('dismissCloudInputBanner:', e));
    });
  }

  // Language toggle
  const langBtn = el("btnLangToggle");
  if (langBtn) {
    langBtn.textContent = _mika5Lang === 'en' ? 'EN' : 'ES';
    langBtn.onclick = () => {
      const newLang = _mika5Lang === 'en' ? 'es' : 'en';
      setLanguage(newLang);
      langBtn.textContent = newLang === 'en' ? 'EN' : 'ES';
      applyTranslations();
      // El pie y el aviso cloud son texto traducido y con estado: se repintan.
      updatePrivacyUI();
    };
  }
  el("btnNewChat").onclick = newChat;
  el("btnSaveChatDoc").onclick = saveChatAsDoc;
  const btnExport = el("btnExportChat");
  if (btnExport) btnExport.onclick = exportChatToFile;
  el("btnSend").onclick = send;

  // --- Chat search ---
  const searchCloseBtn = el("chatSearchClose");
  if (searchCloseBtn) searchCloseBtn.addEventListener("click", closeChatSearch);
  const searchPrevBtn = el("chatSearchPrev");
  if (searchPrevBtn) searchPrevBtn.addEventListener("click", () => navigateSearch(searchCurrentIdx - 1));
  const searchNextBtn = el("chatSearchNext");
  if (searchNextBtn) searchNextBtn.addEventListener("click", () => navigateSearch(searchCurrentIdx + 1));
  const searchInput = el("chatSearchInput");
  if (searchInput) {
    let searchDebounce = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => performChatSearch(searchInput.value.trim()), 250);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeChatSearch();
      if (e.key === "Enter") {
        e.preventDefault();
        if (confirmaComposicion(e)) return;
        navigateSearch(e.shiftKey ? searchCurrentIdx - 1 : searchCurrentIdx + 1);
      }
    });
  }

  // Ctrl+F / Cmd+F opens chat search instead of browser find
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      openChatSearch();
    }
  });

  // --- Reply preview close ---
  const replyCloseBtn = el("replyPreviewClose");
  if (replyCloseBtn) replyCloseBtn.addEventListener("click", clearReplyTo);
  const btnPull = el("btnPull");
  // La biblioteca que se abre es la del proveedor ELEGIDO. La dirección la
  // declara cada adaptador en el proceso principal; aquí no hay ninguna
  // escrita, y por tanto ninguna puede quedarse apuntando a otro proveedor.
  if (btnPull) btnPull.onclick = () => { if (providerLibraryUrl) window.mika5.openExternal(providerLibraryUrl); };
  const btnPullLocal = el("btnPullLocal");
  if (btnPullLocal) btnPullLocal.onclick = pullModel;
  
  // Provider panel removed from sidebar (now only in header dropdown)

  const sidebar = el("sidebar");
  const sidebarToggle = el("sidebarToggle");
  const mobileSidebarToggle = el("mobileSidebarToggle");
  if (sidebar) {
    if (sidebarToggle) sidebarToggle.addEventListener("click", toggleSidebar);
    if (mobileSidebarToggle) mobileSidebarToggle.addEventListener("click", toggleSidebar);
    // Restore sidebar state from DB; fallback to responsive default
    window.mika5.getAppState("sidebar_collapsed").then(val => {
      if (val === "1") sidebar.classList.remove("open");
      else if (window.innerWidth > 768) sidebar.classList.add("open");
      else sidebar.classList.remove("open");
    }).catch(() => {
      if (window.innerWidth > 768) sidebar.classList.add("open");
      else sidebar.classList.remove("open");
    });
  }

  const modelTrigger = el("modelTrigger");
  const modelOptions = el("modelOptions");
  if (modelTrigger && modelOptions) {
    modelTrigger.onclick = (e) => {
      e.stopPropagation();
      modelOptions.classList.toggle("open");
      modelTrigger.setAttribute("aria-expanded", modelOptions.classList.contains("open"));
    };
    document.addEventListener("click", () => {
      modelOptions.classList.remove("open");
      modelTrigger.setAttribute("aria-expanded", "false");
      // Also close provider dropdown on outside click
      const provOpts = el("providerOptions");
      if (provOpts) provOpts.style.display = "none";
    });
  }

  const attachBtn = el("attachBtn");
  const fileInput = el("fileInput");
  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      if (files.length === 0) return;

      if (files.length > 1) showToast(`Procesando ${files.length} archivos…`, "info");

      let attached = 0;
      for (const file of files) {
        if (!file.size) continue;

        // Size limit: 10 MB for documents, 5 MB for images
        const maxSize = isDocumentFile(file) ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
        if (file.size > maxSize) {
          showToast(`Archivo muy grande: ${file.name} (máx ${maxSize / 1024 / 1024} MB)`, "error");
          continue;
        }

        // Reject truly binary files (executables, archives, media)
        if (TRUE_BINARY_EXTS.test(file.name)) {
          showToast(`${file.name}: formato binario no soportado`, "warning");
          continue;
        }

        try {
          if (isImageFile(file)) {
            // Identidad capturada ANTES de cualquier await.
            const attachContext = captureAttachmentContext();
            const outcome = await processImageAttachment({
              file,
              source: 'file',
              chatId: attachContext.chatId,
              providerId: attachContext.providerId,
              model: attachContext.model
            });
            if (!outcome.ok) {
              if (outcome.code === 'unsupported-type') {
                showToast(`${file.name}: formato de imagen no compatible. Usa PNG, JPEG o WebP.`, 'warning');
              } else if (outcome.code === 'blocked') {
                showToast(`${file.name}: ${outcome.reason}`, 'error');
                renderAttachmentPreview();
                updateSendButtonState();
              } else if (outcome.code === 'error') {
                showToast(`${file.name}: no se pudo procesar la imagen. No se adjuntó.`, 'error');
              }
              // 'aborted' es silencioso: la usuaria ya cambió de contexto.
              // El texto y el resto de adjuntos se conservan en todos los casos.
              continue;
            }
            attached++;
          } else if (isDocumentFile(file)) {
            try {
              const text = await extractTextFromDocument(file);
              if (text && text.trim()) {
                chatAttachments.push({ name: file.name, type: 'text', text });
                attached++;
              } else {
                showToast(`No se pudo extraer texto de ${file.name}`, "warning");
              }
            } catch (docErr) {
              handleDocExtractionError(docErr, file.name);
            }
          } else {
            // Plain text files (.js, .py, .json, .md, .txt, .html, .css, etc.)
            const text = await readFileAsText(file);
            const controlRatio = (text.match(/[\x00-\x08\x0E-\x1F]/g) || []).length / Math.max(text.length, 1);
            if (controlRatio > 0.1) {
              showToast(`${file.name}: el archivo parece ser binario`, "warning");
              continue;
            }
            chatAttachments.push({ name: file.name, type: 'text', text });
            attached++;
          }
        } catch (err) {
          console.warn(`Attachment error for ${file.name}:`, err);
          showToast(`Error: ${file.name}`, "error");
        }
      }

      // Consolidated feedback
      if (attached > 0 && files.length > 1) {
        showToast(`${attached} archivo(s) adjuntados`, "success");
      }
      renderAttachmentPreview();
    });
  }

  el("input").addEventListener("input", () => {
    updateSendButtonState();
    // El cuadro crece solo con su contenido: `field-sizing: content` en
    // `.input-textarea`. Antes se medía `scrollHeight` en cada tecla, lo que
    // obligaba a recalcular el diseño dos veces por pulsación.
  });

  // Clipboard paste: support pasting images
  el("input").addEventListener("paste", async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        if (file.size > 5 * 1024 * 1024) {
          showToast(t('toast.fileTooLarge', { name: 'pasted image' }), "error");
          continue;
        }
        try {
          const attachContext = captureAttachmentContext();
          const ext = file.type.split('/')[1] || 'png';
          // Mismo camino que el selector de archivos: la huella es del contenido,
          // así que volver a pegar la misma imagen resuelve el rechazo anterior.
          const outcome = await processImageAttachment({
            file,
            source: 'paste',
            displayName: `pasted-image.${ext}`,
            chatId: attachContext.chatId,
            providerId: attachContext.providerId,
            model: attachContext.model
          });
          if (!outcome.ok) {
            if (outcome.code === 'unsupported-type') {
              showToast('Formato de imagen no compatible. Usa PNG, JPEG o WebP.', 'warning');
            } else if (outcome.code === 'blocked') {
              showToast(`Imagen pegada: ${outcome.reason}`, 'error');
              renderAttachmentPreview();
              updateSendButtonState();
            } else if (outcome.code === 'error') {
              showToast('No se pudo procesar la imagen pegada. No se adjuntó.', 'error');
            }
            continue;
          }
          renderAttachmentPreview();
        } catch (err) {
          showToast('Error pasting image', "error");
        }
      }
    }
  });
  el("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (confirmaComposicion(e)) return;
      if (!isGenerating) send();
    }
  });

  const btnContextToggle = el("btnContextToggle");
  const contextPanel = el("contextPanel");
  const contextPanelClose = el("contextPanelClose");
  if (btnContextToggle && contextPanel) btnContextToggle.addEventListener("click", toggleContextPanel);
  if (contextPanelClose && contextPanel) contextPanelClose.addEventListener("click", () => contextPanel.classList.remove("open"));

  const btnSaveContext = el("btnSaveContext");
  if (btnSaveContext) btnSaveContext.addEventListener("click", saveProjectContext);

  const btnAddKnowledge = el("btnAddKnowledge");
  const knowledgeFileInput = el("knowledgeFileInput");
  if (btnAddKnowledge && knowledgeFileInput) {
    btnAddKnowledge.addEventListener("click", () => knowledgeFileInput.click());
    knowledgeFileInput.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      if (!activeProjectId) {
        showToast("Selecciona un proyecto primero", "error");
        return;
      }
      if (files.length === 0) return;

      let added = 0;
      let failed = 0;
      const total = files.length;

      // Show progress for multi-file uploads
      if (total > 1) showToast(`Procesando ${total} archivos…`, "info");

      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        if (file.size > 10 * 1024 * 1024) {
          showToast(`Archivo muy grande: ${file.name} (máx. 10 MB)`, "error");
          failed++;
          continue;
        }

        // Reject truly binary files
        if (TRUE_BINARY_EXTS.test(file.name)) {
          showToast(`${file.name}: formato binario no soportado`, "warning");
          failed++;
          continue;
        }

        try {
          let text;
          let mime = file.type || "text/plain";

          if (isImageFile(file)) {
            // Images: store a description placeholder (images can't be indexed as text)
            showToast(`${file.name}: las imágenes no se pueden indexar como conocimiento`, "warning");
            failed++;
            continue;
          } else if (isDocumentFile(file)) {
            try {
              text = await extractTextFromDocument(file);
              mime = "text/plain";
            } catch (docErr) {
              handleDocExtractionError(docErr, file.name);
              failed++;
              continue;
            }
          } else {
            // Plain text files (.js, .py, .json, .md, .txt, .html, .css, etc.)
            text = await readFileAsText(file);
            // Reject binary disguised as text
            const controlRatio = (text.match(/[\x00-\x08\x0E-\x1F]/g) || []).length / Math.max(text.length, 1);
            if (controlRatio > 0.1) {
              showToast(`${file.name}: el archivo parece ser binario`, "warning");
              failed++;
              continue;
            }
          }

          if (!text || !text.trim()) {
            showToast(`${file.name}: sin contenido de texto`, "warning");
            failed++;
            continue;
          }

          const knowledgePayload = {
            projectId: activeProjectId,
            title: file.name,
            content: text,
            mimeType: mime
          };
          if (activeProjectId === QUICK_CHAT_ID && activeChatId) {
            knowledgePayload.chatId = activeChatId;
          }
          const res = await window.mika5.db.addKnowledgeFromText(knowledgePayload);
          if (res && res.ok) added++;
          else { showToast(`Error: ${(res && res.error) || "desconocido"}`, "error"); failed++; }
        } catch (err) {
          console.warn(`Knowledge upload error for ${file.name}:`, err);
          showToast(`No se pudo leer ${file.name}`, "error");
          failed++;
        }
      }

      // Consolidated result toast
      if (added > 0 && failed === 0) {
        showToast(added === 1
          ? `${files[0]?.name || 'Archivo'} añadido al conocimiento`
          : `${added} archivos añadidos al conocimiento`, "success");
      } else if (added > 0 && failed > 0) {
        showToast(`${added} añadidos, ${failed} con errores`, "warning");
      }
      await renderKnowledgeList();
    });
  }
}

async function loadLogo() {
  const img = document.getElementById("brandLogo");
  if (!img || !window.mika5?.getAssetUrl) return;
  try {
    img.src = window.mika5.getAssetUrl("assets/logo.png");
    img.onerror = () => { img.style.display = "none"; };
  } catch (_) {
    img.style.display = "none";
  }
}

// --- Privacy Info Modal ---
function showPrivacyInfo() {
  const existing = document.getElementById('privacyInfoModal');
  if (existing) { existing.style.display = 'flex'; return; }

  const modal = document.createElement('div');
  modal.id = 'privacyInfoModal';
  modal.className = 'modal';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:500px;">
      <div class="modal-header">
        <h3>Privacidad en MIKA5</h3>
        <button class="btn-icon" onclick="document.getElementById('privacyInfoModal').style.display='none'">×</button>
      </div>
      <div class="modal-body" style="padding:16px 0;line-height:1.7;color:var(--text-muted);font-size:14px;">
        <p><strong style="color:var(--text-main);">🔒 Modo Local (Ollama)</strong><br>
        Todos los datos se procesan en tu equipo. Ningún mensaje sale de tu PC. 100% privado.</p>
        <br>
        <p><strong style="color:var(--text-main);">☁️ Modo Cloud</strong><br>
        Los mensajes se envían a servidores externos del proveedor seleccionado. MIKA5 sanitiza PII básica (emails, teléfonos, IDs) antes de enviar.</p>
        <br>
        <p><strong style="color:var(--text-main);">🔑 API Keys</strong><br>
        Se almacenan cifradas (AES-256-GCM) en la base de datos local. Nunca se transmiten a terceros más allá del proveedor.</p>
      </div>
    </div>
  `;
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
  document.body.appendChild(modal);
}

// --- API Key Modal ---
function showApiKeyModal() {
  const modal = el('apiKeyModal');
  if (modal) {
    modal.style.display = 'flex';
    const provider = (currentProvider !== 'local') ? currentProvider : 'openai';
    switchTab(provider);
  }
}

function closeApiKeyModal() {
  const modal = el('apiKeyModal');
  if (modal) modal.style.display = 'none';
}

function switchTab(provider) {
  document.querySelectorAll('.tab-content').forEach(t => t.style.display = 'none');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const tab = document.getElementById('tab-' + provider);
  if (tab) tab.style.display = 'block';
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.textContent.toLowerCase().includes(provider)) b.classList.add('active');
  });
  if (provider === 'alibaba') loadAlibabaConfig().catch(error => {
    showToast('Error al cargar Alibaba: ' + (error?.message || error), 'error');
  });
}

let alibabaConfig = null;

async function loadAlibabaConfig() {
  alibabaConfig = await window.mika5.ai.getProviderConfig('alibaba');
  const endpointInput = el('alibabaEndpointInput');
  endpointInput.value = alibabaConfig.endpoint || '';
  el('alibabaProtocolInput').value = alibabaConfig.protocol || 'anthropic-compatible';
  el('alibabaRegionInput').value = alibabaConfig.region || '';
  el('alibabaWorkspaceInput').value = alibabaConfig.workspace || '';
  el('alibabaBillingInput').value = alibabaConfig.billingMode || 'token-plan';
  const isTemplate = /<workspace-id>|\{WorkspaceId\}/i.test(endpointInput.value);
  const usesConfiguredWorkspace = alibabaConfig.workspace
    && endpointInput.value.startsWith(`https://${alibabaConfig.workspace}.`);
  endpointInput.dataset.autoGenerated = isTemplate || usesConfiguredWorkspace ? 'true' : 'false';
  if (!endpointInput.dataset.listenersBound) {
    el('alibabaWorkspaceInput').addEventListener('input', () => generateAlibabaEndpoint());
    el('alibabaRegionInput').addEventListener('input', () => generateAlibabaEndpoint());
    endpointInput.addEventListener('input', () => {
      endpointInput.dataset.autoGenerated = 'false';
    });
    endpointInput.dataset.listenersBound = 'true';
  }
  generateAlibabaEndpoint();
  const simpleModelSelect = el('alibabaModelSelect');
  simpleModelSelect.replaceChildren();
  for (const model of alibabaConfig.models || []) {
    if (!['chat', 'vision'].includes(model.taskType || 'chat')) continue;
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.displayName || model.id;
    simpleModelSelect.appendChild(option);
  }
  try {
    const lastModel = await window.mika5.getAppState('lastModel');
    if (lastModel && Array.from(simpleModelSelect.options).some(option => option.value === lastModel)) {
      simpleModelSelect.value = lastModel;
    }
  } catch (_) {}
  renderAlibabaModels();
  populateAlibabaGenerationModels();
}

function generateAlibabaEndpoint(force = false) {
  const endpointInput = el('alibabaEndpointInput');
  const workspace = el('alibabaWorkspaceInput').value.trim();
  const region = el('alibabaRegionInput').value.trim();
  if (!endpointInput || !workspace || !region) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(workspace) || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(region)) return;
  if (force || endpointInput.dataset.autoGenerated === 'true') {
    endpointInput.value = `https://${workspace}.${region}.maas.aliyuncs.com/apps/anthropic`;
    endpointInput.dataset.autoGenerated = 'true';
  }
}

function capabilitySummary(capabilities) {
  const labels = {
    tools: 'tools',
    vision: 'visión',
    reasoning: 'reasoning',
    streaming: 'streaming',
    structuredJson: 'JSON'
  };
  const known = Object.entries(capabilities || {})
    .filter(([, value]) => value === true || value === false)
    .map(([key, value]) => `${labels[key] || key}: ${value ? 'sí' : 'no'}`);
  return known.length ? known.join(' · ') : 'Capacidades no declaradas';
}

function renderAlibabaModels() {
  const list = el('alibabaModelsList');
  if (!list) return;
  list.replaceChildren();
  const groups = [
    ['chat', 'Chat'],
    ['vision', 'Vision'],
    ['image-generation', 'Imagen'],
    ['video-generation', 'Video']
  ];
  for (const [taskType, label] of groups) {
    const models = (alibabaConfig?.models || []).filter(model => (model.taskType || 'chat') === taskType);
    if (!models.length) continue;
    const heading = document.createElement('strong');
    heading.textContent = label;
    heading.style.marginTop = '8px';
    list.appendChild(heading);
    for (const model of models) {
    const row = document.createElement('div');
    row.style.cssText = 'border:1px solid var(--border-subtle);border-radius:8px;padding:9px;';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;gap:8px;align-items:center;';
    const title = document.createElement('strong');
    title.textContent = model.displayName || model.id;
    const actions = document.createElement('span');
    const editButton = document.createElement('button');
    editButton.className = 'btn-icon';
    editButton.textContent = '✎';
    editButton.title = 'Editar modelo';
    editButton.onclick = () => editAlibabaModel(model.id);
    const deleteButton = document.createElement('button');
    deleteButton.className = 'btn-icon';
    deleteButton.textContent = '×';
    deleteButton.title = 'Eliminar modelo';
    deleteButton.onclick = () => deleteAlibabaModel(model.id);
    actions.append(editButton, deleteButton);
    header.append(title, actions);
    const details = document.createElement('div');
    details.className = 'hint';
    details.textContent = `${model.id} · ${capabilitySummary(model.capabilities)} · Parámetros: ${Object.keys(model.parameters || {}).join(', ') || 'ninguno'}`;
    row.append(header, details);
    list.appendChild(row);
    }
  }
  if (!(alibabaConfig?.models || []).length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No hay modelos configurados. Agrega uno autorizado en tu workspace.';
    list.appendChild(empty);
  }
}

async function saveAlibabaConfig({ quiet = false } = {}) {
  if (!alibabaConfig) await loadAlibabaConfig();
  generateAlibabaEndpoint();
  const next = {
    ...alibabaConfig,
    endpoint: el('alibabaEndpointInput').value.trim(),
    protocol: el('alibabaProtocolInput').value.trim(),
    region: el('alibabaRegionInput').value.trim(),
    workspace: el('alibabaWorkspaceInput').value.trim(),
    billingMode: el('alibabaBillingInput').value.trim() || 'token-plan'
  };
  alibabaConfig = await window.mika5.ai.saveProviderConfig('alibaba', next);
  if (!quiet) showToast('Configuración de Alibaba guardada', 'success');
  if (currentProvider === 'alibaba') await loadRuntime();
  return alibabaConfig;
}

async function saveAlibabaSimpleConfig(quiet = false) {
  try {
    if (!alibabaConfig) await loadAlibabaConfig();
    const keyInput = el('alibabaKeyInput');
    const key = keyInput.value.trim();
    await window.mika5.ai.setProvider('alibaba');
    currentProvider = 'alibaba';
    providerPrivacy = 'cloud';
    await refreshProviderCapabilities();
    let keyResult = null;
    if (key) {
      keyResult = await window.mika5.ai.setApiKey('alibaba', key);
      keyInput.value = '';
    } else {
      const status = await window.mika5.ai.status();
      if (!status?.ok) {
        showToast('Pega tu API Key de Alibaba Token Plan', 'error');
        return false;
      }
    }
    await saveAlibabaConfig({ quiet: true });
    const selectedModel = el('alibabaModelSelect').value || 'qwen3.7-max';
    await window.mika5.setAppState('lastModel', selectedModel);
    updatePrivacyUI();
    await loadRuntime();
    el('modelSelect').value = selectedModel;
    syncModelDropdown();
    if (keyResult?.warning) showToast(keyResult.warning, 'warning');
    else if (!quiet) showToast('Alibaba Token Plan guardado', 'success');
    return true;
  } catch (error) {
    showToast('No se pudo guardar Alibaba: ' + (error?.message || error), 'error');
    return false;
  }
}

async function testAlibabaConnection() {
  const saved = await saveAlibabaSimpleConfig(true);
  if (!saved) return;
  const model = el('alibabaModelSelect').value || 'qwen3.7-max';
  try {
    const result = await sendAIChat({
      providerId: 'alibaba',
      model,
      messages: [{ role: 'user', content: 'Responde únicamente: OK' }]
    });
    if (result?.message?.content) showToast('Conexión con Alibaba correcta', 'success');
    else showToast('Alibaba respondió sin contenido', 'warning');
  } catch (error) {
    showToast('Falló la conexión con Alibaba: ' + (error?.message || error), 'error');
  }
}

async function editAlibabaModel(existingId) {
  if (!alibabaConfig) await loadAlibabaConfig();
  const existing = (alibabaConfig.models || []).find(model => model.id === existingId);
  const id = await mikaPrompt('Modelo Alibaba', 'Identificador exacto autorizado en tu workspace:', existing?.id || '');
  if (!id) return;
  const displayName = await mikaPrompt('Nombre visible', 'Nombre visible del modelo:', existing?.displayName || id);
  if (displayName == null) return;
  const taskType = await mikaPrompt(
    'Tipo de modelo',
    'Usa chat, vision, image-generation o video-generation:',
    existing?.taskType || 'chat'
  );
  if (!taskType) return;
  try {
    const model = {
      id: id.trim(),
      displayName: displayName.trim() || id.trim(),
      taskType: taskType.trim(),
      capabilities: { vision: taskType.trim() === 'vision' ? true : null },
      parameters: ['chat', 'vision'].includes(taskType.trim()) ? { max_tokens: 1024 } : {}
    };
    alibabaConfig = existing
      ? await window.mika5.ai.updateProviderModel('alibaba', existing.id, model)
      : await window.mika5.ai.addProviderModel('alibaba', model);
    renderAlibabaModels();
    if (currentProvider === 'alibaba') await loadRuntime();
  } catch (error) {
    showToast('Modelo no guardado: ' + (error?.message || error), 'error');
  }
}

function populateAlibabaGenerationModels() {
  const imageSelect = el('alibabaImageModelSelect');
  const videoList = el('alibabaVideoModels');
  if (imageSelect) {
    imageSelect.replaceChildren();
    for (const model of (alibabaConfig?.models || []).filter(item => item.taskType === 'image-generation')) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.displayName || model.id;
      imageSelect.appendChild(option);
    }
  }
  if (videoList) {
    videoList.textContent = (alibabaConfig?.models || [])
      .filter(item => item.taskType === 'video-generation')
      .map(item => item.displayName || item.id)
      .join(' · ');
  }
}

async function generateAlibabaImage() {
  const prompt = el('alibabaImagePrompt')?.value.trim();
  const model = el('alibabaImageModelSelect')?.value;
  if (!prompt || !model) {
    showToast('Escribe una descripción y selecciona un modelo de imagen', 'warning');
    return;
  }
  const saved = await saveAlibabaSimpleConfig(true);
  if (!saved) return;
  const requestContext = createRequestContext({
    chatId: activeChatId || 'alibaba-config',
    projectId: activeProjectId,
    providerId: 'alibaba',
    selectedModel: model
  });
  const generationPayload = {
    requestId: requestContext.requestId,
    providerId: requestContext.providerId,
    model,
    prompt,
    sourceImages: []
  };
  const cloudScope = buildEffectiveCloudScope(requestContext, generationPayload);
  if (!await ensureCloudConsent(requestContext, cloudScope)) return;
  activeRequestId = requestContext.requestId;
  const button = el('alibabaGenerateImageButton');
  const results = el('alibabaImageResults');
  if (button) button.disabled = true;
  if (results) results.textContent = 'Generando imagen…';
  try {
    const response = await sendAIImage(generationPayload);
    if (results) {
      results.replaceChildren();
      for (const url of response.images || []) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = prompt;
        img.style.cssText = 'max-width:100%;border-radius:10px;margin-top:10px;';
        results.appendChild(img);
      }
      enhanceMessageImages(results, { role: 'assistant', model });
    }
  } catch (error) {
    if (results) results.textContent = '';
    showToast('No se pudo crear la imagen: ' + sanitizeRemoteErrorMessage(error?.message || error), 'error');
  } finally {
    if (activeRequestId === requestContext.requestId) activeRequestId = null;
    if (button) button.disabled = false;
  }
}

async function deleteAlibabaModel(modelId) {
  const confirmed = await mikaConfirm('Eliminar modelo', `¿Eliminar ${modelId} del catálogo local?`, 'Eliminar');
  if (!confirmed) return;
  try {
    alibabaConfig = await window.mika5.ai.deleteProviderModel('alibaba', modelId);
    renderAlibabaModels();
    if (currentProvider === 'alibaba') await loadRuntime();
  } catch (error) {
    showToast('Modelo no eliminado: ' + (error?.message || error), 'error');
  }
}

async function saveApiKey(provider) {
  const input = el(provider + 'KeyInput');
  if (!input) { showToast('Error: campo no encontrado', 'error'); return; }
  const key = input.value.trim();
  if (!key) { showToast('Ingresa una API Key válida', 'error'); return; }
  try {
    const result = await window.mika5.ai.setApiKey(provider, key);
    if (result) {
      showToast(result.warning || ('API Key guardada para ' + provider), result.warning ? 'warning' : 'success');
      input.value = '';
      closeApiKeyModal();
      if (currentProvider === provider) await loadRuntime();
    } else {
      showToast('No se pudo guardar la API Key', 'error');
    }
  } catch (e) {
    showToast('Error: ' + (e?.message || e), 'error');
  }
}

// boot con manejo de errores para asegurar que el input quede usable
(async function boot() {
  try {
    wire();
  } catch (e) {
    console.error('[boot] wire() failed:', e);
  }

  // Restore language from DB before applying translations
  try { await restoreLanguageFromDb(); } catch (_) {}
  applyTranslations();

  try { await loadLogo(); } catch (_) {}

  try {
    await loadProvider();
  } catch (e) {
    console.warn('[boot] loadProvider failed:', e);
  }

  try {
    await loadRuntime();
  } catch (e) {
    console.warn('[boot] loadRuntime failed:', e);
  }

  // Ensure Quick Chat project exists
  try {
    await ensureQuickChat();
  } catch (e) {
    console.warn('[boot] ensureQuickChat failed:', e);
  }

  try {
    await loadProjects();
  } catch (e) {
    console.warn('[boot] loadProjects failed:', e);
  }

  // Restore last session
  try {
    const lastProjectId = await window.mika5.getAppState("lastProjectId");
    if (lastProjectId) {
      const projects = await Store.listProjects();
      const p = projects.find((x) => x.id === lastProjectId);
      if (p) {
        await selectProject(p.id, p.name);
      } else {
        await window.mika5.setAppState("lastProjectId", null);
      }
    }
  } catch (error) {
    console.error("[boot] Error restoring session:", error);
  }

  // Ensure app is usable regardless of what happened above
  const input = el("input");
  if (input) input.disabled = false;

  if (!activeProjectId) {
    try {
      const projects = await Store.listProjects();
      el("activeTitle").textContent = projects.length === 0
        ? t('chat.createFirst')
        : t('chat.selectProject');
    } catch (_) {
      el("activeTitle").textContent = t('chat.selectProject');
    }
  }

  // Listen for knowledge indexing completion from main process
  // Un documento largo en un motor con la ventana pequeña se lee por partes:
  // varios minutos en los que «Generando…» no decía nada.
  window.mika5?.ai?.onChatProgress?.((avance) => {
    if (!avance || avance.requestId !== activeRequestId || !(avance.parts > 0)) return;
    const placeholder = document.getElementById('msg-generating-placeholder');
    if (!placeholder) return;
    placeholder.textContent = avance.answering
      ? t('chat.readingPartsAnswering', { n: avance.parts })
      : t('chat.readingParts', { i: avance.part, n: avance.parts });
  });

  if (window.mika5?.onKnowledgeIndexComplete) {
    window.mika5.onKnowledgeIndexComplete((data) => {
      renderKnowledgeList();
      if (data.ok && data.indexed > 0) {
        showToast(t('toast.knowledgeIndexed') || `Document indexed (${data.indexed} chunks)`, 'success');
      } else if (!data.ok && data.saved && data.pending) {
        const pendingMessage = data.code === 'EMBEDDING_MODEL_NOT_CONFIGURED'
          ? 'Documento guardado. Configura un modelo local de embeddings para habilitar búsqueda semántica.'
          : 'Documento guardado. Indexación pendiente: falta el modelo local de embeddings.';
        showToast(pendingMessage, 'warning');
      } else if (!data.ok && data.error) {
        const err = data.error || '';
        if (err.includes('EMBED') || err.includes('INVALID_EMBED') || err.includes('nomic') || err.includes('Connection refused') || err.includes('ECONNREFUSED')) {
          showToast('Documento guardado. Indexación pendiente: falta el modelo local de embeddings.', 'warning');
        } else {
          showToast(`${t('toast.knowledgeIndexError')}: ${err.slice(0, 150)}`, 'error');
        }
        console.warn('[Knowledge] Index error:', err);
      }
    });
  }

  console.log('[boot] DONE. activeProjectId:', activeProjectId, 'activeChatId:', activeChatId);
})();
