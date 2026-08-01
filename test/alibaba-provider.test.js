const assert = require('assert');
const fs = require('fs');
const {
  AIProviderManager,
  PROVIDERS,
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
  buildAnthropicMessagesPayload,
  extractVisualSuggestions,
  detectUserIntent,
  detectUserIntentDetailed,
  resolveVisualContext,
  routeIntent,
  buildImageEditPlan,
  buildImageVariationPlan,
  buildVisionAnalysisPlan,
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
  getProviderVisualCapabilities
} = require('../src/main/ai-providers');

function createDb() {
  const values = new Map();
  return {
    values,
    prepare(sql) {
      if (sql.startsWith('SELECT key, value')) {
        return { all: (...keys) => keys.filter(key => values.has(key)).map(key => ({ key, value: values.get(key) })) };
      }
      if (sql.startsWith('INSERT OR REPLACE')) {
        return { run: (key, value) => values.set(key, value) };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    }
  };
}

(async () => {
  const imageAttachment = [{ type: 'image', mediaType: 'image/png' }];
  assert.deepEqual(extractVisualSuggestions([
    'Mejoras sugeridas:',
    '- Simplificar el fondo.',
    '2. Aumentar la legibilidad.'
  ].join('\n')), {
    suggestions: ['Simplificar el fondo.', 'Aumentar la legibilidad.'],
    source: 'structured'
  });
  assert.deepEqual(
    extractVisualSuggestions('La composición puede mejorar. Recomiendo aumentar el contraste.'),
    {
      suggestions: ['La composición puede mejorar.', 'Recomiendo aumentar el contraste.'],
      source: 'heuristic'
    }
  );
  assert.deepEqual(extractVisualSuggestions('La imagen contiene una caja sobre una mesa.'), {
    suggestions: [],
    source: 'none'
  });
  assert.equal(detectUserIntent({ text: 'analiza la imagen', attachments: imageAttachment }), 'vision-analysis');
  assert.equal(detectUserIntent({ text: 'describe esta imagen', attachments: imageAttachment }), 'vision-analysis');
  assert.equal(detectUserIntent({ text: 'qué ves aquí', attachments: imageAttachment }), 'vision-analysis');
  assert.equal(detectUserIntent({ text: 'explica la imagen', attachments: imageAttachment }), 'vision-analysis');
  assert.equal(detectUserIntent({ text: 'crea una imagen de un avión' }), 'image-generation');
  assert.equal(detectUserIntent({ text: 'hazle un cambio a esta imagen', attachments: imageAttachment }), 'image-edit');
  assert.equal(detectUserIntent({ text: 'cambia el color de la vasija a azul', attachments: imageAttachment }), 'image-edit');
  assert.equal(detectUserIntent({ text: 'cambibia el color de la vasija a color azul', attachments: imageAttachment }), 'image-edit');
  assert.equal(detectUserIntent({ text: 'cámbiale el color a azul', attachments: imageAttachment }), 'image-edit');
  assert.equal(detectUserIntent({ text: 'canbia el fondo', attachments: imageAttachment }), 'image-edit');
  assert.equal(detectUserIntent({ text: 'modifca el fondo', attachments: imageAttachment }), 'image-edit');
  assert.equal(detectUserIntent({ text: 'pon la vasija azul', attachments: imageAttachment }), 'image-edit');
  assert.equal(detectUserIntent({ text: 'quita el fondo', attachments: imageAttachment }), 'image-edit');
  assert.equal(detectUserIntent({ text: 'agrega una planta', attachments: imageAttachment }), 'image-edit');
  assert.equal(detectUserIntent({ text: 'hazlo más moderno', attachments: imageAttachment }), 'image-edit');
  assert.equal(detectUserIntent({ text: 'reemplaza el fondo', attachments: imageAttachment }), 'image-edit');
  assert.equal(detectUserIntent({ text: '¿qué hago con esto?', attachments: imageAttachment }), 'ambiguous-visual');
  assert.equal(detectUserIntent({ text: 'analiza el color de la vasija', attachments: imageAttachment }), 'vision-analysis');
  for (const text of [
    'explícame este código',
    'qué hace este código',
    'qué significa este código',
    'ayúdame a entender este código',
    'interpreta este código',
    'revisa este código'
  ]) {
    const detailedExplanation = detectUserIntentDetailed({ text, attachments: imageAttachment });
    assert.equal(detailedExplanation.intent, 'vision-analysis');
    assert(!['image-generation', 'image-edit', 'image-variation'].includes(detailedExplanation.intent));
    const explanationRoute = routeIntent(detailedExplanation.intent, {
      currentProvider: 'alibaba',
      currentModel: 'qwen3.7-max'
    });
    assert.equal(explanationRoute.action, 'chat');
    assert.equal(explanationRoute.model, 'qwen3.7-plus');
    assert.notEqual(explanationRoute.action, 'generate-image');
    const explanationPlan = buildVisionAnalysisPlan({
      text,
      visualContext: detailedExplanation.visualContext
    });
    assert.equal(validateVisualTaskPlan(explanationPlan, { vision: true }).valid, true);
  }
  assert.equal(detectUserIntent({ text: 'crea un video' }), 'video-generation');
  assert.equal(detectUserIntent({ text: 'Explícame este concepto' }), 'normal-chat');
  assert(Array.isArray(detectUserIntentDetailed({ text: 'Explícame este concepto' }).variationSignals));
  assert.deepEqual(routeIntent('vision-analysis', {
    currentProvider: 'alibaba',
    currentModel: 'qwen3.7-max'
  }), {
    intent: 'vision-analysis',
    action: 'chat',
    model: 'qwen3.7-plus'
  });
  assert.equal(routeIntent('image-generation', { currentProvider: 'alibaba' }).action, 'generate-image');
  const imageEditRoute = routeIntent('image-edit', { currentProvider: 'alibaba' });
  assert.equal(imageEditRoute.action, 'generate-image');
  assert.equal(imageEditRoute.model, 'wan2.7-image');
  assert.equal(providerSupportsImageGeneration('alibaba'), true);
  assert.equal(providerSupportsImageEdit('alibaba'), true);
  assert.equal(providerSupportsImageVariation('alibaba'), true);
  assert.equal(providerSupportsVisionRouting('alibaba'), true);
  assert.deepEqual(getProviderVisualCapabilities('alibaba'), {
    vision: true,
    imageGeneration: true,
    imageEdit: true,
    imageVariation: true,
    sourceImages: true,
    defaultVisionModel: 'qwen3.7-plus',
    defaultImageModel: 'wan2.7-image'
  });
  assert.equal(getDefaultImageModelForProvider('alibaba'), 'wan2.7-image');
  assert.equal(getDefaultVisionModelForProvider('alibaba'), 'qwen3.7-plus');
  for (const providerId of ['local', 'openai', 'anthropic', 'groq', 'moonshot', 'llamacpp']) {
    assert.equal(providerSupportsImageGeneration(providerId), false);
    assert.equal(providerSupportsImageEdit(providerId), false);
    assert.equal(providerSupportsImageVariation(providerId), false);
    assert.notEqual(routeIntent('image-generation', { currentProvider: providerId }).action, 'generate-image');
  }
  assert.equal(providerSupportsVisionRouting('local'), true);
  assert.equal(providerSupportsVisionRouting('openai'), false);
  assert.equal(
    routeIntent('image-generation', { currentProvider: 'openai' }).message,
    'El proveedor actual no soporta generación de imágenes. Cambia a un proveedor con modelos de imagen.'
  );
  assert.equal(routeIntent('image-edit', { currentProvider: 'openai' }).action, 'unsupported');
  const ambiguousRoute = routeIntent('ambiguous-visual', { currentProvider: 'alibaba' });
  assert.equal(ambiguousRoute.action, 'unsupported');
  assert.equal(ambiguousRoute.message, '¿Quieres analizar la imagen, editarla o generar una nueva versión?');
  assert.match(routeIntent('video-generation', { currentProvider: 'alibaba' }).message, /disponible próximamente/);

  const previousImage = { type: 'image', mediaType: 'image/png', base64: 'aGVsbG8=', name: 'anterior.png' };
  const criticalText = 'cambia el color del fondo anterior por un color que no sea gris y que se lea el contenido';
  const resolvedPrevious = resolveVisualContext({ text: criticalText, lastUploadedImage: previousImage });
  assert.equal(resolvedPrevious.hasVisualContext, true);
  assert.equal(resolvedPrevious.source, 'previous-user-image');
  const recentGenerated = {
    type: 'image',
    url: 'https://example.test/generated.png',
    updatedAt: 20
  };
  const olderUpload = { ...previousImage, updatedAt: 10 };
  const resolvedRecent = resolveVisualContext({
    text: 'analiza la imagen anterior',
    lastUploadedImage: olderUpload,
    lastGeneratedImage: recentGenerated
  });
  assert.equal(resolvedRecent.source, 'previous-generated-image');
  const analyzedImage = {
    ...previousImage,
    updatedAt: 30,
    chatId: 'chat-visual',
    source: 'analyzed-image'
  };
  const implicitEditText = 'cambia el color del fondo por un gris mas oscuro';
  const implicitContext = resolveVisualContext({
    text: implicitEditText,
    lastAnalyzedImage: analyzedImage
  });
  assert.equal(implicitContext.hasVisualContext, true);
  assert.equal(implicitContext.source, 'previous-analyzed-image');
  const implicitEdit = detectUserIntentDetailed({
    text: implicitEditText,
    lastAnalyzedImage: analyzedImage
  });
  assert.equal(implicitEdit.intent, 'image-edit');
  assert.equal(implicitEdit.visualContext.source, 'previous-analyzed-image');
  const sameChatImage = {
    ...previousImage,
    chatId: 'chat-a',
    updatedAt: 40,
    visualEntryId: 'visual-source-a'
  };
  const otherChatImage = { ...sameChatImage, chatId: 'chat-b', updatedAt: 50 };
  const goldenBackground = detectUserIntentDetailed({
    text: 'cambia el color del fondo a dorado',
    chatId: 'chat-a',
    lastUserImage: sameChatImage
  });
  assert.equal(goldenBackground.intent, 'image-edit');
  assert.equal(goldenBackground.visualContext.imageRef, sameChatImage);
  assert.equal(resolveVisualContext({
    text: 'quita el brillo del fondo',
    chatId: 'chat-a',
    lastUserImage: sameChatImage
  }).hasVisualContext, true);
  assert.equal(resolveVisualContext({
    text: 'cambia el color del fondo a dorado',
    chatId: 'chat-a',
    lastUserImage: otherChatImage
  }).hasVisualContext, false);
  assert.equal(detectUserIntentDetailed({
    text: '¿Qué color tiene el fondo?',
    chatId: 'chat-a',
    lastUserImage: sameChatImage
  }).intent, 'vision-analysis');
  assert.equal(detectUserIntentDetailed({
    text: 'Describe la imagen',
    chatId: 'chat-a',
    lastUserImage: sameChatImage
  }).intent, 'vision-analysis');
  for (const text of ['qué hace este código', 'explica esta captura']) {
    const previousVisualExplanation = detectUserIntentDetailed({
      text,
      chatId: 'chat-a',
      lastAnalyzedImage: sameChatImage
    });
    assert.equal(previousVisualExplanation.intent, 'vision-analysis');
    assert.equal(previousVisualExplanation.visualContext.hasVisualContext, true);
    assert.equal(previousVisualExplanation.visualContext.source, 'previous-analyzed-image');
    assert.equal(routeIntent(previousVisualExplanation.intent, {
      currentProvider: 'alibaba',
      currentModel: 'qwen3.7-max'
    }).action, 'chat');
  }
  const generatedAfterAnalysis = {
    type: 'image',
    url: 'https://example.test/new-context.png',
    chatId: 'chat-a',
    updatedAt: 60,
    visualEntryId: 'visual-generated'
  };
  const unchangedSourceAfterAnalysis = resolveVisualContext({
    text: 'analiza la imagen',
    chatId: 'chat-a',
    lastUserImage: sameChatImage,
    lastAnalyzedImage: sameChatImage
  });
  assert.equal(unchangedSourceAfterAnalysis.imageRef, sameChatImage);
  const newestGeneratedContext = resolveVisualContext({
    text: 'hazlo más moderno',
    chatId: 'chat-a',
    lastUserImage: sameChatImage,
    lastAnalyzedImage: sameChatImage,
    lastGeneratedImage: generatedAfterAnalysis
  });
  assert.equal(newestGeneratedContext.imageRef, generatedAfterAnalysis);
  const detailedEdit = detectUserIntentDetailed({ text: criticalText, lastUploadedImage: previousImage });
  assert.equal(detailedEdit.intent, 'image-edit');
  assert.equal(detailedEdit.usesPreviousImageContext, true);
  assert.equal(typeof detailedEdit.confidence, 'number');
  assert(Array.isArray(detailedEdit.matchedSignals));
  assert(Array.isArray(detailedEdit.editSubtypes));
  const editPlan = buildImageEditPlan({
    text: criticalText,
    detailed: detailedEdit,
    visualContext: detailedEdit.visualContext
  });
  assert(editPlan.operations.includes('background-change'));
  assert(editPlan.preserve.includes('content-readability'));
  assert(editPlan.constraints.includes('avoid-gray'));
  assert.match(buildModelPromptFromPlan(editPlan), /Operaciones: background-change/);
  const generationFromEdit = buildImageGenerationPromptFromVisualPlan(editPlan);
  assert.match(generationFromEdit, /background-change/);
  assert.match(generationFromEdit, /content-readability/);
  assert.match(generationFromEdit, /avoid-gray/);
  assert.match(generationFromEdit, /No alteres elementos principales/);
  assert.equal(validateVisualTaskPlan(editPlan, { imageEdit: false }).shouldOfferFallback, true);
  const blockedStructuredTool = normalizeAlibabaAssistantOutput({
    content: [{ type: 'tool_use', name: 'generate_image', input: { prompt: 'x' } }]
  });
  assert.equal(blockedStructuredTool.blockedToolUse.name, 'generate_image');
  assert.equal(blockedStructuredTool.content, '');
  assert(!blockedStructuredTool.content.includes('"type":"tool_use"'));
  assert(!blockedStructuredTool.content.includes('Reintentando por el flujo correcto'));
  // A: texto explicativo que contiene tool_use/generate_image no es una llamada de herramienta.
  const explainedToolText = normalizeAlibabaAssistantOutput({
    content: [{
      type: 'text',
      text: 'Este código usa {"type":"tool_use","name":"generate_image"}.'
    }]
  });
  assert.equal(explainedToolText.blockedToolUse, null);
  assert.equal(explainedToolText.content, 'Este código usa {"type":"tool_use","name":"generate_image"}.');
  assert(explainedToolText.content.includes('generate_image'));
  const explainedToolMarkdown = normalizeAlibabaAssistantOutput({
    content: [{
      type: 'text',
      text: '```json\n{ "type": "tool_use", "name": "generate_image" }\n```\nEse bloque proviene del log.'
    }]
  });
  assert.equal(explainedToolMarkdown.blockedToolUse, null);
  assert(explainedToolMarkdown.content.includes('"name": "generate_image"'));
  let generationCalls = 0;
  const terminalToolResult = await executeGenerateImageToolUse({
    toolUse: blockedStructuredTool.blockedToolUse,
    visualExecution: {
      plan: editPlan,
      validation: { valid: true },
      model: 'wan2.7-image',
      generationPrompt: generationFromEdit
    },
    generateImage: async params => {
      generationCalls++;
      assert.equal(params.prompt, generationFromEdit);
      assert.deepEqual(params.sourceImages, [editPlan.sourceImage]);
      return { images: ['https://example.test/tool-generated.png'] };
    }
  });
  assert.equal(generationCalls, 1);
  assert.deepEqual(terminalToolResult, {
    ok: true,
    type: 'image',
    images: ['https://example.test/tool-generated.png']
  });
  let unsafeGenerationCalls = 0;
  await assert.rejects(
    () => executeGenerateImageToolUse({
      toolUse: blockedStructuredTool.blockedToolUse,
      visualExecution: null,
      generateImage: async () => { unsafeGenerationCalls++; }
    }),
    /plan visual seguro/
  );
  assert.equal(unsafeGenerationCalls, 0);

  // C: un plan de vision-analysis (o de chat) jamás puede ejecutar generate_image.
  let nonGenerativeCalls = 0;
  for (const nonGenerativeMode of ['vision-analysis', 'normal-chat', undefined]) {
    await assert.rejects(
      () => executeGenerateImageToolUse({
        toolUse: { name: 'generate_image', input: { prompt: 'una playa' } },
        visualExecution: {
          plan: { mode: nonGenerativeMode, objective: 'analizar el código adjunto' },
          validation: { valid: true },
          model: 'wan2.7-image',
          generationPrompt: 'genera una imagen'
        },
        generateImage: async () => { nonGenerativeCalls++; return { images: ['x'] }; }
      }),
      /la tarea actual no es generativa/
    );
  }
  assert.equal(nonGenerativeCalls, 0);

  for (const text of [
    'haz una versión más moderna de esta imagen',
    'crea una nueva versión basada en esta imagen',
    'haz otra opción con la misma línea visual'
  ]) {
    const detailedVariation = detectUserIntentDetailed({ text, lastUploadedImage: previousImage });
    assert.equal(detailedVariation.intent, 'image-variation');
    const variationPlan = buildImageVariationPlan({
      text,
      detailed: detailedVariation,
      visualContext: detailedVariation.visualContext
    });
    assert.equal(variationPlan.mode, 'image-variation');
    assert(Array.isArray(variationPlan.preserve));
    assert(Array.isArray(variationPlan.allowChanges));
    assert(Array.isArray(variationPlan.styleGoals));
  }
  const previousGeneratedImage = {
    ...generatedAfterAnalysis,
    chatId: 'chat-diagnostico'
  };
  for (const text of [
    'genera una nueva version',
    'genera una nueva versión',
    'crea otra version'
  ]) {
    const detailedVariation = detectUserIntentDetailed({
      text,
      chatId: 'chat-diagnostico',
      lastGeneratedImage: previousGeneratedImage
    });
    assert.equal(detailedVariation.intent, 'image-variation');
    assert.equal(detailedVariation.visualContext.hasVisualContext, true);
    assert.equal(detailedVariation.visualContext.source, 'previous-generated-image');
    const variationPlan = buildImageVariationPlan({
      text,
      detailed: detailedVariation,
      visualContext: detailedVariation.visualContext
    });
    assert.equal(variationPlan.sourceImage, previousGeneratedImage);
    assert.equal(validateVisualTaskPlan(variationPlan, { imageVariation: true }).valid, true);
  }
  for (const text of [
    'rediseña el logo por un logo moderno',
    'moderniza este logo'
  ]) {
    const detailedEdit = detectUserIntentDetailed({
      text,
      chatId: 'chat-diagnostico',
      lastGeneratedImage: previousGeneratedImage
    });
    assert.notEqual(detailedEdit.intent, 'ambiguous-visual');
    assert.equal(detailedEdit.intent, 'image-edit');
    assert.equal(detailedEdit.visualContext.hasVisualContext, true);
    const editPlan = buildImageEditPlan({
      text,
      detailed: detailedEdit,
      visualContext: detailedEdit.visualContext
    });
    assert.equal(editPlan.sourceImage, previousGeneratedImage);
    assert.equal(validateVisualTaskPlan(editPlan, { imageEdit: true }).valid, true);
  }
  const previousVisualAnalysis = {
    chatId: 'chat-suggestions',
    sourceImageRef: { ...previousImage, chatId: 'chat-suggestions' },
    analysisText: 'El fondo distrae. Sugiero mejorar la composición y aumentar la legibilidad del texto.',
    suggestions: [
      'Mejorar la composición.',
      'Aumentar la legibilidad del texto.'
    ],
    updatedAt: 70
  };
  const suggestionsSourceImage = {
    ...previousImage,
    chatId: 'chat-suggestions',
    updatedAt: 60,
    visualEntryId: 'visual-suggestions-source'
  };
  const applySuggestionsText = 'aplica los cambios sugeridos y crea una nueva imagen';
  const suggestionsDetailed = detectUserIntentDetailed({
    text: applySuggestionsText,
    chatId: 'chat-suggestions',
    lastUserImage: suggestionsSourceImage
  });
  assert.equal(suggestionsDetailed.intent, 'image-variation');
  assert(Array.isArray(suggestionsDetailed.variationSignals));
  assert(suggestionsDetailed.variationSignals.includes('apply-previous-suggestions'));
  for (const text of [
    'aplica las mejoras sugeridas y genera una nueva imagen',
    'aplica las recomendaciones y crea una nueva imagen',
    'usa los cambios sugeridos y genera una nueva versión',
    'haz los cambios que sugeriste y crea una nueva imagen',
    'toma las mejoras anteriores y genera una nueva versión',
    'crea una nueva imagen con esos cambios',
    'genera una nueva versión con esos cambios'
  ]) {
    assert.equal(detectUserIntentDetailed({
      text,
      chatId: 'chat-suggestions',
      lastUserImage: suggestionsSourceImage
    }).intent, 'image-variation');
  }
  const suggestionsPlan = buildImageVariationPlan({
    text: applySuggestionsText,
    detailed: suggestionsDetailed,
    visualContext: suggestionsDetailed.visualContext,
    lastVisualAnalysis: previousVisualAnalysis
  });
  assert.equal(suggestionsPlan.mode, 'image-variation');
  assert.equal(suggestionsPlan.sourceImage, suggestionsSourceImage);
  assert(suggestionsPlan.preserve.includes('primary-visual-identity'));
  assert.deepEqual(suggestionsPlan.appliedSuggestions, [
    'Sugiero mejorar la composición y aumentar la legibilidad del texto.'
  ]);
  assert.equal(suggestionsPlan.suggestionSource, 'heuristic');
  assert.match(buildModelPromptFromPlan(suggestionsPlan), /Genera una nueva imagen/);
  assert.match(buildModelPromptFromPlan(suggestionsPlan), /Sugiero mejorar la composición/);
  assert.match(buildImageGenerationPromptFromVisualPlan(suggestionsPlan), /aumentar la legibilidad/);
  const noSuggestionsPlan = buildImageVariationPlan({
    text: applySuggestionsText,
    detailed: suggestionsDetailed,
    visualContext: suggestionsDetailed.visualContext,
    lastVisualAnalysis: {
      ...previousVisualAnalysis,
      suggestions: [],
      analysisText: 'El fondo contiene un degradado azul y el producto está centrado.'
    }
  });
  assert.deepEqual(noSuggestionsPlan.appliedSuggestions, []);
  assert.equal(noSuggestionsPlan.suggestionSource, 'none');
  assert(!buildImageGenerationPromptFromVisualPlan(noSuggestionsPlan).includes('degradado azul'));
  assert.notEqual(detectUserIntentDetailed({
    text: 'aplica los cambios sugeridos',
    chatId: 'chat-suggestions',
    lastUserImage: suggestionsSourceImage
  }).intent, 'image-variation');
  assert.equal(detectUserIntent({
    text: 'crea una nueva imagen desde cero'
  }), 'image-generation');
  const previousAnalysis = detectUserIntentDetailed({
    text: 'analiza la imagen anterior',
    lastAnalyzedImage: previousImage
  });
  assert.equal(previousAnalysis.intent, 'vision-analysis');
  assert.equal(previousAnalysis.usesPreviousImageContext, true);
  assert.equal(detectUserIntent({ text: 'crea una imagen nueva de una ciudad' }), 'image-generation');

  const normalized = normalizeAlibabaConfig(ALIBABA_DEFAULT_CONFIG);
  assert.equal(normalized.endpoint, ALIBABA_TOKEN_PLAN_ENDPOINT);
  assert.equal(normalized.protocol, 'anthropic-compatible');
  assert.equal(normalized.mode, 'token-plan');
  assert.equal(normalized.billingMode, 'token-plan');
  assert.equal(normalized.models[0].id, ALIBABA_DEFAULT_MODEL_ID);
  assert.deepEqual(normalized.models.map(model => model.id), [
    'qwen3.7-max',
    'GLM-5.2',
    'deepseek-v4-pro',
    'qwen3.8-max-preview',
    'qwen3.7-plus',
    'qwen3.6-flash',
    'wan2.7-image',
    'wan2.7-image-pro',
    'happyhorse-1.1-t2v',
    'happyhorse-1.1-i2v',
    'happyhorse-1.1-r2v'
  ]);
  for (const model of normalized.models) {
    assert.equal(model.name, undefined);
    assert.equal(model.capabilities.tools, null);
  }
  assert.equal(normalized.models.find(model => model.id === 'qwen3.7-plus').capabilities.vision, true);
  assert.equal(normalized.models.find(model => model.id === 'qwen3.8-max-preview').capabilities.vision, true);
  assert.equal(normalized.models.find(model => model.id === 'qwen3.6-flash').capabilities.vision, true);
  assert.notEqual(normalized.models.find(model => model.id === 'qwen3.7-max').capabilities.vision, true);
  assert.equal(normalized.models.find(model => model.id === 'wan2.7-image').taskType, 'image-generation');
  assert.equal(normalized.models.find(model => model.id === 'happyhorse-1.1-t2v').taskType, 'video-generation');

  assert.equal(normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    endpoint: 'https://<workspace-id>.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
    workspace: ''
  }).endpoint, ALIBABA_TOKEN_PLAN_ENDPOINT);
  assert.throws(() => normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    billingMode: 'pay-as-you-go',
    endpoint: 'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
    workspace: ''
  }), /Workspace/);
  assert.throws(() => normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    endpoint: 'https://abc123.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages',
    workspace: 'abc123'
  }), /sin \/v1/);
  assert.throws(() => normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    endpoint: 'https://abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    workspace: 'abc123'
  }), /sin \/v1/);

  const payload = buildAnthropicMessagesPayload({
    model: {
      id: 'third-party/model',
      parameters: { max_tokens: 512, temperature: 0.2 }
    },
    messages: [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' }
    ],
    sanitize: false
  });
  assert.deepEqual(payload, {
    model: 'third-party/model',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 512,
    temperature: 0.2,
    system: 'System'
  });
  const visionPayload = buildAnthropicMessagesPayload({
    model: normalized.models.find(model => model.id === 'qwen3.7-plus'),
    messages: [{ role: 'user', content: 'Analiza la imagen' }],
    images: [{ mediaType: 'image/png', base64: 'aGVsbG8=' }],
    sanitize: false
  });
  assert.deepEqual(visionPayload.messages[0].content, [
    { type: 'text', text: 'Analiza la imagen' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
  ]);
  const urlVisionPayload = buildAnthropicMessagesPayload({
    model: normalized.models.find(model => model.id === 'qwen3.7-plus'),
    messages: [{ role: 'user', content: 'Analiza la imagen anterior' }],
    images: [{ url: 'https://example.test/generated.png' }],
    sanitize: false
  });
  assert.deepEqual(urlVisionPayload.messages[0].content[1], {
    type: 'image',
    source: { type: 'url', url: 'https://example.test/generated.png' }
  });
  assert.throws(() => buildAnthropicMessagesPayload({
    model: normalized.models.find(model => model.id === 'qwen3.7-max'),
    messages: [{ role: 'user', content: 'Analiza la imagen' }],
    images: [{ mediaType: 'image/jpeg', base64: 'aGVsbG8=' }],
    sanitize: false
  }), /qwen3\.7-plus/);
  assert.throws(() => buildAnthropicMessagesPayload({
    model: normalized.models.find(model => model.id === 'qwen3.7-plus'),
    messages: [{ role: 'user', content: 'Analiza la imagen' }],
    images: [{ mediaType: 'image/gif', base64: 'aGVsbG8=' }],
    sanitize: false
  }), /PNG, JPEG o WebP/);
  const repairedInvalidCatalog = normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    models: [{ id: 'unsafe', parameters: { model: 'override' } }]
  });
  assert(!repairedInvalidCatalog.models.some(model => model.id === 'unsafe'));
  assert(repairedInvalidCatalog.models.some(model => model.id === ALIBABA_DEFAULT_MODEL_ID));
  const repairedEmptyCatalog = normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    models: []
  });
  assert.equal(repairedEmptyCatalog.models.length, 11);
  const customCatalog = normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    models: [{ id: 'vendor/custom', parameters: { max_tokens: 256 } }]
  });
  assert(customCatalog.models.some(model => model.id === 'vendor/custom'));
  assert(customCatalog.models.some(model => model.id === ALIBABA_DEFAULT_MODEL_ID));
  const legacyCatalog = normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    models: [
      { id: 'wan2.7-image', parameters: { custom: true } },
      { id: 'vendor/custom', taskType: 'chat', parameters: { max_tokens: 256 } }
    ]
  });
  assert.equal(legacyCatalog.models.find(model => model.id === 'wan2.7-image').taskType, 'image-generation');
  assert.equal(legacyCatalog.models.find(model => model.id === 'wan2.7-image').parameters.custom, true);
  assert(legacyCatalog.models.some(model => model.id === 'vendor/custom'));
  assert.throws(() => normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    endpoint: 'http://workspace.example/apps/anthropic'
  }), /HTTPS/);

  const originalFetch = global.fetch;
  let capturedRequest;
  const requestedUrls = [];
  global.fetch = async (url, options) => {
    capturedRequest = { url, options };
    requestedUrls.push(url);
    if (url === ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output: { choices: [{ message: { content: [{ image: 'https://example.test/generated.png' }] } }] }
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'OK' }] })
    };
  };
  try {
    const response = await PROVIDERS.alibaba.chat({
      model: 'third-party/model',
      messages: [{ role: 'user', content: 'Hello' }],
      apiKey: 'test-key',
      sanitize: false,
      providerConfig: {
        ...ALIBABA_DEFAULT_CONFIG,
        models: [{
          id: 'third-party/model',
          capabilities: {},
          parameters: { max_tokens: 256 }
        }]
      }
    });
    assert.equal(capturedRequest.url, `${ALIBABA_TOKEN_PLAN_ENDPOINT}/v1/messages`);
    assert(!capturedRequest.url.includes('/v1/models'));
    assert.equal(capturedRequest.options.headers['x-api-key'], 'test-key');
    assert.equal(JSON.parse(capturedRequest.options.body).model, 'third-party/model');
    assert.equal(response.message.content, 'OK');

    await PROVIDERS.alibaba.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      apiKey: 'test-key',
      sanitize: false,
      providerConfig: ALIBABA_DEFAULT_CONFIG
    });
    assert.equal(JSON.parse(capturedRequest.options.body).model, ALIBABA_DEFAULT_MODEL_ID);
    assert(requestedUrls.every(url => url === `${ALIBABA_TOKEN_PLAN_ENDPOINT}/v1/messages`));

    const generated = await PROVIDERS.alibaba.generateImage({
      model: 'wan2.7-image',
      prompt: 'Un paisaje',
      apiKey: 'test-key',
      providerConfig: ALIBABA_DEFAULT_CONFIG
    });
    assert.equal(capturedRequest.url, ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT);
    assert(!capturedRequest.url.endsWith('/v1/messages'));
    assert.deepEqual(generated.images, ['https://example.test/generated.png']);
  } finally {
    global.fetch = originalFetch;
  }

  const connectTimeoutError = () => Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'UND_ERR_CONNECT_TIMEOUT', name: 'ConnectTimeoutError' }
  });
  let timeoutFetchCalls = 0;
  global.fetch = async () => {
    timeoutFetchCalls++;
    throw connectTimeoutError();
  };
  try {
    await assert.rejects(
      () => PROVIDERS.alibaba.generateImage({
        model: 'wan2.7-image',
        prompt: 'Una prueba de timeout',
        apiKey: 'test-key',
        providerConfig: ALIBABA_DEFAULT_CONFIG
      }),
      error => /No se pudo conectar con Alibaba Cloud Model Studio/.test(error.message)
        && !/fetch failed|UND_ERR|ConnectTimeoutError|attempted addresses/i.test(error.message)
    );
    assert.equal(timeoutFetchCalls, 2);
  } finally {
    global.fetch = originalFetch;
  }

  let retryFetchCalls = 0;
  let retryPayload = null;
  global.fetch = async (_url, options) => {
    retryFetchCalls++;
    if (retryFetchCalls === 1) throw connectTimeoutError();
    retryPayload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        output: { choices: [{ message: { content: [{ image: 'https://example.test/retry.png' }] } }] }
      })
    };
  };
  try {
    const retried = await PROVIDERS.alibaba.generateImage({
      model: 'wan2.7-image',
      prompt: 'Conservar la referencia',
      sourceImages: [{
        type: 'image',
        mediaType: 'image/jpeg',
        base64: 'aGVsbG8='
      }],
      apiKey: 'test-key',
      providerConfig: ALIBABA_DEFAULT_CONFIG
    });
    assert.equal(retryFetchCalls, 2);
    assert.deepEqual(retried.images, ['https://example.test/retry.png']);
    assert(/^data:image\/jpeg;base64,/.test(retryPayload.input.messages[0].content[0].image));
  } finally {
    global.fetch = originalFetch;
  }

  let unauthorizedFetchCalls = 0;
  global.fetch = async () => {
    unauthorizedFetchCalls++;
    return { ok: false, status: 401 };
  };
  try {
    await assert.rejects(
      () => PROVIDERS.alibaba.generateImage({
        model: 'wan2.7-image',
        prompt: 'No reintentar HTTP',
        apiKey: 'test-key',
        providerConfig: ALIBABA_DEFAULT_CONFIG
      }),
      error => /rechazó la autenticación/.test(error.message)
        && !/test-key/.test(error.message)
    );
    assert.equal(unauthorizedFetchCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }

  global.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({
      error: { message: 'Modelo incompatible', code: 'InvalidParameter' },
      request_id: 'req-test-123'
    })
  });
  try {
    await assert.rejects(
      () => PROVIDERS.alibaba.chat({
        model: 'qwen3.7-max',
        messages: [{ role: 'user', content: 'Hola' }],
        apiKey: 'test-key',
        sanitize: false,
        providerConfig: ALIBABA_DEFAULT_CONFIG
      }),
      error => /respondió con estado HTTP 400/.test(error.message)
        && !/Modelo incompatible|InvalidParameter|req-test-123/.test(error.message)
        && !/test-key/.test(error.message)
    );
  } finally {
    global.fetch = originalFetch;
  }

  const db = createDb();
  const manager = new AIProviderManager(db);
  manager.setProvider('openai');
  const unsupportedOpenAiRoute = manager.routeIntent({
    text: 'crea una imagen de prueba',
    currentModel: 'gpt-4o'
  });
  assert.equal(unsupportedOpenAiRoute.action, 'unsupported');
  assert.equal(unsupportedOpenAiRoute.validation.valid, false);
  await assert.rejects(
    () => manager.generateImage({ model: 'unsupported', prompt: 'no ejecutar' }),
    /proveedor actual no soporta generación de imágenes/
  );
  manager.setProvider('alibaba');
  manager.apiKeys.alibaba = 'test-key';
  const routedCritical = manager.routeIntent({
    text: criticalText,
    chatId: 'chat-a',
    lastUploadedImage: sameChatImage,
    currentModel: ''
  });
  assert.equal(routedCritical.intent, 'image-edit');
  assert.equal(routedCritical.action, 'generate-image');
  assert.notEqual(routedCritical.model, 'qwen3.7-max');
  assert.equal(routedCritical.model, 'wan2.7-image');
  assert.equal(routedCritical.options, null);
  assert.equal(routedCritical.detailed.usesPreviousImageContext, true);
  assert(routedCritical.plan.operations.includes('background-change'));
  assert.match(routedCritical.modelPrompt, /Preservar: content-readability/);
  assert.match(routedCritical.generationPrompt, /Restricciones obligatorias: avoid-gray/);
  assert.equal(routedCritical.visualExecution.validation.valid, true);
  assert.equal(routedCritical.visualExecution.plan, routedCritical.plan);
  const originalAlibabaChat = PROVIDERS.alibaba.chat;
  const originalAlibabaGenerateImage = PROVIDERS.alibaba.generateImage;
  let managerChatCalls = 0;
  let managerGenerationCalls = 0;
  PROVIDERS.alibaba.chat = async () => {
    managerChatCalls++;
    return {
      message: { role: 'assistant', content: '' },
      blockedToolUse: { name: 'generate_image', input: { prompt: 'ignorar este prompt' } }
    };
  };
  PROVIDERS.alibaba.generateImage = async params => {
    managerGenerationCalls++;
    assert.equal(params.prompt, routedCritical.visualExecution.generationPrompt);
    assert.equal(params.apiKey, 'test-key');
    assert.deepEqual(params.providerConfig, manager.getProviderConfig('alibaba'));
    return { images: ['https://example.test/manager-terminal.png'] };
  };
  try {
    const directGeneration = await manager.generateImage({
      model: 'wan2.7-image',
      prompt: routedCritical.visualExecution.generationPrompt
    });
    assert.deepEqual(directGeneration.images, ['https://example.test/manager-terminal.png']);
    const terminalFromManager = await manager.chat({
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: criticalText }],
      visualExecution: routedCritical.visualExecution
    });
    assert.equal(managerChatCalls, 1);
    assert.equal(managerGenerationCalls, 2);
    assert.equal(terminalFromManager.terminalType, 'image');
    assert.deepEqual(terminalFromManager.images, ['https://example.test/manager-terminal.png']);
    // Sin plan generativo, un tool_use del proveedor nunca produce imagen.
    await assert.rejects(
      () => manager.chat({
        model: 'qwen3.7-plus',
        messages: [{ role: 'user', content: criticalText }]
      }),
      /herramienta visual fuera de la tarea solicitada/
    );
    assert.equal(managerGenerationCalls, 2);
    await assert.rejects(
      () => manager.chat({
        model: 'qwen3.7-plus',
        messages: [{ role: 'user', content: criticalText }],
        visualExecution: {
          plan: { mode: 'vision-analysis' },
          validation: { valid: true },
          model: 'wan2.7-image',
          generationPrompt: 'genera una imagen'
        }
      }),
      /herramienta visual fuera de la tarea solicitada/
    );
    assert.equal(managerGenerationCalls, 2);
    // Con texto disponible, se devuelve el texto en lugar de ejecutar la herramienta.
    PROVIDERS.alibaba.chat = async () => ({
      message: { role: 'assistant', content: 'El código llama a generate_image en la línea 12.' },
      blockedToolUse: { name: 'generate_image', input: { prompt: 'ignorar' } }
    });
    const analysisFallback = await manager.chat({
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: criticalText }],
      visualExecution: {
        plan: { mode: 'vision-analysis' },
        validation: { valid: true },
        model: 'wan2.7-image'
      }
    });
    assert.equal(analysisFallback.terminalType, undefined);
    assert.equal(analysisFallback.images, undefined);
    assert.equal(analysisFallback.message.content, 'El código llama a generate_image en la línea 12.');
    assert.equal(managerGenerationCalls, 2);
  } finally {
    PROVIDERS.alibaba.chat = originalAlibabaChat;
    PROVIDERS.alibaba.generateImage = originalAlibabaGenerateImage;
  }
  const routedImplicitEdit = manager.routeIntent({
    text: implicitEditText,
    chatId: 'chat-visual',
    lastAnalyzedImage: analyzedImage,
    currentModel: ''
  });
  assert.equal(routedImplicitEdit.intent, 'image-edit');
  assert.equal(routedImplicitEdit.action, 'generate-image');
  assert.equal(routedImplicitEdit.visualContext.source, 'previous-analyzed-image');
  assert.notEqual(routedImplicitEdit.model, 'qwen3.7-max');
  // --- REGRESIÓN: creación desde cero en un chat CON historial visual -------
  // Caso real: en el chat donde antes se generó una tarjeta Razer, pedir "crea
  // una imagen de una chica en la oficina…" devolvía otra tarjeta Razer. El
  // mismo texto en un chat nuevo funcionaba. Causa: el texto activaba a la vez
  // `referencesPrevious` (por el artículo "la" de "en la oficina") y
  // `hasImplicitVisualSignal` (por "imagen", "rojo", "azul"), y el resolutor
  // entregaba lastGeneratedImage como fuente.
  const razerCard = {
    name: 'razer-card.png',
    chatId: 'chat-razer',
    base64: 'cmF6ZXI=',
    mediaType: 'image/png',
    visualEntryId: 've-razer',
    updatedAt: 2000
  };
  const officeRequest = 'crea una imagen de una chica en la oficina tomando café, '
    + 'con la blusa rojo con azul y pantalón amarillo';

  const routedFromScratch = manager.routeIntent({
    text: officeRequest,
    chatId: 'chat-razer',
    lastGeneratedImage: razerCard,
    lastUserImage: razerCard,
    lastUploadedImage: razerCard,
    lastAnalyzedImage: razerCard,
    currentModel: ''
  });
  assert.equal(routedFromScratch.intent, 'image-generation', 'debe crear, no editar');
  assert.equal(routedFromScratch.plan.mode, 'image-generation');
  assert.equal(routedFromScratch.plan.createFromScratch, true);
  assert.equal(routedFromScratch.plan.sourceImage, null, 'plan.sourceImage debe ser null');
  assert.equal(routedFromScratch.visualContext.hasVisualContext, false);
  assert.equal(routedFromScratch.visualContext.imageRef, null);
  assert.equal(routedFromScratch.visualContext.policy, 'forbidden-historical-reference');
  // Lo que el renderer usará como sourceImages: `plan.sourceImage || imageRef`.
  const fromScratchSources = routedFromScratch.visualExecution?.plan?.sourceImage
    || routedFromScratch.visualContext?.imageRef
    || null;
  assert.deepEqual(fromScratchSources ? [fromScratchSources] : [], [], 'sourceImages debe ir vacío');

  const fromScratchPrompt = routedFromScratch.modelPrompt || '';
  for (const term of ['chica', 'oficina', 'café', 'rojo', 'azul', 'amarillo']) {
    assert(fromScratchPrompt.toLowerCase().includes(term), `el prompt conserva "${term}"`);
  }
  assert(!/razer/i.test(fromScratchPrompt), 'el prompt no menciona la imagen anterior');
  assert(!/conserva|preserva|manten|identidad|composicion anterior|misma composici/i.test(fromScratchPrompt),
    'el prompt no pide preservar identidad ni composición previa');
  assert.notEqual(routedFromScratch.action, 'unsupported',
    'una orden clara no debe pedir aclaración');
  assert.equal(routedFromScratch.plan.needsClarification, false);

  // 4. Chat NUEVO, misma petición → mismo routing.
  const routedNewChat = manager.routeIntent({
    text: officeRequest, chatId: 'chat-nuevo', currentModel: ''
  });
  assert.equal(routedNewChat.intent, routedFromScratch.intent,
    'el resultado no puede depender del historial del chat');
  assert.equal(routedNewChat.plan.createFromScratch, true);
  assert.equal(routedNewChat.plan.sourceImage, null);

  // 5. Contraste en el MISMO chat: una orden anafórica sí resuelve la tarjeta.
  const routedAnaphoric = manager.routeIntent({
    text: 'cambia esta tarjeta a verde',
    chatId: 'chat-razer',
    lastGeneratedImage: razerCard,
    currentModel: ''
  });
  assert.equal(routedAnaphoric.intent, 'image-edit', 'la anáfora sigue editando');
  assert.equal(routedAnaphoric.visualContext.hasVisualContext, true);
  assert.equal(routedAnaphoric.visualContext.imageRef.name, 'razer-card.png',
    'y usa exactamente la tarjeta anterior');
  assert.equal(routedAnaphoric.plan.createFromScratch, undefined,
    'un plan de edición no declara creación desde cero');

  // Las demás instrucciones anafóricas no pueden romperse.
  for (const [texto, esperado] of [
    ['ahora ponlo verde', true],
    ['cámbiala', true],
    ['haz otra versión', true],
    ['usa la imagen anterior', true],
    ['conserva la composición', true],
    ['rediseña este logo', true]
  ]) {
    const routed = manager.routeIntent({
      text: texto, chatId: 'chat-razer', lastGeneratedImage: razerCard, currentModel: ''
    });
    assert.equal(routed.visualContext.hasVisualContext, esperado,
      `"${texto}" debe seguir resolviendo la imagen previa`);
    assert.notEqual(routed.plan?.createFromScratch, true,
      `"${texto}" no puede clasificarse como creación desde cero`);
  }

  // "haz una mejor" es ambigua por diseño: NO es creación desde cero (no puede
  // ignorar el historial) pero tampoco se fuerza a editar — queda para el camino
  // de aclaración, que es donde corresponde.
  const routedAmbiguous = manager.routeIntent({
    text: 'haz una mejor', chatId: 'chat-razer', lastGeneratedImage: razerCard, currentModel: ''
  });
  assert.notEqual(routedAmbiguous.plan?.createFromScratch, true,
    'una frase ambigua no puede clasificarse como creación desde cero');

  // --- Borde 1: política del ADJUNTO DEL TURNO -----------------------------
  // currentImage se devolvía antes de aplicar la política, así que una creación
  // autosuficiente con un adjunto no mencionado lo convertía en edición.
  const attachedCard = {
    type: 'image', name: 'razer-card.png', chatId: 'chat-razer',
    base64: 'cmF6ZXI=', mediaType: 'image/png', visualEntryId: 've-razer'
  };
  const routedUnmentioned = manager.routeIntent({
    text: 'crea una imagen de una chica en una oficina tomando café',
    chatId: 'chat-razer',
    attachments: [attachedCard],
    currentModel: ''
  });
  assert.equal(routedUnmentioned.intent, 'image-generation');
  assert.equal(routedUnmentioned.plan.sourceImage, null, 'plan.sourceImage null');
  assert.equal(routedUnmentioned.visualContext.hasVisualContext, false);
  assert.equal(routedUnmentioned.visualContext.policy, 'forbidden-unmentioned-attachment');
  assert.equal(
    (routedUnmentioned.visualExecution?.plan?.sourceImage
      || routedUnmentioned.visualContext?.imageRef || null), null,
    'sourceImages queda vacío: el adjunto no se usa en silencio'
  );

  // D: referencia explícita al adjunto → se usa.
  const routedRequired = manager.routeIntent({
    text: 'usa esta imagen como referencia para crear una oficina',
    chatId: 'chat-razer', attachments: [attachedCard], currentModel: ''
  });
  assert.equal(routedRequired.visualContext.hasVisualContext, true);
  assert.equal(routedRequired.visualContext.source, 'current-attachment');
  assert.equal(routedRequired.visualContext.policy, 'required-current-attachment');
  assert.equal(routedRequired.visualContext.imageRef.name, 'razer-card.png');

  // Exclusión explícita del adjunto.
  const routedForbidden = manager.routeIntent({
    text: 'crea desde cero un logo, sin usar la imagen',
    chatId: 'chat-razer', attachments: [attachedCard], currentModel: ''
  });
  assert.equal(routedForbidden.visualContext.hasVisualContext, false);
  assert.equal(routedForbidden.visualContext.policy, 'forbidden-current-attachment');

  // Sin orden de creación, el adjunto sigue siendo el contexto natural.
  const routedPlainAttachment = manager.routeIntent({
    text: 'ponlo verde', chatId: 'chat-razer', attachments: [attachedCard], currentModel: ''
  });
  assert.equal(routedPlainAttachment.visualContext.source, 'current-attachment',
    'sin creación autosuficiente el adjunto no cambia de comportamiento');

  // --- Borde 2: "nueva/otra IMAGEN" no es anáfora --------------------------
  for (const texto of [
    'crea una nueva imagen de una playa',
    'genera otra imagen de una ciudad futurista'
  ]) {
    const routed = manager.routeIntent({
      text: texto, chatId: 'chat-razer', lastGeneratedImage: razerCard, currentModel: ''
    });
    assert.equal(routed.plan?.createFromScratch, true, `"${texto}" es creación, no anáfora`);
    assert.equal(routed.visualContext.hasVisualContext, false);
    assert.equal(
      (routed.visualExecution?.plan?.sourceImage || routed.visualContext?.imageRef || null),
      null, `"${texto}" no arrastra la tarjeta`);
  }

  // Pero "otra VERSIÓN" y "basada en la anterior" siguen siendo anáfora.
  const routedOtherVersion = manager.routeIntent({
    text: 'crea otra versión de esta tarjeta',
    chatId: 'chat-razer', lastGeneratedImage: razerCard, currentModel: ''
  });
  assert.equal(routedOtherVersion.intent, 'image-variation');
  assert.equal(routedOtherVersion.visualContext.imageRef.name, 'razer-card.png');

  const routedBasedOn = manager.routeIntent({
    text: 'crea otra imagen basada en la anterior',
    chatId: 'chat-razer', lastGeneratedImage: razerCard, currentModel: ''
  });
  assert.equal(routedBasedOn.visualContext.hasVisualContext, true,
    '"basada en la anterior" sí resuelve la imagen previa');
  assert.equal(routedBasedOn.visualContext.imageRef.name, 'razer-card.png');

  for (const texto of ['crea otra versión', 'con esos cambios', 'mantén la composición']) {
    const routed = manager.routeIntent({
      text: texto, chatId: 'chat-razer', lastGeneratedImage: razerCard, currentModel: ''
    });
    assert.notEqual(routed.plan?.createFromScratch, true,
      `"${texto}" debe seguir siendo anafórico`);
  }

  // Órdenes autosuficientes en varias formas.
  for (const texto of [
    'genera una escena de un bosque nevado',
    'dibuja un gato naranja',
    'crea una fotografía de un coche antiguo',
    'crea desde cero un logo minimalista'
  ]) {
    const routed = manager.routeIntent({
      text: texto, chatId: 'chat-razer', lastGeneratedImage: razerCard, currentModel: ''
    });
    assert.equal(routed.visualContext.hasVisualContext, false,
      `"${texto}" no puede heredar la imagen del historial`);
    assert.equal(routed.plan?.createFromScratch, true,
      `"${texto}" debe declarar createFromScratch`);
  }

  const routedVariation = manager.routeIntent({
    text: 'haz una versión más moderna de esta imagen',
    lastUploadedImage: previousImage,
    currentModel: ''
  });
  assert.equal(routedVariation.intent, 'image-variation');
  assert.equal(routedVariation.action, 'generate-image');
  assert.equal(routedVariation.plan.mode, 'image-variation');
  const routedSuggestionsVariation = manager.routeIntent({
    text: applySuggestionsText,
    chatId: 'chat-suggestions',
    lastUserImage: suggestionsSourceImage,
    lastVisualAnalysis: previousVisualAnalysis,
    currentModel: ''
  });
  assert.equal(routedSuggestionsVariation.intent, 'image-variation');
  assert.equal(routedSuggestionsVariation.action, 'generate-image');
  assert.equal(routedSuggestionsVariation.model, 'wan2.7-image');
  assert.equal(routedSuggestionsVariation.options, null);
  assert.equal(routedSuggestionsVariation.validation.valid, true);
  assert(!/Puedo:\s*1\./.test(routedSuggestionsVariation.message || ''));
  assert.match(routedSuggestionsVariation.generationPrompt, /Sugiero mejorar la composición/);
  const routedWithoutAnalysis = manager.routeIntent({
    text: applySuggestionsText,
    chatId: 'chat-suggestions',
    lastUserImage: suggestionsSourceImage,
    currentModel: ''
  });
  assert.equal(routedWithoutAnalysis.intent, 'ambiguous-visual');
  assert.equal(routedWithoutAnalysis.action, 'unsupported');
  assert.match(routedWithoutAnalysis.message, /Indica cambios concretos/);
  assert(!/Puedo:\s*1\./.test(routedWithoutAnalysis.message));
  const routedWithoutReference = manager.routeIntent({
    text: applySuggestionsText,
    chatId: 'chat-no-reference',
    currentModel: ''
  });
  assert.equal(routedWithoutReference.action, 'error');
  assert.match(routedWithoutReference.message, /falta una imagen de referencia/);
  const initialModels = await manager.listModels();
  const expectedChatModels = normalized.models
    .filter(model => ['chat', 'vision'].includes(model.taskType))
    .map(model => model.id);
  assert.deepEqual(initialModels.models.map(model => model.name), expectedChatModels);
  assert(initialModels.models.every(model => model.capabilities && model.parameters));
  assert(!initialModels.models.some(model => model.name.startsWith('wan')));
  assert(!initialModels.models.some(model => model.name.startsWith('happyhorse-')));
  assert(initialModels.models.find(model => model.name === 'qwen3.7-plus').supportsVision);
  assert(manager.getProviderConfig('alibaba').models.some(model =>
    model.id === 'wan2.7-image' && model.taskType === 'image-generation'
  ));
  let forbiddenFetchCalled = false;
  global.fetch = async () => {
    forbiddenFetchCalled = true;
    throw new Error('fetch no debe ejecutarse');
  };
  await assert.rejects(
    () => manager.chat({ model: 'wan2.7-image', messages: [{ role: 'user', content: 'Crea una imagen' }] }),
    /Usa generateImage/
  );
  await assert.rejects(
    () => manager.chat({ model: 'happyhorse-1.1-t2v', messages: [{ role: 'user', content: 'Crea un video' }] }),
    /no puede usarse en chat/
  );
  assert.equal(forbiddenFetchCalled, false);
  global.fetch = originalFetch;
  const warning = manager.setApiKey('alibaba', 'not-a-token-plan-key');
  assert.equal(warning.warning, 'Para Token Plan normalmente la clave debe empezar con sk-sp-');
  manager.addProviderModel('alibaba', {
    id: 'vendor/custom-model',
    displayName: 'Custom',
    capabilities: { tools: false, vision: true },
    parameters: { max_tokens: 1024 }
  });
  let config = manager.getProviderConfig('alibaba');
  assert(config.models.some(model => model.id === 'vendor/custom-model'));

  manager.updateProviderModel('alibaba', 'vendor/custom-model', {
    id: 'vendor/custom-model-v2',
    capabilities: { reasoning: true },
    parameters: {}
  });
  config = manager.getProviderConfig('alibaba');
  assert(config.models.some(model => model.id === 'vendor/custom-model-v2'));
  assert(!config.models.some(model => model.id === 'vendor/custom-model'));

  manager.deleteProviderModel('alibaba', 'vendor/custom-model-v2');
  config = manager.getProviderConfig('alibaba');
  assert(!config.models.some(model => model.id === 'vendor/custom-model-v2'));
  assert(db.values.has('alibaba_config'));

  const listed = await manager.listModels();
  assert(listed.models.every(model => ['chat', 'vision'].includes(model.taskType)));
  assert.equal(manager.getProvider().name, 'Alibaba Cloud Model Studio');

  const rendererSource = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
  const providerSource = fs.readFileSync(require.resolve('../src/main/ai-providers.js'), 'utf8');
  const sendGuard = rendererSource.indexOf('Este modelo se usa desde Crear imagen, no desde chat.');
  const chatCall = rendererSource.indexOf('window.mika5.ai.chat(payload)', sendGuard);
  assert(sendGuard >= 0 && chatCall > sendGuard);
  assert(rendererSource.includes("!['chat', 'vision'].includes(m.taskType)"));
  const generateRoute = rendererSource.indexOf("route.action === 'generate-image'");
  const generateCall = rendererSource.indexOf('window.mika5.ai.generateImage', generateRoute);
  const routedChatCall = rendererSource.indexOf('window.mika5.ai.chat(payload)', generateRoute);
  assert(generateRoute >= 0 && generateCall > generateRoute && routedChatCall > generateCall);
  const terminalReturn = rendererSource.indexOf('\n        return;', generateCall);
  assert(terminalReturn > generateCall && terminalReturn < routedChatCall);
  assert(rendererSource.includes('lastVisualAnalysis: visualContextMemory.lastVisualAnalysis'));
  assert(rendererSource.includes('registerLastVisualAnalysis({'));
  assert(rendererSource.includes("routedIntent === 'image-variation'"));
  assert(rendererSource.includes('No se pudo generar la nueva imagen:'));
  assert(rendererSource.includes("['image-edit', 'image-variation'].includes(routedIntent)"));
  assert(rendererSource.includes("automatic.textContent = 'Automático'"));
  assert(rendererSource.includes('Usando qwen3.7-plus para analizar imágenes.'));
  assert(rendererSource.includes('appendControlledIntentResponse(text, route.message'));
  assert(rendererSource.includes('let pendingVisualAction = null'));
  assert(rendererSource.includes('handlePendingVisualActionReply(text)'));
  assert(rendererSource.includes("window.mika5.ai.generateImage({ model: 'wan2.7-image', prompt })"));
  assert(rendererSource.includes("model: 'qwen3.7-plus'"));
  assert(rendererSource.includes('pendingVisualAction = null'));
  assert(rendererSource.includes('safeAssistantContent(out.message.content)'));
  assert(!rendererSource.includes("out.blockedToolUse?.name === 'generate_image'"));
  assert(rendererSource.includes("out.terminalType === 'image'"));
  assert(rendererSource.includes('No se pudo generar la imagen:'));
  assert(!rendererSource.includes('Reintentando por el flujo correcto...'));
  assert(rendererSource.includes('lastUserImage'));
  for (const field of ['id:', 'chatId,', 'role,', 'origin,', 'createdAt,', 'sourceVisualEntryId']) {
    assert(rendererSource.includes(field));
  }
  for (const origin of ['user-upload', 'vision-analysis', 'image-generation', 'image-edit']) {
    assert(rendererSource.includes(`'${origin}'`));
  }
  assert(rendererSource.includes('terminalImageAnswer(generated.images)'));
  assert(rendererSource.includes("Store.addMessage(activeChatId, 'assistant', answer"));
  assert(rendererSource.includes('modelName !== AUTOMATIC_MODEL_ID'));
  assert(rendererSource.includes('shouldWarnImageCapability(currentModel)'));
  assert(!rendererSource.includes('if (!modelSupportsVision(currentModel))'));
  assert(!rendererSource.includes('Advertencia: "__automatic__"'));
  assert(providerSource.includes('La generación de video está disponible próximamente en MIKA5.'));
  assert(!/console\.(?:log|warn|error)\([^)]*apiKey/i.test(providerSource));

  console.log('Alibaba provider tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
