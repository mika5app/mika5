const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mika5", {
  db: {
    listProjects: () => ipcRenderer.invoke("db:listProjects"),
    createProject: (payload) => ipcRenderer.invoke("db:createProject", payload),
    updateProject: (id, payload) => ipcRenderer.invoke("db:updateProject", id, payload),
    deleteProject: (id) => ipcRenderer.invoke("db:deleteProject", id),

    listChats: (projectId) => ipcRenderer.invoke("db:listChats", projectId),
    createChat: (payload) => ipcRenderer.invoke("db:createChat", payload),
    updateChat: (chatId, payload) => ipcRenderer.invoke("db:updateChat", chatId, payload),

    listMessages: (chatId, opts) => ipcRenderer.invoke("db:listMessages", chatId, opts),
    countMessages: (chatId) => ipcRenderer.invoke("db:countMessages", chatId),
    addMessage: (payload) => ipcRenderer.invoke("db:addMessage", payload),
    getMessage: (msgId) => ipcRenderer.invoke("db:getMessage", msgId),
    clearChat: (chatId) => ipcRenderer.invoke("db:clearChat", chatId),
    deleteChat: (chatId) => ipcRenderer.invoke("db:deleteChat", chatId),

    getProjectContext: (projectId) => ipcRenderer.invoke("db:getProjectContext", projectId),
    setProjectContext: (projectId, systemPrompt) => ipcRenderer.invoke("db:setProjectContext", projectId, systemPrompt),

    getChatContext: (chatId) => ipcRenderer.invoke("db:getChatContext", chatId),
    setChatContext: (chatId, systemPrompt) => ipcRenderer.invoke("db:setChatContext", chatId, systemPrompt),

    listKnowledge: (projectId, chatId) => ipcRenderer.invoke("db:listKnowledge", projectId, chatId),
    addKnowledgeFromText: (payload) => ipcRenderer.invoke("db:addKnowledgeFromText", payload),
    deleteKnowledge: (itemId) => ipcRenderer.invoke("db:deleteKnowledge", itemId)
  },
  rag: {
    query: (projectId, text, k) => ipcRenderer.invoke("rag:query", projectId, text, k),
    queryByChat: (chatId, text, k) => ipcRenderer.invoke("rag:queryByChat", chatId, text, k),
    indexKnowledgeItem: (knowledgeItemId) => ipcRenderer.invoke("rag:indexKnowledgeItem", knowledgeItemId),
    getDocumentText: (knowledgeItemId) => ipcRenderer.invoke("rag:getDocumentText", knowledgeItemId),
    listChunksRaw: (projectId, chatId, maxChars, mode = 'selective') => ipcRenderer.invoke("rag:listChunksRaw", projectId, chatId, maxChars, mode)
  },
  ai: {
    getProviders: () => ipcRenderer.invoke('ai:get-providers'),
    getCurrentProvider: () => ipcRenderer.invoke('ai:get-current-provider'),
    setProvider: (id) => ipcRenderer.invoke('ai:set-provider', id),
    setApiKey: (provider, key) => ipcRenderer.invoke('ai:set-api-key', provider, key),
    getProviderConfig: (provider) => ipcRenderer.invoke('ai:get-provider-config', provider),
    saveProviderConfig: (provider, config) => ipcRenderer.invoke('ai:save-provider-config', provider, config),
    addProviderModel: (provider, model) => ipcRenderer.invoke('ai:add-provider-model', provider, model),
    updateProviderModel: (provider, modelId, model) => ipcRenderer.invoke('ai:update-provider-model', provider, modelId, model),
    deleteProviderModel: (provider, modelId) => ipcRenderer.invoke('ai:delete-provider-model', provider, modelId),
    chat: (params) => ipcRenderer.invoke('ai:chat', params),
    generateImage: (params) => ipcRenderer.invoke('ai:generate-image', params),
    routeIntent: (params) => ipcRenderer.invoke('ai:route-intent', params),
    listModels: () => ipcRenderer.invoke('ai:list-models'),
    status: () => ipcRenderer.invoke('ai:status'),
    abort: () => ipcRenderer.invoke('ai:abort'),
    getCapabilities: (providerId) => ipcRenderer.invoke('ai:get-capabilities', providerId),
    resolveVision: (params) => ipcRenderer.invoke('ai:resolve-vision', params)
  },
  ollama: {
    status: () => ipcRenderer.invoke("ollama:status"),
    tags: () => ipcRenderer.invoke("ollama:tags"),
    chat: (payload) => ipcRenderer.invoke("ollama:chat", payload),
    pull: (model) => ipcRenderer.invoke("ollama:pull", model)
  },
  getAssetUrl: (relPath) => {
    // Security: only allow safe relative asset paths
    const safe = String(relPath || '').replace(/\.\./g, '').replace(/[<>"']/g, '');
    if (/^(https?:|file:|javascript:|data:)/i.test(safe)) return '';
    return new URL(safe, window.location.href).toString();
  },
  debugRagState: (projectId) => ipcRenderer.invoke("debug:ragState", projectId),
  onKnowledgeIndexComplete: (callback) => {
    ipcRenderer.on('knowledge:index-complete', (_event, data) => callback(data));
  },
  extractPDF: (base64Data) => ipcRenderer.invoke("file:extractPDF", base64Data),
  extractWord: (base64Data) => ipcRenderer.invoke("file:extractWord", base64Data),
  extractSpreadsheet: (base64Data) => ipcRenderer.invoke("file:extractSpreadsheet", base64Data),
  getAppState: (key) => ipcRenderer.invoke("appState:get", key),
  setAppState: (key, value) => ipcRenderer.invoke("appState:set", key, value),
  openExternal: (url) => ipcRenderer.invoke("openExternal", url),
  saveFile: (payload) => ipcRenderer.invoke("app:saveFile", payload),
  printToPDF: (payload) => ipcRenderer.invoke("app:printToPDF", payload)
});