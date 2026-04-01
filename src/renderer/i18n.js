/**
 * MIKA5 — Internationalization (i18n)
 * Auto-detects OS language. User can override via app settings.
 * Usage in app.js: t('key') returns the translated string.
 */
const MIKA5_TRANSLATIONS = {
  es: {
    // Header & Status
    'status.connected': '✓ Conectado',
    'status.disconnected': '✗ Desconectado',
    'status.connecting': '● Conectando...',
    'privacy.private': '🔒 Privado',
    'privacy.cloud': '☁️ Cloud',
    'privacy.tooltipPrivate': 'Modo Privado: Tus datos nunca salen de esta computadora',
    'privacy.tooltipCloud': 'Modo Online: Los datos se envían a servidores externos',
    'privacy.inputWarning': 'Este mensaje se enviará a servidores externos. No compartas contraseñas ni datos sensibles.',
    'theme.light': 'Claro',
    'theme.dark': 'Oscuro',

    // Sidebar
    'sidebar.projects': 'PROYECTOS',
    'sidebar.recentChats': 'CHATS RECIENTES',
    'sidebar.projectName': 'Nombre del proyecto',
    'sidebar.noChats': 'Sin chats todavía',

    // Actions
    'action.send': 'Enviar',
    'action.sending': 'Enviando…',
    'action.save': 'Guardar',
    'action.cancel': 'Cancelar',
    'action.delete': 'Eliminar',
    'action.accept': 'Aceptar',
    'action.export': 'Exportar',
    'action.copy': '📋 Copiar',
    'action.saveAsDoc': 'Guardar como doc 📄',
    'action.saveChat': '📄 Guardar',
    'action.newChat': 'Nuevo chat',
    'action.pull': 'Pull',
    'action.downloading': 'Descargando…',

    // Modals
    'modal.renameProject': 'Renombrar proyecto',
    'modal.renameChat': 'Renombrar chat',
    'modal.deleteProject': 'Eliminar proyecto',
    'modal.deleteProjectMsg': '¿Eliminar este proyecto y todos sus chats? Esta acción no se puede deshacer.',
    'modal.deleteChat': 'Eliminar chat',
    'modal.deleteChatMsg': '¿Eliminar este chat y todos sus mensajes?',
    'modal.moveChat': 'Mover chat a:',
    'modal.saveAsDoc': 'Guardar como documento',
    'modal.docTitle': 'Título del documento:',
    'modal.pullModel': 'Descargar modelo',
    'modal.pullModelMsg': 'Nombre del modelo (ej: llama3.2, qwen2.5:7b)',
    'modal.configApiKey': 'Configurar API Key',
    'modal.exportChat': 'Exportar chat',
    'modal.exportSelect': 'Selecciona el formato de exportación:',
    'modal.privacyTitle': 'Privacidad en MIKA5',
    'modal.privacyLocal': 'Todos los datos se procesan en tu equipo. Ningún mensaje sale de tu PC. 100% privado.',
    'modal.privacyCloud': 'Los mensajes se envían a servidores externos del proveedor seleccionado. MIKA5 sanitiza PII básica (emails, teléfonos, IDs) antes de enviar.',
    'modal.privacyKeys': 'Se almacenan cifradas (AES-256-GCM) en la base de datos local. Nunca se transmiten a terceros más allá del proveedor.',

    // Toasts
    'toast.projectCreated': 'Proyecto creado.',
    'toast.projectRenamed': 'Proyecto renombrado',
    'toast.projectDeleted': 'Proyecto eliminado',
    'toast.chatRenamed': 'Chat renombrado',
    'toast.chatDeleted': 'Chat eliminado',
    'toast.chatMoved': 'Chat movido a "{name}"',
    'toast.docSaved': 'Documento guardado en Knowledge.',
    'toast.chatSaved': 'Chat completo guardado en Knowledge.',
    'toast.exported': 'Chat exportado.',
    'toast.copied': 'Copiado al portapapeles',
    'toast.codeCopied': 'Código copiado',
    'toast.apiKeySaved': 'API Key guardada para {provider}',
    'toast.modelDownloaded': 'Modelo descargado: {model}',
    'toast.errorRename': 'Error al renombrar',
    'toast.errorMove': 'Error al mover',
    'toast.errorDelete': 'Error al eliminar',
    'toast.errorExport': 'Error al exportar.',
    'toast.errorGeneric': 'Error desconocido',
    'toast.noProjects': 'No hay otros proyectos donde mover',
    'toast.selectProject': 'Selecciona un proyecto primero.',
    'toast.selectModel': 'Selecciona un modelo.',
    'toast.enterProjectName': 'Escribe un nombre para el proyecto.',
    'toast.cloudMode': 'Modo Cloud activado. Los mensajes se enviarán a servidores externos.',
    'toast.privateMode': 'Modo Privado: 100% local',
    'toast.fileTooLarge': 'Archivo demasiado grande: {name} (máx. 2 MB)',
    'toast.knowledgeAdded': '{name} añadido al conocimiento',
    'toast.knowledgeDeleted': 'Archivo eliminado del conocimiento',
    'toast.ollamaError': 'Ollama no responde. Verifica que esté ejecutándose: ollama serve',
    'toast.ragError': 'RAG no disponible — enviando sin contexto',
    'toast.contextError': 'No se pudieron cargar las instrucciones del proyecto',
    'knowledge.statusReady': 'Indexado',
    'knowledge.statusPending': 'Pendiente de indexación',
    'knowledge.statusError': 'Error',
    'toast.knowledgeIndexed': 'Documento indexado correctamente',
    'toast.knowledgeIndexError': 'Error al indexar documento',
    'toast.knowledgeIndexErrorEmbed': 'Error de indexación — ¿está instalado el modelo de embeddings? Ejecuta: ollama pull nomic-embed-text',
    'toast.ollamaNotRunning': 'Ollama no está ejecutándose. Inicia con: ollama serve',
    'toast.invalidApiKey': 'API Key inválida. Verifica tu configuración.',
    'toast.pdfFallback': 'PDF nativo no disponible. Se guardará como HTML — ábrelo y usa Ctrl+P → Guardar como PDF.',
    'toast.generationStopped': 'Generación detenida.',
    'toast.imageNotSupported': '⚠️ Las imágenes no son soportadas aún. Usa archivos de texto (.txt, .md, .csv).',
    'toast.binaryNotSupported': '⚠️ Archivos binarios no soportados. Usa archivos de texto.',

    // Projects
    'project.quickChat': 'Chat rápido',

    // Chat
    'chat.placeholder': 'Escribe tu mensaje aquí...',
    'chat.emptyHint': 'Escribe un mensaje abajo para empezar.',
    'chat.generating': 'Generando…',
    'chat.selectProject': 'Selecciona un proyecto',
    'chat.createFirst': 'Crea tu primer proyecto en la barra izquierda para empezar',

    // Context panel
    'context.title': 'Contexto del proyecto',
    'context.chatTitle': 'Contexto del chat',
    'context.systemPrompt': 'Instrucciones del sistema',
    'context.systemPromptPlaceholder': 'Define cómo debe comportarse la IA en este proyecto...',
    'context.chatSystemPromptPlaceholder': 'Define cómo debe comportarse la IA en este chat...',
    'context.saveInstructions': 'Guardar instrucciones',
    'context.instructionsSaved': 'Instrucciones guardadas',
    'context.knowledge': 'Base de conocimiento',
    'context.knowledgeHint': 'Archivos de texto para contexto permanente (RAG).',
    'context.addFiles': '+ Añadir archivos',
    'context.noKnowledge': 'Sin archivos. Añade archivos de texto.',
    'context.selectProjectFirst': 'Selecciona un proyecto para gestionar la base de conocimiento.',

    // Footer
    'footer.tagline': 'Ollama Local AI • Privado y Seguro • 100% en tu PC',
    'footer.cloud':   'Cloud AI • Tus datos salen de tu PC • Usa con precaución',

    // Providers
    'provider.local': 'Ollama (Local)',
    'provider.localDesc': 'Modelos locales. Tus datos nunca salen de tu PC.',
    'provider.openai': 'OpenAI',
    'provider.anthropic': 'Claude (Anthropic)',
    'provider.groq': 'Groq',
    'provider.groqDesc': 'Llama/Mistral ultrarrápido.',
    'provider.moonshot': 'Moonshot (Kimi)',
    'provider.moonshotDesc': 'Contexto 256k tokens.',
    'provider.cloudWarning': '⚠️ Cloud activo: Mensajes a servidores externos.',
    'provider.moreInfo': 'Más info',

    // Language
    'lang.label': 'Idioma',
    'lang.es': 'Español',
    'lang.en': 'English',
  },

  en: {
    'status.connected': '✓ Connected',
    'status.disconnected': '✗ Disconnected',
    'status.connecting': '● Connecting...',
    'privacy.private': '🔒 Private',
    'privacy.cloud': '☁️ Cloud',
    'privacy.tooltipPrivate': 'Private Mode: Your data never leaves this computer',
    'privacy.tooltipCloud': 'Online Mode: Data is sent to external servers',
    'privacy.inputWarning': 'This message will be sent to external servers. Do not share passwords or sensitive data.',
    'theme.light': 'Light',
    'theme.dark': 'Dark',

    'sidebar.projects': 'PROJECTS',
    'sidebar.recentChats': 'RECENT CHATS',
    'sidebar.projectName': 'Project name',
    'sidebar.noChats': 'No chats yet',

    'action.send': 'Send',
    'action.sending': 'Sending…',
    'action.save': 'Save',
    'action.cancel': 'Cancel',
    'action.delete': 'Delete',
    'action.accept': 'OK',
    'action.export': 'Export',
    'action.copy': '📋 Copy',
    'action.saveAsDoc': 'Save as doc 📄',
    'action.saveChat': '📄 Save',
    'action.newChat': 'New chat',
    'action.pull': 'Pull',
    'action.downloading': 'Downloading…',

    'modal.renameProject': 'Rename project',
    'modal.renameChat': 'Rename chat',
    'modal.deleteProject': 'Delete project',
    'modal.deleteProjectMsg': 'Delete this project and all its chats? This action cannot be undone.',
    'modal.deleteChat': 'Delete chat',
    'modal.deleteChatMsg': 'Delete this chat and all its messages?',
    'modal.moveChat': 'Move chat to:',
    'modal.saveAsDoc': 'Save as document',
    'modal.docTitle': 'Document title:',
    'modal.pullModel': 'Download model',
    'modal.pullModelMsg': 'Model name (e.g. llama3.2, qwen2.5:7b)',
    'modal.configApiKey': 'Configure API Key',
    'modal.exportChat': 'Export chat',
    'modal.exportSelect': 'Select export format:',
    'modal.privacyTitle': 'Privacy in MIKA5',
    'modal.privacyLocal': 'All data is processed on your machine. No message ever leaves your PC. 100% private.',
    'modal.privacyCloud': 'Messages are sent to external servers of the selected provider. MIKA5 sanitizes basic PII (emails, phones, IDs) before sending.',
    'modal.privacyKeys': 'Stored encrypted (AES-256-GCM) in the local database. Never transmitted to third parties beyond the provider.',

    'toast.projectCreated': 'Project created.',
    'toast.projectRenamed': 'Project renamed',
    'toast.projectDeleted': 'Project deleted',
    'toast.chatRenamed': 'Chat renamed',
    'toast.chatDeleted': 'Chat deleted',
    'toast.chatMoved': 'Chat moved to "{name}"',
    'toast.docSaved': 'Document saved to Knowledge.',
    'toast.chatSaved': 'Full chat saved to Knowledge.',
    'toast.exported': 'Chat exported.',
    'toast.copied': 'Copied to clipboard',
    'toast.codeCopied': 'Code copied',
    'toast.apiKeySaved': 'API Key saved for {provider}',
    'toast.modelDownloaded': 'Model downloaded: {model}',
    'toast.errorRename': 'Failed to rename',
    'toast.errorMove': 'Failed to move',
    'toast.errorDelete': 'Failed to delete',
    'toast.errorExport': 'Export failed.',
    'toast.errorGeneric': 'Unknown error',
    'toast.noProjects': 'No other projects to move to',
    'toast.selectProject': 'Select a project first.',
    'toast.selectModel': 'Select a model.',
    'toast.enterProjectName': 'Enter a project name.',
    'toast.cloudMode': 'Cloud mode enabled. Messages will be sent to external servers.',
    'toast.privateMode': 'Private mode: 100% local',
    'toast.fileTooLarge': 'File too large: {name} (max 2 MB)',
    'toast.knowledgeAdded': '{name} added to knowledge',
    'toast.knowledgeDeleted': 'File removed from knowledge',
    'toast.ollamaError': 'Ollama not responding. Verify it\'s running: ollama serve',
    'toast.ragError': 'RAG unavailable — sending without context',
    'toast.contextError': 'Could not load project instructions',
    'knowledge.statusReady': 'Indexed',
    'knowledge.statusPending': 'Pending indexing',
    'knowledge.statusError': 'Error',
    'toast.knowledgeIndexed': 'Document indexed successfully',
    'toast.knowledgeIndexError': 'Document indexing failed',
    'toast.knowledgeIndexErrorEmbed': 'Indexing failed — is the embedding model installed? Run: ollama pull nomic-embed-text',
    'toast.ollamaNotRunning': 'Ollama is not running. Start with: ollama serve',
    'toast.invalidApiKey': 'Invalid API Key. Check your configuration.',
    'toast.pdfFallback': 'Native PDF not available. Saved as HTML — open it and use Ctrl+P → Save as PDF.',
    'toast.generationStopped': 'Generation stopped.',
    'toast.imageNotSupported': '⚠️ Images not supported yet. Use text files (.txt, .md, .csv).',
    'toast.binaryNotSupported': '⚠️ Binary files not supported. Use text files.',

    'project.quickChat': 'Quick Chat',

    'chat.placeholder': 'Type your message here...',
    'chat.emptyHint': 'Type a message below to get started.',
    'chat.generating': 'Generating…',
    'chat.selectProject': 'Select a project',
    'chat.createFirst': 'Create your first project in the left sidebar to get started',

    'context.title': 'Project context',
    'context.chatTitle': 'Chat context',
    'context.systemPrompt': 'System instructions',
    'context.systemPromptPlaceholder': 'Define how the AI should behave in this project...',
    'context.chatSystemPromptPlaceholder': 'Define how the AI should behave in this chat...',
    'context.saveInstructions': 'Save instructions',
    'context.instructionsSaved': 'Instructions saved',
    'context.knowledge': 'Knowledge base',
    'context.knowledgeHint': 'Text files for permanent context (RAG).',
    'context.addFiles': '+ Add files',
    'context.noKnowledge': 'No files. Add text files.',
    'context.selectProjectFirst': 'Select a project to manage the knowledge base.',

    'footer.tagline': 'Ollama Local AI • Private & Secure • 100% on your PC',
    'footer.cloud':   'Cloud AI • Your data leaves your PC • Use with caution',

    'provider.local': 'Ollama (Local)',
    'provider.localDesc': 'Local models. Your data never leaves your PC.',
    'provider.openai': 'OpenAI',
    'provider.anthropic': 'Claude (Anthropic)',
    'provider.groq': 'Groq',
    'provider.groqDesc': 'Ultrafast Llama/Mistral.',
    'provider.moonshot': 'Moonshot (Kimi)',
    'provider.moonshotDesc': '256k token context.',
    'provider.cloudWarning': '⚠️ Cloud active: Messages sent to external servers.',
    'provider.moreInfo': 'More info',

    'lang.label': 'Language',
    'lang.es': 'Español',
    'lang.en': 'English',
  }
};

// --- i18n engine ---
let _mika5Lang = 'es';

function detectLanguage() {
  // 1. Check DB preference (loaded async on boot, fallback to localStorage until then)
  try {
    const saved = localStorage.getItem('mika5_lang');
    if (saved === 'en' || saved === 'es') return saved;
  } catch (_) {}
  // 2. Detect from OS/browser
  const nav = (navigator.language || navigator.userLanguage || 'es').toLowerCase();
  return nav.startsWith('en') ? 'en' : 'es';
}

function setLanguage(lang) {
  _mika5Lang = (lang === 'en') ? 'en' : 'es';
  // Persist to both localStorage (immediate) and DB (durable)
  try { localStorage.setItem('mika5_lang', _mika5Lang); } catch (_) {}
  try { if (window.mika5?.setAppState) window.mika5.setAppState('language', _mika5Lang); } catch (_) {}
}

// Restore language from DB (called after mika5 bridge is ready)
async function restoreLanguageFromDb() {
  try {
    if (!window.mika5?.getAppState) return;
    const dbLang = await window.mika5.getAppState('language');
    if (dbLang === 'en' || dbLang === 'es') {
      _mika5Lang = dbLang;
      try { localStorage.setItem('mika5_lang', dbLang); } catch (_) {}
    }
  } catch (_) {}
}

function t(key, params) {
  const dict = MIKA5_TRANSLATIONS[_mika5Lang] || MIKA5_TRANSLATIONS['es'];
  let str = dict[key] || MIKA5_TRANSLATIONS['es'][key] || key;
  if (params) {
    Object.keys(params).forEach(k => {
      str = str.replace(`{${k}}`, params[k]);
    });
  }
  return str;
}

// Initialize language on load
_mika5Lang = detectLanguage();