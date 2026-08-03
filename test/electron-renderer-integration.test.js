'use strict';

const assert = require('assert');
const path = require('path');
const { app, BrowserWindow, ipcMain, session } = require('electron');

async function waitFor(win, expression, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timeout waiting for ${expression}`);
}

async function run() {
  await app.whenReady();
  const appState = new Map();
  const state = {
    dbWrites: [],
    chatCalls: [],
    generateCalls: [],
    externalUrls: [],
    routeMode: 'chat',
    ragEnabled: true,
    resolveVisionCalls: [],
    routeIntentCalls: [],
    echoRestoredImage: false,
    dbAttempts: [],
    addMessageFailure: null,
    chunkScopeCalls: [],
    knowledgeScopeCalls: [],
    abortCalls: [],
    holdChat: false,
    order: []
  };
  const handlers = {
    'appState:get': (_event, key) => appState.get(key) ?? null,
    'appState:set': (_event, key, value) => {
      if (value === '') appState.delete(key);
      else appState.set(key, value);
      return true;
    },
    'db:listProjects': () => [],
    'db:createProject': () => ({ ok: true, id: 'quick-chat' }),
    'db:listChats': () => [],
    'db:listMessages': () => [{ id: 1, role: 'assistant', content: 'history' }],
    'db:addMessage': (_event, payload) => {
      state.dbAttempts.push(payload);
      state.order.push('db:' + payload.role + ':start');
      // Fallo inyectable: permite ejercer el gate de persistencia por los
      // caminos productivos, no llamando a helpers a mano.
      const failure = state.addMessageFailure;
      const failureApplies = failure
        && failure.role === payload.role
        && (!failure.onlyContent || failure.onlyContent === payload.content);
      if (failureApplies) {
        if (failure.once) state.addMessageFailure = null;
        state.order.push('db:' + payload.role + ':fail');
        // `throws` reproduce una excepción del canal IPC, no un ok:false.
        if (failure.throws) throw new Error('DB_UNAVAILABLE');
        return { ok: false, error: 'ATTACHMENT_TOO_LARGE' };
      }
      state.dbWrites.push(payload);
      state.order.push('db:' + payload.role + ':ok');
      return { ok: true, id: state.dbWrites.length };
    },
    'db:getProjectContext': () => 'Project instruction',
    'db:getChatContext': () => '',
    'db:listKnowledge': (_event, projectId, chatId, opts) => {
      state.knowledgeScopeCalls.push({ projectId, chatId, opts });
      return [];
    },
    'rag:listChunksRaw': (_event, projectId, chatId, maxChars, mode, opts) => {
      state.chunkScopeCalls.push({ projectId, chatId, mode, opts });
      return state.ragEnabled
        ? [{ title: 'Private-RAG.md', chunk_index: 0, chunk_text: 'local rag content' }]
        : [];
    },
    'ai:get-current-provider': () => ({ id: 'openai', name: 'OpenAI', privacy: 'cloud' }),
    'ai:list-models': () => [{ name: 'gpt-4o', supportsVision: true }],
    'ai:get-capabilities': () => ({ provider: 'openai', chat: true, vision: true }),
    'ai:resolve-vision': (_event, params = {}) => {
      state.resolveVisionCalls.push({ provider: params.provider, model: params.model });
      return {
      provider: 'openai',
      model: params.model || null,
      supported: params.model === 'gpt-4o',
      reason: params.model === 'gpt-4o' ? 'allowlist' : 'model-unsupported',
      message: params.model === 'gpt-4o'
        ? null
        : `El modelo ${params.model} no acepta imagenes en OpenAI (Cloud).`
      };
    },
    'ai:status': () => ({ ok: true }),
    'ollama:status': () => ({ ok: true }),
    'ollama:tags': () => [],
    'ai:route-intent': (_event, params = {}) => {
      state.routeIntentCalls.push({ lastUserImage: params.lastUserImage || null });
      if (state.routeMode === 'edit') {
        // 'edit-restored' echa mano de la imagen que el renderer diga tener como
        // contexto visual: así el test demuestra que la restaurada llega hasta
        // generateImage, en vez de fabricar una fuente sintética.
        const sourceImage = state.routeMode === 'edit' && state.echoRestoredImage && params.lastUserImage
          ? params.lastUserImage
          : {
          name: 'source-edit.png',
          base64: 'c291cmNl',
          mediaType: 'image/png',
          visualEntryId: 'visual-1'
        };
        return {
          action: 'generate-image',
          intent: 'image-edit',
          model: 'image-model',
          modelPrompt: 'edit image',
          generationPrompt: 'edit image',
          detailed: { intentConflicts: {} },
          visualContext: { imageRef: sourceImage },
          visualExecution: {
            generationPrompt: 'edit image',
            validation: { valid: true },
            plan: { mode: 'image-edit', sourceImage }
          }
        };
      }
      return {
        action: 'chat',
        intent: 'normal-chat',
        // El router real puede cambiar el modelo, y send() usa el que devuelve
        // (`model = route.model || model`). Fijarlo a gpt-4o hacía que el fixture
        // ignorara el modelo seleccionado y la barrera de visión nunca se probara.
        model: params.currentModel || 'gpt-4o',
        detailed: { intentConflicts: {} },
        visualContext: null,
        visualExecution: null
      };
    },
    'ai:chat': (_event, payload) => {
      state.order.push('provider:start');
      state.chatCalls.push(payload);
      if (state.holdChat) {
        return new Promise(resolve => { state.releaseChat = resolve; });
      }
      return { message: { content: 'ok' } };
    },
    'ai:generate-image': (_event, payload) => {
      state.order.push('provider:start');
      state.generateCalls.push(payload);
      return { images: ['https://example.com/generated.png'] };
    },
    // El requestId con el que se cancela DEBE ser el mismo con el que se envió:
    // sin él, el proceso principal aborta otra solicitud, o ninguna.
    'ai:abort': (_event, requestId) => {
      state.abortCalls.push(requestId);
      return { aborted: true };
    },
    'openExternal': (_event, url) => {
      state.externalUrls.push(url);
      return true;
    }
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

  const networkRequests = [];
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../src/main/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true
    }
  });
  // Sin esto, un error dentro de executeJavaScript llega como "Script failed to
  // execute" sin ninguna pista de qué falló.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer ${sourceId}:${line}] ${message}`);
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[preload error]', preloadPath, error);
  });
  await win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/i.test(details.url)) {
      networkRequests.push(details.url);
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  await waitFor(win, `typeof send === 'function' && typeof renderMarkdown === 'function'`);

  const sanitizer = await win.webContents.executeJavaScript(`(() => {
    const host = document.createElement('div');
    host.className = 'message-content';
    host.innerHTML = renderMarkdown(
      '<img/src=x/onerror=MARK><svg/onload=MARK></svg>'
      + '<a href=javascript:MARK>x</a>'
      + '<div style="background:url(javascript:MARK)">x</div>'
      + '[safe](https://example.com/safe)'
    );
    document.body.appendChild(host);
    return {
      html: host.innerHTML,
      events: Array.from(host.querySelectorAll('*')).flatMap(node =>
        Array.from(node.attributes).filter(attr => /^on/i.test(attr.name))
      ).length,
      styles: host.querySelectorAll('[style],style').length,
      active: host.querySelectorAll('svg,iframe,object,embed,form').length
    };
  })()`, true);
  assert.strictEqual(sanitizer.events, 0);
  assert.strictEqual(sanitizer.styles, 0);
  assert.strictEqual(sanitizer.active, 0);
  assert(!/javascript:/i.test(sanitizer.html));

  const linkCheck = await win.webContents.executeJavaScript(`(() => {
    const link = document.querySelector('.message-content a[href]');
    const href = link?.getAttribute('href');
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { href, safe: safeExternalHref(href) };
  })()`, true);
  assert.strictEqual(linkCheck.safe, 'https://example.com/safe');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepStrictEqual(state.externalUrls, ['https://example.com/safe']);

  const prepare = ({ text, withImage }) => win.webContents.executeJavaScript(`(() => {
    activeProjectId = 'project-a';
    activeChatId = 'chat-a';
    currentProvider = 'openai';
    providerPrivacy = 'cloud';
    const select = document.getElementById('modelSelect');
    select.innerHTML = '<option value="gpt-4o" data-vision="1">gpt-4o</option>';
    select.value = 'gpt-4o';
    document.getElementById('input').value = ${JSON.stringify(text)};
    chatAttachments = ${withImage ? `[{type:'image',name:'attached.png',mediaType:'image/png',base64:'aW1hZ2U='}]` : '[]'};
  })()`, true);

  await prepare({ text: 'cancel me', withImage: true });
  await win.webContents.executeJavaScript(`window.__sendPromise = send(); undefined`, true);
  await waitFor(win, `document.getElementById('cloudConsentModal')`);
  const cancelScope = await win.webContents.executeJavaScript(
    `document.getElementById('cloudConsentModal').innerText`,
    true
  );
  assert.match(cancelScope, /attached\.png/);
  assert.match(cancelScope, /Private-RAG\.md/);
  await win.webContents.executeJavaScript(
    `document.querySelectorAll('#cloudConsentModal button')[2].click()`,
    true
  );
  await win.webContents.executeJavaScript(`window.__sendPromise`, true);
  assert.strictEqual(state.dbWrites.length, 0, 'cancel must happen before DB write');
  assert.strictEqual(state.chatCalls.length, 0);
  const preserved = await win.webContents.executeJavaScript(`({
    input: document.getElementById('input').value,
    attachments: chatAttachments.map(item => item.name)
  })`, true);
  assert.strictEqual(preserved.input, 'cancel me');
  assert.deepStrictEqual(preserved.attachments, ['attached.png']);

  const textOnlyConsent = {
    providerId: 'openai',
    projectScope: 'project:project-a',
    categories: {
      message: true,
      history: true,
      projectInstructions: true,
      textAttachments: false,
      imageAttachments: false,
      ragContext: false
    },
    schemaVersion: 1,
    grantedAt: new Date(0).toISOString()
  };
  appState.set('cloud-consent:v1:openai:project:project-a', JSON.stringify(textOnlyConsent));
  await prepare({ text: 'send expanded', withImage: true });
  await win.webContents.executeJavaScript(`window.__sendPromise = send(); undefined`, true);
  await waitFor(win, `document.getElementById('cloudConsentModal')`);
  const expandedScope = await win.webContents.executeJavaScript(
    `document.getElementById('cloudConsentModal').innerText`,
    true
  );
  assert.match(expandedScope, /Imágenes adjuntas|Attached images/);
  assert.match(expandedScope, /Contexto RAG|RAG context/);
  await win.webContents.executeJavaScript(
    `document.querySelectorAll('#cloudConsentModal button')[0].click()`,
    true
  );
  await win.webContents.executeJavaScript(`window.__sendPromise`, true);
  assert.strictEqual(state.chatCalls.length, 1);
  assert.strictEqual(state.dbWrites.length >= 2, true);
  // Forma unificada del contrato: el renderer envía siempre { base64, mediaType, url }.
  // El base64 pelado no basta — OpenAI y Anthropic necesitan el mediaType para
  // construir su bloque de imagen, y `local.chat` reduce este objeto a lo que
  // espera Ollama.
  assert.deepStrictEqual(state.chatCalls[0].images, [
    { base64: 'aW1hZ2U=', mediaType: 'image/png', url: undefined }
  ]);
  assert(state.chatCalls[0].messages.some(message =>
    message.role === 'system' && message.content.includes('local rag content')
  ));
  assert.match(state.chatCalls[0].requestId, /^[A-Za-z0-9._:-]{8,128}$/);

  // --- Cancelación: Detener aborta ESTA solicitud, no otra ---
  // Sin esta comprobación, pasar un requestId equivocado (o ninguno) dejaba el
  // botón sin efecto y ningún test lo notaba.
  state.abortCalls.length = 0;
  state.holdChat = true;
  await prepare({ text: "cancelame por id", withImage: false });
  await win.webContents.executeJavaScript(`window.__cancelPromise = send(); undefined`, true);
  await waitFor(win, `document.getElementById('cloudConsentModal')`);
  await win.webContents.executeJavaScript(
    `document.querySelectorAll('#cloudConsentModal button')[0].click()`, true);
  await waitFor(win, `document.getElementById('btnStop').style.display !== 'none'`);
  await win.webContents.executeJavaScript(
    `document.getElementById('btnStop').click()`, true);
  assert.strictEqual(state.abortCalls.length, 1, 'Detener debe llamar a ai:abort una vez');
  assert.strictEqual(state.abortCalls[0], state.chatCalls.at(-1).requestId,
    'ai:abort debe recibir el mismo requestId con el que se envió la solicitud');

  if (state.releaseChat) state.releaseChat({ message: { content: 3 > 2 ? "tarde" : "" } });
  await win.webContents.executeJavaScript(`window.__cancelPromise.catch(() => {})`, true);
  state.holdChat = false;
  state.releaseChat = null;

  // --- Alcance de conocimiento pedido por un proyecto NORMAL ---
  // Antes se enviaba projectId con chatId null, y el proceso principal filtraba
  // sólo por kc.project_id: el conocimiento privado de cualquier otro chat del
  // proyecto acababa inyectado en esta conversación.
  const normalScope = state.chunkScopeCalls.at(-1);
  assert.strictEqual(normalScope.projectId, 'project-a', 'proyecto normal envía su projectId');
  assert.strictEqual(normalScope.chatId, 'chat-a', 'proyecto normal envía también el chatId');
  assert.strictEqual(normalScope.opts.includeProjectScope, true,
    'proyecto normal pide includeProjectScope=true');

  // --- Alcance de conocimiento pedido por Quick Chat ---
  // Quick Chat no tiene conocimiento de proyecto: incluirlo mezclaría los
  // documentos de todos los chats rápidos.
  state.chunkScopeCalls.length = 0;
  await win.webContents.executeJavaScript(`(() => {
    activeProjectId = 'quick-chat';
    activeChatId = 'quick-chat-1';
    document.getElementById('input').value = 'quick chat scope';
    chatAttachments = [];
  })()`, true);
  await win.webContents.executeJavaScript(`window.__sendPromise = send(); undefined`, true);
  await waitFor(win, `document.getElementById('cloudConsentModal')`);
  await win.webContents.executeJavaScript(
    `document.querySelectorAll('#cloudConsentModal button')[0].click()`, true);
  await win.webContents.executeJavaScript(`window.__sendPromise`, true);
  const quickScope = state.chunkScopeCalls.at(-1);
  assert.strictEqual(quickScope.projectId, 'quick-chat', 'Quick Chat envía quick-chat como projectId');
  assert.strictEqual(quickScope.chatId, 'quick-chat-1', 'Quick Chat envía el chat activo');
  assert.strictEqual(quickScope.opts.includeProjectScope, false,
    'Quick Chat pide includeProjectScope=false');

  appState.delete('cloud-consent:v1:openai:project:project-a');
  state.routeMode = 'edit';
  state.ragEnabled = false;
  await prepare({ text: 'edit source', withImage: false });
  await win.webContents.executeJavaScript(`window.__sendPromise = send(); undefined`, true);
  await waitFor(win, `document.getElementById('cloudConsentModal')`);
  const editScope = await win.webContents.executeJavaScript(
    `document.getElementById('cloudConsentModal').innerText`,
    true
  );
  assert.match(editScope, /source-edit\.png/);
  await win.webContents.executeJavaScript(
    `document.querySelectorAll('#cloudConsentModal button')[0].click()`,
    true
  );
  await win.webContents.executeJavaScript(`window.__sendPromise`, true);
  assert.strictEqual(state.generateCalls.length, 1);
  assert.strictEqual(state.generateCalls[0].sourceImages[0].name, 'source-edit.png');
  assert.match(state.generateCalls[0].requestId, /^[A-Za-z0-9._:-]{8,128}$/);

  assert(
    networkRequests.every(url => url === 'https://example.com/generated.png'),
    'renderer integration must not make unexpected network requests'
  );

  // --- AUD-006: modelo sin visión + imagen + instrucción que depende de ella ---
  // El fallo original no era solo que el adapter descartara la imagen: era que
  // MIKA5 enviaba el texto igualmente y el modelo respondía como si la hubiera
  // visto. Aquí se exige corte total antes de la red.
  // Aislamiento explícito: los escenarios anteriores dejan routeMode='edit' y
  // una acción visual pendiente que desviaría send() a otra rama.
  state.routeMode = 'chat';
  state.ragEnabled = true;
  const dbWritesBefore = state.dbWrites.length;
  const chatCallsBefore = state.chatCalls.length;
  state.resolveVisionCalls.length = 0;
  await win.webContents.executeJavaScript(`(() => {
    pendingVisualAction = null;
    activeVisualRoute = null;
    rejectedImageAttachments = [];
    activeProjectId = 'project-a';
    activeChatId = 'chat-a';
    currentProvider = 'openai';
    providerPrivacy = 'cloud';
    const select = document.getElementById('modelSelect');
    // Modelo real de OpenAI SIN visión: la lista no le pone data-vision.
    select.innerHTML = '<option value="gpt-3.5-turbo">gpt-3.5-turbo</option>';
    select.value = 'gpt-3.5-turbo';
    document.getElementById('input').value = 'analiza esto';
    chatAttachments = [{ type:'image', name:'sin-vision.png', mediaType:'image/png', base64:'aW1hZ2U=' }];
    // Señal positiva: sin esto, "cero llamadas" podría deberse a que send()
    // se cortó en cualquier otro punto anterior y la barrera nunca se ejecutó.
    window.__toasts = [];
    if (!window.__toastHooked) {
      window.__toastHooked = true;
      const originalToast = showToast;
      showToast = (message, level) => {
        window.__toasts.push({ message: String(message), level });
        return originalToast(message, level);
      };
    }
  })()`, true);
  await win.webContents.executeJavaScript(`(() => {
    window.__blockedOutcome = null;
    Promise.race([
      send().then(() => 'resolved', error => 'rejected: ' + (error?.message || error)),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 8000))
    ]).then(outcome => { window.__blockedOutcome = outcome; });
  })()`, true);
  await waitFor(win, `window.__blockedOutcome !== null`, 12000);
  const blockedOutcome = await win.webContents.executeJavaScript(`window.__blockedOutcome`, true);
  assert.notStrictEqual(blockedOutcome, 'timeout', 'send() debe cortar, no quedarse colgado');

  assert.strictEqual(state.chatCalls.length, chatCallsBefore,
    'cero ai.chat: la petición no puede salir a la red sin la imagen');
  assert.strictEqual(state.dbWrites.length, dbWritesBefore,
    'cero escrituras en DB: no se registra un turno que el modelo no vio completo');
  const blockedState = await win.webContents.executeJavaScript(`({
    input: document.getElementById('input').value,
    attachments: chatAttachments.map(item => item.name),
    consentModalOpen: Boolean(document.getElementById('cloudConsentModal'))
  })`, true);
  assert.strictEqual(blockedState.input, 'analiza esto',
    'el texto se conserva para que la usuaria cambie de modelo');
  assert.deepStrictEqual(blockedState.attachments, ['sin-vision.png'],
    'la imagen sigue adjunta: no se descarta a espaldas de la usuaria');
  assert.strictEqual(blockedState.consentModalOpen, false,
    'el corte ocurre antes del consentimiento: no se pide permiso para algo que no se enviará');

  // Señal POSITIVA: se alcanzó exactamente la barrera final del renderer, con la
  // identidad correcta. Sin esto, los "cero" de arriba podrían venir de un corte
  // en cualquier otro punto (estado residual, excepción del fixture, otra ruta).
  assert.strictEqual(state.resolveVisionCalls.length, 1,
    'la barrera final debe consultar al proceso principal exactamente una vez');
  assert.deepStrictEqual(state.resolveVisionCalls[0], { provider: 'openai', model: 'gpt-3.5-turbo' },
    'el proveedor viaja explícito: no se resuelve contra this.currentProvider');
  const blockToasts = await win.webContents.executeJavaScript(`window.__toasts`, true);
  const blockToast = blockToasts.at(-1);
  assert.strictEqual(blockToast.level, 'error');
  assert.match(blockToast.message, /^No se envía:/,
    'el corte lo produjo la barrera de visión, no otra causa');
  assert.match(blockToast.message, /gpt-3\.5-turbo/);

  // --- Cambiar de modelo NO resuelve la intención pendiente -----------------
  // Borrarla automáticamente reabría AUD-006: el registro desaparecía, la imagen
  // nunca estuvo en chatAttachments, el texto seguía ahí y "analiza esto" salía
  // sin imagen. Solo re-adjuntar o pulsar ✕ desbloquean.
  const seed = await win.webContents.executeJavaScript(`(async () => {
    rejectedImageAttachments = [];
    chatAttachments = [];
    // El rechazo lo produce el camino productivo, con el modelo sin visión.
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const file = new File([bytes], 'foto.png', { type: 'image/png', lastModified: 5 });
    let rejection;
    try {
      rejection = await processImageAttachment({
        file, source: 'file', chatId: 'chat-a', providerId: 'openai', model: 'gpt-3.5-turbo'
      });
    } catch (error) {
      return { threw: String(error && error.stack || error) };
    }
    if (rejection.ok) return { threw: 'el modelo sin visión debía rechazar' };
    const select = document.getElementById('modelSelect');
    select.innerHTML = '<option value="gpt-4o" data-vision="1">gpt-4o</option>';
    select.value = 'gpt-4o';
    onSelectedModelChanged();
    return { threw: null };
  })()`, true);
  assert.strictEqual(seed.threw, null, `la semilla falló: ${seed && seed.threw}`);
  const afterSwitch = await win.webContents.executeJavaScript(`({
    pending: pendingRejectedImages('chat-a').length,
    notice: rejectionNotice(rejectedImageAttachments[0]),
    chipVisible: document.querySelectorAll('#attachmentPreview .preview-item-rejected').length
  })`, true);
  assert.strictEqual(afterSwitch.pending, 1, 'el rechazo sobrevive al cambio de modelo');
  assert.strictEqual(afterSwitch.chipVisible, 1, 'y sigue visible en la tira de adjuntos');
  assert.match(afterSwitch.notice, /Vuelve a adjuntar foto\.png/,
    'el aviso cambia a "vuelve a adjuntar" cuando el modelo nuevo sí acepta');

  // Enviar sigue bloqueado con el modelo compatible: la imagen no está adjunta.
  const chatCallsBeforeSwitchSend = state.chatCalls.length;
  await win.webContents.executeJavaScript(`(() => {
    window.__toasts = [];
    document.getElementById('input').value = 'analiza esto';
    chatAttachments = [];
    window.__switchSend = send();
  })()`, true);
  await win.webContents.executeJavaScript(`window.__switchSend`, true);
  assert.strictEqual(state.chatCalls.length, chatCallsBeforeSwitchSend,
    'cambiar a un modelo con visión no puede desbloquear un envío sin la imagen');
  const switchToasts = await win.webContents.executeJavaScript(`window.__toasts`, true);
  assert.match(switchToasts.at(-1).message, /^No se envía:/);

  // Re-adjuntar por el CAMINO PRODUCTIVO. Llamar a resolveRejectedImage() a mano
  // demostraría solo que la función aislada funciona: el test pasaría aunque el
  // handler real nunca la invocara. Aquí se ejecuta processImageAttachment(),
  // que es exactamente lo que corren el selector de archivos y el pegado.
  const afterReattach = await win.webContents.executeJavaScript(`(async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const file = new File([bytes], 'foto.png', { type: 'image/png', lastModified: 5 });
    const outcome = await processImageAttachment({
      file, source: 'file', chatId: 'chat-a', providerId: 'openai', model: 'gpt-4o'
    });
    renderAttachmentPreview();
    return {
      ok: outcome.ok,
      pending: pendingRejectedImages('chat-a').length,
      attachments: chatAttachments.map(item => item.name)
    };
  })()`, true);
  assert.strictEqual(afterReattach.ok, true);
  assert.strictEqual(afterReattach.pending, 0,
    'el camino productivo resuelve el rechazo pendiente por sí solo');
  assert.deepStrictEqual(afterReattach.attachments, ['foto.png'],
    'y añade la imagen a chatAttachments');

  const reattachSendBefore = state.chatCalls.length;
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('input').value = 'analiza esto';
    window.__okSend = send();
  })()`, true);
  await waitFor(win, `document.getElementById('cloudConsentModal')`);
  await win.webContents.executeJavaScript(
    `document.querySelectorAll('#cloudConsentModal button')[0].click()`, true);
  await win.webContents.executeJavaScript(`window.__okSend`, true);
  assert.strictEqual(state.chatCalls.length, reattachSendBefore + 1, 'ahora sí sale la petición');
  const sentImages = state.chatCalls.at(-1).images;
  assert.strictEqual(sentImages.length, 1, 'y ai.chat recibe la imagen');
  assert.strictEqual(sentImages[0].mediaType, 'image/png');
  // Los bytes reales del File del test: 89 50 4E 47 01 02 03.
  assert.strictEqual(sentImages[0].base64, Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString('base64'),
    'el contenido que viaja es el del archivo adjuntado, no un placeholder');

  // --- Dos archivos distintos con el mismo nombre son registros distintos ----
  const homonyms = await win.webContents.executeJavaScript(`(() => {
    rejectedImageAttachments = [];
    recordRejectedImage({
      chatId: 'chat-a', providerId: 'openai', model: 'gpt-3.5-turbo',
      fingerprint: 'file:imagen.png:100:1:image/png', name: 'imagen.png', reason: 'r'
    });
    recordRejectedImage({
      chatId: 'chat-a', providerId: 'openai', model: 'gpt-3.5-turbo',
      fingerprint: 'file:imagen.png:900:2:image/png', name: 'imagen.png', reason: 'r'
    });
    // Mismo fingerprint: actualiza el existente, no crea otro.
    recordRejectedImage({
      chatId: 'chat-a', providerId: 'openai', model: 'gpt-3.5-turbo',
      fingerprint: 'file:imagen.png:100:1:image/png', name: 'imagen.png', reason: 'r2'
    });
    const ids = rejectedImageAttachments.map(item => item.id);
    discardRejectedImage(ids[0]);
    return {
      total: ids.length,
      uniqueIds: new Set(ids).size,
      afterDiscard: rejectedImageAttachments.map(item => item.fingerprint)
    };
  })()`, true);
  assert.strictEqual(homonyms.total, 2, 'dos archivos homónimos distintos = dos registros');
  assert.strictEqual(homonyms.uniqueIds, 2, 'con ids diferentes');
  assert.deepStrictEqual(homonyms.afterDiscard, ['file:imagen.png:900:2:image/png'],
    'descartar uno deja el otro vivo y bloqueando');

  // La huella es del CONTENIDO y es ESTABLE entre intentos. Con un UUID por
  // operación, volver a pegar la misma imagen nunca resolvía el rechazo previo:
  // quedaba bloqueando hasta pulsar ✕.
  const fingerprints = await win.webContents.executeJavaScript(`(async () => {
    const mk = (bytes, name) => new File([new Uint8Array(bytes)], name, { type: 'image/png' });
    const a1 = await imageContentFingerprint(mk([1, 2, 3], 'a.png'));
    const a2 = await imageContentFingerprint(mk([1, 2, 3], 'otro-nombre.png'));
    const b = await imageContentFingerprint(mk([9, 9, 9], 'a.png'));
    return { a1, a2, b };
  })()`, true);
  assert.strictEqual(fingerprints.a1, fingerprints.a2,
    'mismo contenido = misma identidad, aunque cambie el nombre (pegar vs elegir del disco)');
  assert.notStrictEqual(fingerprints.a1, fingerprints.b,
    'contenidos distintos con el mismo nombre son identidades distintas');
  assert.match(fingerprints.a1, /^sha256:[0-9a-f]{64}$/);

  // --- Mismo modelId en proveedores distintos no confunde la identidad ------
  const crossProvider = await win.webContents.executeJavaScript(`(() => {
    rejectedImageAttachments = [];
    recordRejectedImage({
      chatId: 'chat-a', providerId: 'openai', model: 'modelo-x',
      fingerprint: 'file:a.png:1:1:image/png', name: 'a.png', reason: 'openai'
    });
    recordRejectedImage({
      chatId: 'chat-a', providerId: 'groq', model: 'modelo-x',
      fingerprint: 'file:a.png:1:1:image/png', name: 'a.png', reason: 'groq'
    });
    const select = document.getElementById('modelSelect');
    select.innerHTML = '<option value="modelo-x">modelo-x</option>';
    select.value = 'modelo-x';
    currentProvider = 'openai';
    return {
      total: rejectedImageAttachments.length,
      matchesOpenai: rejectedImageAttachments.map(item => rejectionMatchesCurrentTarget(item))
    };
  })()`, true);
  assert.strictEqual(crossProvider.total, 2,
    'el mismo modelId en dos proveedores son rechazos distintos');
  assert.deepStrictEqual(crossProvider.matchesOpenai, [true, false],
    'solo el del proveedor activo cuenta como vigente');

  // --- Cambiar de chat NO destruye la intención pendiente -------------------
  // resetViewState() guarda el borrador (texto + adjuntos) en chatDrafts y lo
  // restaura al volver. Si el rechazo se borrara ahí, volvería el "analiza esto"
  // pero no el bloqueo: asimetría exacta que reabre AUD-006.
  const acrossChats = await win.webContents.executeJavaScript(`(() => {
    rejectedImageAttachments = [];
    chatAttachments = [];
    activeChatId = 'chat-a';
    recordRejectedImage({
      chatId: 'chat-a', providerId: 'openai', model: 'gpt-3.5-turbo',
      fingerprint: 'sha256:aa', name: 'foto.png', reason: 'sin visión'
    });
    document.getElementById('input').value = 'analiza esto';
    resetViewState();            // salida del chat A
    activeChatId = 'chat-b';
    const inChatB = pendingRejectedImages('chat-b').length;
    resetViewState();            // salida del chat B
    activeChatId = 'chat-a';     // vuelta al chat A
    return {
      inChatB,
      backInChatA: pendingRejectedImages('chat-a').length,
      total: rejectedImageAttachments.length
    };
  })()`, true);
  assert.strictEqual(acrossChats.inChatB, 0, 'el rechazo no se filtra a otro chat');
  assert.strictEqual(acrossChats.backInChatA, 1,
    'al volver al chat A la intención pendiente sigue viva');
  assert.strictEqual(acrossChats.total, 1);

  // --- BUG 2: la imagen adjunta debe verse en la burbuja del usuario --------
  // appendMsg() solo renderizaba msg.content y Store.addMessage() solo guardaba
  // texto: la imagen llegaba al proveedor pero desaparecía de la conversación.
  const bubbleCase = await win.webContents.executeJavaScript(`(() => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    appendMsg({
      role: 'user',
      content: 'rediseña el logo por uno más moderno',
      attachments: [{ name: 'logo.png', mediaType: 'image/png', base64: 'aW1hZ2U=' }]
    }, host);
    const bubble = host.querySelector('.msg.user');
    const thumbs = bubble.querySelectorAll('.msg-attachments img');
    return {
      text: bubble.querySelector('.msg-content').textContent.trim(),
      count: thumbs.length,
      src: thumbs[0]?.getAttribute('src'),
      alt: thumbs[0]?.getAttribute('alt'),
      caption: bubble.querySelector('.msg-attachment-name')?.textContent
    };
  })()`, true);
  // A: texto + miniatura correspondiente a los bytes adjuntos.
  assert.match(bubbleCase.text, /rediseña el logo/);
  assert.strictEqual(bubbleCase.count, 1);
  assert.strictEqual(bubbleCase.src, 'data:image/png;base64,aW1hZ2U=');
  assert.strictEqual(bubbleCase.alt, 'logo.png');
  assert.strictEqual(bubbleCase.caption, 'logo.png');

  // B: al recargar, la fila llega desde SQLite con attachments como TEXT.
  const reloadCase = await win.webContents.executeJavaScript(`(() => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    appendMsg({
      role: 'user',
      content: 'rediseña el logo',
      attachments: JSON.stringify([{ name: 'logo.png', mediaType: 'image/png', base64: 'aW1hZ2U=' }])
    }, host);
    const thumbs = host.querySelectorAll('.msg-attachments img');
    return { count: thumbs.length, src: thumbs[0]?.getAttribute('src') };
  })()`, true);
  assert.strictEqual(reloadCase.count, 1, 'la miniatura sobrevive a la recarga del chat');
  assert.strictEqual(reloadCase.src, 'data:image/png;base64,aW1hZ2U=');

  // C: mensaje de solo texto no crea contenedores vacíos.
  const textOnlyCase = await win.webContents.executeJavaScript(`(() => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    appendMsg({ role: 'user', content: 'solo texto' }, host);
    appendMsg({ role: 'user', content: 'con array vacío', attachments: [] }, host);
    appendMsg({ role: 'user', content: 'con json vacío', attachments: '[]' }, host);
    appendMsg({ role: 'user', content: 'con json roto', attachments: '{no-json' }, host);
    return host.querySelectorAll('.msg-attachments').length;
  })()`, true);
  assert.strictEqual(textOnlyCase, 0, 'sin adjuntos no se crea galería');

  // D: dos imágenes se pintan una sola vez cada una, sin mezclar identidades.
  const twoImages = await win.webContents.executeJavaScript(`(() => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    appendMsg({
      role: 'user',
      content: 'compara estas dos',
      attachments: [
        { name: 'a.png', mediaType: 'image/png', base64: 'YQ==', visualEntryId: 've-a' },
        { name: 'b.png', mediaType: 'image/png', base64: 'Yg==', visualEntryId: 've-b' }
      ]
    }, host);
    return {
      figures: Array.from(host.querySelectorAll('.msg-attachment')).map(node => ({
        entry: node.dataset.visualEntryId,
        name: node.querySelector('.msg-attachment-name').textContent,
        src: node.querySelector('img').getAttribute('src')
      })),
      galleries: host.querySelectorAll('.msg-attachments').length
    };
  })()`, true);
  assert.strictEqual(twoImages.galleries, 1);
  assert.deepStrictEqual(twoImages.figures, [
    { entry: 've-a', name: 'a.png', src: 'data:image/png;base64,YQ==' },
    { entry: 've-b', name: 'b.png', src: 'data:image/png;base64,Yg==' }
  ], 'nombres, bytes y visualEntryId no se mezclan');

  // E: la persistencia NO puede ser solo cosmética. Tras reiniciar, la imagen
  // debe volver a ser contexto visual: si no, "ahora ponlo verde" no encuentra
  // referencia y el router degrada a chat normal.
  const rehydrated = await win.webContents.executeJavaScript(`(() => {
    // Estado como tras un arranque en frío: memoria visual vacía.
    resetVisualContextForChat('chat-rehydrate');
    const before = {
      lastUserImage: visualContextMemory.lastUserImage,
      entries: visualContextMemory.entries.length
    };
    const restoredCount = rehydrateVisualContextFromMessages([
      {
        role: 'user', created_at: 1000,
        content: 'rediseña el logo',
        attachments: JSON.stringify([
          { name: 'logo.png', mediaType: 'image/png', base64: 'aW1hZ2U=', visualEntryId: 've-persistido' }
        ])
      },
      { role: 'assistant', created_at: 1500, content: 'listo', attachments: null },
      {
        role: 'assistant', created_at: 2000,
        content: 'generada',
        attachments: JSON.stringify([
          { name: 'gen.png', url: 'https://example.test/gen.png', visualEntryId: 've-generada' }
        ])
      }
    ], 'chat-rehydrate');
    return {
      before,
      restoredCount,
      entries: visualContextMemory.entries.length,
      lastUser: visualContextMemory.lastUserImage,
      lastGenerated: visualContextMemory.lastGeneratedImage
    };
  })()`, true);
  assert.strictEqual(rehydrated.before.lastUserImage, null, 'parte de memoria visual vacía');
  assert.strictEqual(rehydrated.restoredCount, 2, 'se restauran las dos imágenes persistidas');
  assert.strictEqual(rehydrated.entries, 2);
  assert.strictEqual(rehydrated.lastUser.name, 'logo.png');
  assert.strictEqual(rehydrated.lastUser.base64, 'aW1hZ2U=');
  assert.strictEqual(rehydrated.lastUser.chatId, 'chat-rehydrate');
  assert.strictEqual(rehydrated.lastUser.origin, 'user-upload');
  // El visualEntryId original se conserva: acuñar uno nuevo rompería el vínculo
  // con las acciones visuales selladas y las cancelaría por identidad.
  assert.strictEqual(rehydrated.lastUser.visualEntryId, 've-persistido');
  assert.strictEqual(rehydrated.lastGenerated.visualEntryId, 've-generada');
  assert.strictEqual(rehydrated.lastGenerated.url, 'https://example.test/gen.png');

  // Orden cronológico: la MÁS RECIENTE gana, aunque llegue desordenada.
  const ordering = await win.webContents.executeJavaScript(`(() => {
    rehydrateVisualContextFromMessages([
      { role: 'user', created_at: 3000, content: 'b', attachments: JSON.stringify([
        { name: 'nueva.png', mediaType: 'image/png', base64: 'Yg==', visualEntryId: 've-b' }]) },
      { role: 'user', created_at: 1000, content: 'a', attachments: JSON.stringify([
        { name: 'vieja.png', mediaType: 'image/png', base64: 'YQ==', visualEntryId: 've-a' }]) }
    ], 'chat-orden');
    return visualContextMemory.lastUserImage.name;
  })()`, true);
  assert.strictEqual(ordering, 'nueva.png', 'lastUserImage apunta a la más reciente');

  // Abrir otro chat no arrastra el contexto visual del anterior.
  const isolated = await win.webContents.executeJavaScript(`(() => {
    rehydrateVisualContextFromMessages([{ role: 'user', created_at: 1, content: 'x' }], 'chat-vacio');
    return {
      lastUser: visualContextMemory.lastUserImage,
      entries: visualContextMemory.entries.length
    };
  })()`, true);
  assert.strictEqual(isolated.lastUser, null, 'un chat sin imágenes no hereda las del anterior');
  assert.strictEqual(isolated.entries, 0);

  // --- END-TO-END post-reinicio: rehidratar → routing → generación ----------
  // Sin esto solo se probaba que la memoria queda poblada, no que la imagen
  // restaurada llegue realmente a generateImage.
  state.routeMode = 'edit';
  state.echoRestoredImage = true;
  state.routeIntentCalls.length = 0;
  const generateBefore = state.generateCalls.length;
  const chatBefore = state.chatCalls.length;
  await win.webContents.executeJavaScript(`(async () => {
    pendingVisualAction = null;
    activeVisualRoute = null;
    chatAttachments = [];
    activeProjectId = 'project-a';
    activeChatId = 'chat-persistido';
    currentProvider = 'openai';
    providerPrivacy = 'cloud';
    const select = document.getElementById('modelSelect');
    select.innerHTML = '<option value="gpt-4o" data-vision="1">gpt-4o</option>';
    select.value = 'gpt-4o';
    // Arranque en frío: solo existe lo que hay en la BD.
    rehydrateVisualContextFromMessages([{
      role: 'user', created_at: 1000, content: 'rediseña el logo',
      attachments: JSON.stringify([{
        name: 'logo-persistido.png', mediaType: 'image/png',
        base64: 'cGVyc2lzdGlkbw==', visualEntryId: 've-persistido'
      }])
    }], 'chat-persistido');
    document.getElementById('input').value = 'ahora ponlo verde';
    window.__greenOutcome = null;
    Promise.race([
      send().then(() => 'resolved', error => 'rejected: ' + (error?.message || error)),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 8000))
    ]).then(outcome => { window.__greenOutcome = outcome; });
  })()`, true);
  await waitFor(win, `document.getElementById('cloudConsentModal')`, 8000);
  await win.webContents.executeJavaScript(
    `document.querySelectorAll('#cloudConsentModal button')[0].click()`, true);
  await waitFor(win, `window.__greenOutcome !== null`, 12000);
  const greenOutcome = await win.webContents.executeJavaScript(`(() => ({
    outcome: window.__greenOutcome,
    consentOpen: Boolean(document.getElementById('cloudConsentModal'))
  }))()`, true);
  assert.notStrictEqual(greenOutcome.outcome, 'timeout',
    `send() se colgó (consentModal abierto: ${greenOutcome.consentOpen})`);

  assert.strictEqual(state.routeIntentCalls.length, 1, 'se enruta una vez');
  assert.ok(state.routeIntentCalls[0].lastUserImage,
    'routeIntent recibe la imagen restaurada como contexto visual');
  assert.strictEqual(state.routeIntentCalls[0].lastUserImage.visualEntryId, 've-persistido',
    'y es exactamente la persistida, con su visualEntryId original');
  assert.strictEqual(state.generateCalls.length, generateBefore + 1, 'una sola generación');
  assert.strictEqual(state.chatCalls.length, chatBefore, 'ningún ai.chat normal');
  const greenGeneration = state.generateCalls.at(-1);
  assert.strictEqual(greenGeneration.sourceImages.length, 1);
  assert.strictEqual(greenGeneration.sourceImages[0].base64, 'cGVyc2lzdGlkbw==',
    'sourceImages lleva los bytes de la imagen restaurada');

  // Y la imagen GENERADA se persiste como adjunto del mensaje del asistente:
  // registerVisualImage solo toca memoria efímera.
  const assistantWrite = state.dbWrites.filter(w => w.role === 'assistant').at(-1);
  assert.ok(assistantWrite.attachments, 'el turno del asistente guarda su imagen');
  assert.strictEqual(assistantWrite.attachments[0].url, 'https://example.com/generated.png');
  assert.ok(assistantWrite.attachments[0].visualEntryId,
    'con visualEntryId para poder rehidratarla luego');
  state.routeMode = 'chat';
  state.echoRestoredImage = false;

  // Carrera: el chat A termina de cargar DESPUÉS de que la usuaria abrió el B.
  const raceResult = await win.webContents.executeJavaScript(`(() => {
    activeChatId = 'chat-B';
    rehydrateVisualContextFromMessages([{
      role: 'user', created_at: 1, content: 'b',
      attachments: JSON.stringify([{ name: 'de-B.png', mediaType: 'image/png', base64: 'Qg==' }])
    }], 'chat-B');
    const afterB = visualContextMemory.lastUserImage.name;
    // Llegada tardía de A: la barrera de identidad debe descartarla.
    const chatId = 'chat-A';
    const signal = null;
    const allMessages = [{
      role: 'user', created_at: 1, content: 'a',
      attachments: JSON.stringify([{ name: 'de-A.png', mediaType: 'image/png', base64: 'QQ==' }])
    }];
    if (!signal?.aborted && activeChatId === chatId) {
      rehydrateVisualContextFromMessages(allMessages, chatId);
    }
    return { afterB, afterLateA: visualContextMemory.lastUserImage.name };
  })()`, true);
  assert.strictEqual(raceResult.afterB, 'de-B.png');
  assert.strictEqual(raceResult.afterLateA, 'de-B.png',
    'una carga tardía no puede pisar el contexto visual del chat en pantalla');

  // La barrera existe en el código productivo, no solo en el test.
  const openChatSource = require('fs').readFileSync(
    path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert(openChatSource.includes("if (!signal?.aborted && activeChatId === chatId) {"),
    'openChat protege la rehidratación con la identidad del chat');

  // Se engancha al historial COMPLETO, no a la página pintada.
  const rendererSource = require('fs').readFileSync(
    path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert(rendererSource.includes('rehydrateVisualContextFromMessages(allMessages, chatId);'),
    'la rehidratación usa el historial completo, no la página visible');

  await win.webContents.executeJavaScript(`(() => {
    resetVisualContextForChat();
    document.querySelectorAll('body > div.msg').forEach(node => node.remove());
  })()`, true);

  // --- Wrappers de interfaz conectados de verdad ----------------------------
  // Las aserciones de fuente prueban que existen dos llamadas a
  // processImageAttachment, no que los eventos reales lleguen hasta ellas.
  // Aquí se despachan `change` y `paste` auténticos sobre los elementos vivos.
  await win.webContents.executeJavaScript(`(() => {
    rejectedImageAttachments = [];
    chatAttachments = [];
    activeChatId = 'chat-a';
    activeProjectId = 'project-a';
    currentProvider = 'openai';
    const select = document.getElementById('modelSelect');
    select.innerHTML = '<option value="gpt-4o" data-vision="1">gpt-4o</option>';
    select.value = 'gpt-4o';
    document.getElementById('input').value = '';
    renderAttachmentPreview();
  })()`, true);

  const viaFileInput = await win.webContents.executeJavaScript(`(async () => {
    const file = new File([new Uint8Array([10, 20, 30])], 'desde-selector.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('fileInput');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 80 && chatAttachments.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return chatAttachments.map(item => item.name);
  })()`, true);
  assert.deepStrictEqual(viaFileInput, ['desde-selector.png'],
    'el evento change del selector debe llegar a processImageAttachment');

  const viaPaste = await win.webContents.executeJavaScript(`(async () => {
    chatAttachments = [];
    const file = new File([new Uint8Array([40, 50, 60])], 'pegada.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    document.getElementById('input').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
    );
    for (let i = 0; i < 80 && chatAttachments.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return chatAttachments.map(item => item.name);
  })()`, true);
  assert.deepStrictEqual(viaPaste, ['pasted-image.png'],
    'el evento paste debe llegar al mismo flujo y usar el nombre normalizado');

  await win.webContents.executeJavaScript(`(() => {
    rejectedImageAttachments = [];
    chatAttachments = [];
    currentProvider = 'openai';
    document.getElementById('input').value = '';
    renderAttachmentPreview();
  })()`, true);

  // ==========================================================================
  // BARRERA TRANSACCIONAL DEL TURNO DEL USUARIO
  // La BD es el gate previo a cualquier llamada externa. Antes varios caminos
  // hacían `await Store.addMessage(...)` y seguían aunque devolviera ok:false.
  // ==========================================================================
  const prepareTurn = (extra = '') => win.webContents.executeJavaScript(`(() => {
    // Contenedor aislado: los escenarios anteriores dejan burbujas que falsearían
    // los conteos de este bloque.
    document.getElementById('chat').innerHTML = '';
    pendingVisualAction = null;
    activeVisualRoute = null;
    rejectedImageAttachments = [];
    activeProjectId = 'project-tx';
    activeChatId = 'chat-tx';
    currentProvider = 'openai';
    providerPrivacy = 'cloud';
    const select = document.getElementById('modelSelect');
    select.innerHTML = '<option value="gpt-4o" data-vision="1">gpt-4o</option>';
    select.value = 'gpt-4o';
    document.getElementById('input').value = 'analiza esta imagen';
    chatAttachments = [{ type:'image', name:'tx.png', mediaType:'image/png', base64:'dHg=' }];
    window.__toasts = [];
    window.__order = [];
    ${extra}
  })()`, true);

  const runSend = async (label) => {
    await win.webContents.executeJavaScript(`(() => {
      window.__outcome_${label} = null;
      Promise.race([
        send().then(() => 'resolved', e => 'rejected: ' + (e?.message || e)),
        new Promise(r => setTimeout(() => r('timeout'), 8000))
      ]).then(o => { window.__outcome_${label} = o; });
    })()`, true);
    // El consentimiento puede aparecer: se concede para el proyecto una vez.
    for (let i = 0; i < 40; i++) {
      const open = await win.webContents.executeJavaScript(
        `Boolean(document.getElementById('cloudConsentModal'))`, true);
      if (open) {
        await win.webContents.executeJavaScript(
          `document.querySelectorAll('#cloudConsentModal button')[1].click()`, true);
        break;
      }
      const done = await win.webContents.executeJavaScript(
        `window.__outcome_${label} !== null`, true);
      if (done) break;
      await new Promise(r => setTimeout(r, 25));
    }
    await waitFor(win, `window.__outcome_${label} !== null`, 12000);
    return win.webContents.executeJavaScript(`window.__outcome_${label}`, true);
  };

  const snapshotAfter = () => win.webContents.executeJavaScript(`({
    input: document.getElementById('input').value,
    attachments: chatAttachments.map(a => a.name),
    userBubbles: document.querySelectorAll('#chat .msg.user').length,
    placeholder: document.querySelectorAll('#chat .generating-placeholder, #chat .msg.generating').length,
    toasts: window.__toasts.length,
    pending: pendingVisualAction ? {
      sourceImage: pendingVisualAction.sourceImage?.name || null,
      generationPrompt: pendingVisualAction.generationPrompt || null
    } : null
  })`, true);

  // --- G: el orden se instrumenta en el PROCESO PRINCIPAL. Envolver
  // window.mika5.* desde la página no funciona: contextBridge expone objetos
  // de solo lectura y la asignación se descarta en silencio.

  // --- F: turno normal sin adjuntos, sin regresión --------------------------
  state.routeMode = 'chat';
  await prepareTurn(`chatAttachments = []; document.getElementById('input').value = 'hola sin adjuntos';`);
  const chatBeforeF = state.chatCalls.length;
  const orderBeforeF = state.order.length;
  assert.notStrictEqual(await runSend('F'), 'timeout');
  const afterF = await snapshotAfter();
  assert.strictEqual(state.chatCalls.length, chatBeforeF + 1, 'F: el turno normal llega al proveedor');
  assert.strictEqual(afterF.input, '', 'F: el input se limpia tras el éxito');
  assert.deepStrictEqual(
    state.order.slice(orderBeforeF, orderBeforeF + 3),
    ['db:user:start', 'db:user:ok', 'provider:start'],
    `G: orden real → ${state.order.slice(orderBeforeF).join(' → ')}`);

  // --- A: chat con imagen, la BD rechaza ------------------------------------
  state.addMessageFailure = { role: 'user' };
  const chatBeforeA = state.chatCalls.length;
  const genBeforeA = state.generateCalls.length;
  const orderBeforeA = state.order.length;
  await prepareTurn();
  assert.notStrictEqual(await runSend('A'), 'timeout');
  const afterA = await snapshotAfter();
  assert.strictEqual(state.chatCalls.length, chatBeforeA, 'A: cero ai.chat');
  assert.strictEqual(state.generateCalls.length, genBeforeA, 'A: cero generateImage');
  assert.strictEqual(afterA.input, 'analiza esta imagen', 'A: el texto se conserva');
  assert.deepStrictEqual(afterA.attachments, ['tx.png'], 'A: la imagen sigue adjunta');
  assert.strictEqual(afterA.userBubbles, 0, 'A: no hay burbuja de usuario enviada');
  assert.strictEqual(afterA.placeholder, 0, 'A: no hay placeholder');
  assert.strictEqual(afterA.toasts, 1, 'A: exactamente un toast por fallo');
  assert.deepStrictEqual(state.order.slice(orderBeforeA), ['db:user:start', 'db:user:fail'],
    'A: tras el fallo de BD el turno termina ahí, sin provider:start');

  // --- D: reintento tras corregir el problema -------------------------------
  state.addMessageFailure = null;
  const chatBeforeD = state.chatCalls.length;
  const writesBeforeD = state.dbWrites.filter(w => w.role === 'user').length;
  assert.notStrictEqual(await runSend('D'), 'timeout');
  const afterD = await snapshotAfter();
  assert.strictEqual(state.chatCalls.length, chatBeforeD + 1, 'D: el proveedor se llama una sola vez');
  assert.strictEqual(state.dbWrites.filter(w => w.role === 'user').length, writesBeforeD + 1,
    'D: el turno se guarda una sola vez');
  assert.strictEqual(afterD.userBubbles, 1, 'D: una sola burbuja, sin duplicar el intento fallido');
  assert.deepStrictEqual(afterD.attachments, [], 'D: los adjuntos se limpian solo tras el éxito');
  assert.strictEqual(afterD.input, '', 'D: el input se limpia solo tras el éxito');

  // --- B: generación directa, la BD rechaza ---------------------------------
  state.routeMode = 'edit';
  state.addMessageFailure = { role: 'user' };
  const genBeforeB = state.generateCalls.length;
  await prepareTurn(`document.getElementById('input').value = 'haz una variación';`);
  assert.notStrictEqual(await runSend('B'), 'timeout');
  const afterB2 = await snapshotAfter();
  assert.strictEqual(state.generateCalls.length, genBeforeB, 'B: cero generateImage');
  assert.strictEqual(afterB2.input, 'haz una variación', 'B: el texto permanece');
  assert.deepStrictEqual(afterB2.attachments, ['tx.png'], 'B: el adjunto permanece');
  assert.strictEqual(afterB2.userBubbles, 0, 'B: no hay mensaje fantasma');
  state.routeMode = 'chat';

  // --- C: acción visual pendiente, la BD rechaza ----------------------------
  const genBeforeC = state.generateCalls.length;
  await win.webContents.executeJavaScript(`(() => {
    window.__toasts = [];
    activeProjectId = 'project-tx';
    activeChatId = 'chat-tx';
    currentProvider = 'openai';
    const sourceImage = {
      name: 'logo-original.png', base64: 'bG9nbw==', mediaType: 'image/png',
      visualEntryId: 've-pendiente', chatId: 'chat-tx'
    };
    pendingVisualAction = createPendingVisualAction({
      type: 'image-edit',
      model: 'image-model',
      visionModel: null,
      visualExecution: { model: 'image-model', generationPrompt: 'moderniza el logo' },
      plan: { mode: 'image-edit', sourceImage },
      visualContext: { imageRef: sourceImage },
      options: null,
      generationPrompt: 'moderniza el logo'
    });
    document.getElementById('input').value = 'generar una nueva versión';
  })()`, true);
  const handled = await win.webContents.executeJavaScript(
    `handlePendingVisualActionReply('generar una nueva versión')`, true);
  assert.strictEqual(handled, true, 'C: la confirmación se consume, no se reenruta');
  const afterC = await snapshotAfter();
  assert.strictEqual(state.generateCalls.length, genBeforeC, 'C: cero generateImage');
  assert.ok(afterC.pending, 'C: pendingVisualAction sigue presente tras el fallo');
  assert.strictEqual(afterC.pending.sourceImage, 'logo-original.png', 'C: conserva sourceImage');
  assert.strictEqual(afterC.pending.generationPrompt, 'moderniza el logo', 'C: conserva generationPrompt');

  // C-bis: corregido el problema, el mismo pendiente se ejecuta.
  state.addMessageFailure = null;
  const handledRetry = await win.webContents.executeJavaScript(
    `handlePendingVisualActionReply('generar una nueva versión')`, true);
  assert.strictEqual(handledRetry, true);
  assert.strictEqual(state.generateCalls.length, genBeforeC + 1, 'C: reintentable tras corregir');
  assert.strictEqual(state.generateCalls.at(-1).prompt, 'moderniza el logo',
    'C: el prompt original sobrevive al fallo');
  assert.strictEqual(
    await win.webContents.executeJavaScript(`pendingVisualAction === null`, true), true,
    'C: solo ahora se consume la acción');

  // --- E: la respuesta del asistente no se puede guardar --------------------
  state.routeMode = 'chat';
  state.addMessageFailure = { role: 'assistant' };
  const chatBeforeE = state.chatCalls.length;
  await prepareTurn(`chatAttachments = []; document.getElementById('input').value = 'texto E';`);
  assert.notStrictEqual(await runSend('E'), 'timeout');
  const afterE = await win.webContents.executeJavaScript(`({
    unsavedBadges: document.querySelectorAll('#chat .msg-unsaved').length,
    queued: unsavedAssistantMessages.length,
    toasts: window.__toasts.length
  })`, true);
  assert.strictEqual(state.chatCalls.length, chatBeforeE + 1, 'E: el proveedor se llamó una vez');
  assert.strictEqual(afterE.unsavedBadges, 1, 'E: la respuesta se marca como no guardada');
  assert.strictEqual(afterE.queued, 1, 'E: queda un reintento local pendiente');
  assert.strictEqual(afterE.toasts, 1, 'E: un solo aviso');

  // ==========================================================================
  // REINTENTO DE RESPUESTAS NO PERSISTIDAS (solo escritura, nunca proveedor)
  // ==========================================================================

  // Estado de la cola tal y como lo ve la UI, sin tocar el DOM.
  const queueState = () => win.webContents.executeJavaScript(`
    unsavedAssistantMessages.map(e => ({
      id: e.id, chatId: e.chatId, content: e.content, status: e.status,
      attempts: e.attempts, error: e.error, renderedMsgId: e.renderedMsgId,
      attachments: e.attachments ? e.attachments.length : 0
    }))`, true);

  // --- R-A: Store.addMessage devuelve ok:false ------------------------------
  state.addMessageFailure = { role: 'assistant' };
  const chatBeforeRA = state.chatCalls.length;
  const entryId = (await queueState())[0].id;
  const resultRA = await win.webContents.executeJavaScript(
    `retryUnsavedAssistantMessage(${JSON.stringify(entryId)})`, true);
  assert.strictEqual(resultRA.ok, false);
  const queueRA = await queueState();
  assert.strictEqual(queueRA.length, 1, 'R-A: la entrada permanece en la cola');
  assert.strictEqual(queueRA[0].attempts, 1, 'R-A: attempts aumenta');
  assert.strictEqual(queueRA[0].status, 'pending', 'R-A: vuelve a pending, no queda en retrying');
  assert.strictEqual(state.chatCalls.length, chatBeforeRA, 'R-A: cero llamadas al proveedor');
  const buttonRA = await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('.msg-unsaved-retry');
      return { disabled: b?.disabled, text: b?.textContent,
               label: document.querySelector('.msg-unsaved-text')?.textContent }; })()`, true);
  assert.strictEqual(buttonRA.disabled, false, 'R-A: el botón vuelve a habilitarse');
  assert.match(buttonRA.label, /No se pudo guardar/);

  // --- R-B: Store.addMessage LANZA -----------------------------------------
  // Se añade una segunda entrada para probar que una excepción no vacía la cola.
  await win.webContents.executeJavaScript(`(() => {
    enqueueUnsavedAssistantMessage({
      chatId: 'chat-tx', content: 'segunda respuesta', model: 'gpt-4o',
      attachments: null, replyToId: null, renderedMsgId: null, error: 'PERSIST_FAILED'
    });
  })()`, true);
  assert.strictEqual((await queueState()).length, 2);

  state.addMessageFailure = { role: 'assistant', throws: true };
  const resultRB = await win.webContents.executeJavaScript(
    `retryUnsavedAssistantMessage(${JSON.stringify(entryId)})`, true);
  assert.strictEqual(resultRB.ok, false);
  assert.strictEqual(resultRB.error, 'PERSIST_THREW', 'R-B: la excepción se captura como fallo');
  const queueRB = await queueState();
  assert.strictEqual(queueRB.length, 2, 'R-B: ninguna entrada se pierde al lanzar');
  assert.strictEqual(queueRB[0].attempts, 2);
  assert.strictEqual(queueRB[0].status, 'pending');

  // --- R-E / R-G: aislamiento entre entradas -------------------------------
  // La primera sigue lanzando; la segunda debe guardarse igualmente.
  // El contenido de la entrada es la RESPUESTA del asistente, no el texto que
  // escribió la usuaria; se toma de la cola en vez de asumirlo.
  const firstContent = queueRB[0].content;
  state.addMessageFailure = { role: 'assistant', throws: true, onlyContent: firstContent };
  const retryAll = await win.webContents.executeJavaScript(
    `retryAllUnsavedAssistantMessages()`, true);
  assert.deepStrictEqual(retryAll, { attempted: 2, saved: 1, stillFailing: 1 },
    'R-G: una excepción no impide procesar las demás');
  const queueAfterAll = await queueState();
  assert.strictEqual(queueAfterAll.length, 1, 'R-E: solo queda la que falla');
  assert.strictEqual(queueAfterAll[0].id, entryId, 'R-E: es exactamente la primera');
  assert.strictEqual(queueAfterAll[0].content, firstContent, 'R-E: los payloads no se mezclaron');
  const savedSecond = state.dbWrites.filter(w => w.content === 'segunda respuesta');
  assert.strictEqual(savedSecond.length, 1, 'R-E: la segunda se escribió una sola vez');

  // --- R-D: doble clic simultáneo → una sola escritura ---------------------
  state.addMessageFailure = null;
  const writesBeforeD2 = state.dbWrites.filter(w => w.content === firstContent).length;
  const chatBeforeD2 = state.chatCalls.length;
  const doubleClick = await win.webContents.executeJavaScript(`
    Promise.all([
      retryUnsavedAssistantMessage(${JSON.stringify(entryId)}),
      retryUnsavedAssistantMessage(${JSON.stringify(entryId)})
    ]).then(rs => rs.map(r => ({ ok: r.ok, entryId: r.entryId, already: !!r.alreadyResolved })))`, true);
  assert.strictEqual(doubleClick[0].ok, true);
  assert.strictEqual(doubleClick[1].ok, true);
  assert.strictEqual(
    state.dbWrites.filter(w => w.content === firstContent).length, writesBeforeD2 + 1,
    'R-D: dos llamadas simultáneas producen UNA sola escritura');
  assert.strictEqual(state.chatCalls.length, chatBeforeD2, 'R-D/H: cero llamadas al proveedor');

  // --- R-C: éxito → entrada fuera y marcador retirado ----------------------
  assert.strictEqual((await queueState()).length, 0, 'R-C: la entrada se elimina tras el éxito');
  const badgeAfterSave = await win.webContents.executeJavaScript(`(() => ({
    text: document.querySelector('.msg-unsaved-text')?.textContent || null,
    retryButtons: document.querySelectorAll('.msg-unsaved-retry').length
  }))()`, true);
  assert.strictEqual(badgeAfterSave.text, '✅ Guardado', 'R-C: el marcador pasa a Guardado');
  assert.strictEqual(badgeAfterSave.retryButtons, 0, 'R-C: el botón desaparece');

  // Reintentar una entrada ya resuelta no vuelve a escribir.
  const writesBeforeNoop = state.dbWrites.length;
  const noop = await win.webContents.executeJavaScript(
    `retryUnsavedAssistantMessage(${JSON.stringify(entryId)})`, true);
  assert.deepStrictEqual(noop, { ok: true, alreadyResolved: true });
  assert.strictEqual(state.dbWrites.length, writesBeforeNoop, 'R-C: resultado estable sin escribir');

  // --- R-F: el reintento termina con OTRO chat en pantalla ------------------
  const writesBeforeF2 = state.dbWrites.length;
  const crossChat = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('chat').innerHTML = '';
    activeChatId = 'chat-origen';
    const rendered = appendMsg({ role: 'assistant', content: 'respuesta origen' });
    const entry = enqueueUnsavedAssistantMessage({
      chatId: 'chat-origen', content: 'respuesta origen', model: 'gpt-4o',
      attachments: null, replyToId: null, renderedMsgId: rendered, error: 'PERSIST_FAILED'
    });
    markMessageAsUnsaved(entry);
    const badgesBefore = document.querySelectorAll('.msg-unsaved').length;
    // La usuaria se va a otro chat mientras el reintento está en vuelo.
    const promise = retryUnsavedAssistantMessage(entry.id);
    activeChatId = 'chat-visible';
    document.getElementById('chat').innerHTML = '';
    const otherBubble = appendMsg({ role: 'assistant', content: 'mensaje del chat visible' });
    const result = await promise;
    return {
      badgesBefore,
      ok: result.ok,
      badgesInVisibleChat: document.querySelectorAll('.msg-unsaved').length,
      visibleBubbleIntact: Boolean(document.querySelector('[data-msg-id="' + otherBubble + '"]'))
    };
  })()`, true);
  assert.strictEqual(crossChat.badgesBefore, 1);
  assert.strictEqual(crossChat.ok, true, 'R-F: la escritura se completa para el chat original');
  assert.strictEqual(state.dbWrites.length, writesBeforeF2 + 1);
  assert.strictEqual(state.dbWrites.at(-1).chatId, 'chat-origen',
    'R-F: se guarda en el chat original, no en el visible');
  assert.strictEqual(crossChat.badgesInVisibleChat, 0,
    'R-F: no se inyecta ningún marcador en el chat visible');
  assert.strictEqual(crossChat.visibleBubbleIntact, true,
    'R-F: la burbuja del chat visible no se toca');
  assert.strictEqual(state.chatCalls.length, chatBeforeD2, 'R-F/H: cero llamadas al proveedor');

  await win.webContents.executeJavaScript(
    `unsavedAssistantMessages.length = 0; activeChatId = 'chat-tx'; undefined`, true);

  // G: en ninguna ejecución el proveedor precede a la confirmación de la BD.
  // Ningún provider:start puede carecer de un db:user:ok previo.
  let lastUserOk = -1;
  state.order.forEach((event, index) => {
    if (event === 'db:user:ok') lastUserOk = index;
    if (event === 'provider:start') {
      assert(lastUserOk >= 0 && lastUserOk < index,
        `G: provider:start en ${index} sin db:user:ok previo — orden: ${state.order.join(' → ')}`);
    }
  });

  state.addMessageFailure = null;
  state.routeMode = 'chat';

  win.destroy();

  console.log('Electron renderer integration tests passed');
}

run().then(
  () => app.quit(),
  error => {
    console.error(error);
    app.exit(1);
  }
);
