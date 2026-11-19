// src/main/ai-providers.js
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const {
  describirError, sanearMensaje, errorDeRespuesta, ProviderError,
  probeDeError, probeDeExito, probeDeRespuestaInvalida, probeNoIntentada
} = require('./provider-errors');
const {
  getProviderContract,
  resolveVisionSupport,
  describeVisionBlock,
  assertVisionSupported,
  normalizeChatResult,
  attachOpenAIImages,
  buildAnthropicImageBlocks
} = require('./provider-capabilities');
const {
  sanitizeForCloud, formatBytes, detectCapabilities, createAbortContext, probeOllamaVision,
  isProviderNetworkError, delay, normalizeProviderNetworkError
} = require('./provider-runtime');
const { adaptadorLocal } = require('./providers/local');
const { adaptadorOpenai } = require('./providers/openai');
const { adaptadorAnthropic } = require('./providers/anthropic');
const { adaptadorGroq } = require('./providers/groq');
const { adaptadorMoonshot } = require('./providers/moonshot');
const { crearAdaptadorAlibaba } = require('./providers/alibaba');
const { adaptadorLlamacpp } = require('./providers/llamacpp');
const { adaptadorBitnet } = require('./providers/bitnet');
const { getEncryptionKey, encrypt, decryptRecord, canPersistCredentials } = require('./provider-credentials');
const {
  fetchWithProviderRetry,
  getAlibabaHttpError,
  ALIBABA_PROVIDER_ID,
  ALIBABA_CONFIG_KEY,
  ALIBABA_TOKEN_PLAN_ENDPOINT,
  ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT,
  ALIBABA_DEFAULT_MODEL_ID,
  ALIBABA_TOKEN_PLAN_MODELS,
  ALIBABA_TASK_TYPES,
  ALIBABA_DEFAULT_MAX_TOKENS,
  ALIBABA_LEGACY_MAX_TOKENS,
  ALIBABA_TEXT_TASK_TYPES,
  migrateAlibabaOfficialMaxTokens,
  createAlibabaPresetModel,
  ALIBABA_DEFAULT_CONFIG,
  normalizeAlibabaModel,
  normalizeAlibabaModels,
  normalizeAlibabaConfig,
  buildAnthropicMessagesPayload,
  formatAlibabaHttpError,
  normalizeAlibabaInputImage,
  extractAlibabaUsage,
  normalizeAlibabaAssistantOutput
} = require('./providers/alibaba-config');
const { PROVIDER_API_VERSION, ProviderRegistry } = require('./provider-registry');
const { ESTADO_MOTOR, GestorDeMotores, validarRutaDeMotor } = require('./local-engines');
const { descubrirModelos, comprobarRequisitos } = require('./engine-discovery');
const { GestorDeDescargas } = require('./model-download');





// Solo se conserva como heurística de sugerencia para catálogos sin sonda.
// Prohibido usarla para autorizar el envío de imágenes.
function detectVisionByName(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  const patterns = [
    'vision', 'vl', 'ocr', 'img', 'clip',
    'llava', 'bakllava', 'moondream', 'cogvlm', 'pixtral',
    'minicpm-v', 'gemma3', 'gemma-3',
    'gpt-4o', 'gpt-4-vision', 'gpt-4-turbo',
    'claude-3', 'claude-3.5', 'claude-4',
    'gemini-1.5', 'gemini-2', 'gemini',
    'kimi', 'glm',
  ];
  return patterns.some(p => n.includes(p));
}







// Únicos modos de plan visual autorizados a producir una imagen como respuesta terminal.
const GENERATIVE_VISUAL_MODES = ['image-generation', 'image-edit', 'image-variation'];
// Señales ya existentes de detectUserIntentDetailed, clasificadas para detectar
// cuándo una misma solicitud pide análisis y generación a la vez.
const ANALYSIS_INTENT_SIGNALS = [
  'analysis-verb',
  'visual-explanation-request',
  'descriptive-visual-question'
];
const GENERATIVE_INTENT_SIGNALS = [
  'from-scratch-generation',
  'reference-variation',
  'apply-suggestions-and-generate',
  'generate-new-visual-from-reference',
  'edit-operation',
  'approximate-edit-verb',
  'background-target',
  'color-target'
];
// Margen a partir del cual una instrucción generativa se considera dominante de
// forma segura pese a que también haya señales de análisis.
const UNAMBIGUOUS_GENERATION_MARGIN = 10;




function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}







function normalizeIntentText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(?:cambibia|canbia|cambiale)\b/g, 'cambia')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractVisualSuggestions(analysisText) {
  const text = String(analysisText || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { suggestions: [], source: 'none' };
  const cleanSuggestion = value => String(value || '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  const structured = text
    .split('\n')
    .filter(line => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line))
    .map(cleanSuggestion)
    .filter(Boolean)
    .slice(0, 6);
  if (structured.length) return { suggestions: structured, source: 'structured' };
  const heuristic = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => /\b(sugier|recom|mejor|conviene|podri|deberi|ajust|cambi)\w*/i.test(sentence))
    .map(cleanSuggestion)
    .filter(Boolean)
    .slice(0, 6);
  return heuristic.length
    ? { suggestions: heuristic, source: 'heuristic' }
    : { suggestions: [], source: 'none' };
}

function hasApproximateVisualEditVerb(normalizedText) {
  const targets = ['cambia', 'modifica', 'edita', 'quita', 'agrega', 'reemplaza', 'sustituye'];
  const distance = (left, right) => {
    const row = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= right.length; j++) {
        const saved = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
        previous = saved;
      }
    }
    return row[right.length];
  };
  // La tolerancia existe para erratas («modfica», «cmabia»), no para palabras
  // corrientes. Con distancia 2 sobre verbos de cinco letras, «esta» contaba
  // como «edita» y «queda» como «quita»: cualquier frase normal en un chat con
  // una imagen se leía como orden de edición. Los verbos cortos admiten una
  // sola errata, y una palabra de menos de cinco letras nunca es una errata.
  return normalizedText.split(' ').some(token =>
    token.length >= 5 && targets.some(target => {
      const tolerancia = target.length <= 5 ? 1 : 2;
      return Math.abs(token.length - target.length) <= tolerancia && distance(token, target) <= tolerancia;
    })
  );
}

// Verbos que abren una creación. `rediseña` queda FUERA a propósito: implica
// que ya existe algo que rediseñar.
const CREATE_FROM_SCRATCH_VERB = '(?:crea|crear|creame|genera|generar|generame|dibuja|dibujar|dibujame|ilustra|ilustrame|pinta|pintame|hazme|haz|disena|disename)';
const CREATE_FROM_SCRATCH_LEAD = '(?:por favor\\s+|porfa\\s+|quiero que\\s+|quiero\\s+|puedes\\s+|podrias\\s+|me\\s+)*';
const CREATE_FROM_SCRATCH_RE = new RegExp(`^${CREATE_FROM_SCRATCH_LEAD}${CREATE_FROM_SCRATCH_VERB}\\b`);

// Marcadores que delatan una referencia a algo ya existente. Si aparece
// cualquiera, la orden NO es autosuficiente y se resuelve por el camino normal.
// Son deliberadamente específicos: un demostrativo suelto ("que esta en la
// oficina") no puede bloquear una creación legítima.
const ANAPHORIC_MARKERS = [
  /\b(?:est[ae]|es[ae])\s+(?:imagen|foto|fotografia|tarjeta|logo|diseno|captura|escena|version|composicion|ilustracion)\b/,
  /\banterior(?:es)?\b/,
  // "otra/nueva VERSIÓN" sí es anáfora; "otra/nueva IMAGEN" no lo es por sí
  // sola: "crea una nueva imagen de una playa" es una creación legítima.
  /\b(?:otra|otro|nueva|nuevo)\s+(?:version|opcion|variante)\b/,
  /\bmism[ao]\b/,
  /\b(?:mejor|peor)\b/,
  /\bbasad[oa]\s+en\b/,
  /\bcon\s+(?:esos|estos|los)\s+cambios\b/,
  /\b(?:conserva|conservando|preserva|preservando|manten|manteniendo)\b/,
  /\b(?:usa|con|sobre|desde|para)\s+la\s+(?:imagen|foto|tarjeta|captura)\b/,
  /\b(?:ponlo|ponla|quitalo|quitala|cambiala|cambialo|hazlo|hazla|dejalo|dejala|vuelvelo|vuelvela|modificala|modificalo|editala|editalo)\b/,
  /\bredisen/
];

// El adjunto del turno se usa SOLO si el texto lo menciona.
const ATTACHMENT_REQUIRED_RE = /\b(?:usa|usando|utiliza|toma|parte|basate|basandote|con|sobre|desde|para)\s+(?:est[ae]|es[ae]|la|el)\s+(?:imagen|foto|fotografia|tarjeta|captura|logo|adjunto|archivo)\b|\bcomo\s+referencia\b|\b(?:la|el)\s+(?:imagen|foto|archivo)\s+adjunt[ao]\b|\b(?:est[ae]|es[ae])\s+(?:imagen|foto|fotografia|tarjeta|captura|logo)\b/;

// Y se prohíbe explícitamente si el texto lo excluye.
const ATTACHMENT_FORBIDDEN_RE = /\bdesde cero\b|\b(?:sin|no)\s+(?:usar|uses|utilizar|utilices|tomar|tomes)\s+(?:la|el|est[ae])?\s*(?:imagen|foto|tarjeta|adjunto|referencia)\b|\bignora\s+(?:la|el|est[ae])\s+(?:imagen|foto|adjunto)\b/;

/**
 * ¿Es el texto una orden autosuficiente de crear un concepto o escena nueva?
 *
 * Motivo: en un chat con historial visual, "crea una imagen de una chica en la
 * oficina…" activaba a la vez `referencesPrevious` (por el artículo "la") y
 * `hasImplicitVisualSignal` (por "imagen", "rojo", "azul"), y el resolutor
 * entregaba la última imagen generada como fuente. El mismo texto en un chat
 * nuevo funcionaba, porque no había candidatos.
 */
function detectCreateFromScratch(normalizedText) {
  const text = String(normalizedText || '');
  if (!CREATE_FROM_SCRATCH_RE.test(text)) return false;
  return !ANAPHORIC_MARKERS.some(marker => marker.test(text));
}

function resolveVisualContext({
  text = '',
  attachments = [],
  chatId = null,
  lastUserImage = null,
  lastUploadedImage = null,
  lastGeneratedImage = null,
  lastAnalyzedImage = null
} = {}) {
  const normalizedText = normalizeIntentText(text);
  const currentImage = Array.isArray(attachments)
    ? attachments.find(item => item?.type === 'image' || String(item?.mediaType || '').startsWith('image/'))
    : null;
  // Hueco preexistente: la familia cambiala/modificala/editala/retocala no
  // estaba, así que "cámbiala" a secas no resolvía ninguna imagen previa
  // — el pronombre enclítico es exactamente la referencia anafórica.
  const referencesPrevious = /\b(anterior|esa|esta|la|del|de la|de esta|de esa|ponlo|ponla|quitalo|quitala|hazlo|hazla|dejalo|dejala|vuelvelo|vuelvela|cambiala|cambialo|modificala|modificalo|editala|editalo|retocala|retocalo|arreglala|arreglalo|basad[oa] en|mismo plano|misma linea visual|otra opcion|nueva version|version nueva|otra version|nueva imagen con esos cambios)\b/.test(normalizedText);
  const hasImplicitVisualSignal = /\b(fondo|color|imagen|foto|captura|pantalla|screenshot|codigo|logo|producto|empaque|texto|objeto|contenido|vasija|tarjeta|diseno|composicion|azul|rojo|verde|dorado|blanco|negro|oscuro|claro|moderno|grande|pequeno|alineado|de frente)\b/.test(normalizedText)
    || /\bmas\s+(oscuro|claro|moderno|grande|pequeno|legible)\b/.test(normalizedText);
  const belongsToChat = imageRef => imageRef && (!chatId || imageRef.chatId === chatId);
  const createFromScratch = detectCreateFromScratch(normalizedText);
  if (currentImage) {
    if (!chatId || !currentImage.chatId || currentImage.chatId === chatId) {
      // Política explícita para el adjunto del turno. Antes se devolvía siempre,
      // así que "crea una imagen de X" con un adjunto no mencionado lo
      // convertía en edición sin decirlo.
      if (ATTACHMENT_FORBIDDEN_RE.test(normalizedText)) {
        return {
          hasVisualContext: false, source: null, imageRef: null, confidence: 0,
          createFromScratch: true, policy: 'forbidden-current-attachment'
        };
      }
      if (ATTACHMENT_REQUIRED_RE.test(normalizedText)) {
        return {
          hasVisualContext: true, source: 'current-attachment', imageRef: currentImage,
          confidence: 1, createFromScratch: false, policy: 'required-current-attachment'
        };
      }
      // Orden autosuficiente + adjunto NO mencionado: se crea desde cero. El
      // adjunto sigue visible y persistido, simplemente no viaja al generador.
      if (createFromScratch) {
        return {
          hasVisualContext: false, source: null, imageRef: null, confidence: 0,
          createFromScratch: true, policy: 'forbidden-unmentioned-attachment'
        };
      }
      return {
        hasVisualContext: true, source: 'current-attachment', imageRef: currentImage,
        confidence: 1, createFromScratch: false
      };
    }
  }
  // POLÍTICA FORBIDDEN: una orden autosuficiente de creación no puede heredar
  // ninguna imagen del historial. La memoria visual sigue almacenada en el chat
  // —"ahora ponlo verde" la seguirá encontrando— pero no viaja al generador.
  if (createFromScratch) {
    return {
      hasVisualContext: false,
      source: null,
      imageRef: null,
      confidence: 0,
      createFromScratch: true,
      policy: 'forbidden-historical-reference'
    };
  }
  if (referencesPrevious || hasImplicitVisualSignal) {
    const candidates = [
      { source: 'previous-user-image', imageRef: lastUserImage, confidence: 0.95, priority: 4 },
      { source: 'previous-user-image', imageRef: lastUploadedImage, confidence: 0.95, priority: 3 },
      { source: 'previous-generated-image', imageRef: lastGeneratedImage, confidence: 0.9, priority: 2 },
      { source: 'previous-analyzed-image', imageRef: lastAnalyzedImage, confidence: 0.9, priority: 1 }
    ].filter(candidate => belongsToChat(candidate.imageRef));
    candidates.sort((a, b) =>
      (Number(b.imageRef.updatedAt) - Number(a.imageRef.updatedAt)) || (b.priority - a.priority)
    );
    if (candidates[0]) {
      const { source, imageRef, confidence } = candidates[0];
      return { hasVisualContext: true, source, imageRef, confidence, createFromScratch: false };
    }
  }
  return {
    hasVisualContext: false, source: null, imageRef: null, confidence: 0,
    createFromScratch: false
  };
}

function detectUserIntentDetailed(input = {}) {
  const normalizedText = normalizeIntentText(input.text);
  const visualContext = resolveVisualContext(input);
  const matchedSignals = [];
  const editSubtypes = [];
  const variationSignals = [];
  const scores = {
    'normal-chat': 1,
    'vision-analysis': 0,
    'image-edit': 0,
    'image-variation': 0,
    'image-generation': 0,
    'video-generation': 0,
    'ambiguous-visual': 0
  };
  const add = (intent, score, signal) => {
    scores[intent] += score;
    matchedSignals.push(signal);
  };

  if (/\b(crea|crear|genera|generar|haz|hacer|produce|producir)\b[\s\S]{0,40}\bvideo\b/.test(normalizedText)) {
    add('video-generation', 10, 'video-request');
  }
  if (/\b(analiza|analizar|describe|describir|explica|explicar|lee|leer|mira|mirar|ve|ves|ver|observa|observar|identifica|identificar)\b/.test(normalizedText)) {
    add('vision-analysis', visualContext.hasVisualContext ? 9 : 3, 'analysis-verb');
  }
  const visualExplanationPattern = /\b(explicame|explica|analiza|interpreta|revisa|lee|describe|ayudame a entender|que hace|que significa|que ves)\b[\s\S]{0,60}\b(codigo|imagen|captura|pantalla|screenshot|foto)\b/;
  if (visualContext.hasVisualContext && visualExplanationPattern.test(normalizedText)) {
    add('vision-analysis', 12, 'visual-explanation-request');
  }
  if (/\bque\s+(color\s+tiene|logo\s+aparece|aparece|hay|ves)\b/.test(normalizedText)) {
    add('vision-analysis', visualContext.hasVisualContext ? 9 : 3, 'descriptive-visual-question');
  }
  const applySuggestionsPattern = /\b(aplica|usa|haz|toma)\b[\s\S]{0,45}\b(cambios|mejoras|recomendaciones)\b[\s\S]{0,25}\b(sugerid[oa]s?|anteriores|que sugeriste)\b|\baplica las recomendaciones\b|\bcon esos cambios\b/;
  const createNewVisualPattern = /\b(crea|crear|genera|generar)\b[\s\S]{0,30}\b(nueva imagen|imagen nueva|nueva version|version nueva)\b/;
  const requestsFromScratch = /\bdesde cero\b/.test(normalizedText);
  const appliesPreviousSuggestions = applySuggestionsPattern.test(normalizedText);
  const createsReferencedVariation = createNewVisualPattern.test(normalizedText);
  const variationPattern = /\b(nueva version|otra version|otra opcion|misma linea visual|basad[oa] en (esta|esa|la)|version mas|nueva imagen con esos cambios)\b/;
  if (variationPattern.test(normalizedText)) {
    add('image-variation', visualContext.hasVisualContext ? 11 : 6, 'reference-variation');
    variationSignals.push('reference-based-version');
  }
  if (appliesPreviousSuggestions) {
    variationSignals.push('apply-previous-suggestions');
  }
  if (appliesPreviousSuggestions && createsReferencedVariation && !requestsFromScratch) {
    add('image-variation', visualContext.hasVisualContext ? 20 : 14, 'apply-suggestions-and-generate');
  } else if (visualContext.hasVisualContext && createsReferencedVariation && !requestsFromScratch) {
    add('image-variation', 12, 'generate-new-visual-from-reference');
    variationSignals.push('reference-based-version');
  }
  // «modernízalo», «cámbiala», «editarlos»: el pronombre pegado al verbo no
  // cambia lo que se pide, y sin contemplarlo la petición pasaba por análisis.
  const editVerb = /\b(edita|editar|cambia|cambiar|cambio|modifica|modificar|quita|quitar|remueve|remover|elimina|eliminar|agrega|agregar|anade|anadir|sustituye|sustituir|reemplaza|reemplazar|pon|poner|coloca|colocar|hazle|hazlo|dejalo|vuelvelo|mueve|mover|agranda|agrandar|reduce|reducir|alinea|alinear|redisena|redisenar|moderniza|modernizar|renueva|renovar|actualiza|actualizar)(?:lo|la|los|las)?\b|hacer(?:la|lo)?\s+mas/;
  if (editVerb.test(normalizedText) && visualContext.hasVisualContext) add('image-edit', 9, 'edit-operation');
  else if (visualContext.hasVisualContext && hasApproximateVisualEditVerb(normalizedText)) add('image-edit', 7, 'approximate-edit-verb');
  if (/\bfondo\b/.test(normalizedText)) {
    editSubtypes.push('background-change');
    if (visualContext.hasVisualContext) add('image-edit', 4, 'background-target');
  }
  if (/\bcolor\b|\b(azul|rojo|verde|dorado|blanco|negro|gris)\b/.test(normalizedText)) {
    editSubtypes.push('color-change');
    if (visualContext.hasVisualContext) add('image-edit', 3, 'color-target');
  }
  if (/\b(quita|remueve|elimina)\b.*\bfondo\b/.test(normalizedText)) editSubtypes.push('background-removal');
  if (/\b(agrega|anade|pon)\b/.test(normalizedText)) editSubtypes.push('element-addition');
  if (/\b(reemplaza|sustituye)\b/.test(normalizedText)) editSubtypes.push('element-replacement');
  if (/\b(moderno|hazlo|dejalo|vuelvelo|redisena|redisenar|moderniza|modernizar|renueva|renovar|actualiza|actualizar)(?:lo|la|los|las)?\b/.test(normalizedText)) editSubtypes.push('style-change');
  if (/\b(agranda|reduce|mas grande|mas pequeno)\b/.test(normalizedText)) editSubtypes.push('resize');
  if (/\b(mueve|alinea|mismo plano|en linea|de frente)\b/.test(normalizedText)) editSubtypes.push('layout-adjustment');

  // Tres formas de pedir una imagen nueva. Antes solo se reconocía la primera,
  // así que "dibuja un gato" o "crea una fotografía de…" caían en normal-chat.
  const createsImage =
    // 1. verbo de creación + sustantivo visual cercano
    /\b(crea|crear|creame|genera|generar|generame|dibuja|dibujar|produce|producir|disena|disenar)\b[\s\S]{0,50}\b(imagen|image|ilustracion|dibujo|fotografia|foto|escena|render|retrato|poster|cartel|logo|wallpaper|pintura)\b/.test(normalizedText)
    // 2. verbo intrínsecamente gráfico: "dibuja un gato" no necesita sustantivo
    || /\b(dibuja|dibujame|dibujar|ilustra|ilustrame|ilustrar|pinta|pintame|pintar)\b/.test(normalizedText)
    // 3. "desde cero" con verbo de creación
    || /\b(crea|crear|genera|generar|haz|hazme)\b[\s\S]{0,30}\bdesde cero\b/.test(normalizedText);
  if (createsImage && !visualContext.hasVisualContext) add('image-generation', 10, 'from-scratch-generation');
  if (visualContext.hasVisualContext) add('ambiguous-visual', 2, 'visual-context-present');

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let [intent, score] = ranked[0];
  const secondScore = ranked[1][1];
  if (appliesPreviousSuggestions && createsReferencedVariation && !requestsFromScratch) {
    intent = 'image-variation';
    score = scores['image-variation'];
  }
  if (visualContext.hasVisualContext && score <= 2) intent = 'ambiguous-visual';
  if (intent === 'normal-chat' && visualContext.hasVisualContext) intent = 'ambiguous-visual';
  const usesPreviousImageContext = Boolean(visualContext.hasVisualContext && visualContext.source !== 'current-attachment');
  const analysisSignals = matchedSignals.filter(signal => ANALYSIS_INTENT_SIGNALS.includes(signal));
  // createsImage cuenta como señal generativa aunque no haya puntuado por existir
  // contexto visual: la intención textual de generar sigue presente.
  const generationSignals = [...new Set([
    ...matchedSignals.filter(signal => GENERATIVE_INTENT_SIGNALS.includes(signal)),
    ...(createsImage ? ['from-scratch-generation'] : [])
  ])];
  const analysisScore = scores['vision-analysis'];
  const generationScore = Math.max(
    scores['image-generation'],
    scores['image-edit'],
    scores['image-variation']
  );
  const dominantGeneration = generationScore - analysisScore >= UNAMBIGUOUS_GENERATION_MARGIN;
  // Mejor intent generativo puntuado, aunque el análisis haya ganado el ranking: es la
  // petición que quedaría sin atender cuando ambas señales coexisten.
  const generationCandidate = GENERATIVE_VISUAL_MODES
    .map(candidate => [candidate, scores[candidate]])
    .sort((a, b) => b[1] - a[1])
    .filter(([, candidateScore]) => candidateScore > 0)
    .map(([candidate]) => candidate)[0] || null;
  const analysisAndGeneration = analysisSignals.length > 0
    && generationSignals.length > 0
    && !dominantGeneration;
  return {
    intent,
    confidence: Math.max(0.35, Math.min(1, (score - secondScore + 5) / 10)),
    score,
    normalizedText,
    matchedSignals: [...new Set(matchedSignals)],
    requiresVisualContext: ['vision-analysis', 'image-edit', 'image-variation'].includes(intent),
    usesPreviousImageContext,
    editSubtypes: [...new Set(editSubtypes)],
    variationSignals,
    analysisSignals,
    generationSignals,
    generationCandidate,
    intentConflicts: { analysisAndGeneration },
    reason: `Señales dominantes para ${intent}: ${matchedSignals.join(', ') || 'ninguna'}`,
    visualContext
  };
}

function detectUserIntent(input = {}) {
  return detectUserIntentDetailed(input).intent;
}

function buildImageEditPlan({ text = '', detailed, visualContext } = {}) {
  const normalized = detailed?.normalizedText || normalizeIntentText(text);
  const objective = String(text || '').trim();
  const operations = [...new Set(detailed?.editSubtypes || [])];
  const preserve = [];
  const qualityGoals = [];
  const constraints = [];

  if (/\b(lea|leer|legible|legibilidad|contenido)\b/.test(normalized)) preserve.push('content-readability');
  if (/\b(no sea|sin|evita|evitar)\s+(el\s+)?gris\b/.test(normalized)) constraints.push('avoid-gray');
  if (/\bmoderno\b/.test(normalized)) qualityGoals.push('modern-appearance');
  if (preserve.includes('content-readability')) qualityGoals.push('clear-readable-content');

  return {
    mode: 'image-edit',
    objective,
    sourceImage: visualContext?.imageRef || null,
    operations,
    preserve,
    qualityGoals,
    constraints,
    needsClarification:
      !visualContext?.hasVisualContext
      || !visualContext?.imageRef
      || operations.length === 0
      || !objective,
    reason: detailed?.reason || 'Edición visual detectada',
    visualContext
  };
}

function buildImageVariationPlan({ text = '', detailed, visualContext, lastVisualAnalysis = null } = {}) {
  const normalized = detailed?.normalizedText || normalizeIntentText(text);
  const preserve = ['primary-visual-identity'];
  const allowChanges = ['composition-variation'];
  const styleGoals = [];
  const analysisBelongsToSource = lastVisualAnalysis
    && (!visualContext?.imageRef?.chatId || lastVisualAnalysis.chatId === visualContext.imageRef.chatId);
  const extraction = analysisBelongsToSource
    ? extractVisualSuggestions(lastVisualAnalysis.analysisText)
    : { suggestions: [], source: 'none' };
  const appliedSuggestions = extraction.suggestions
    .map(item => String(item || '').replace(/\s+/g, ' ').trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, 6);
  if (/\bmisma linea visual\b/.test(normalized)) preserve.push('visual-language');
  if (/\bcontenido\b/.test(normalized)) preserve.push('core-content');
  if (/\bmoderno\b/.test(normalized)) styleGoals.push('modern-style');
  if (/\botra opcion|nueva version\b/.test(normalized)) allowChanges.push('layout');
  return {
    mode: 'image-variation',
    objective: text,
    sourceImage: visualContext?.imageRef || null,
    preserve: [...new Set(preserve)],
    allowChanges: [...new Set(allowChanges)],
    styleGoals,
    referenceStrength: appliedSuggestions.length ? 'high' : 'medium',
    constraints: [],
    appliedSuggestions,
    suggestionSource: extraction.source,
    needsClarification: !visualContext?.hasVisualContext,
    reason: detailed?.reason || 'Variación visual detectada',
    visualContext
  };
}

function buildVisionAnalysisPlan({ text = '', visualContext } = {}) {
  // Sin restricciones: analizar una imagen no lleva ninguna. Aquí había una
  // etiqueta interna («describe-only-do-not-edit») que acababa dentro del
  // mensaje enviado al modelo, y el modelo la repetía al usuario como si fuera
  // una prohibición suya.
  return { mode: 'vision-analysis', objective: text, constraints: [], needsClarification: !visualContext?.hasVisualContext, visualContext };
}

function buildImageGenerationPlan({ text = '', visualContext = null } = {}) {
  const createFromScratch = visualContext?.createFromScratch === true;
  return {
    mode: 'image-generation',
    objective: text,
    qualityGoals: ['coherent-composition'],
    constraints: [],
    // Explícito: ninguna imagen del historial entra en una creación desde cero.
    createFromScratch,
    sourceImage: null,
    needsClarification: !String(text).trim()
  };
}

// Constructor único de planes por intent: lo usan tanto el intent efectivo como la
// alternativa generativa conservada cuando el guard de routing mixto degrada la ruta.
function buildPlanForIntent({ intent, text, detailed, visualContext, lastVisualAnalysis } = {}) {
  if (intent === 'image-edit') return buildImageEditPlan({ text, detailed, visualContext });
  if (intent === 'image-variation') {
    return buildImageVariationPlan({ text, detailed, visualContext, lastVisualAnalysis });
  }
  if (intent === 'vision-analysis') return buildVisionAnalysisPlan({ text, detailed, visualContext });
  if (intent === 'image-generation') return buildImageGenerationPlan({ text, detailed, visualContext });
  return null;
}

function validateVisualTaskPlan(plan, capabilities = {}) {
  const errors = [];
  if (['image-edit', 'image-variation', 'vision-analysis'].includes(plan?.mode) && !plan?.visualContext?.hasVisualContext) errors.push('visual-context-required');
  const capabilityKey = {
    'image-edit': 'imageEdit',
    'image-variation': 'imageVariation',
    'vision-analysis': 'vision',
    'image-generation': 'imageGeneration'
  }[plan?.mode];
  if (capabilityKey && capabilities[capabilityKey] !== true) errors.push(`${capabilityKey}-unavailable`);
  if (plan?.needsClarification) errors.push('clarification-required');
  const contradictions = (plan?.preserve || []).filter(item => (plan?.allowChanges || []).includes(item));
  if (contradictions.length) errors.push('contradictory-instructions');
  return { valid: errors.length === 0, errors, shouldOfferFallback: errors.length > 0 };
}

function buildModelPromptFromPlan(plan) {
  if (plan?.mode === 'image-variation' && plan.appliedSuggestions?.length) {
    return [
      'Genera una nueva imagen usando la imagen previa como referencia.',
      `Solicitud actual: ${String(plan.objective || '').trim()}`,
      `Aplica las mejoras sugeridas previamente: ${plan.appliedSuggestions.join(' | ')}.`,
      'Preserva la identidad visual principal.',
      'Mejora fondo, composición, legibilidad y dinamismo según las sugerencias disponibles.',
      'No devuelvas instrucciones ni texto explicativo; genera únicamente la imagen.'
    ].join('\n');
  }
  // Para analizar una imagen el modelo recibe lo que escribió el usuario, tal
  // cual. El plan es un dato interno del routing: convertirlo en texto y
  // mandarlo en lugar del mensaje sustituía las palabras del usuario por jerga
  // de MIKA5.
  if (plan?.mode === 'vision-analysis') return String(plan.objective || '');
  const lines = [`Tarea visual: ${plan.mode}.`];
  if (plan.objective) lines.push(`Objetivo: ${plan.objective}`);
  if (plan.operations?.length) lines.push(`Operaciones: ${plan.operations.join(', ')}.`);
  if (plan.preserve?.length) lines.push(`Preservar: ${plan.preserve.join(', ')}.`);
  if (plan.allowChanges?.length) lines.push(`Cambios permitidos: ${plan.allowChanges.join(', ')}.`);
  if (plan.styleGoals?.length) lines.push(`Estilo: ${plan.styleGoals.join(', ')}.`);
  if (plan.qualityGoals?.length) lines.push(`Calidad: ${plan.qualityGoals.join(', ')}.`);
  if (plan.constraints?.length) lines.push(`Restricciones: ${plan.constraints.join(', ')}.`);
  return lines.join('\n');
}

function buildImageGenerationPromptFromVisualPlan(plan = {}) {
  const lines = [
    'Genera una imagen nueva basada en este plan visual.',
    'No copies artefactos ni introduzcas texto ilegible.'
  ];

  if (plan.objective) {
    lines.push(`Solicitud exacta del usuario: ${String(plan.objective).trim()}`);
  }

  if (plan.mode === 'image-edit') {
    lines.push('Edita la imagen de referencia proporcionada; no generes un sujeto diferente.');
    lines.push('Modifica únicamente los elementos solicitados y preserva el sujeto principal, identidad, forma, proporciones y contenido.');
  }

  if (plan.operations?.length) lines.push(`Aplica estos cambios: ${plan.operations.join(', ')}.`);
  if (plan.preserve?.length) lines.push(`Mantén: ${plan.preserve.join(', ')}.`);
  else lines.push('Mantén los elementos principales y el contenido esencial de la referencia.');
  if (plan.qualityGoals?.length) lines.push(`Objetivos de calidad: ${plan.qualityGoals.join(', ')}.`);
  if (plan.styleGoals?.length) lines.push(`Objetivos de estilo: ${plan.styleGoals.join(', ')}.`);
  if (plan.constraints?.length) lines.push(`Restricciones obligatorias: ${plan.constraints.join(', ')}.`);
  if (plan.allowChanges?.length) lines.push(`Puedes variar: ${plan.allowChanges.join(', ')}.`);
  if (plan.appliedSuggestions?.length) lines.push(`Aplica las mejoras sugeridas previamente: ${plan.appliedSuggestions.join(' | ')}.`);
  if (plan.mode === 'image-variation') {
    lines.push('Usa la imagen previa como referencia y preserva la identidad visual principal.');
    lines.push('Mejora fondo, composición, legibilidad y dinamismo según las sugerencias disponibles.');
    lines.push('No devuelvas instrucciones ni texto explicativo; genera únicamente la imagen.');
  }
  lines.push('No alteres elementos principales salvo cuando una operación lo solicite explícitamente.');
  return lines.join('\n');
}



async function executeGenerateImageToolUse({ toolUse, visualExecution, generateImage }) {
  if (toolUse?.name !== 'generate_image') {
    throw new Error('La herramienta visual solicitada no está soportada');
  }
  const plan = visualExecution?.plan;
  const validation = visualExecution?.validation;
  if (!plan || validation?.valid !== true || typeof generateImage !== 'function') {
    throw new Error('No se pudo generar la imagen: no existe un plan visual seguro');
  }
  // Barrera terminal: vision-analysis y normal-chat nunca pueden generar imagen.
  const allowedModes = new Set(GENERATIVE_VISUAL_MODES);
  if (!allowedModes.has(plan?.mode)) {
    throw new Error(
      'No se pudo ejecutar la generación de imagen: la tarea actual no es generativa'
    );
  }
  const prompt = String(visualExecution.generationPrompt || '').trim();
  if (!prompt) throw new Error('No se pudo generar la imagen: el plan visual no contiene una instrucción segura');
  const model = String(visualExecution.model || '').trim();
  if (!model) throw new Error('No se pudo generar la imagen: falta un modelo de imagen configurado');
  const sourceImage =
    plan.sourceImage
    || visualExecution?.visualContext?.imageRef
    || plan.visualContext?.imageRef
    || null;
  if (['image-edit', 'image-variation'].includes(plan.mode) && !sourceImage) {
    throw new Error('No se pudo generar la imagen: falta la imagen de referencia');
  }
  const generated = await generateImage({
    model,
    prompt,
    sourceImages: sourceImage ? [sourceImage] : []
  });
  if (!Array.isArray(generated?.images) || generated.images.length === 0) {
    throw new Error('No se pudo generar la imagen: el generador no devolvió imágenes');
  }
  return { ok: true, type: 'image', images: generated.images };
}

function routeIntent(intent, { currentProvider = '', currentModel = '' } = {}) {
  const capabilities = getProviderVisualCapabilities(currentProvider);
  const defaultImageModel = getDefaultImageModelForProvider(currentProvider);
  const defaultVisionModel = getDefaultVisionModelForProvider(currentProvider);
  if (intent === 'normal-chat') {
    return {
      intent,
      action: 'chat',
      model: currentModel || (currentProvider === ALIBABA_PROVIDER_ID ? ALIBABA_DEFAULT_MODEL_ID : null)
    };
  }
  if (intent === 'vision-analysis') {
    return {
      intent,
      action: 'chat',
      model: defaultVisionModel || currentModel || null
    };
  }
  if (intent === 'image-generation') {
    if (capabilities.imageGeneration) {
      return { intent, action: 'generate-image', model: defaultImageModel || currentModel || null };
    }
    return {
      intent,
      action: 'unsupported',
      model: null,
      message: 'El proveedor actual no soporta generación de imágenes. Cambia a un proveedor con modelos de imagen.'
    };
  }
  if (intent === 'image-edit' || intent === 'image-variation') {
    const supported = intent === 'image-edit' ? capabilities.imageEdit : capabilities.imageVariation;
    if (supported) {
      return { intent, action: 'generate-image', model: defaultImageModel || currentModel || null };
    }
    return {
      intent,
      action: 'unsupported',
      model: null,
      message: 'El proveedor actual no soporta edición o variación de imágenes. Cambia a un proveedor con modelos de imagen.'
    };
  }
  if (intent === 'ambiguous-visual' || intent === 'image-ambiguous') {
    return {
      intent,
      action: 'unsupported',
      message: '¿Quieres analizar la imagen, editarla o generar una nueva versión?'
    };
  }
  if (intent === 'video-generation') {
    return {
      intent,
      action: 'unsupported',
      message: 'La generación de video está disponible próximamente en MIKA5.'
    };
  }
  return { intent, action: 'chat', model: currentModel || null };
}

const { ollamaApi } = require('./ollama');


/**
 * Códigos que impiden usar el proveedor aunque haya catálogo. Un 403, un 429 o
 * un 500 pueden llegar junto al respaldo declarado del adaptador: sin esta
 * comprobación, ese respaldo dejaría el proveedor como utilizable pese a que
 * el servicio acaba de decir que no.
 */
const ERRORES_QUE_IMPIDEN_USO = new Set([
  'PROVIDER_AUTH_REJECTED',
  'PROVIDER_FORBIDDEN',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TRANSPORT_UNREACHABLE',
  'PROVIDER_UNKNOWN_ERROR',
  // Un proveedor que contesta con algo que no se entiende no es utilizable,
  // por mucho que el 2xx demuestre que está vivo.
  'PROVIDER_RESPONSE_INVALID'
]);

/**
 * Cualquier error HTTP del proveedor cuenta, no sólo los enumerados: la
 * familia `PROVIDER_HTTP_*` es abierta por definición —un 502, un 503— y
 * dejarla fuera permitía que un 500 con catálogo de respaldo pasara por
 * utilizable. Lo detectó la prueba de groq degradando con un 500 encima.
 */
function impideUso(errorCode) {
  if (!errorCode) return false;
  return ERRORES_QUE_IMPIDEN_USO.has(errorCode) || errorCode.startsWith('PROVIDER_HTTP_');
}

/**
 * Log del proceso principal. El detalle saneado se queda aquí: al renderer
 * sólo cruzan `errorCode` y `httpStatus`, nunca el texto de un error.
 */
// `codigoDeclarado` gana cuando el adaptador ya clasificó el fallo: es quien
// tuvo delante el error estructurado. Volver a deducirlo aquí, sobre lo que
// haya sobrevivido, escribía PROVIDER_UNKNOWN_ERROR en el registro mientras el
// estado calculado decía otra cosa — dos versiones del mismo fallo.
function registrarFalloDeProveedor(providerId, operacion, error, codigoDeclarado = null) {
  const d = describirError(error);
  const detalle = d.logMessage ? ` — ${d.logMessage}` : '';
  console.warn(`[provider:${providerId}] ${operacion}: ${codigoDeclarado || d.errorCode}${detalle}`);
}

/**
 * Cómo debe presentarse un proveedor.
 *
 * Ocho estados y no dos porque «alcanzable» y «utilizable» son cosas
 * distintas, y agruparlas obligaba a mentir. Un 404, un 429 y un 500 prueban
 * que hay alguien al otro lado y ninguno de los tres significa que el
 * proveedor funcione: pintarlos en verde como «Conectado» afirmaba algo falso.
 * Un 401 y un 403 tampoco son lo mismo: el primero dice que la credencial no
 * vale, el segundo que el servidor la reconoce y no autoriza la operación.
 *
 * `UNKNOWN` existe para no afirmar sin prueba: es lo que queda cuando nadie ha
 * hablado con el servidor todavía.
 */
const UI_STATE = Object.freeze({
  CONNECTED: 'connected',
  OFFLINE: 'offline',
  UNKNOWN: 'unknown',
  CONFIGURATION_REQUIRED: 'configuration-required',
  AUTHENTICATION_REJECTED: 'authentication-rejected',
  AUTHORIZATION_FORBIDDEN: 'authorization-forbidden',
  RATE_LIMITED: 'rate-limited',
  PROVIDER_ERROR: 'provider-error'
});

/**
 * Qué estado corresponde a cada código de fallo. Sólo los códigos listados
 * tienen estado propio; el resto cae al genérico de la evidencia.
 */
const ESTADO_POR_ERROR = Object.freeze({
  PROVIDER_AUTH_REJECTED: UI_STATE.AUTHENTICATION_REJECTED,
  PROVIDER_FORBIDDEN: UI_STATE.AUTHORIZATION_FORBIDDEN,
  PROVIDER_RATE_LIMITED: UI_STATE.RATE_LIMITED,
  PROVIDER_TRANSPORT_UNREACHABLE: UI_STATE.OFFLINE,
  PROVIDER_TIMEOUT: UI_STATE.UNKNOWN,
  PROVIDER_ABORTED: UI_STATE.UNKNOWN,
  PROVIDER_RESPONSE_INVALID: UI_STATE.PROVIDER_ERROR
});

/**
 * Prioridad: lo que el usuario debe resolver primero manda. Primero lo que
 * depende de él —configurar, corregir la clave—, después lo que depende del
 * proveedor, y sólo al final la conectividad genérica.
 */
function resolverUiState({ configured, reachable, authenticated, errorCode } = {}) {
  if (!configured) return UI_STATE.CONFIGURATION_REQUIRED;
  if (authenticated === false) return UI_STATE.AUTHENTICATION_REJECTED;

  if (errorCode) {
    const propio = ESTADO_POR_ERROR[errorCode];
    if (propio) return propio;
    // Un error del proveedor con el servidor vivo: 404, 500, respuesta
    // ilegible. Alcanzable, pero el servicio no está sirviendo.
    if (errorCode.startsWith('PROVIDER_HTTP_') || errorCode === 'PROVIDER_UNKNOWN_ERROR') {
      return UI_STATE.PROVIDER_ERROR;
    }
  }

  if (reachable === false) return UI_STATE.OFFLINE;
  if (reachable === true) return UI_STATE.CONNECTED;
  return UI_STATE.UNKNOWN;
}
/**
 * Preparación de un proveedor: la pregunta «¿puedo conversar ya, y si no, qué
 * hago?». Es una vista sobre la disponibilidad, no un segundo modelo: los ocho
 * estados de `UI_STATE` siguen diciendo QUÉ pasó, y esto dice en qué punto del
 * camino está el usuario, igual para un motor local que para una API remota.
 */
const READINESS = Object.freeze({
  AVAILABLE: 'available',
  NEEDS_SETUP: 'needs-setup',
  STARTING: 'starting',
  LOADING_MODEL: 'loading-model',
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error'
});

/** Acción correctiva que la interfaz puede ofrecer. Conjunto cerrado. */
const READINESS_ACTION = Object.freeze({
  CONFIGURE_KEY: 'configure-key',
  CONFIGURE_PROVIDER: 'configure-provider',
  CONFIGURE_ENGINE: 'configure-engine',
  APPROVE_ENGINE: 'approve-engine',
  INSTALL_ENGINE: 'install-engine',
  START_ENGINE: 'start-engine',
  START_SERVICE: 'start-service',
  DOWNLOAD_MODEL: 'download-model',
  RETRY: 'retry'
});

/**
 * Lo que MIKA5 puede afirmar de un modelo frente a un motor. `unverified` no
 * es un «probablemente sí»: es que nadie lo ha comprobado.
 */
const COMPATIBILITY = Object.freeze({
  COMPATIBLE: 'compatible',
  INCOMPATIBLE: 'incompatible',
  UNVERIFIED: 'unverified'
});

/**
 * En qué punto está un motor local. Es lo que se le enseña al usuario en vez
 * de «sin conexión», que para un motor que MIKA5 gestiona no dice nada: un
 * motor parado a la espera de un modelo y un motor roto no son lo mismo.
 */
const ENGINE_STATUS = Object.freeze({
  NOT_INSTALLED: 'not-installed',
  NEEDS_APPROVAL: 'needs-approval',
  NEEDS_MODEL: 'needs-model',
  STOPPED: 'stopped',
  STARTING: 'starting',
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error'
});

/** Versión del criterio con que se guardan los veredictos de compatibilidad. */
const VERDICTS_VERSION = 2;

/** Repositorio de Hugging Face: `usuario/modelo`, con cuantización opcional. */
const HF_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}(?::[A-Za-z0-9._-]{1,40})?$/;

/** Lo que impide arrancar un motor, traducido a estado y acción. */
function readinessDeMotor(codigo, tipo) {
  const R = READINESS;
  const A = READINESS_ACTION;
  switch (codigo) {
    case null:
    case undefined:
      return { readiness: R.UNAVAILABLE, action: A.START_ENGINE };
    case 'ENGINE_NOT_INSTALLED':
      // Un motor gestionable se resuelve eligiendo su ejecutable; un servicio
      // externo hay que instalarlo, y MIKA5 no descarga nada por su cuenta.
      return { readiness: R.NEEDS_SETUP, action: tipo === 'managed' ? A.CONFIGURE_ENGINE : A.INSTALL_ENGINE };
    case 'ENGINE_APPROVAL_REQUIRED':
      return { readiness: R.NEEDS_SETUP, action: A.APPROVE_ENGINE };
    case 'ENGINE_MODEL_REQUIRED':
    case 'ENGINE_MODEL_MISSING':
    case 'ENGINE_MODEL_INVALID':
      return { readiness: R.NEEDS_SETUP, action: A.CONFIGURE_ENGINE };
    case 'ENGINE_SERVICE_MANAGED':
    case 'ENGINE_EXTERNALLY_CONFIGURED':
    case 'ENGINE_AUTOSTART_DISABLED':
      return { readiness: R.UNAVAILABLE, action: A.START_SERVICE };
    default:
      // Puerto ocupado, proceso que salió, plazo agotado: el intento falló.
      return { readiness: R.ERROR, action: A.START_ENGINE };
  }
}

/**
 * `motor` es null para un proveedor sin motor local. Si lo tiene:
 *   tipo         'managed' | 'external-service'
 *   state        estado del proceso que MIKA5 pudo haber arrancado
 *   errorCode    por qué falló el último arranque
 *   diagnostico  qué impide arrancarlo ahora (null: nada)
 */
function resolverReadiness(disp, motor = null) {
  const R = READINESS;
  const A = READINESS_ACTION;
  const r = (readiness, action = null) => ({ readiness, action });

  if (motor && motor.state === ESTADO_MOTOR.STARTING && disp.reachable !== true) return r(R.STARTING);
  // `llama-server` contesta 503 mientras carga el modelo: el servidor está,
  // el modelo todavía no. No es un error, es una espera.
  if (motor && disp.reachable === true && disp.httpStatus === 503) return r(R.LOADING_MODEL);
  if (disp.ready) return r(R.READY);
  if (disp.canAttempt) return r(R.AVAILABLE);

  switch (disp.uiState) {
    case UI_STATE.CONFIGURATION_REQUIRED:
      if (disp.errorCode === 'PROVIDER_UNKNOWN') return r(R.ERROR);
      return r(R.NEEDS_SETUP, disp.errorCode === 'PROVIDER_CREDENTIAL_REQUIRED' ? A.CONFIGURE_KEY : A.CONFIGURE_PROVIDER);
    case UI_STATE.AUTHENTICATION_REJECTED:
    case UI_STATE.AUTHORIZATION_FORBIDDEN:
      return r(R.NEEDS_SETUP, A.CONFIGURE_KEY);
    case UI_STATE.RATE_LIMITED:
      return r(R.UNAVAILABLE, A.RETRY);
    case UI_STATE.OFFLINE:
      if (!motor) return r(R.UNAVAILABLE, A.RETRY);
      return readinessDeMotor(
        motor.state === ESTADO_MOTOR.FAILED ? motor.errorCode : motor.diagnostico,
        motor.tipo
      );
    case UI_STATE.PROVIDER_ERROR:
      return r(R.ERROR, A.RETRY);
    case UI_STATE.CONNECTED:
      // Contestó y no hay catálogo. En Ollama eso es «no has descargado
      // ningún modelo», que el usuario sí puede resolver.
      if (motor && motor.tipo === 'external-service') return r(R.NEEDS_SETUP, A.DOWNLOAD_MODEL);
      return r(R.UNAVAILABLE, A.RETRY);
    default:
      return r(R.UNAVAILABLE, A.RETRY);
  }
}

// Registro canónico de proveedores. Cada adaptador vive en su propio módulo;
// aquí sólo se componen, conservando el orden observable.
const PROVIDERS = {
  local: adaptadorLocal,
  openai: adaptadorOpenai,
  anthropic: adaptadorAnthropic,
  groq: adaptadorGroq,
  moonshot: adaptadorMoonshot,
  alibaba: crearAdaptadorAlibaba({
    ALIBABA_DEFAULT_MODEL_ID,
    ALIBABA_PROVIDER_ID,
    ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT,
    buildAnthropicMessagesPayload,
    fetchWithProviderRetry,
    getAlibabaHttpError,
    normalizeAlibabaAssistantOutput,
    normalizeAlibabaConfig,
    normalizeAlibabaInputImage
  }),
  llamacpp: adaptadorLlamacpp,
  bitnet: adaptadorBitnet
};

// Registro interno versionado, construido a partir del conjunto anterior.
// Los ocho se registran explícitamente y desde código de confianza: no hay
// carga desde disco, ni descubrimiento de plugins, ni require dinámico.
// La validación es fail-closed y ocurre aquí, al arrancar el módulo, no en el
// primer uso: un adaptador mal formado se rechaza cuando aún se sabe quién lo
// registró.
const registroDeProveedores = new ProviderRegistry();
for (const [id, adapter] of Object.entries(PROVIDERS)) {
  registroDeProveedores.register({
    apiVersion: PROVIDER_API_VERSION,
    id,
    displayName: adapter.name,
    traits: {
      requiresKey: adapter.requiresKey === true,
      privacy: adapter.privacy,
      visualCapabilities: adapter.visualCapabilities
    },
    adapter
  });
}

function getProviderVisualCapabilities(providerId) {
  const provider = registroDeProveedores.getAdapter(providerId);
  const declared = provider?.visualCapabilities || {};
  const imageGeneration = typeof provider?.generateImage === 'function';
  const sourceImages = imageGeneration
    && (declared.sourceImages === true || providerId === ALIBABA_PROVIDER_ID);
  return {
    vision: declared.vision === true,
    imageGeneration,
    imageEdit: sourceImages,
    imageVariation: sourceImages,
    sourceImages,
    defaultVisionModel: declared.defaultVisionModel || null,
    defaultImageModel: declared.defaultImageModel || null
  };
}

function providerSupportsImageGeneration(providerId) {
  return getProviderVisualCapabilities(providerId).imageGeneration;
}

function providerSupportsImageEdit(providerId) {
  return getProviderVisualCapabilities(providerId).imageEdit;
}

function providerSupportsImageVariation(providerId) {
  return getProviderVisualCapabilities(providerId).imageVariation;
}

function getDefaultImageModelForProvider(providerId) {
  return getProviderVisualCapabilities(providerId).defaultImageModel;
}

function getDefaultVisionModelForProvider(providerId) {
  return getProviderVisualCapabilities(providerId).defaultVisionModel;
}

function providerSupportsVisionRouting(providerId) {
  return getProviderVisualCapabilities(providerId).vision;
}

class AIProviderManager {
  constructor(db, opciones = {}) {
    this.db = db;
    // Inyectable para que las pruebas no arranquen procesos reales.
    this.motores = opciones.motores || new GestorDeMotores();
    this.descargas = opciones.descargas || new GestorDeDescargas();
    // Carpeta de los modelos que MIKA5 descarga. Sin ella no se ofrece descarga.
    this.modelsDir = opciones.modelsDir || null;
    // Carpeta donde MIKA5 instala motores ya compilados, uno por proveedor.
    this.enginesDir = opciones.enginesDir || null;
    this._preparaciones = new Map();
    if (this.enginesDir) {
      const rutas = this.motores._platform === 'win32' ? path.win32 : path.posix;
      for (const id of registroDeProveedores.ids()) {
        const spec = registroDeProveedores.getAdapter(id).engine;
        if (spec && spec.tipo === 'managed') this.motores.carpetasDeMotor[id] = rutas.join(this.enginesDir, id);
      }
    }
    this._fallosRegistrados = new Map();
    this._pruebas = new Map();
    this.engineConfigs = {};
    this.currentProvider = 'local';
    this.apiKeys = {};
    this.providerConfigs = {
      [ALIBABA_PROVIDER_ID]: cloneJson(ALIBABA_DEFAULT_CONFIG)
    };
    // Future redaction is opt-in, visible and auditable. Normal cloud requests
    // preserve the exact accepted content and never apply silent rewriting.
    this.sanitizeCloud = false;
    
    // Initialize encryption key with app userData path
    try {
      const { app } = require('electron');
      getEncryptionKey(app.getPath('userData'));
    } catch (_) {
      getEncryptionKey(null);
    }
    
    this.init();
  }

  init() {
    // Cargar configuración guardada
    const stmt = this.db.prepare('SELECT key, value FROM app_state WHERE key IN (?, ?, ?, ?, ?, ?, ?)');
    const rows = stmt.all('ai_provider', 'openai_key', 'anthropic_key', 'groq_key', 'moonshot_key', 'alibaba_key', ALIBABA_CONFIG_KEY);
    
    let hasAlibabaConfig = false;
    let alibabaConfigNeedsPersist = false;
    rows.forEach(row => {
      // Un identificador que ya no existe en el registro (proveedor retirado o
      // valor corrupto) no puede quedar activo: `getProvider()` leería
      // `undefined.privacy` y la rehidratación fallaría entera. Se ignora y se
      // conserva el local por defecto.
      if (row.key === 'ai_provider' && registroDeProveedores.has(row.value)) this.currentProvider = row.value;
      if (['openai_key', 'anthropic_key', 'groq_key', 'moonshot_key', 'alibaba_key'].includes(row.key)) {
        const record = decryptRecord(row.value);
        const value = record?.value;
        this.apiKeys[row.key.slice(0, -4)] = value;
        // Migrate only successfully decrypted records. Never overwrite an
        // unreadable credential when the OS key store is temporarily locked.
        if (value && record.needsMigration) {
          this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)')
            .run(row.key, canPersistCredentials() ? encrypt(value) : '');
        }
      }
      if (row.key === ALIBABA_CONFIG_KEY) {
        hasAlibabaConfig = true;
        try {
          const storedConfig = JSON.parse(row.value);
          this.providerConfigs.alibaba = normalizeAlibabaConfig(storedConfig);
          alibabaConfigNeedsPersist = JSON.stringify(storedConfig) !== JSON.stringify(this.providerConfigs.alibaba);
        } catch (error) {
          console.warn('Configuración de Alibaba ignorada:', error.message);
          alibabaConfigNeedsPersist = true;
        }
      }
    });
    if (!hasAlibabaConfig || alibabaConfigNeedsPersist) {
      this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)')
        .run(ALIBABA_CONFIG_KEY, JSON.stringify(this.providerConfigs.alibaba));
    }
  }
  
  setProvider(providerId) {
    const descriptor = registroDeProveedores.get(providerId);
    if (!descriptor) throw new Error('Proveedor no válido');
    this.currentProvider = providerId;

    const stmt = this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)');
    stmt.run('ai_provider', providerId);

    return {
      provider: providerId,
      privacy: descriptor.traits.privacy,
      libraryUrl: descriptor.adapter.libraryUrl || null
    };
  }

  getProvider() {
    // Los metadatos salen del descriptor registrado, no del adaptador: son
    // datos declarados y validados al registrar, así que un adaptador no puede
    // presentarse aquí con una privacidad que el registro nunca aceptó.
    const descriptor = registroDeProveedores.get(this.currentProvider);
    const privacy = descriptor.traits.privacy;
    return {
      id: this.currentProvider,
      name: descriptor.displayName,
      privacy,
      requiresKey: descriptor.traits.requiresKey,
      libraryUrl: descriptor.adapter.libraryUrl || null,
      privacyLabel: privacy === 'private' ? 'Privado' : 'Cloud',
      credentialStorage: canPersistCredentials() ? 'protected' : 'session',
      credentialSessionOnly: Object.values(this.apiKeys).some(Boolean) && !canPersistCredentials(),
      capabilities: this.getCapabilities(this.currentProvider)
    };
  }

  setApiKey(provider, key) {
    const descriptor = registroDeProveedores.get(provider);
    if (!descriptor) throw new Error('Proveedor no válido');
    if (!descriptor.traits.requiresKey) return false;
    this.apiKeys[provider] = key;
    
    const stmt = this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)');
    stmt.run(`${provider}_key`, canPersistCredentials() ? encrypt(key) : '');
    const warnings = [];
    if (key && !canPersistCredentials()) warnings.push('El almacén seguro del sistema no está disponible. La clave funciona sólo durante esta sesión.');
    if (provider === ALIBABA_PROVIDER_ID
      && this.providerConfigs.alibaba.billingMode === 'token-plan'
      && !String(key).startsWith('sk-sp-')) {
      warnings.push('Para Token Plan normalmente la clave debe empezar con sk-sp-');
    }
    if (warnings.length) return { ok: true, persisted: canPersistCredentials(), warning: warnings.join(' ') };
    return true;
  }

  getProviderConfig(providerId) {
    if (providerId !== ALIBABA_PROVIDER_ID) throw new Error('Proveedor sin configuración editable');
    return cloneJson(this.providerConfigs[providerId]);
  }

  saveProviderConfig(providerId, config) {
    if (providerId !== ALIBABA_PROVIDER_ID) throw new Error('Proveedor sin configuración editable');
    const normalized = normalizeAlibabaConfig(config, this.providerConfigs[providerId]);
    this.providerConfigs[providerId] = normalized;
    this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)')
      .run(ALIBABA_CONFIG_KEY, JSON.stringify(normalized));
    return cloneJson(normalized);
  }

  addProviderModel(providerId, model) {
    const config = this.getProviderConfig(providerId);
    const normalized = normalizeAlibabaModel(model);
    if (config.models.some(item => item.id === normalized.id)) throw new Error('El modelo ya existe');
    config.models.push(normalized);
    return this.saveProviderConfig(providerId, config);
  }

  updateProviderModel(providerId, existingId, model) {
    const config = this.getProviderConfig(providerId);
    const index = config.models.findIndex(item => item.id === existingId);
    if (index < 0) throw new Error('Modelo no encontrado');
    config.models[index] = normalizeAlibabaModel(model);
    return this.saveProviderConfig(providerId, config);
  }

  deleteProviderModel(providerId, modelId) {
    const config = this.getProviderConfig(providerId);
    const nextModels = config.models.filter(item => item.id !== modelId);
    if (nextModels.length === config.models.length) throw new Error('Modelo no encontrado');
    config.models = nextModels;
    return this.saveProviderConfig(providerId, config);
  }

  async chat(params) {
    const providerId = params.providerId || this.currentProvider;
    const provider = registroDeProveedores.getAdapter(providerId);
    if (!provider) throw new Error('Proveedor no válido');
    if (providerId === ALIBABA_PROVIDER_ID) {
      const selectedModelId = params.model || ALIBABA_DEFAULT_MODEL_ID;
      const selectedModel = this.providerConfigs.alibaba.models.find(model => model.id === selectedModelId);
      if (selectedModel?.taskType === 'image-generation') {
        throw new Error('Este modelo genera imágenes. Usa generateImage.');
      }
      if (selectedModel?.taskType === 'video-generation') {
        throw new Error('Este modelo genera video y no puede usarse en chat.');
      }
    }
    
    const paramsWithKey = {
      ...params,
      apiKey: this.apiKeys[providerId],
      providerConfig: this.providerConfigs[providerId],
      sanitize: this.sanitizeCloud
    };
    
    await this._prepararMotorParaChat(providerId, params.model, params.signal);
    const result = await provider.chat(paramsWithKey);
    if (providerId === ALIBABA_PROVIDER_ID && result?.blockedToolUse) {
      // Sin un plan generativo activo, una herramienta visual jamás se ejecuta:
      // una petición de chat o de análisis nunca puede terminar en imagen.
      const mode = params.visualExecution?.plan?.mode;
      if (!GENERATIVE_VISUAL_MODES.includes(mode)) {
        const assistantText = String(result?.message?.content || '').trim();
        if (assistantText) {
          return {
            ...result,
            message: { role: 'assistant', content: assistantText },
            blockedToolUse: null
          };
        }
        throw new Error('El modelo intentó ejecutar una herramienta visual fuera de la tarea solicitada.');
      }
      const terminal = await executeGenerateImageToolUse({
        toolUse: result.blockedToolUse,
        visualExecution: params.visualExecution,
        generateImage: generationParams => this.generateImage({ ...generationParams, providerId, signal: params.signal })
      });
      return {
        message: {
          role: 'assistant',
          content: terminal.images.map(image => `![Imagen generada](${image})`).join('\n\n')
        },
        provider: ALIBABA_PROVIDER_ID,
        model: params.visualExecution?.model || result.model || null,
        usage: result.usage ?? null,
        finishReason: 'stop',
        images: terminal.images,
        terminalType: 'image'
      };
    }
    return result;
  }

  // Contrato de capacidades. Es la única fuente que la interfaz debe consultar
  // para decidir qué ofrecer; nunca el nombre del modelo.
  getCapabilities(providerId = this.currentProvider) {
    const contract = getProviderContract(providerId);
    const visual = getProviderVisualCapabilities(providerId);
    // Un motor con la ventana pequeña declara cuánto texto admite. La interfaz
    // lo usa para elegir menos fragmentos y menos historial; null = sin límite propio.
    const ventana = this._engineSpec(providerId)?.contexto || null;
    return {
      provider: providerId,
      ...contract,
      contextBudget: ventana
        ? { knowledgeChars: ventana.knowledgeChars, historyChars: ventana.historyChars }
        : null,
      defaultVisionModel: visual.defaultVisionModel,
      defaultImageModel: visual.defaultImageModel
    };
  }

  // Resolución de visión para un modelo concreto, con motivo legible.
  // ÚNICA fuente de verdad: el renderer no replica allowlists ni políticas, la
  // consulta por IPC y muestra el `message` que sale de aquí. Es la misma
  // resolución que usa la barrera de los adapters, así que UI y red no pueden
  // divergir.
  async resolveVision({ provider = this.currentProvider, model, modelMeta = null } = {}) {
    let meta = modelMeta;
    if (!meta && provider === ALIBABA_PROVIDER_ID) {
      const configured = this.providerConfigs.alibaba?.models?.find(item => item.id === model);
      if (configured) meta = { capabilities: configured.capabilities };
    }
    if (!meta && provider === 'local' && model) {
      // Misma sonda que ejecuta el adapter antes de enviar: la UI no puede
      // autorizar algo que la barrera vaya a rechazar después.
      meta = { supportsVision: await probeOllamaVision(model) };
    }
    const resolution = resolveVisionSupport({ providerId: provider, modelId: model, modelMeta: meta });
    return {
      provider,
      model: model || null,
      ...resolution,
      message: resolution.supported
        ? null
        : describeVisionBlock({ providerId: provider, modelId: model, reason: resolution.reason })
    };
  }

  async generateImage(params) {
    const providerId = params.providerId || this.currentProvider;
    const provider = registroDeProveedores.getAdapter(providerId);
    if (!provider) throw new Error('Proveedor no válido');
    if (typeof provider.generateImage !== 'function') {
      throw new Error('El proveedor actual no soporta generación de imágenes');
    }
    return provider.generateImage({
      ...params,
      apiKey: this.apiKeys[providerId],
      providerConfig: this.providerConfigs[providerId]
    });
  }

  routeIntent(params) {
    const providerId = params?.providerId || this.currentProvider;
    const detailed = detectUserIntentDetailed({
      ...params,
      currentProvider: providerId
    });
    const visualContext = detailed.visualContext;
    // Guard de routing mixto: si la solicitud pide análisis y generación a la vez
    // sin que una instrucción generativa domine con claridad, no se abre la ruta
    // directa de generación. Se degrada a análisis o chat, y el plan resultante
    // deja de ser generativo, así que las barreras posteriores también aplican.
    let effectiveIntent = detailed.intent;
    if (detailed.intentConflicts?.analysisAndGeneration
      && GENERATIVE_VISUAL_MODES.includes(effectiveIntent)) {
      effectiveIntent = visualContext.hasVisualContext ? 'vision-analysis' : 'normal-chat';
    }
    // Un proveedor que no genera imágenes no puede editar ni variar ninguna, así
    // que en él «editar», «variar» o «ambiguo» sólo admiten una lectura: chat.
    // Antes se bloqueaba el mensaje con «el proveedor no soporta edición», y
    // como la detección se dispara con cualquier imagen en el chat más una
    // palabra corriente («esta», «la», «queda»), una conversación normal dejaba
    // de enviarse en TODOS los proveedores salvo el que sí edita. La imagen
    // adjunta en el turno sigue viajando por el camino de chat, donde la barrera
    // de visión decide si el modelo la acepta. Pedir una imagen nueva desde
    // cero («dibuja un gato») conserva su aviso: ahí la intención es inequívoca.
    // «Analiza el documento» no es analizar una imagen. El verbo dispara la
    // intención visual, pero sin ninguna imagen —ni adjunta ni en el contexto
    // del chat— no hay nada visual que analizar: es una conversación normal,
    // y el usuario puede estar hablando de un documento que acaba de adjuntar.
    if (effectiveIntent === 'vision-analysis' && !visualContext.hasVisualContext) {
      effectiveIntent = 'normal-chat';
    }
    const capabilities = getProviderVisualCapabilities(providerId);
    if (!capabilities.imageGeneration
      && ['image-edit', 'image-variation', 'ambiguous-visual', 'image-ambiguous'].includes(effectiveIntent)) {
      effectiveIntent = 'normal-chat';
    }
    // El plan corresponde siempre al intent efectivo, nunca al detectado.
    const buildPlan = intent => buildPlanForIntent({
      intent,
      text: params?.text,
      detailed,
      visualContext,
      lastVisualAnalysis: params?.lastVisualAnalysis
    });
    const plan = buildPlan(effectiveIntent);
    const routed = routeIntent(effectiveIntent, {
      currentProvider: providerId,
      currentModel: params?.currentModel
    });
    const appliesPreviousSuggestions = detailed.variationSignals.includes('apply-previous-suggestions');
    if (plan?.mode === 'image-variation' && appliesPreviousSuggestions && plan.appliedSuggestions.length === 0) {
      if (visualContext.hasVisualContext) {
        routed.intent = 'ambiguous-visual';
        routed.action = 'unsupported';
        routed.model = null;
        routed.message = 'No encontré sugerencias visuales aplicables en el análisis anterior. Indica cambios concretos para generar la nueva imagen.';
      } else {
        routed.action = 'error';
        routed.model = null;
        routed.message = 'No se pudo generar la nueva imagen: falta una imagen de referencia.';
      }
    }
    // Cuando análisis y generación coexisten, la petición generativa no se descarta:
    // se conserva como alternativa que solo puede ejecutarse con confirmación explícita
    // del usuario. Aplica tanto si el guard degradó la ruta como si el análisis ya
    // ganaba el ranking por sí solo, que es el caso más común. Se exige contexto visual,
    // así que la alternativa siempre opera sobre una imagen real: una petición
    // generativa que solo aparece en el texto pegado no se ofrece nunca.
    let conflictAlternative = null;
    const alternativeIntent = GENERATIVE_VISUAL_MODES.includes(detailed.intent)
      ? detailed.intent
      : detailed.generationCandidate;
    if (detailed.intentConflicts?.analysisAndGeneration
      && visualContext.hasVisualContext
      && alternativeIntent
      && alternativeIntent !== effectiveIntent) {
      const alternativePlan = buildPlan(alternativeIntent);
      const alternativeValidation = alternativePlan
        ? validateVisualTaskPlan(alternativePlan, capabilities)
        : null;
      const alternativeRoute = routeIntent(alternativeIntent, {
        currentProvider: providerId,
        currentModel: params?.currentModel
      });
      if (alternativePlan
        && GENERATIVE_VISUAL_MODES.includes(alternativePlan.mode)
        && alternativeValidation?.valid === true
        && alternativeRoute.action === 'generate-image'
        && alternativeRoute.model) {
        const alternativeGenerationPrompt = buildImageGenerationPromptFromVisualPlan(alternativePlan);
        conflictAlternative = {
          intent: alternativeIntent,
          action: 'generate-image',
          model: alternativeRoute.model,
          plan: alternativePlan,
          validation: alternativeValidation,
          generationPrompt: alternativeGenerationPrompt,
          visualExecution: {
            plan: alternativePlan,
            visualContext,
            validation: alternativeValidation,
            model: alternativeRoute.model,
            generationPrompt: alternativeGenerationPrompt
          }
        };
      }
    }
    const options = null;
    if (options && !/\n1\./.test(routed.message || '')) {
      routed.message += '\nPuedo:\n1. Analizar la imagen actual\n2. Generar una nueva imagen basada en tu instrucción';
    }
    // El usuario pidió cambiar o crear una imagen y este proveedor sólo sabe
    // mirarlas. Se le dice con claridad, en vez de dejar que el modelo prometa
    // —o niegue con una excusa inventada— algo que no depende de él.
    const pidioGenerar = GENERATIVE_VISUAL_MODES.includes(detailed.intent)
      || GENERATIVE_VISUAL_MODES.includes(detailed.generationCandidate);
    return {
      ...routed,
      imageEditUnavailable: Boolean(pidioGenerar && !capabilities.imageGeneration),
      capabilities,
      detailed,
      visualContext,
      conflictAlternative,
      plan,
      validation: plan ? validateVisualTaskPlan(plan, capabilities) : null,
      modelPrompt: plan ? buildModelPromptFromPlan(plan) : params?.text,
      generationPrompt: plan && ['image-edit', 'image-variation'].includes(plan.mode)
        ? buildImageGenerationPromptFromVisualPlan(plan)
        : null,
      options,
      visualExecution: plan ? {
        plan,
        visualContext,
        validation: validateVisualTaskPlan(plan, capabilities),
        model: routed.model,
        generationPrompt: ['image-edit', 'image-variation'].includes(plan.mode)
          ? buildImageGenerationPromptFromVisualPlan(plan)
          : null
      } : null
    };
  }
  
  async listModels() {
    const provider = registroDeProveedores.getAdapter(this.currentProvider);
    if (this.currentProvider === 'local') {
      return provider.listModels();
    }
    return provider.listModels(this.apiKeys[this.currentProvider], this.providerConfigs[this.currentProvider]);
  }
  
  async status() {
    if (this.currentProvider === 'local') {
      return PROVIDERS.local.status();
    }
    if (this.currentProvider === 'llamacpp' || this.currentProvider === 'bitnet') {
      return registroDeProveedores.getAdapter(this.currentProvider).status();
    }
    return {
      ok: !!this.apiKeys[this.currentProvider],
      message: this.apiKeys[this.currentProvider] ? 'API Key configurada' : 'API Key requerida'
    };
  }

  /**
   * Disponibilidad de un proveedor, en estados que antes viajaban colapsados.
   *
   *   configured       su configuración es utilizable
   *   reachable        su endpoint contestó (null = nadie lo ha comprobado)
   *   authenticated    la credencial fue aceptada (null = sin evidencia)
   *   modelsAvailable  cuántos modelos ofrece
   *   canAttempt       está configurado para intentarlo: hay con qué probar,
   *                    pero NADIE ha verificado que funcione
   *   ready            verificado utilizable: hay evidencia de que el servidor
   *                    contestó, la credencial no fue rechazada y hay catálogo
   *   uiState          cómo presentarlo, de un conjunto cerrado de ocho
   *   errorCode        contrato estable; el renderer traduce a partir de él
   *   httpStatus       único metadato numérico que cruza al renderer
   *
   * `canAttempt` y `ready` son distintos a propósito. Un catálogo declarado en
   * el propio adaptador y una clave meramente presente permiten INTENTARLO,
   * pero no prueban nada: el proveedor puede estar caído y la clave caducada,
   * y sólo el primer envío lo dirá. Llamar «listo» a eso era afirmar una
   * verificación que nunca ocurrió.
   *
   * La evidencia NO se deduce del tamaño del catálogo ni del tipo de
   * adaptador. Viene de dos fuentes explícitas y de ninguna más: la sonda
   * `status()` del adaptador, y el objeto `probe` que `listModels()` devuelve.
   * Un 200 con catálogo vacío da `reachable: true`, `authenticated: true` y
   * `modelsAvailable: 0`: el servidor respondió y aceptó la clave, y aun así
   * no hay nada que usar.
   */
  async getAvailability(providerId = this.currentProvider) {
    // Un identificador que el registro no conoce no es un proveedor: aquí es
    // donde se decide, y por eso `config` puede seguir siendo nulo sin romper.
    const config = registroDeProveedores.getAdapter(providerId);
    if (!config) {
      return {
        providerId, configured: false, reachable: null, authenticated: null,
        modelsAvailable: 0, models: [], canAttempt: false, ready: false,
        uiState: UI_STATE.CONFIGURATION_REQUIRED,
        errorCode: 'PROVIDER_UNKNOWN', httpStatus: null
      };
    }

    // `configured` puede venir del propio adaptador, que sabe si su
    // configuración es utilizable. Sin `validateConfig()` se cae al criterio
    // mínimo: la credencial que el adaptador declare necesitar.
    let configured;
    let errorCode = null;
    let httpStatus = null;
    if (typeof config.validateConfig === 'function') {
      let veredicto;
      try {
        veredicto = await config.validateConfig(
          this.providerConfigs[providerId],
          this.apiKeys[providerId]
        );
      } catch (error) {
        registrarFalloDeProveedor(providerId, 'validateConfig', error);
        veredicto = { ok: false, errorCode: 'PROVIDER_CONFIG_INVALID' };
      }
      configured = Boolean(veredicto && veredicto.ok);
      if (!configured) errorCode = (veredicto && veredicto.errorCode) || 'PROVIDER_CONFIG_REQUIRED';
    } else {
      configured = !config.requiresKey || Boolean(this.apiKeys[providerId]);
      if (!configured) errorCode = 'PROVIDER_CREDENTIAL_REQUIRED';
    }

    let reachable = null;
    let authenticated = null;

    /** Incorpora una sonda. Una evidencia concreta sustituye a la ausencia. */
    const incorporar = (probe) => {
      if (!probe || probe.attempted !== true) return;
      if (probe.reachable === true || probe.reachable === false) reachable = probe.reachable;
      if (probe.authenticated === true || probe.authenticated === false) authenticated = probe.authenticated;
      if (Number.isInteger(probe.httpStatus)) httpStatus = probe.httpStatus;
      if (probe.errorCode && !errorCode) errorCode = probe.errorCode;
    };

    if (typeof config.status === 'function') {
      let sonda;
      try {
        sonda = await config.status();
      } catch (error) {
        sonda = { ok: false, error };
      }
      if (sonda && sonda.ok) {
        // La sonda puede declarar su propia evidencia; si no, se asume lo
        // mínimo que prueba un `ok`: contestó, y no dijo nada de credencial.
        incorporar((sonda && sonda.probe) || probeDeExito({ authenticated: null }));
      } else {
        const fallo = (sonda && (sonda.error || sonda.message)) || null;
        // El adaptador puede haber clasificado ya el fallo con los campos
        // estructurados que tenía delante. Reclasificar aquí a partir de lo que
        // quede sería tirar esa evidencia: un mensaje de texto no distingue un
        // ECONNREFUSED de un 503.
        const probe = (sonda && sonda.probe) || probeDeError(fallo);
        this._registrarFalloUnaVez(providerId, 'status', fallo, probe.errorCode);
        // Una sonda que falla sin código reconocible sigue significando que no
        // se pudo hablar con el servidor: para eso está la sonda.
        if (probe.reachable === null) probe.reachable = false;
        if (!probe.errorCode || probe.errorCode === 'PROVIDER_UNKNOWN_ERROR') {
          probe.errorCode = 'PROVIDER_TRANSPORT_UNREACHABLE';
        }
        incorporar(probe);
      }
    }

    const cerrar = (extra = {}) => {
      const base = {
        providerId, configured, reachable, authenticated,
        modelsAvailable: 0, models: [], errorCode, httpStatus, ...extra
      };
      const sinRechazo = base.configured
        && base.authenticated !== false
        && base.modelsAvailable > 0
        && !impideUso(base.errorCode);
      base.canAttempt = Boolean(sinRechazo && base.reachable !== false);
      base.ready = Boolean(sinRechazo && base.reachable === true);
      base.uiState = resolverUiState(base);
      return base;
    };

    // Sin configuración utilizable no se consulta nada: una petición condenada
    // al rechazo no aporta información y sí gasta red.
    if (!configured) return cerrar();
    if (reachable === false) return cerrar();

    let models = [];
    try {
      const respuesta = await config.listModels(
        this.apiKeys[providerId],
        this.providerConfigs[providerId]
      );
      models = Array.isArray(respuesta) ? respuesta : ((respuesta && respuesta.models) || []);
      // Única vía de evidencia del catálogo: la sonda que el adaptador declara.
      incorporar(respuesta && respuesta.probe);
    } catch (error) {
      registrarFalloDeProveedor(providerId, 'listModels', error);
      const probe = probeDeError(error);
      incorporar(probe);
      return cerrar({ errorCode: probe.errorCode || errorCode });
    }

    if (models.length === 0 && !errorCode) errorCode = 'PROVIDER_CATALOG_EMPTY';

    return cerrar({ modelsAvailable: models.length, models, errorCode });
  }
  // --- Motores locales -----------------------------------------------------

  /** Declaración de motor del adaptador, o null si el proveedor no tiene. */
  _engineSpec(providerId) {
    const adapter = registroDeProveedores.getAdapter(providerId);
    return (adapter && adapter.engine) || null;
  }

  /**
   * Ejecutable y modelo que el usuario eligió para un motor gestionable. Vive
   * en `app_state`, junto al resto de preferencias, y se lee una sola vez.
   */
  getEngineConfig(providerId) {
    const spec = this._engineSpec(providerId);
    if (!spec) return {};
    if (!this.engineConfigs[providerId]) {
      let guardado = {};
      try {
        const fila = this.db.prepare('SELECT key, value FROM app_state WHERE key IN (?)')
          .all(`engine_${providerId}`)[0];
        const leido = fila ? JSON.parse(fila.value) : null;
        if (leido && typeof leido === 'object' && !Array.isArray(leido)) {
          if (typeof leido.executable === 'string') guardado.executable = leido.executable;
          if (typeof leido.model === 'string') guardado.model = leido.model;
          if (typeof leido.modelId === 'string') guardado.modelId = leido.modelId;
          if (leido.launch && typeof leido.launch === 'object' && !Array.isArray(leido.launch)) {
            guardado.launch = {};
            for (const [ruta, variante] of Object.entries(leido.launch)) {
              if (Number.isInteger(variante) && variante >= 0 && variante < 8) guardado.launch[ruta] = variante;
            }
          }
          if (leido.verified && typeof leido.verified === 'object' && !Array.isArray(leido.verified)) {
            // Los «incompatible» guardados con el criterio anterior no valen:
            // entonces cualquier cierre del motor marcaba el modelo, y el
            // cierre habitual era quedarse sin memoria gráfica, no un modelo
            // que no sirve. Se descartan; los «compatible» sí son evidencia.
            const vigentes = leido.verdicts === VERDICTS_VERSION;
            guardado.verified = {};
            for (const [ruta, veredicto] of Object.entries(leido.verified)) {
              if (veredicto === COMPATIBILITY.COMPATIBLE
                || (vigentes && veredicto === COMPATIBILITY.INCOMPATIBLE)) guardado.verified[ruta] = veredicto;
            }
          }
          if (leido.approval && typeof leido.approval.path === 'string'
            && /^[0-9a-f]{64}$/.test(String(leido.approval.sha256))) {
            guardado.approval = { path: leido.approval.path, sha256: leido.approval.sha256 };
          }
        }
      } catch (_) {
        guardado = {};
      }
      this.engineConfigs[providerId] = guardado;
    }
    return { ...this.engineConfigs[providerId] };
  }

  _guardarEngineConfig(providerId, config) {
    config.verdicts = VERDICTS_VERSION;
    this.engineConfigs[providerId] = config;
    this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)')
      .run(`engine_${providerId}`, JSON.stringify(config));
  }

  /**
   * Guarda una ruta de motor. La ruta viene de un diálogo nativo del proceso
   * principal o de lo que el propio proceso principal descubrió, y aun así se
   * valida aquí: nombre de ejecutable de la lista cerrada, fichero existente,
   * modelo con cabecera GGUF.
   */
  setEngineFile(providerId, tipo, ruta, modelId = null) {
    const spec = this._engineSpec(providerId);
    if (!spec || spec.tipo !== 'managed') throw new Error('ENGINE_NOT_MANAGED');
    const validada = validarRutaDeMotor(tipo, ruta, spec, {
      fs: this.motores._fs, platform: this.motores._platform
    });
    const config = this.getEngineConfig(providerId);
    config[tipo] = validada;
    if (tipo === 'model') {
      // Nombre con el que se le presenta al usuario. Para un fichero elegido a
      // mano, el del propio fichero.
      config.modelId = modelId || this._idDeMotor(spec, validada.split(/[\\/]/).pop().replace(/\.gguf$/i, ''));
      // Un fichero que el usuario elige a mano vuelve a intentarse aunque
      // antes fallara: puede que el fallo no fuera del modelo.
      if (!modelId && config.verified) delete config.verified[validada];
    }
    this._guardarEngineConfig(providerId, config);
    return this.describeEngine(providerId);
  }

  /**
   * Modelos GGUF de este equipo. Recorrer el disco no es gratis, así que el
   * resultado se conserva unos segundos: la interfaz pregunta en bucle
   * mientras un motor arranca.
   */
  discoverEngineModels({ refresh = false } = {}) {
    const ahora = Date.now();
    if (!refresh && this._modelosDescubiertos && ahora - this._modelosDescubiertos.cuando < 30000) {
      return this._modelosDescubiertos.modelos;
    }
    let modelos = [];
    try {
      modelos = descubrirModelos({
        fs: this.motores._fs, env: this.motores._env, platform: this.motores._platform,
        carpetasPropias: [this.modelsDir]
      });
    } catch (_) {
      modelos = [];
    }
    this._modelosDescubiertos = { cuando: ahora, modelos };
    return modelos;
  }

  /**
   * Modelos que puede ofrecer un motor: los descubiertos más el elegido a
   * mano, cada uno con su veredicto de compatibilidad. Los que se sabe que no
   * sirven para este motor no se ofrecen.
   */
  _modelosDeMotor(providerId, opciones) {
    const spec = this._engineSpec(providerId);
    const config = this.getEngineConfig(providerId);
    const modelos = this.discoverEngineModels(opciones).map(m => ({ ...m }));
    if (config.model && !modelos.some(m => m.path === config.model)) {
      // Un fichero elegido a mano: se nombra por su fichero.
      modelos.unshift({
        id: config.model.split(/[\\/]/).pop().replace(/\.gguf$/i, ''),
        path: config.model, source: 'manual', size: 0, architecture: null
      });
    }
    const comprobado = config.verified || {};
    return modelos
      .map(m => ({
        ...m,
        // Tres identidades que no se mezclan: el motor que lo ejecuta va en el
        // identificador, el nombre del modelo en `label` y su procedencia en
        // `source`. Un GGUF que descargó Ollama servido por llama.cpp es
        // «llama.cpp · llama3.2:3b», con origen Ollama.
        id: this._idDeMotor(spec, m.id),
        label: m.id,
        // Manda la evidencia: lo que pasó al cargarlo en este equipo. Si no la
        // hay, lo que el propio fichero declara. Nunca una suposición.
        compatibility: comprobado[m.path] || (spec && spec.compatibilidad ? spec.compatibilidad(m) : COMPATIBILITY.UNVERIFIED),
        // Arranque que funcionó la última vez con este modelo en este equipo.
        launch: (config.launch || {})[m.path]
      }))
      .filter(m => m.compatibility !== COMPATIBILITY.INCOMPATIBLE);
  }

  /** Identificador de un modelo servido por un motor: «motor · modelo». */
  _idDeMotor(spec, nombre) {
    return `${(spec && spec.etiqueta) || 'motor'} · ${nombre}`;
  }

  /** Nombre con que se enseña el modelo configurado, buscado por su fichero. */
  _modeloConfigurado(providerId) {
    const config = this.getEngineConfig(providerId);
    if (!config.model) return null;
    return this._modelosDeMotor(providerId).find(m => m.path === config.model) || null;
  }

  /** Apunta lo que pasó al cargar un modelo: es la única prueba real. */
  _registrarCompatibilidad(providerId, ruta, veredicto) {
    if (!ruta) return;
    const config = this.getEngineConfig(providerId);
    if (config.verified && config.verified[ruta] === veredicto) return;
    config.verified = { ...(config.verified || {}), [ruta]: veredicto };
    this._guardarEngineConfig(providerId, config);
  }

  /** Lo que la pantalla de configuración del motor necesita enseñar. */
  describeEngine(providerId, opciones) {
    const spec = this._engineSpec(providerId);
    if (!spec) return null;
    const config = this.getEngineConfig(providerId);
    const diagnostico = this.motores.diagnosticar(spec, config);
    const instalacion = this.motores.planDeInstalacion(spec);
    const modelos = spec.tipo === 'managed' ? this._modelosDeMotor(providerId, opciones) : [];
    return {
      ...this.motores.estado(providerId),
      providerId,
      managed: spec.tipo === 'managed',
      requiresModel: spec.requiereModelo === true,
      executable: this.motores.localizar(spec, config),
      executables: this.motores.descubrir(spec),
      executableChosen: Boolean(config.executable),
      executableApproved: Boolean(this.engineIdentity(providerId)?.approved),
      // Dónde escucha el motor: sólo se enseña en la configuración avanzada.
      endpoint: (() => { try { return new URL(spec.baseUrl()).host; } catch (_) { return null; } })(),
      installKind: spec.instalacion || null,
      // Para un motor que se compila: qué herramientas hay y cuáles faltan.
      requirements: comprobarRequisitos(spec.requisitos, {
        fs: this.motores._fs, env: this.motores._env, platform: this.motores._platform
      }),
      // Al renderer sólo va el nombre y el origen: la ruta se queda aquí.
      models: modelos.map(m => ({ id: m.id, label: m.label, source: m.source, size: m.size, compatibility: m.compatibility })),
      // Sistema detectado: decide qué instalador se ofrece.
      platform: this.motores._platform,
      arch: process.arch,
      canInstall: Boolean(instalacion),
      installer: instalacion ? instalacion.gestor : null,
      guideUrl: spec.guia || null,
      canDownload: spec.descargaHf === true,
      catalog: this.engineCatalog(providerId),
      // Para «Instalar y comenzar»: qué falta y cuánto ocupa.
      setup: this.engineSetupPlan(providerId),
      setupStatus: this.engineSetupStatus(providerId),
      experimental: spec.experimental === true,
      download: this.descargas.estado(),
      canStart: diagnostico.ok,
      errorCode: diagnostico.ok ? null : diagnostico.errorCode,
      // `estado()` trae la ruta del modelo cargado; al renderer va el nombre.
      model: (spec.tipo === 'managed' ? this._modeloConfigurado(providerId)?.id : null) || null
    };
  }

  /**
   * Qué ejecutable arrancaría MIKA5 y si el usuario ya lo aprobó. Es lo que
   * enseña el diálogo de aprobación: la ruta real y la huella del contenido.
   */
  engineIdentity(providerId) {
    const spec = this._engineSpec(providerId);
    if (!spec) return null;
    const config = this.getEngineConfig(providerId);
    const identidad = this.motores.identidad(this.motores.localizar(spec, config));
    if (!identidad) return null;
    return {
      ...identidad,
      approved: Boolean(config.approval
        && config.approval.path === identidad.path && config.approval.sha256 === identidad.sha256)
    };
  }

  /**
   * Registra la aprobación del usuario para el ejecutable que se le enseñó.
   * Se exige la huella que vio: si el fichero cambió entre el diálogo y este
   * momento, no se aprueba otra cosa en su lugar.
   */
  approveEngine(providerId, sha256Visto) {
    const identidad = this.engineIdentity(providerId);
    if (!identidad || identidad.sha256 !== sha256Visto) throw new Error('ENGINE_APPROVAL_REQUIRED');
    const config = this.getEngineConfig(providerId);
    config.approval = { path: identidad.path, sha256: identidad.sha256 };
    this._guardarEngineConfig(providerId, config);
    this.motores.reiniciarFallo(providerId);
    return this.describeEngine(providerId);
  }

  /** Elige uno de los ejecutables DESCUBIERTOS. Una ruta ajena se rechaza. */
  selectEngineExecutable(providerId, ruta) {
    const spec = this._engineSpec(providerId);
    if (!spec || !this.motores.descubrir(spec).includes(ruta)) throw new Error('ENGINE_EXECUTABLE_NOT_ALLOWED');
    return this.setEngineFile(providerId, 'executable', ruta);
  }

  /**
   * Elige un modelo por su nombre y deja el motor arrancando con él. Si MIKA5
   * tenía el motor en marcha con otro modelo, lo cambia. Un servidor que
   * arrancó el usuario no se toca: su modelo es el que él cargó.
   */
  async selectEngineModel(providerId, modelId) {
    const spec = this._engineSpec(providerId);
    if (!spec || spec.tipo !== 'managed') throw new Error('ENGINE_NOT_MANAGED');
    // Elegir un modelo arranca el motor: sin ejecutable aprobado no se elige.
    if (!this.engineIdentity(providerId)?.approved) throw new Error('ENGINE_APPROVAL_REQUIRED');
    const modelo = this._modelosDeMotor(providerId).find(m => m.id === modelId);
    if (!modelo) throw new Error('ENGINE_MODEL_MISSING');
    this.setEngineFile(providerId, 'model', modelo.path, modelo.id);
    await this._asegurarMotor(providerId);
    return this.getReadiness(providerId);
  }

  /** Pone en marcha el motor con el modelo configurado, cambiándolo si hace falta. */
  async _asegurarMotor(providerId) {
    const spec = this._engineSpec(providerId);
    const config = this.getEngineConfig(providerId);
    let estado = this.motores.estado(providerId);
    if (estado.owned && estado.model !== config.model) {
      await this.motores.detener(providerId);
      estado = this.motores.estado(providerId);
    }
    if (estado.owned) return estado;
    const disp = await this.getAvailability(providerId);
    if (disp.reachable === true) return estado;
    this.motores.reiniciarFallo(providerId);
    this._pruebas.delete(providerId);
    return this.motores.iniciar(providerId, spec, this._configDeArranque(providerId), {
      variante: (config.launch || {})[config.model] || 0
    });
  }

  /**
   * Configuración con la que se lanza el proceso del motor. El alias viaja
   * como argumento y vuelve en las respuestas del servidor: con un carácter no
   * ASCII —el «·» del identificador, o una tilde en el nombre del fichero— un
   * servidor antiguo devuelve HTTP 500 al listar el modelo. Medido con el
   * motor real de BitNet. Se pasa sólo ASCII.
   */
  _configDeArranque(providerId) {
    const config = this.getEngineConfig(providerId);
    const vigente = this._modeloConfigurado(providerId);
    const alias = String(vigente ? vigente.id : (config.modelId || '')).replace(/[^\x20-\x7E]+/g, '-');
    return { ...config, modelId: alias || undefined };
  }

  /**
   * Una inferencia mínima contra el motor propio recién cargado. Se lanza una
   * sola vez por arranque y no bloquea: quien consulta ve «cargando» hasta
   * que contesta. `resultado` es null mientras está en curso.
   */
  _probarInferencia(providerId, estado) {
    const clave = `${estado.model}#${estado.variant}`;
    const previa = this._pruebas.get(providerId);
    if (previa && previa.clave === clave) return previa;
    const prueba = { clave, resultado: null };
    this._pruebas.set(providerId, prueba);
    const adapter = registroDeProveedores.getAdapter(providerId);
    fetch(`${adapter.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content: 'ok' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(120000)
    }).then(async (res) => {
      // Hay servidores que listan el modelo antes de terminar de cargarlo y
      // contestan 503 a la inferencia mientras tanto: medido con el motor real
      // de BitNet. Eso no es un fallo, es «todavía no»: se olvida esta prueba
      // para que la siguiente consulta la repita. El techo lo pone el plazo
      // de carga del gestor de motores.
      if (res.status === 503) {
        if (this._pruebas.get(providerId) === prueba) this._pruebas.delete(providerId);
        return;
      }
      const datos = res.ok ? await res.json().catch(() => null) : null;
      prueba.resultado = Boolean(datos && Array.isArray(datos.choices) && datos.choices.length);
    }).catch(() => {
      prueba.resultado = false;
    });
    return prueba;
  }

  /**
   * Antes de un chat con un motor gestionable: si el modelo pedido es uno de
   * los descubiertos, el motor se arranca con él y se espera a que conteste.
   * Así «elegir modelo y escribir» basta, sin pasos intermedios.
   */
  async _prepararMotorParaChat(providerId, model, signal) {
    const spec = this._engineSpec(providerId);
    if (!spec || spec.tipo !== 'managed') return;
    const config = this.getEngineConfig(providerId);
    if (!this.engineIdentity(providerId)?.approved) return;
    const adapter = registroDeProveedores.getAdapter(providerId);
    const elegido = this._modelosDeMotor(providerId).find(m => m.id === model);
    const estado = this.motores.estado(providerId);
    const cambio = elegido && elegido.path !== config.model;
    if (!cambio && !estado.owned && (await adapter.status()).ok) return;
    if (!elegido && !config.model) return;
    if (elegido) this.setEngineFile(providerId, 'model', elegido.path, elegido.id);
    await this._asegurarMotor(providerId);

    const limite = Date.now() + 600000;
    while (Date.now() < limite) {
      if (signal && signal.aborted) {
        const cancelado = new Error('Solicitud cancelada por el usuario');
        cancelado.name = 'AbortError';
        cancelado.code = 'USER_CANCELED';
        throw cancelado;
      }
      if ((await adapter.status()).ok) {
        this.motores.marcarVivo(providerId);
        return;
      }
      const actual = this.motores.estado(providerId);
      if (actual.state === ESTADO_MOTOR.FAILED) {
        const motivo = actual.errorCode === 'ENGINE_OUT_OF_MEMORY'
          ? 'Este equipo no tiene memoria suficiente para este modelo. Prueba con uno más pequeño o cierra otros programas.'
          : actual.errorCode === 'ENGINE_START_TIMEOUT'
            ? 'El modelo tardó demasiado en cargar. Prueba con uno más pequeño.'
            : 'El motor no pudo cargar este modelo. Prueba con otro.';
        const fallo = new Error(`${adapter.name}: ${motivo}`);
        fallo.code = actual.errorCode;
        throw fallo;
      }
      if (!actual.owned) return;
      await delay(500);
    }
    throw new Error(`${adapter.name}: el motor local tardó demasiado en cargar el modelo.`);
  }

  /** Motor ya compilado que MIKA5 puede instalar en ESTE sistema, o null. */
  _runtimeDisponible(providerId) {
    const spec = this._engineSpec(providerId);
    if (!spec || !this.enginesDir) return null;
    return (spec.runtimes || []).find(r => r.platform === this.motores._platform && r.arch === process.arch) || null;
  }

  /**
   * Qué haría «Instalar y comenzar» para este proveedor: qué falta, cuánto
   * ocupa y si se puede hacer en este sistema. No descarga nada.
   */
  engineSetupPlan(providerId) {
    const spec = this._engineSpec(providerId);
    if (!spec || spec.tipo !== 'managed') return null;
    const config = this.getEngineConfig(providerId);
    const tieneMotor = Boolean(this.motores.localizar(spec, config));
    const runtime = tieneMotor ? null : this._runtimeDisponible(providerId);
    const tieneModelo = this._modelosDeMotor(providerId).length > 0;
    const modelo = tieneModelo || !this.modelsDir ? null : (spec.catalogo || [])[0] || null;
    const pasos = [];
    if (runtime) pasos.push({ kind: 'engine', label: spec.etiqueta, size: runtime.size });
    if (modelo) pasos.push({ kind: 'model', label: modelo.label, size: modelo.size, license: modelo.license });
    return {
      // Se puede preparar si hay motor (o se puede instalar) y hay modelo (o se puede descargar).
      possible: (tieneMotor || Boolean(runtime)) && (tieneModelo || Boolean(modelo)),
      engineMissing: !tieneMotor,
      engineAvailable: tieneMotor || Boolean(runtime),
      steps: pasos,
      totalSize: pasos.reduce((suma, p) => suma + p.size, 0)
    };
  }

  /** Estado de la preparación en curso o de la última. */
  engineSetupStatus(providerId) {
    const p = this._preparaciones.get(providerId);
    if (!p) return { state: 'idle' };
    const descarga = this.descargas.estado();
    return {
      state: p.state, step: p.step, errorCode: p.errorCode || null,
      received: p.state === 'running' && descarga.state === 'downloading' ? descarga.received : 0,
      total: p.state === 'running' && descarga.state === 'downloading' ? descarga.total : 0
    };
  }

  /**
   * «Instalar y comenzar», ya autorizado por el usuario: instala el motor si
   * falta, descarga un modelo si no hay ninguno, y arranca. Cada descarga se
   * comprueba contra el tamaño y el SHA-256 declarados antes de usarse.
   * Devuelve enseguida; el avance se consulta con `engineSetupStatus()`.
   */
  prepareEngine(providerId) {
    const spec = this._engineSpec(providerId);
    const plan = this.engineSetupPlan(providerId);
    if (!spec || !plan || !plan.possible) return { ok: false, errorCode: 'ENGINE_SETUP_UNAVAILABLE' };
    const previa = this._preparaciones.get(providerId);
    if (previa && previa.state === 'running') return { ok: true, already: true };
    const preparacion = { state: 'running', step: null, errorCode: null };
    this._preparaciones.set(providerId, preparacion);

    const descargar = (entrada, dir) => new Promise((resolve) => {
      const r = this.descargas.iniciar({ providerId, entrada, dir, alTerminar: resolve });
      if (!r.ok) resolve({ state: 'failed', errorCode: r.errorCode });
      else if (r.already) resolve({ state: 'done' });
    });
    const fallar = (codigo) => { preparacion.state = 'failed'; preparacion.errorCode = codigo; };

    (async () => {
      const runtime = plan.engineMissing ? this._runtimeDisponible(providerId) : null;
      if (runtime) {
        preparacion.step = 'engine';
        const fin = await descargar(runtime, this.motores.carpetasDeMotor[providerId]);
        if (fin.state !== 'done') return fallar(fin.errorCode || 'MODEL_DOWNLOAD_FAILED');
        // El usuario autorizó instalar exactamente este motor, y lo descargado
        // coincide con su huella: esa es su aprobación. Si el fichero cambia
        // después, deja de valer como la de cualquier otro ejecutable.
        this.motores.descubrir(spec, { fresca: true });
        const identidad = this.engineIdentity(providerId);
        if (!identidad || identidad.sha256 !== runtime.sha256) return fallar('ENGINE_APPROVAL_REQUIRED');
        this.approveEngine(providerId, identidad.sha256);
      }
      if (!this.engineIdentity(providerId)?.approved) return fallar('ENGINE_APPROVAL_REQUIRED');

      if (!this._modelosDeMotor(providerId, { refresh: true }).length) {
        const modelo = (spec.catalogo || [])[0];
        if (!modelo) return fallar('ENGINE_MODEL_REQUIRED');
        preparacion.step = 'model';
        const fin = await descargar(modelo, this.modelsDir);
        if (fin.state !== 'done') return fallar(fin.errorCode || 'MODEL_DOWNLOAD_FAILED');
      }

      // Arrancar con un modelo compatible: el ya elegido, o el primero que haya.
      preparacion.step = 'start';
      this._modelosDescubiertos = null;
      const modelos = this._modelosDeMotor(providerId, { refresh: true });
      const elegido = this._modeloConfigurado(providerId) || modelos[0];
      if (!elegido) return fallar('ENGINE_MODEL_REQUIRED');
      await this.selectEngineModel(providerId, elegido.id);
      preparacion.state = 'done';
      return undefined;
    })().catch(() => fallar('ENGINE_SPAWN_FAILED'));

    return { ok: true, already: false };
  }

  /** Catálogo del motor: qué puede descargarse y qué está ya en el equipo. */
  engineCatalog(providerId) {
    const spec = this._engineSpec(providerId);
    if (!spec || !this.modelsDir) return [];
    return (spec.catalogo || []).map(entrada => ({
      id: entrada.id, label: entrada.label, size: entrada.size, license: entrada.license, repo: entrada.repo,
      installed: this.descargas.yaDescargado(this.modelsDir, entrada)
    }));
  }

  /**
   * Descarga ya autorizada de un modelo del catálogo. El renderer manda el
   * identificador de la entrada; el origen, el tamaño y la huella salen del
   * adaptador, nunca de fuera.
   */
  downloadCatalogModel(providerId, catalogId) {
    const spec = this._engineSpec(providerId);
    const entrada = spec && (spec.catalogo || []).find(e => e.id === catalogId);
    if (!entrada || !this.modelsDir) return { ok: false, errorCode: 'MODEL_DOWNLOAD_INVALID' };
    return this.descargas.iniciar({
      providerId, entrada, dir: this.modelsDir,
      // Al terminar, el modelo nuevo tiene que aparecer sin esperar a la caché.
      alTerminar: () => { this._modelosDescubiertos = null; }
    });
  }

  /** Instalación ya autorizada por el usuario, con el gestor de paquetes oficial. */
  async installEngine(providerId) {
    const spec = this._engineSpec(providerId);
    if (!spec) throw new Error('ENGINE_NOT_MANAGED');
    const resultado = await this.motores.instalar(spec);
    return { ...resultado, engine: this.describeEngine(providerId, { refresh: true }) };
  }

  /**
   * Descarga ya autorizada: el propio `llama-server` baja el GGUF de Hugging
   * Face a su caché y lo carga. MIKA5 no descarga nada por su cuenta.
   */
  async downloadEngineModel(providerId, repo) {
    const spec = this._engineSpec(providerId);
    if (!spec || !spec.descargaHf) throw new Error('ENGINE_DOWNLOAD_UNSUPPORTED');
    if (!HF_REPO_RE.test(String(repo || ''))) throw new Error('ENGINE_MODEL_INVALID');
    const disp = await this.getAvailability(providerId);
    if (disp.reachable === true && !this.motores.estado(providerId).owned) throw new Error('ENGINE_PORT_IN_USE');
    await this.motores.detener(providerId);
    const config = { ...this.getEngineConfig(providerId), hf: repo, modelId: repo };
    await this.motores.iniciar(providerId, spec, config, { sinPlazo: true });
    return this.getReadiness(providerId);
  }

  /**
   * Disponibilidad más preparación. Con `autoStart`, un motor local parado y
   * arrancable se pone en marcha: es el único efecto lateral, y sólo ocurre
   * para el proveedor que se consulta, nunca para todos.
   *
   * Un motor que ya falló no se reintenta solo: la interfaz consulta en bucle
   * mientras arranca, y reintentar aquí relanzaría el proceso sin fin. El
   * reintento es una acción del usuario, `startEngine()`.
   */
  async getReadiness(providerId = this.currentProvider, { autoStart = false } = {}) {
    const disp = await this.getAvailability(providerId);
    const spec = this._engineSpec(providerId);
    if (!spec) return { ...disp, ...resolverReadiness(disp, null), engine: null };

    if (disp.reachable === true) this.motores.marcarVivo(providerId);
    const config = this.getEngineConfig(providerId);
    if (autoStart && disp.reachable === false
      && this.motores.estado(providerId).state === ESTADO_MOTOR.IDLE
      && this.motores.diagnosticar(spec, config).ok) {
      await this.motores.iniciar(providerId, spec, this._configDeArranque(providerId), {
        variante: (config.launch || {})[config.model] || 0
      });
    }

    const estado = this.motores.estado(providerId);
    const diagnostico = this.motores.diagnosticar(spec, config);
    const motor = {
      tipo: spec.tipo,
      state: estado.state,
      errorCode: estado.errorCode,
      diagnostico: diagnostico.ok ? null : diagnostico.errorCode
    };
    let preparacion = resolverReadiness(disp, motor);

    // Evidencia de compatibilidad. Que el servidor liste el modelo no prueba
    // que sepa generar con él: para un motor propio se hace UNA inferencia
    // mínima antes de darlo por listo. Sólo entonces es «compatible».
    let probando = false;
    if (spec.tipo === 'managed' && estado.model && estado.model === config.model) {
      if (estado.owned && disp.ready && !estado.ready) {
        const prueba = this._probarInferencia(providerId, estado);
        if (prueba.resultado === true) {
          this.motores.marcarListo(providerId);
          this._registrarCompatibilidad(providerId, estado.model, COMPATIBILITY.COMPATIBLE);
          // Se recuerda con qué arranque funcionó, para no repetir los que fallan.
          // Se relee la configuración: el registro anterior acaba de guardarla.
          const vigente = this.getEngineConfig(providerId);
          if (Number.isInteger(estado.variant) && (vigente.launch || {})[estado.model] !== estado.variant) {
            vigente.launch = { ...(vigente.launch || {}), [estado.model]: estado.variant };
            this._guardarEngineConfig(providerId, vigente);
          }
        } else if (prueba.resultado === false) {
          this.motores.fallar(providerId, 'ENGINE_INFERENCE_FAILED');
        } else {
          probando = true;
        }
      } else if (estado.state === ESTADO_MOTOR.FAILED && estado.errorCode === 'ENGINE_MODEL_UNSUPPORTED') {
        // Sólo cuando el motor DICE que no entiende el modelo. Quedarse sin
        // memoria es un límite del equipo, y un cierre sin causa conocida no
        // demuestra nada: ninguno de los dos hace incompatible al modelo.
        this._registrarCompatibilidad(providerId, estado.model, COMPATIBILITY.INCOMPATIBLE);
      }
    }
    if (probando || this.motores.estado(providerId).state !== estado.state) {
      // El estado cambió en esta misma consulta: se recalcula con el nuevo.
      const actual = this.motores.estado(providerId);
      motor.state = actual.state;
      motor.errorCode = actual.errorCode;
      Object.assign(estado, actual);
      if (probando) {
        // Servidor en pie, inferencia aún sin confirmar: sigue cargando.
        disp.ready = false;
        preparacion = { readiness: READINESS.LOADING_MODEL, action: null };
      } else if (actual.state === ESTADO_MOTOR.FAILED) {
        disp.ready = false;
        preparacion = readinessDeMotor(actual.errorCode, spec.tipo);
      }
    }

    // Un motor gestionable ofrece los modelos que hay en el equipo, esté o no
    // en marcha: elegir uno es lo que lo arranca. Un servidor que lanzó el
    // usuario es distinto: tiene cargado su modelo y MIKA5 no puede cambiarlo,
    // así que ahí manda su catálogo.
    const esExterno = disp.reachable === true && !estado.owned;
    if (spec.tipo === 'managed' && !esExterno && this.engineIdentity(providerId)?.approved) {
      const modelos = this._modelosDeMotor(providerId);
      if (modelos.length) {
        disp.models = modelos.map(m => ({
          name: m.id, label: m.label, origin: m.source, size: m.size, digest: m.id,
          sizeFormatted: m.size ? formatBytes(m.size) : '', compatibility: m.compatibility
        }));
        disp.modelsAvailable = modelos.length;
        // Siempre se puede elegir: también tras un fallo, porque la salida de
        // «este modelo no carga» es precisamente elegir otro.
        disp.canAttempt = true;
        if (disp.reachable === false && estado.state === ESTADO_MOTOR.IDLE) {
          preparacion = { readiness: READINESS.AVAILABLE, action: null };
        }
      }
    }

    // Modelo que el motor tiene (o tendría) cargado, por su fichero. Si ese
    // fichero ya no se ofrece —no existe, o se supo incompatible— no hay
    // modelo elegido: la interfaz no debe enseñar otro en su lugar como si
    // estuviese listo.
    const configurado = spec.tipo === 'managed' && !esExterno ? this._modeloConfigurado(providerId) : null;
    const aprobado = spec.tipo !== 'managed' || Boolean(this.engineIdentity(providerId)?.approved);
    let status = null;
    if (spec.tipo === 'managed') {
      const E = ENGINE_STATUS;
      if (preparacion.readiness === READINESS.READY) status = E.READY;
      else if (preparacion.readiness === READINESS.LOADING_MODEL) status = E.LOADING;
      else if (preparacion.readiness === READINESS.STARTING) status = E.STARTING;
      else if (estado.state === ESTADO_MOTOR.FAILED) status = E.ERROR;
      // El motor propio está en marcha y contesta, pero con un error: no está
      // detenido, está fallando.
      else if (estado.owned && preparacion.readiness === READINESS.ERROR) status = E.ERROR;
      else if (!this.motores.localizar(spec, config)) status = E.NOT_INSTALLED;
      else if (!aprobado) status = E.NEEDS_APPROVAL;
      else if (!disp.modelsAvailable) status = E.NEEDS_MODEL;
      else status = E.STOPPED;
    }

    return {
      ...disp,
      ...preparacion,
      engine: {
        selectedModel: configurado ? configurado.id : null,
        // Las tres identidades, por separado, para que la interfaz no tenga
        // que deducirlas de un nombre.
        label: spec.etiqueta || null,
        modelOrigin: configurado ? configurado.source : null,
        external: esExterno,
        status,
        managed: spec.tipo === 'managed',
        state: estado.state,
        owned: estado.owned,
        // Con el servidor contestando, lo que impediría arrancarlo no es un
        // problema del usuario: no se le enseña.
        // Un fallo del motor propio se dice siempre: puede haberse retirado
        // en esta misma consulta, cuando el servidor aún contestaba.
        errorCode: estado.state === ESTADO_MOTOR.FAILED ? estado.errorCode
          : (disp.reachable === true ? null : motor.diagnostico)
      }
    };
  }

  /** Arranque pedido por el usuario: olvida el fallo anterior y lo intenta. */
  async startEngine(providerId = this.currentProvider) {
    const spec = this._engineSpec(providerId);
    if (!spec) throw new Error('ENGINE_NOT_MANAGED');
    this.motores.reiniciarFallo(providerId);
    const disp = await this.getAvailability(providerId);
    if (disp.reachable !== true) {
      await this.motores.iniciar(providerId, spec, this._configDeArranque(providerId));
    }
    return this.getReadiness(providerId);
  }

  /** Al cerrar: se detiene lo que MIKA5 arrancó, y nada más. */
  stopEngines() {
    this.motores.detenerTodos();
  }

  /**
   * Registra un fallo sin repetirlo. La interfaz consulta el estado cada pocos
   * segundos mientras un motor arranca: escribir la misma línea en cada
   * consulta llenaba el registro sin decir nada nuevo.
   */
  _registrarFalloUnaVez(providerId, operacion, error, codigo) {
    const clave = `${providerId}:${operacion}`;
    const previo = this._fallosRegistrados.get(clave);
    const ahora = Date.now();
    if (previo && previo.codigo === codigo && ahora - previo.cuando < 60000) return;
    this._fallosRegistrados.set(clave, { codigo, cuando: ahora });
    registrarFalloDeProveedor(providerId, operacion, error, codigo);
  }

  getAllProviders() {
    return Object.entries(PROVIDERS).map(([id, config]) => ({
      id,
      name: config.name,
      privacy: config.privacy,
      requiresKey: config.requiresKey,
      libraryUrl: config.libraryUrl || null,
      current: id === this.currentProvider,
      capabilities: this.getCapabilities(id)
    }));
  }
}

module.exports = {
  AIProviderManager,
  PROVIDERS,
  registroDeProveedores,
  UI_STATE,
  resolverUiState,
  READINESS,
  READINESS_ACTION,
  resolverReadiness,
  HF_REPO_RE,
  COMPATIBILITY,
  ENGINE_STATUS,
  probeOllamaVision,
  getProviderContract,
  resolveVisionSupport,
  describeVisionBlock,
  assertVisionSupported,
  normalizeChatResult,
  sanitizeForCloud,
  ALIBABA_DEFAULT_CONFIG,
  ALIBABA_DEFAULT_MODEL_ID,
  ALIBABA_DEFAULT_MAX_TOKENS,
  ALIBABA_LEGACY_MAX_TOKENS,
  createAlibabaPresetModel,
  migrateAlibabaOfficialMaxTokens,
  extractAlibabaUsage,
  ALIBABA_TOKEN_PLAN_ENDPOINT,
  ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT,
  normalizeAlibabaConfig,
  normalizeAlibabaModel,
  extractVisualSuggestions,
  buildAnthropicMessagesPayload,
  normalizeIntentText,
  detectUserIntent,
  detectUserIntentDetailed,
  detectCreateFromScratch,
  resolveVisualContext,
  routeIntent,
  buildImageEditPlan,
  buildImageVariationPlan,
  buildVisionAnalysisPlan,
  buildImageGenerationPlan,
  validateVisualTaskPlan,
  buildModelPromptFromPlan,
  buildImageGenerationPromptFromVisualPlan,
  normalizeAlibabaAssistantOutput,
  executeGenerateImageToolUse,
  providerSupportsImageGeneration,
  providerSupportsImageEdit,
  providerSupportsImageVariation,
  getDefaultImageModelForProvider,
  getDefaultVisionModelForProvider,
  providerSupportsVisionRouting,
  getProviderVisualCapabilities,
  isProviderNetworkError,
  normalizeProviderNetworkError,
  createAbortContext,
  delay,
  fetchWithProviderRetry
};
