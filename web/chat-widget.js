(function () {
  'use strict';

  // ── KNOWLEDGE BASE ──────────────────────────────────────────
  const KB = [
    {
      id: 'what-is',
      category: 'general',
      keywords: { en: ['what', 'mika5', 'about', 'overview', 'explain'], es: ['que', 'mika5', 'sobre', 'descripcion', 'explicar'] },
      question: { en: 'What is MIKA5?', es: 'Que es MIKA5?' },
      answer: {
        en: 'MIKA5 is a free, open-source AI desktop app that runs 100% on your computer. It connects to Ollama for local AI models, includes a built-in RAG engine, project organization, vision model support, and optional cloud providers. Licensed under AGPL-3.0.',
        es: 'MIKA5 es una app de escritorio de IA gratuita y de codigo abierto que funciona 100% en tu computadora. Se conecta a Ollama para modelos locales, incluye motor RAG integrado, organizacion por proyectos, soporte de modelos de vision y proveedores cloud opcionales. Licencia AGPL-3.0.'
      }
    },
    {
      id: 'free',
      category: 'general',
      keywords: { en: ['free', 'cost', 'price', 'pay', 'subscription', 'license'], es: ['gratis', 'gratuito', 'costo', 'precio', 'pagar', 'suscripcion', 'licencia'] },
      question: { en: 'Is MIKA5 free?', es: 'MIKA5 es gratis?' },
      answer: {
        en: 'Yes! MIKA5 is 100% free with no subscriptions, no license key, and no hidden costs. It is open-source under the AGPL-3.0 license.',
        es: 'Si! MIKA5 es 100% gratuito, sin suscripciones, sin clave de licencia y sin costos ocultos. Es open-source bajo licencia AGPL-3.0.'
      }
    },
    {
      id: 'platforms',
      category: 'general',
      keywords: { en: ['platform', 'windows', 'mac', 'macos', 'linux', 'os', 'operating', 'system', 'run'], es: ['plataforma', 'windows', 'mac', 'macos', 'linux', 'sistema', 'operativo', 'ejecutar', 'correr'] },
      question: { en: 'What platforms does MIKA5 support?', es: 'En que plataformas funciona MIKA5?' },
      answer: {
        en: 'MIKA5 is available for:\n- Windows 10+ (installer .exe and portable)\n- macOS 12+ (Intel x64 and Apple Silicon arm64 DMG)\n- Linux (AppImage, .deb, .rpm)',
        es: 'MIKA5 esta disponible para:\n- Windows 10+ (instalador .exe y portable)\n- macOS 12+ (Intel x64 y Apple Silicon arm64 DMG)\n- Linux (AppImage, .deb, .rpm)'
      }
    },
    {
      id: 'languages-ui',
      category: 'general',
      keywords: { en: ['language', 'spanish', 'english', 'bilingual', 'i18n', 'translate'], es: ['idioma', 'espanol', 'ingles', 'bilingue', 'traducir', 'traduccion'] },
      question: { en: 'What languages does MIKA5 support?', es: 'Que idiomas soporta MIKA5?' },
      answer: {
        en: 'The MIKA5 interface is fully bilingual: English and Spanish. You can toggle the language anytime with the EN/ES button. AI model responses depend on the model you use.',
        es: 'La interfaz de MIKA5 es completamente bilingue: espanol e ingles. Puedes cambiar el idioma en cualquier momento con el boton EN/ES. Las respuestas de los modelos dependen del modelo que uses.'
      }
    },
    {
      id: 'rag',
      category: 'features',
      keywords: { en: ['rag', 'knowledge', 'document', 'upload', 'retrieval', 'chunk', 'embed', 'search'], es: ['rag', 'conocimiento', 'documento', 'subir', 'recuperacion', 'fragmento', 'embeber', 'buscar', 'busqueda'] },
      question: { en: 'What is the RAG engine?', es: 'Que es el motor RAG?' },
      answer: {
        en: 'MIKA5 includes a built-in RAG (Retrieval-Augmented Generation) engine. When you upload documents, it automatically chunks them (~4200 chars with 700 overlap), creates embeddings via Ollama, stores them in SQLite, and retrieves the top-3 most relevant fragments for every message using cosine similarity. Knowledge bases are per-project and per-chat.',
        es: 'MIKA5 incluye un motor RAG (Generacion Aumentada por Recuperacion) integrado. Al subir documentos, automaticamente los fragmenta (~4200 caracteres con 700 de solapamiento), crea embeddings via Ollama, los almacena en SQLite y recupera los 3 fragmentos mas relevantes para cada mensaje usando similitud coseno. Las bases de conocimiento son por proyecto y por chat.'
      }
    },
    {
      id: 'projects',
      category: 'features',
      keywords: { en: ['project', 'chat', 'organize', 'workspace', 'quick'], es: ['proyecto', 'chat', 'organizar', 'espacio', 'rapido'] },
      question: { en: 'How do projects and chats work?', es: 'Como funcionan los proyectos y chats?' },
      answer: {
        en: 'MIKA5 organizes work into projects with isolated knowledge bases, system prompts, and chat history. Each project can have multiple chats. Use Quick Chat for ad-hoc conversations without a project.',
        es: 'MIKA5 organiza el trabajo en proyectos con bases de conocimiento aisladas, prompts de sistema e historial de chat. Cada proyecto puede tener multiples chats. Usa Chat Rapido para conversaciones sin proyecto.'
      }
    },
    {
      id: 'vision',
      category: 'features',
      keywords: { en: ['vision', 'image', 'photo', 'picture', 'llava', 'see', 'visual', 'ocr'], es: ['vision', 'imagen', 'foto', 'visual', 'llava', 'ver', 'ocr'] },
      question: { en: 'Does MIKA5 support vision models?', es: 'MIKA5 soporta modelos de vision?' },
      answer: {
        en: 'Yes! Attach images to any message. MIKA5 auto-detects vision-capable models (LLaVA, GLM-OCR, Gemma3, Qwen2.5-VL, GPT-4o, Claude) and warns you when the active model cannot process images.',
        es: 'Si! Adjunta imagenes a cualquier mensaje. MIKA5 detecta automaticamente modelos con vision (LLaVA, GLM-OCR, Gemma3, Qwen2.5-VL, GPT-4o, Claude) y te avisa cuando el modelo activo no puede procesar imagenes.'
      }
    },
    {
      id: 'cloud',
      category: 'features',
      keywords: { en: ['cloud', 'openai', 'anthropic', 'groq', 'moonshot', 'gpt', 'claude', 'api', 'provider', 'online'], es: ['cloud', 'nube', 'openai', 'anthropic', 'groq', 'moonshot', 'gpt', 'claude', 'api', 'proveedor', 'online'] },
      question: { en: 'Can I use cloud AI providers?', es: 'Puedo usar proveedores de IA en la nube?' },
      answer: {
        en: 'Yes, optionally. MIKA5 supports OpenAI, Anthropic, Groq, and Moonshot. API keys are encrypted with AES-256-GCM. A privacy indicator always shows when cloud is active. Cloud is never required - MIKA5 works fully offline with Ollama.',
        es: 'Si, opcionalmente. MIKA5 soporta OpenAI, Anthropic, Groq y Moonshot. Las claves API se cifran con AES-256-GCM. Un indicador de privacidad siempre muestra cuando la nube esta activa. La nube nunca es obligatoria - MIKA5 funciona 100% offline con Ollama.'
      }
    },
    {
      id: 'export',
      category: 'features',
      keywords: { en: ['export', 'save', 'markdown', 'pdf', 'html', 'download', 'conversation'], es: ['exportar', 'guardar', 'markdown', 'pdf', 'html', 'descargar', 'conversacion'] },
      question: { en: 'Can I export conversations?', es: 'Puedo exportar conversaciones?' },
      answer: {
        en: 'Yes! Export individual messages or full conversations to Markdown, plain text, HTML, Python, or PDF. Smart titles are generated automatically from content.',
        es: 'Si! Exporta mensajes individuales o conversaciones completas a Markdown, texto plano, HTML, Python o PDF. Los titulos se generan automaticamente del contenido.'
      }
    },
    {
      id: 'model-tracking',
      category: 'features',
      keywords: { en: ['model', 'tracking', 'tag', 'switch', 'which', 'answered'], es: ['modelo', 'seguimiento', 'etiqueta', 'cambio', 'cual', 'respondio'] },
      question: { en: 'How does model tracking work?', es: 'Como funciona el seguimiento de modelos?' },
      answer: {
        en: 'Every message is tagged with the model that generated it. When you switch models mid-chat, MIKA5 highlights the change inline so you always know which AI answered each message.',
        es: 'Cada mensaje se etiqueta con el modelo que lo genero. Cuando cambias de modelo en medio de un chat, MIKA5 resalta el cambio en linea para que siempre sepas que IA respondio cada mensaje.'
      }
    },
    {
      id: 'privacy',
      category: 'privacy',
      keywords: { en: ['privacy', 'telemetry', 'tracking', 'data', 'collect', 'spy', 'safe', 'secure'], es: ['privacidad', 'telemetria', 'rastreo', 'datos', 'recopilar', 'seguro', 'seguridad', 'espiar'] },
      question: { en: 'Does MIKA5 collect any data?', es: 'MIKA5 recopila datos?' },
      answer: {
        en: 'No. MIKA5 has zero telemetry, zero tracking, and zero data collection. All conversations, documents, and settings stay on your machine in a local SQLite database. Nothing is ever sent anywhere unless you explicitly enable a cloud provider.',
        es: 'No. MIKA5 tiene cero telemetria, cero rastreo y cero recopilacion de datos. Todas las conversaciones, documentos y configuraciones permanecen en tu maquina en una base de datos SQLite local. Nada se envia a ningun lado a menos que actives explicitamente un proveedor cloud.'
      }
    },
    {
      id: 'encryption',
      category: 'privacy',
      keywords: { en: ['encrypt', 'aes', 'key', 'credential', 'secure', 'storage', 'password'], es: ['cifrar', 'cifrado', 'aes', 'clave', 'credencial', 'seguro', 'almacenamiento', 'contrasena'] },
      question: { en: 'How are API keys stored?', es: 'Como se almacenan las claves API?' },
      answer: {
        en: 'API keys are encrypted with AES-256-GCM using Electron safeStorage (OS credential store). PII in messages sent to cloud providers is sanitized: emails, phone numbers, and IDs are replaced with tokens.',
        es: 'Las claves API se cifran con AES-256-GCM usando Electron safeStorage (almacen de credenciales del SO). La informacion personal en mensajes enviados a proveedores cloud se sanitiza: emails, telefonos e IDs se reemplazan con tokens.'
      }
    },
    {
      id: 'requirements',
      category: 'install',
      keywords: { en: ['requirement', 'need', 'ram', 'hardware', 'minimum', 'specs', 'computer'], es: ['requisito', 'necesito', 'ram', 'hardware', 'minimo', 'especificaciones', 'computadora'] },
      question: { en: 'What are the system requirements?', es: 'Cuales son los requisitos del sistema?' },
      answer: {
        en: 'Minimum: 8 GB RAM, 4 GB free disk space (plus space for models). Recommended: 16 GB RAM for 7-8B parameter models. You also need Ollama installed and running locally.',
        es: 'Minimo: 8 GB RAM, 4 GB de espacio en disco (mas espacio para modelos). Recomendado: 16 GB RAM para modelos de 7-8B parametros. Tambien necesitas Ollama instalado y ejecutandose localmente.'
      }
    },
    {
      id: 'install-ollama',
      category: 'install',
      keywords: { en: ['install', 'ollama', 'setup', 'start', 'begin', 'first', 'step'], es: ['instalar', 'ollama', 'configurar', 'iniciar', 'empezar', 'primero', 'paso'] },
      question: { en: 'How do I install Ollama?', es: 'Como instalo Ollama?' },
      answer: {
        en: 'Visit ollama.com and download for your OS. After installing, it runs automatically on http://127.0.0.1:11434. Then pull a model:\n\nollama pull llama3.2\nollama pull nomic-embed-text\n\nThe first model is for chatting, the second enables RAG.',
        es: 'Visita ollama.com y descarga para tu SO. Despues de instalar, se ejecuta automaticamente en http://127.0.0.1:11434. Luego descarga un modelo:\n\nollama pull llama3.2\nollama pull nomic-embed-text\n\nEl primer modelo es para chatear, el segundo habilita RAG.'
      }
    },
    {
      id: 'models-recommend',
      category: 'models',
      keywords: { en: ['recommend', 'model', 'best', 'which', 'choose', 'suggest', 'good'], es: ['recomendar', 'modelo', 'mejor', 'cual', 'elegir', 'sugerir', 'bueno'] },
      question: { en: 'Which models do you recommend?', es: 'Que modelos recomiendas?' },
      answer: {
        en: 'Depends on your RAM:\n- 8 GB: Qwen2.5:3B, Phi-4-mini, Llama3.2:3B\n- 16 GB: Llama3.2:8B, Mistral:7B, Gemma3:12B, Qwen2.5:7B\n- 32 GB+: Llama3.3:70B, DeepSeek-R1, Qwen2.5:32B\n\nFor coding: Qwen2.5-Coder:7B. Always install nomic-embed-text for RAG.',
        es: 'Depende de tu RAM:\n- 8 GB: Qwen2.5:3B, Phi-4-mini, Llama3.2:3B\n- 16 GB: Llama3.2:8B, Mistral:7B, Gemma3:12B, Qwen2.5:7B\n- 32 GB+: Llama3.3:70B, DeepSeek-R1, Qwen2.5:32B\n\nPara codigo: Qwen2.5-Coder:7B. Siempre instala nomic-embed-text para RAG.'
      }
    },
    {
      id: 'embedding',
      category: 'models',
      keywords: { en: ['embedding', 'nomic', 'mxbai', 'vector', 'embed'], es: ['embedding', 'nomic', 'mxbai', 'vector', 'embeber'] },
      question: { en: 'What embedding model should I use?', es: 'Que modelo de embedding debo usar?' },
      answer: {
        en: 'Recommended: nomic-embed-text (274 MB, 768 dimensions, fast). Alternative for higher precision: mxbai-embed-large (670 MB, 1024 dimensions). Install with:\n\nollama pull nomic-embed-text',
        es: 'Recomendado: nomic-embed-text (274 MB, 768 dimensiones, rapido). Alternativa de mayor precision: mxbai-embed-large (670 MB, 1024 dimensiones). Instala con:\n\nollama pull nomic-embed-text'
      }
    },
    {
      id: 'coding-model',
      category: 'models',
      keywords: { en: ['code', 'coding', 'programming', 'developer', 'coder'], es: ['codigo', 'codificar', 'programacion', 'desarrollador', 'coder', 'programar'] },
      question: { en: 'Best model for coding?', es: 'Mejor modelo para programar?' },
      answer: {
        en: 'Qwen2.5-Coder:7B is the top recommendation for coding. It achieves the highest coding benchmarks among 7B models. For lighter setups (8 GB RAM), try DeepSeek-Coder-V2-Lite.',
        es: 'Qwen2.5-Coder:7B es la mejor recomendacion para programar. Logra los benchmarks de codigo mas altos entre modelos de 7B. Para equipos mas ligeros (8 GB RAM), prueba DeepSeek-Coder-V2-Lite.'
      }
    },
    {
      id: 'download',
      category: 'download',
      keywords: { en: ['download', 'get', 'install', 'mika5', 'where', 'link'], es: ['descargar', 'obtener', 'instalar', 'mika5', 'donde', 'enlace', 'link'] },
      question: { en: 'Where can I download MIKA5?', es: 'Donde puedo descargar MIKA5?' },
      answer: {
        en: 'Download MIKA5 from GitHub Releases:\nhttps://github.com/mika5app/mika5-releases/releases\n\nAvailable for Windows (.exe installer + portable), macOS (DMG for Intel and Apple Silicon), and Linux (AppImage, .deb, .rpm).',
        es: 'Descarga MIKA5 desde GitHub Releases:\nhttps://github.com/mika5app/mika5-releases/releases\n\nDisponible para Windows (.exe instalador + portable), macOS (DMG para Intel y Apple Silicon), y Linux (AppImage, .deb, .rpm).'
      }
    },
    {
      id: 'macos-gatekeeper',
      category: 'install',
      keywords: { en: ['gatekeeper', 'macos', 'mac', 'blocked', 'open', 'unidentified', 'damaged', 'apple'], es: ['gatekeeper', 'macos', 'mac', 'bloqueado', 'abrir', 'identificado', 'danado', 'apple'] },
      question: { en: 'macOS blocks MIKA5 from opening', es: 'macOS bloquea la apertura de MIKA5' },
      answer: {
        en: 'MIKA5 is not notarized yet. To bypass Gatekeeper on macOS:\n1. Right-click the app\n2. Select "Open"\n3. Click "Open" in the dialog\n\nThis only needs to be done once.',
        es: 'MIKA5 aun no esta notarizado. Para saltar Gatekeeper en macOS:\n1. Haz clic derecho en la app\n2. Selecciona "Abrir"\n3. Haz clic en "Abrir" en el dialogo\n\nSolo necesitas hacerlo una vez.'
      }
    },
    {
      id: 'architecture',
      category: 'technical',
      keywords: { en: ['architecture', 'technical', 'how', 'work', 'built', 'electron', 'sqlite', 'stack', 'technology'], es: ['arquitectura', 'tecnico', 'como', 'funciona', 'construido', 'electron', 'sqlite', 'stack', 'tecnologia'] },
      question: { en: 'What technology is MIKA5 built with?', es: 'Con que tecnologia esta construido MIKA5?' },
      answer: {
        en: 'MIKA5 is built with Electron (two-process model), SQLite with WAL mode via better-sqlite3, and communicates via IPC contextBridge. The RAG engine uses cosine similarity on locally-generated embeddings. No external frameworks - pure HTML/CSS/JS in the renderer.',
        es: 'MIKA5 esta construido con Electron (modelo de dos procesos), SQLite con modo WAL via better-sqlite3, y se comunica via IPC contextBridge. El motor RAG usa similitud coseno sobre embeddings generados localmente. Sin frameworks externos - HTML/CSS/JS puro en el renderer.'
      }
    },
    {
      id: 'opensource',
      category: 'general',
      keywords: { en: ['open', 'source', 'github', 'contribute', 'code', 'repo', 'repository', 'agpl'], es: ['open', 'source', 'abierto', 'github', 'contribuir', 'codigo', 'repo', 'repositorio', 'agpl'] },
      question: { en: 'Is MIKA5 open source?', es: 'MIKA5 es open source?' },
      answer: {
        en: 'Yes! MIKA5 is fully open-source under the AGPL-3.0 license. The source code is available at:\nhttps://github.com/mika5app/mika5\n\nContributions are welcome.',
        es: 'Si! MIKA5 es completamente open-source bajo la licencia AGPL-3.0. El codigo fuente esta disponible en:\nhttps://github.com/mika5app/mika5\n\nLas contribuciones son bienvenidas.'
      }
    },
    {
      id: 'sovereign',
      category: 'general',
      keywords: { en: ['sovereign', 'philosophy', 'why', 'mission', 'purpose', 'control'], es: ['soberano', 'soberania', 'filosofia', 'por que', 'mision', 'proposito', 'control'] },
      question: { en: 'What does "Sovereign AI" mean?', es: 'Que significa "IA Soberana"?' },
      answer: {
        en: 'Sovereign AI means you own and control your AI experience. Your data never leaves your machine, you choose which models to run, there is no vendor lock-in, and no corporation decides what you can or cannot ask. MIKA5 puts AI sovereignty in the hands of individuals.',
        es: 'IA Soberana significa que tu eres dueno y controlas tu experiencia de IA. Tus datos nunca salen de tu maquina, tu eliges que modelos ejecutar, no hay dependencia de proveedores, y ninguna corporacion decide que puedes o no preguntar. MIKA5 pone la soberania de la IA en manos de los individuos.'
      }
    },
    {
      id: 'offline',
      category: 'features',
      keywords: { en: ['offline', 'internet', 'connection', 'without', 'airplane', 'disconnected'], es: ['offline', 'internet', 'conexion', 'sin', 'desconectado', 'avion'] },
      question: { en: 'Does MIKA5 work offline?', es: 'MIKA5 funciona sin internet?' },
      answer: {
        en: 'Yes! MIKA5 works 100% offline with local Ollama models. You only need internet to download models initially or if you choose to use optional cloud providers.',
        es: 'Si! MIKA5 funciona 100% sin internet con modelos locales de Ollama. Solo necesitas internet para descargar modelos inicialmente o si decides usar proveedores cloud opcionales.'
      }
    },
    {
      id: 'newsletter',
      category: 'general',
      keywords: { en: ['newsletter', 'updates', 'news', 'subscribe', 'email', 'notify'], es: ['newsletter', 'boletin', 'actualizaciones', 'noticias', 'suscribir', 'email', 'notificar'] },
      question: { en: 'How can I stay updated?', es: 'Como puedo mantenerme actualizado?' },
      answer: {
        en: 'Subscribe to the MIKA5 newsletter at the bottom of the landing page, or watch the GitHub repository for releases:\nhttps://github.com/mika5app/mika5',
        es: 'Suscribete al newsletter de MIKA5 al final de la pagina principal, o sigue el repositorio de GitHub para nuevas versiones:\nhttps://github.com/mika5app/mika5'
      }
    }
  ];

  // ── STOP WORDS ──────────────────────────────────────────────
  var STOP = {
    en: new Set(['the', 'a', 'an', 'is', 'it', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'do', 'does', 'did', 'can', 'how', 'what', 'why', 'when', 'where', 'who', 'i', 'me', 'my', 'you', 'your', 'we', 'they', 'this', 'that', 'with', 'from', 'has', 'have', 'had', 'be', 'been', 'are', 'was', 'were', 'will', 'would', 'could', 'should', 'not', 'no', 'but', 'if', 'so', 'just', 'about', 'very', 'also', 'some', 'any', 'all', 'there']),
    es: new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'es', 'son', 'en', 'de', 'del', 'al', 'y', 'o', 'que', 'como', 'por', 'para', 'con', 'se', 'su', 'sus', 'mi', 'tu', 'me', 'te', 'le', 'lo', 'nos', 'yo', 'no', 'si', 'pero', 'ya', 'mas', 'muy', 'hay', 'tiene', 'puede', 'esta', 'este', 'esto', 'eso', 'ese', 'esa', 'cuando', 'donde', 'quien', 'cual', 'tambien', 'todo', 'todos'])
  };

  // ── GREETING PATTERNS ───────────────────────────────────────
  var GREETINGS = /^(hi|hello|hey|hola|buenos dias|buenas tardes|buenas noches|que tal|saludos|good morning|good afternoon|good evening|sup|yo)\b/i;

  // ── MATCHING ENGINE ─────────────────────────────────────────
  function normalize(text) {
    return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function tokenize(text, lang) {
    var words = normalize(text).split(' ');
    var stop = STOP[lang] || STOP.en;
    return words.filter(function (w) { return w.length > 1 && !stop.has(w); });
  }

  // Exact phrase boost terms
  var BOOST_TERMS = ['download', 'descargar', 'rag', 'install', 'instalar', 'privacy', 'privacidad', 'model', 'modelo', 'vision', 'cloud', 'nube', 'export', 'exportar', 'offline', 'free', 'gratis', 'sovereign', 'soberano', 'embed', 'ollama'];

  function findBestMatch(input, lang) {
    var normalizedInput = normalize(input);

    // Greeting check
    if (GREETINGS.test(input.trim())) return null; // signal greeting

    var tokens = tokenize(input, lang);
    if (tokens.length === 0) return null;

    var bestScore = 0;
    var bestEntry = null;

    for (var i = 0; i < KB.length; i++) {
      var entry = KB[i];
      var kw = entry.keywords[lang] || entry.keywords.en;
      var score = 0;

      for (var j = 0; j < tokens.length; j++) {
        for (var k = 0; k < kw.length; k++) {
          if (tokens[j] === kw[k] || kw[k].indexOf(tokens[j]) === 0 || tokens[j].indexOf(kw[k]) === 0) {
            score += 1;
            break;
          }
        }
      }

      // Boost for exact phrase matches
      for (var b = 0; b < BOOST_TERMS.length; b++) {
        if (normalizedInput.indexOf(BOOST_TERMS[b]) !== -1) {
          for (var m = 0; m < kw.length; m++) {
            if (kw[m] === BOOST_TERMS[b]) {
              score += 1.5;
              break;
            }
          }
        }
      }

      // Normalize by keyword count
      var normalizedScore = score / Math.max(tokens.length, 1);

      if (normalizedScore > bestScore) {
        bestScore = normalizedScore;
        bestEntry = entry;
      }
    }

    return bestScore >= 0.3 ? bestEntry : false; // false = no match, null = greeting
  }

  // ── WIDGET UI STRINGS ──────────────────────────────────────
  var UI = {
    en: {
      title: 'MIKA5 Assistant',
      placeholder: 'Ask about MIKA5...',
      welcome: 'Hi! I can help with questions about MIKA5 \u2014 features, installation, privacy, models, and more.',
      greeting: 'Hello! How can I help you with MIKA5 today?',
      fallback: "I'm not sure about that. Try asking about:",
      suggestions: ['Features', 'Download', 'Privacy', 'Models', 'RAG', 'Getting Started'],
      powered: 'Knowledge-based assistant'
    },
    es: {
      title: 'Asistente MIKA5',
      placeholder: 'Pregunta sobre MIKA5...',
      welcome: 'Hola! Puedo ayudarte con preguntas sobre MIKA5 \u2014 funcionalidades, instalacion, privacidad, modelos y mas.',
      greeting: 'Hola! Como puedo ayudarte con MIKA5 hoy?',
      fallback: 'No estoy seguro sobre eso. Prueba preguntar sobre:',
      suggestions: ['Funcionalidades', 'Descargar', 'Privacidad', 'Modelos', 'RAG', 'Inicio'],
      powered: 'Asistente basado en conocimiento'
    }
  };

  // ── CSS ─────────────────────────────────────────────────────
  function injectStyles() {
    var css = [
      '#mika5-cw-bubble{position:fixed;bottom:24px;right:24px;z-index:9999;width:56px;height:56px;border-radius:28px;background:#7C3AED;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(124,58,237,0.4);transition:transform 0.2s,box-shadow 0.2s}',
      '#mika5-cw-bubble:hover{transform:scale(1.08);box-shadow:0 6px 28px rgba(124,58,237,0.5)}',
      '#mika5-cw-bubble svg{width:26px;height:26px;fill:#fff;transition:transform 0.2s}',
      '#mika5-cw-window{position:fixed;bottom:92px;right:24px;z-index:9998;width:380px;max-height:520px;background:#0B0F14;border:1px solid rgba(255,255,255,0.08);border-radius:16px;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,0.5);opacity:0;transform:translateY(12px);transition:opacity 0.25s,transform 0.25s;pointer-events:none;overflow:hidden;font-family:"Inter",sans-serif}',
      '#mika5-cw-window.open{opacity:1;transform:translateY(0);pointer-events:auto}',
      '#mika5-cw-header{background:#111827;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06)}',
      '#mika5-cw-header-left{display:flex;align-items:center;gap:10px}',
      '#mika5-cw-header-dot{width:8px;height:8px;border-radius:4px;background:#34D399}',
      '#mika5-cw-header-title{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:14px;color:#F9FAFB}',
      '#mika5-cw-header-close{background:none;border:none;cursor:pointer;color:#6B7280;font-size:20px;line-height:1;padding:4px;transition:color 0.2s}',
      '#mika5-cw-header-close:hover{color:#F9FAFB}',
      '#mika5-cw-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;min-height:280px;max-height:360px;scroll-behavior:smooth}',
      '.mika5-cw-msg{max-width:85%;padding:10px 14px;border-radius:14px;font-size:13px;line-height:1.55;word-wrap:break-word;white-space:pre-wrap}',
      '.mika5-cw-msg-bot{background:#111827;color:#D1D5DB;align-self:flex-start;border-bottom-left-radius:4px}',
      '.mika5-cw-msg-user{background:#7C3AED;color:#F9FAFB;align-self:flex-end;border-bottom-right-radius:4px}',
      '.mika5-cw-msg a{color:#A78BFA;text-decoration:underline}',
      '#mika5-cw-suggestions{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 12px}',
      '.mika5-cw-chip{background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.3);color:#A78BFA;font-size:11px;padding:5px 12px;border-radius:20px;cursor:pointer;transition:background 0.2s,color 0.2s;font-family:"Inter",sans-serif}',
      '.mika5-cw-chip:hover{background:rgba(124,58,237,0.25);color:#F9FAFB}',
      '#mika5-cw-input-area{display:flex;gap:8px;padding:12px 16px;border-top:1px solid rgba(255,255,255,0.06);background:#0D1117}',
      '#mika5-cw-input{flex:1;background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:9px 14px;color:#F9FAFB;font-size:13px;outline:none;font-family:"Inter",sans-serif;transition:border-color 0.2s}',
      '#mika5-cw-input:focus{border-color:rgba(124,58,237,0.5)}',
      '#mika5-cw-input::placeholder{color:#4B5563}',
      '#mika5-cw-send{background:#7C3AED;border:none;border-radius:10px;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s}',
      '#mika5-cw-send:hover{background:#8B5CF6}',
      '#mika5-cw-send svg{width:18px;height:18px;fill:#fff}',
      '#mika5-cw-powered{text-align:center;padding:6px;font-size:10px;color:#4B5563}',
      '.mika5-cw-typing{display:flex;gap:4px;padding:10px 14px;align-self:flex-start}',
      '.mika5-cw-typing span{width:6px;height:6px;border-radius:3px;background:#6B7280;animation:mika5-bounce 1.2s infinite}',
      '.mika5-cw-typing span:nth-child(2){animation-delay:0.15s}',
      '.mika5-cw-typing span:nth-child(3){animation-delay:0.3s}',
      '@keyframes mika5-bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}',
      '#mika5-cw-messages::-webkit-scrollbar{width:4px}',
      '#mika5-cw-messages::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:2px}',
      '@media(max-width:480px){#mika5-cw-window{width:calc(100vw - 32px);max-height:calc(100vh - 120px);bottom:88px;right:16px}#mika5-cw-bubble{bottom:16px;right:16px}}'
    ].join('\n');

    var style = document.createElement('style');
    style.id = 'mika5-cw-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── DOM CONSTRUCTION ────────────────────────────────────────
  var lang = 'en';
  var isOpen = false;
  var messagesEl, inputEl, suggestionsEl, titleEl, poweredEl, inputPlaceholder;

  function getLang() {
    return localStorage.getItem('mika5-lang') || ((navigator.language || 'en').startsWith('es') ? 'es' : 'en');
  }

  function s(key) {
    return (UI[lang] && UI[lang][key]) || UI.en[key] || '';
  }

  function linkify(text) {
    return text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  function createBubble() {
    var btn = document.createElement('button');
    btn.id = 'mika5-cw-bubble';
    btn.setAttribute('aria-label', 'Chat');
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>';
    btn.addEventListener('click', toggleChat);
    return btn;
  }

  function createWindow() {
    var win = document.createElement('div');
    win.id = 'mika5-cw-window';

    // Header
    var header = document.createElement('div');
    header.id = 'mika5-cw-header';
    var headerLeft = document.createElement('div');
    headerLeft.id = 'mika5-cw-header-left';
    var dot = document.createElement('span');
    dot.id = 'mika5-cw-header-dot';
    titleEl = document.createElement('span');
    titleEl.id = 'mika5-cw-header-title';
    titleEl.textContent = s('title');
    headerLeft.appendChild(dot);
    headerLeft.appendChild(titleEl);
    var closeBtn = document.createElement('button');
    closeBtn.id = 'mika5-cw-header-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', toggleChat);
    header.appendChild(headerLeft);
    header.appendChild(closeBtn);

    // Messages
    messagesEl = document.createElement('div');
    messagesEl.id = 'mika5-cw-messages';

    // Suggestions
    suggestionsEl = document.createElement('div');
    suggestionsEl.id = 'mika5-cw-suggestions';

    // Input area
    var inputArea = document.createElement('div');
    inputArea.id = 'mika5-cw-input-area';
    inputEl = document.createElement('input');
    inputEl.id = 'mika5-cw-input';
    inputEl.type = 'text';
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
    var sendBtn = document.createElement('button');
    sendBtn.id = 'mika5-cw-send';
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
    sendBtn.addEventListener('click', handleSend);
    inputArea.appendChild(inputEl);
    inputArea.appendChild(sendBtn);

    // Powered
    poweredEl = document.createElement('div');
    poweredEl.id = 'mika5-cw-powered';

    win.appendChild(header);
    win.appendChild(messagesEl);
    win.appendChild(suggestionsEl);
    win.appendChild(inputArea);
    win.appendChild(poweredEl);

    return win;
  }

  function addMessage(text, sender) {
    var div = document.createElement('div');
    div.className = 'mika5-cw-msg mika5-cw-msg-' + sender;
    div.innerHTML = linkify(text);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function showTyping() {
    var div = document.createElement('div');
    div.className = 'mika5-cw-typing';
    div.id = 'mika5-cw-typing';
    for (var i = 0; i < 3; i++) {
      var dot = document.createElement('span');
      div.appendChild(dot);
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function removeTyping() {
    var t = document.getElementById('mika5-cw-typing');
    if (t) t.remove();
  }

  function renderSuggestions() {
    suggestionsEl.innerHTML = '';
    var items = s('suggestions');
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      (function (text) {
        var chip = document.createElement('button');
        chip.className = 'mika5-cw-chip';
        chip.textContent = text;
        chip.addEventListener('click', function () {
          inputEl.value = text;
          handleSend();
        });
        suggestionsEl.appendChild(chip);
      })(items[i]);
    }
  }

  function updateUILang() {
    lang = getLang();
    if (titleEl) titleEl.textContent = s('title');
    if (inputEl) inputEl.placeholder = s('placeholder');
    if (poweredEl) poweredEl.textContent = s('powered');
  }

  // ── CHAT LOGIC ──────────────────────────────────────────────
  function handleSend() {
    var text = (inputEl.value || '').trim();
    if (!text) return;

    inputEl.value = '';
    addMessage(text, 'user');

    // Hide suggestions after first message
    suggestionsEl.style.display = 'none';

    showTyping();

    var delay = 300 + Math.random() * 400;
    setTimeout(function () {
      removeTyping();

      var match = findBestMatch(text, lang);

      if (match === null) {
        // Greeting
        addMessage(s('greeting'), 'bot');
      } else if (match === false) {
        // No match - show fallback + suggestions
        var fallbackMsg = s('fallback') + '\n\n' + s('suggestions').join(' \u00b7 ');
        addMessage(fallbackMsg, 'bot');
      } else {
        // FAQ match
        var answer = match.answer[lang] || match.answer.en;
        addMessage(answer, 'bot');
      }
    }, delay);
  }

  function toggleChat() {
    var win = document.getElementById('mika5-cw-window');
    var bubble = document.getElementById('mika5-cw-bubble');
    isOpen = !isOpen;

    if (isOpen) {
      win.classList.add('open');
      bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
      inputEl.focus();
    } else {
      win.classList.remove('open');
      bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>';
    }
  }

  // ── INIT ────────────────────────────────────────────────────
  function init() {
    lang = getLang();
    injectStyles();

    var container = document.createElement('div');
    container.id = 'mika5-cw-container';
    container.appendChild(createWindow());
    container.appendChild(createBubble());
    document.body.appendChild(container);

    updateUILang();
    inputEl.placeholder = s('placeholder');
    poweredEl.textContent = s('powered');

    // Welcome message
    addMessage(s('welcome'), 'bot');
    renderSuggestions();

    // Watch language changes
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].attributeName === 'lang') {
          updateUILang();
          break;
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
