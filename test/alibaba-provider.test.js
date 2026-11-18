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
  for (const providerId of ['local', 'openai', 'anthropic', 'groq', 'moonshot', 'llamacpp', 'bitnet']) {
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
  assert(warning.warning.includes('Para Token Plan normalmente la clave debe empezar con sk-sp-'));
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

  // Normalizado a LF en memoria: el checkout puede materializar CRLF en Windows.
  const { readRendererSource } = require('./helpers/renderer-source');
  const renderer = readRendererSource(require.resolve('../src/renderer/app.js'));
  const rendererSource = renderer.text;
  // Los adaptadores viven en src/main/providers/ desde la extracción, pero los
  // helpers de configuración de Alibaba siguen en ai-providers.js. Las
  // comprobaciones estructurales miran los dos concatenados, para no depender
  // de en cuál de los dos ficheros acabe cada fragmento.
  const providerSource = [
    require.resolve('../src/main/ai-providers.js'),
    require.resolve('../src/main/providers/alibaba.js')
  ].map(ruta => fs.readFileSync(ruta, 'utf8')).join('\n');
  const sendGuard = rendererSource.indexOf('Este modelo se usa desde Crear imagen, no desde chat.');
  const chatCall = rendererSource.indexOf('sendAIChat(payload)', sendGuard);
  assert(sendGuard >= 0 && chatCall > sendGuard);
  assert(rendererSource.includes("!['chat', 'vision'].includes(m.taskType)"));
  const generateRoute = rendererSource.indexOf("route.action === 'generate-image'");
  const generateCall = rendererSource.indexOf('sendAIImage', generateRoute);
  const routedChatCall = rendererSource.indexOf('sendAIChat(payload)', generateRoute);
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
  assert((rendererSource.match(/sourceImages: sourceImage \? \[sourceImage\] : \[\]/g) || []).length >= 2);
  assert(rendererSource.includes('sendAIImage(generationPayload)'));
  assert(rendererSource.includes('requestId: requestContext.requestId'));
  const pendingHandlerStart = rendererSource.indexOf('async function handlePendingVisualActionReply');
  const pendingHandlerEnd = rendererSource.indexOf('\nasync function send()', pendingHandlerStart);
  const pendingHandlerSource = rendererSource.slice(pendingHandlerStart, pendingHandlerEnd);
  // El handler ya no lleva sus regex dentro: depende de parsePendingVisualActionReply.
  // Todo arnés que inyecte el handler debe inyectar antes este bloque.
  const pendingParserSource = rendererSource.slice(
    rendererSource.indexOf('const PENDING_REPLY_LEAD'),
    rendererSource.indexOf('async function handlePendingVisualActionReply')
  )
    // El handler adjunta la imagen fuente a la burbuja del usuario...
    + sliceRendererFunction('snapshotMessageAttachments')
    // ...y persiste el turno ANTES de consumir la acción o llamar al proveedor.
    // Bloque completo de la barrera transaccional: tabla de errores,
    // persistUserTurn, persistAssistantTurn y la cola de reintentos.
    + rendererSource.slice(
      rendererSource.indexOf('const ATTACHMENT_SAVE_ERRORS = {'),
      rendererSource.indexOf('// Forma mínima con la que un adjunto viaja a la BD')
    );
  assert(pendingHandlerSource.includes('model: generationModel'));
  assert(pendingHandlerSource.includes('model: visionModel'));
  assert(!pendingHandlerSource.includes("model: 'wan2.7-image'"));
  assert(rendererSource.includes('pendingVisualAction = null'));
  assert(rendererSource.includes('safeAssistantContent(out.message.content)'));
  assert(!rendererSource.includes("out.blockedToolUse?.name === 'generate_image'"));
  assert(rendererSource.includes("out.terminalType === 'image'"));
  const terminalImageStart = rendererSource.indexOf("if (out.terminalType === 'image')");
  const terminalImageEnd = rendererSource.indexOf("if (routedIntent === 'vision-analysis'", terminalImageStart);
  const terminalImageSource = rendererSource.slice(terminalImageStart, terminalImageEnd);
  assert(terminalImageSource.includes('const terminalModel ='));
  assert(!terminalImageSource.includes("|| 'wan2.7-image'"));
  assert(rendererSource.includes('Adjunto: ${att.name'));
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
  assert(rendererSource.includes("Store.addMessage(requestContext.chatId, 'assistant', answer"));
  // "Automático" es un alias del router: nunca debe contar como modelo sin visión.
  assert(rendererSource.includes("model === AUTOMATIC_MODEL_ID) return null"));
  assert(!rendererSource.includes('Advertencia: "__automatic__"'));
  // AUD-006: adjuntar se BLOQUEA, no se advierte. Ambos puntos de entrada
  // (selector de archivos y pegado) deben cortar el flujo con `continue`.
  // Tres puntos de entrada (selector, pegado, envío) que atraviesan DOS llamadas:
  // los dos de adjuntado comparten processImageAttachment, el tercero es el envío.
  // Se descuenta la declaración: solo cuentan las invocaciones.
  assert.equal(rendererSource.split('visionBlockReason({').length - 2, 2,
    'una sola comprobación por camino: adjuntado compartido + envío');
  assert(rendererSource.includes('await visionBlockReason({ provider: originProviderId, model })'));
  assert(rendererSource.includes('visionBlockReason({ provider: providerId, model })'),
    'el camino de adjuntado comprueba capacidad con el proveedor explícito');
  // La barrera de envío corta de verdad: showToast sin `return` dejaría pasar
  // la imagen hasta el consentimiento y la red.
  const sendBarrier = rendererSource.slice(
    rendererSource.indexOf('await visionBlockReason({ provider: originProviderId, model })')
  ).slice(0, 400);
  assert(/if \(blocked\) \{[\s\S]*?return;[\s\S]*?\}/.test(sendBarrier),
    'la barrera de envío debe terminar en `return;`');
  // Identidad explícita: capturada antes de todo await y reverificada después.
  assert.equal(rendererSource.split('const attachContext = captureAttachmentContext();').length - 1, 2);
  // processImageAttachment revalida DOS veces: tras la huella+capacidad y tras
  // leer el base64. Ambas son awaits en los que la usuaria puede cambiar de chat.
  assert.equal(
    rendererSource.split('if (attachmentContextChanged(context)) return { ok: false, code: \'aborted\' };').length - 1,
    2
  );
  assert(rendererSource.includes('resolveVision?.({ provider, model })'));
  assert(!rendererSource.includes('resolveVision?.({ model: modelName })'),
    'el proveedor no puede quedar implícito en this.currentProvider');
  // Una intención rechazada SOBREVIVE al cambio de modelo. Purgarla reabría
  // AUD-006: el registro desaparecía, la imagen nunca estuvo adjunta, el texto
  // seguía ahí y la petición salía sin la imagen que se quería analizar.
  assert(!rendererSource.includes('purgeStaleRejections'),
    'los rechazos no pueden purgarse por cambio de modelo');
  // 1 definición + 2 caminos de selección (dropdown propio y selectModel()).
  assert.equal(rendererSource.split('onSelectedModelChanged()').length - 1, 3);
  // Solo dos resoluciones explícitas desbloquean el envío.
  assert(rendererSource.includes('function resolveRejectedImage(chatId, fingerprint)'));
  assert(rendererSource.includes('function discardRejectedImage(id)'),
    'se descarta por id, no por nombre');
  // pendingRejectedImages es un getter puro: leer el estado no lo destruye.
  const rejectionGetter = rendererSource.slice(
    rendererSource.indexOf('function pendingRejectedImages(')
  ).slice(0, 200);
  assert(!/rejectedImageAttachments\s*=/.test(rejectionGetter),
    'pendingRejectedImages no debe mutar el estado');
  // Camino único: selector y pegado comparten flujo. Dos copias permitían que
  // una olvidara resolver el rechazo pendiente sin que ningún test lo notara.
  assert(rendererSource.includes('async function processImageAttachment('));
  assert.equal(rendererSource.split('await processImageAttachment({').length - 1, 2,
    'exactamente dos puntos de entrada: selector de archivos y pegado');
  assert(rendererSource.includes('resolveRejectedImage(chatId, fingerprint);'),
    'la resolución ocurre DENTRO del camino productivo, no solo en los tests');
  // Identidad por contenido y estable entre intentos: una huella aleatoria por
  // operación impedía para siempre resolver un pegado rechazado.
  assert(rendererSource.includes('async function imageContentFingerprint(file)'));
  assert(rendererSource.includes("crypto.subtle.digest('SHA-256', bytes)"));
  // Falla en cerrado sin WebCrypto: una huella ambigua podría resolver el
  // rechazo equivocado, que es peor que no poder adjuntar.
  assert(rendererSource.includes("throw new Error('WEBCRYPTO_UNAVAILABLE')"));
  assert(!rendererSource.includes('meta:${file.name}'),
    'sin hash no puede haber huella degradada por metadatos');
  // El contrato devuelve un resultado, nunca una promesa rechazada.
  assert(rendererSource.includes("return { ok: false, code: 'error' };"));
  assert.equal(rendererSource.split("outcome.code === 'error'").length - 1, 2,
    'ambos wrappers deben informar del fallo sin perder el texto');
  assert(!rendererSource.includes('pastedImageFingerprint'),
    'ninguna huella puede ser aleatoria por operación');
  // Cambiar de chat no puede destruir la intención pendiente: resetViewState()
  // conserva el borrador (texto y adjuntos), así que borrar el rechazo ahí
  // devolvería el "analiza esto" sin el bloqueo.
  assert(!rendererSource.slice(
    rendererSource.indexOf('function resetViewState()'),
    rendererSource.indexOf('function resetViewState()') + 900
  ).includes('clearRejectedImages'),
    'resetViewState no puede borrar rechazos: los registros ya van por chatId');
  assert(rendererSource.includes('current.providerId === providerId'),
    'el proveedor forma parte de la identidad del rechazo');
  assert(rendererSource.includes('current.fingerprint === fingerprint'),
    'la deduplicación es por fingerprint, no por nombre');
  assert(!/existing\.(chatId|model|name) === (chatId|model|name)/.test(rendererSource),
    'no puede quedar deduplicación por nombre');
  assert(!rendererSource.includes('shouldWarnImageCapability'));
  assert(!rendererSource.includes('Considera usar un modelo con visión'));
  // La heurística por nombre no puede reaparecer en el renderer.
  for (const pattern of ["'llava'", "'kimi'", "'glm'", "'gpt-4o'", "'claude-3'"]) {
    assert(!rendererSource.includes(pattern), `heurística de visión por nombre reintroducida: ${pattern}`);
  }
  assert(rendererSource.includes("opt?.dataset.vision === '1'"));
  // El renderer no puede tener su propia allowlist: consulta al proceso principal,
  // que resuelve con el mismo código que la barrera de los adapters.
  assert(rendererSource.includes('window.mika5?.ai?.resolveVision?.({ provider, model })'));
  // El aviso de truncamiento se apoya en el campo NORMALIZADO. Comparar contra
  // 'max_tokens' solo funcionaba con Alibaba y dejaba mudos a los otros seis.
  assert(rendererSource.includes("if (finishReason !== 'length' || !requestContext) return false;"));
  assert(rendererSource.includes('appendOutputLimitNotice(out.finishReason, requestContext)'));
  assert(!rendererSource.includes('out.stopReason'));
  // El descarte silencioso en el envío queda prohibido: ya no existe la degradación
  // "el modelo no soporta imágenes → se envía solo el texto".
  assert(!rendererSource.includes('Se envió solo el texto'));
  assert(!rendererSource.includes('pero el modelo no soporta visión]'));
  assert(providerSource.includes('La generación de video está disponible próximamente en MIKA5.'));
  assert(!providerSource.includes('La generación de imagen requiere Alibaba Cloud Model Studio'));
  assert(providerSource.includes('fetchWithProviderRetry(`${config.endpoint}/v1/messages`'));
  assert(providerSource.includes('fetchWithProviderRetry(ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT'));
  assert(rendererSource.includes('function sanitizeRemoteErrorMessage(message)'));
  assert(rendererSource.includes("replace(/Error invoking remote method ['\"]ai:"));
  assert(rendererSource.includes('sanitizeRemoteErrorMessage(error?.message || error)'));
  assert(!/console\.(?:log|warn|error)\([^)]*apiKey/i.test(providerSource));

  // ---------------------------------------------------------------------------
  // Barreras contra generación de imagen durante análisis de código.
  // Se evalúa el código real del renderer, extraído de src/renderer/app.js.
  // ---------------------------------------------------------------------------
  const GENERATIVE_VISUAL_MODES_TEST = ['image-generation', 'image-edit', 'image-variation'];
  // Las funciones de nivel superior de app.js cierran con '}' en la columna 0.
  // No se cuentan llaves porque los regex del código las contienen ({4,}, [{}]).
  // Delegado en test/helpers/renderer-source.js: tolera LF y CRLF y lanza un
  // error explícito si la función no existe o no cierra en columna 0.
  // Declaración, no const: se invoca antes de esta línea y necesita hoisting.
  function sliceRendererFunction(name) { return renderer.slice(name); }

  // --- BUG 1: confirmaciones naturales de una acción visual pendiente -------
  // "generar una nueva versión" no coincidía con /^(2|opcion 2|generar|genera)$/,
  // así que pendingVisualAction se cancelaba y la frase se reenrutaba como una
  // petición nueva y vaga. Se perdía operativamente "rediseña el logo por uno
  // más moderno" y el resultado era casi idéntico al original.
  // Se inyecta el bloque VERBATIM. Extraer los literales con regex convertía
  // `\\s` del fuente en una barra literal y rompía el arnés, no el parser.
  const parsePendingVisualActionReply = new Function(`
    ${rendererSource.slice(
      rendererSource.indexOf('const PENDING_REPLY_LEAD'),
      rendererSource.indexOf('async function handlePendingVisualActionReply')
    )}
    return parsePendingVisualActionReply;
  `)();

  for (const phrase of [
    '1', 'opción 1', 'analizar', 'analiza', 'analizar la imagen',
    'quiero analizarla', 'solo analizar'
  ]) {
    assert.equal(parsePendingVisualActionReply(phrase), 'analyze', `analyze: ${phrase}`);
  }
  for (const phrase of [
    '2', 'opción 2', 'generar', 'genera', 'generar una nueva versión',
    'genera una nueva versión', 'crear una nueva versión', 'crea otra versión',
    'editar', 'edita', 'editarla', 'aplícalo', 'aplicar los cambios', 'hazlo'
  ]) {
    assert.equal(parsePendingVisualActionReply(phrase), 'generate', `generate: ${phrase}`);
  }
  // Anclado: una petición nueva que contenga "generar" NO es una confirmación.
  for (const phrase of [
    'rediseña el logo por uno más moderno',
    'quiero generar un informe de ventas',
    'cambia el color del logo por verde',
    'no', 'hola', '', '   '
  ]) {
    assert.equal(parsePendingVisualActionReply(phrase), null, `no confirmación: ${phrase}`);
  }
  // Mayúsculas, acentos y puntuación se normalizan.
  assert.equal(parsePendingVisualActionReply('  GENERAR una NUEVA versión!! '), 'generate');
  assert.equal(parsePendingVisualActionReply('sí, generar'), 'generate');
  assert.equal(parsePendingVisualActionReply('Opción 1.'), 'analyze');

  // El handler consume el parser, no sus propias regex.
  assert(rendererSource.includes('const intent = parsePendingVisualActionReply(text);'));
  assert(!rendererSource.includes('/^(2|opcion 2|generar|genera)$/'),
    'la lista cerrada de cuatro cadenas no puede volver');
  // La instrucción original manda: el prompt nunca se sustituye por la confirmación.
  assert(rendererSource.includes(
    'const prompt = pending.generationPrompt || buildImageGenerationPromptFromVisualPlan(pending.plan);'
  ));
  assert(rendererSource.includes('sourceImages: sourceImage ? [sourceImage] : []'),
    'la imagen fuente original se conserva en la generación');

  // E: separación instrucción/contenido en mensajes largos.
  const extractRoutingInstruction = new Function(`
    ${sliceRendererFunction('truncateByCharacters')}
    ${sliceRendererFunction('isPastedContentLine')}
    const ROUTING_INSTRUCTION_MAX_CHARS = 500;
    ${sliceRendererFunction('extractRoutingInstruction')}
    return extractRoutingInstruction;
  `)();
  const analysisInstruction = 'Analiza el siguiente código y explica el problema.';
  const noisyBody = [
    'if (toolUse.name === "generate_image") { return runImageGeneration(); }',
    '    at handle (app.js:3803:11)',
    '// intent detectado: image-generation',
    '{"type":"tool_use","name":"generate_image"}',
    'mode: "image-edit"',
    'MODEL_FALLBACK: wan2.7-image',
    '2026-07-29 10:00:00 INFO generate_image queued',
    'const model = "wan2.7-image";'
  ].join('\n').repeat(12);
  const longAnalysisMessage = `${analysisInstruction}\n\n${noisyBody}`;
  assert(longAnalysisMessage.length > 500);
  const routingInstruction = extractRoutingInstruction(longAnalysisMessage);
  assert.equal(routingInstruction, analysisInstruction);
  assert(!routingInstruction.includes('generate_image'));
  assert(!routingInstruction.includes('image-generation'));
  assert(!routingInstruction.includes('wan2.7-image'));
  assert(!routingInstruction.includes('genera una imagen'));
  assert(routingInstruction.length <= 500);
  assert.equal(extractRoutingInstruction(analysisInstruction), analysisInstruction);
  const longSingleParagraph = extractRoutingInstruction(`${analysisInstruction} ${'x'.repeat(900)}`);
  assert(Array.from(longSingleParagraph).length <= 500);

  // E2: el caso real más común — el usuario pega el log/código PRIMERO y dice
  // qué quiere al FINAL. La instrucción final no se puede perder.
  const stackTrace = [
    'Error reportado:',
    "TypeError: Cannot read properties of undefined (reading 'map')",
    '    at UserList (user-list.tsx:18:23)',
    '    at renderWithHooks (react-dom.development.js:16305:18)',
    '    at mountIndeterminateComponent (react-dom.development.js:20074:13)'
  ].join('\n');
  const trailingRequest = 'Explica este error y dime cómo corregir el componente.';
  // La línea indentada sin símbolos densos solo la filtra la regla de indentación.
  const indentedCodeLine = '    resultado = calcular el valor';
  const logFirstMessage = [
    stackTrace,
    '    at frame (file.js:1:1)\n'.repeat(40),
    indentedCodeLine,
    '',
    trailingRequest
  ].join('\n');
  assert(logFirstMessage.length > 500);
  const logFirstRouting = extractRoutingInstruction(logFirstMessage);
  assert(logFirstRouting.includes('Explica este error'));
  assert(!logFirstRouting.includes('    at '));
  assert(!logFirstRouting.includes('react-dom.development.js'));
  assert(!logFirstRouting.includes('resultado = calcular'));
  assert(!logFirstRouting.includes('TypeError'));
  const routedLogFirst = manager.routeIntent({ text: logFirstRouting, currentModel: 'qwen3.7-max' });
  assert.equal(routedLogFirst.action, 'chat');
  assert.notEqual(routedLogFirst.action, 'generate-image');

  // E3: la instrucción al final gana aunque el bloque pegado hable de imágenes.
  const noisyThenAnalyze = `${noisyBody}\n\nNo generes ninguna imagen: solo analiza el código anterior.`;
  const noisyThenAnalyzeRouting = extractRoutingInstruction(noisyThenAnalyze);
  assert(noisyThenAnalyzeRouting.includes('solo analiza el código anterior'));
  const routedNoisyThenAnalyze = manager.routeIntent({
    text: noisyThenAnalyzeRouting,
    attachments: [{ type: 'image', mediaType: 'image/png', base64: 'AAA', name: 'reporte.png' }],
    currentModel: 'qwen3.7-max'
  });
  assert.notEqual(routedNoisyThenAnalyze.action, 'generate-image');
  assert.notEqual(routedNoisyThenAnalyze.intent, 'image-generation');

  // E4: una primera línea tipo log/constante no secuestra la intención.
  const adversarial = [
    'GENERATE_IMAGE: crea una imagen promocional',
    '',
    ...Array.from({ length: 30 }, (_, i) => `2026-07-29 10:0${i % 10}:00 INFO worker=${i} payload={"mode":"image-generation"}`),
    '',
    'El usuario solo quería analizar este código, no generar nada.'
  ].join('\n');
  assert(adversarial.length > 500);
  const adversarialRouting = extractRoutingInstruction(adversarial);
  assert(adversarialRouting.includes('solo quería analizar este código'));
  assert(!adversarialRouting.includes('GENERATE_IMAGE'));
  assert(!adversarialRouting.includes('image-generation'));

  // E5: mensaje largo sin prosa identificable → nunca queda vacío.
  const onlyCode = `${'    at frame (file.js:1:1)\n'.repeat(60)}`;
  const onlyCodeRouting = extractRoutingInstruction(onlyCode);
  assert(typeof onlyCodeRouting === 'string');
  assert(Array.from(onlyCodeRouting).length <= 500);
  assert.notEqual(manager.routeIntent({ text: onlyCodeRouting, currentModel: 'qwen3.7-max' }).action, 'generate-image');

  // E8: prosa larguísima (>500) — se conservan principio Y final, porque la
  // petición real suele cerrar el mensaje.
  const longProse = [
    'Contexto del incidente reportado por soporte al equipo de plataforma.',
    ...Array.from({ length: 20 }, (_, i) => `Detalle ${i} del reporte redactado en prosa por la persona que abrió el ticket.`),
    'Con todo eso en cuenta, analiza el módulo y explícame la causa raíz.'
  ].join('\n');
  assert(Array.from(longProse).length > 500);
  const longProseRouting = extractRoutingInstruction(longProse);
  assert(Array.from(longProseRouting).length <= 500);
  assert(longProseRouting.includes('Contexto del incidente'));
  assert(longProseRouting.includes('explícame la causa raíz'));
  assert.equal(manager.routeIntent({ text: longProseRouting, currentModel: 'qwen3.7-max' }).action, 'chat');

  // E7 (real): la prosa pegada que pide generar una imagen NO puede abrir la ruta
  // directa route.action === 'generate-image'. El routing mixto se degrada a chat.
  const mixedLongMessage = `Analiza este ticket y dime si es viable:\n\n${'El cliente pide: genera una imagen promocional del producto.\n'.repeat(20)}`;
  const mixedRoutingInstruction = extractRoutingInstruction(mixedLongMessage);
  // La heurística de texto no puede filtrar prosa: la petición sigue visible.
  assert(mixedRoutingInstruction.includes('genera una imagen promocional'));
  assert(mixedRoutingInstruction.includes('Analiza este ticket'));

  // A: sin adjunto → chat, y jamás generate-image.
  const mixedRoute = manager.routeIntent({
    text: mixedRoutingInstruction,
    currentModel: 'qwen3.7-max'
  });
  assert.equal(mixedRoute.detailed.intentConflicts.analysisAndGeneration, true);
  assert(mixedRoute.detailed.analysisSignals.length > 0);
  assert(mixedRoute.detailed.generationSignals.length > 0);
  assert.equal(mixedRoute.action, 'chat');
  assert.notEqual(mixedRoute.action, 'generate-image');
  assert.equal(mixedRoute.intent, 'normal-chat');
  assert.notEqual(mixedRoute.model, 'wan2.7-image');
  assert(!GENERATIVE_VISUAL_MODES_TEST.includes(mixedRoute.plan?.mode));
  // normal-chat no tiene constructor de plan: no puede sobrevivir ninguno del
  // intent detectado, ni plan ni visualExecution generativos.
  assert.equal(mixedRoute.plan, null);
  assert.equal(mixedRoute.visualExecution, null);
  assert.equal(mixedRoute.generationPrompt, null);

  // B: mismo caso con una captura adjunta → vision-analysis con el modelo de visión.
  const mixedRouteWithImage = manager.routeIntent({
    text: mixedRoutingInstruction,
    attachments: [{ type: 'image', mediaType: 'image/png', base64: 'AAA', name: 'ticket.png' }],
    currentModel: 'qwen3.7-max'
  });
  assert.equal(mixedRouteWithImage.detailed.intentConflicts.analysisAndGeneration, true);
  assert.equal(mixedRouteWithImage.intent, 'vision-analysis');
  assert.equal(mixedRouteWithImage.action, 'chat');
  assert.equal(mixedRouteWithImage.model, 'qwen3.7-plus');
  assert.notEqual(mixedRouteWithImage.action, 'generate-image');
  assert.equal(mixedRouteWithImage.plan.mode, 'vision-analysis');
  assert(!GENERATIVE_VISUAL_MODES_TEST.includes(mixedRouteWithImage.visualExecution.plan.mode));

  // C: una solicitud generativa inequívoca sigue funcionando.
  const explicitGeneration = manager.routeIntent({
    text: 'Genera una imagen promocional del producto',
    currentModel: 'qwen3.7-max'
  });
  assert.equal(explicitGeneration.detailed.intentConflicts.analysisAndGeneration, false);
  assert.equal(explicitGeneration.intent, 'image-generation');
  assert.equal(explicitGeneration.action, 'generate-image');
  assert.equal(explicitGeneration.model, 'wan2.7-image');

  // D: solicitud mixta real → nunca genera en una sola ruta; prioriza análisis/chat.
  const realMixed = manager.routeIntent({
    text: 'Analiza este error y genera después una imagen del flujo',
    currentModel: 'qwen3.7-max'
  });
  assert.equal(realMixed.detailed.intentConflicts.analysisAndGeneration, true);
  assert.equal(realMixed.action, 'chat');
  assert.notEqual(realMixed.action, 'generate-image');
  // La solicitud completa no se pierde: el prompt del modelo conserva el texto.
  assert(String(realMixed.modelPrompt || '').includes('genera después una imagen del flujo'));
  const realMixedWithImage = manager.routeIntent({
    text: 'Analiza este error y genera después una imagen del flujo',
    attachments: [{ type: 'image', mediaType: 'image/png', base64: 'AAA', name: 'error.png' }],
    currentModel: 'qwen3.7-max'
  });
  assert.equal(realMixedWithImage.action, 'chat');
  assert.equal(realMixedWithImage.intent, 'vision-analysis');
  assert.equal(realMixedWithImage.model, 'qwen3.7-plus');

  // D2: intención generativa dominante EN LA DETECCIÓN + contexto visual. Aquí es
  // donde el guard debe degradar a vision-analysis y donde el plan tiene que
  // reconstruirse con el intent efectivo, no con el detectado.
  const mixedEditWithContext = manager.routeIntent({
    text: 'mira esto y cambia el fondo a azul',
    attachments: [{ type: 'image', mediaType: 'image/png', base64: 'AAA', name: 'captura.png' }],
    currentModel: 'qwen3.7-max'
  });
  assert.equal(mixedEditWithContext.detailed.intent, 'image-edit');
  assert.equal(mixedEditWithContext.detailed.intentConflicts.analysisAndGeneration, true);
  assert.equal(mixedEditWithContext.intent, 'vision-analysis');
  assert.equal(mixedEditWithContext.action, 'chat');
  assert.equal(mixedEditWithContext.model, 'qwen3.7-plus');
  assert.notEqual(mixedEditWithContext.action, 'generate-image');
  // El plan se reconstruye con el intent efectivo: nada generativo sobrevive.
  assert.equal(mixedEditWithContext.plan.mode, 'vision-analysis');
  assert.equal(mixedEditWithContext.visualExecution.plan.mode, 'vision-analysis');
  assert(!GENERATIVE_VISUAL_MODES_TEST.includes(mixedEditWithContext.visualExecution.plan.mode));
  assert.equal(mixedEditWithContext.generationPrompt, null);

  // La petición degradada no se pierde: queda como alternativa confirmable.
  const alternative = mixedEditWithContext.conflictAlternative;
  assert(alternative, 'el guard debe conservar la alternativa generativa');
  assert.equal(alternative.intent, 'image-edit');
  assert.equal(alternative.action, 'generate-image');
  assert.equal(alternative.plan.mode, 'image-edit');
  assert.equal(alternative.validation.valid, true);
  assert.equal(alternative.model, 'wan2.7-image');
  assert.equal(alternative.visualExecution.plan.mode, 'image-edit');
  assert.equal(alternative.visualExecution.model, 'wan2.7-image');
  assert(alternative.plan.operations.includes('background-change'));
  assert(alternative.generationPrompt);
  // La ruta efectiva sigue siendo de análisis: la alternativa no la contamina.
  assert.equal(mixedEditWithContext.action, 'chat');
  assert.equal(mixedEditWithContext.plan.mode, 'vision-analysis');

  // Caso canónico: el análisis GANA el ranking por sí solo (el guard no llega a
  // degradar nada), y la petición de edición igualmente queda ofrecida.
  const canonical = manager.routeIntent({
    text: 'analiza esta imagen y cambiale el fondo a azul',
    attachments: [{ type: 'image', mediaType: 'image/png', base64: 'AAA', name: 'captura.png' }],
    currentModel: 'qwen3.7-max'
  });
  assert.equal(canonical.detailed.intent, 'vision-analysis');
  assert.equal(canonical.detailed.intentConflicts.analysisAndGeneration, true);
  assert.equal(canonical.detailed.generationCandidate, 'image-edit');
  assert.equal(canonical.intent, 'vision-analysis');
  assert.equal(canonical.action, 'chat');
  assert.equal(canonical.model, 'qwen3.7-plus');
  assert.equal(canonical.plan.mode, 'vision-analysis');
  assert(canonical.conflictAlternative, 'la edición pedida no puede perderse en silencio');
  assert.equal(canonical.conflictAlternative.intent, 'image-edit');
  assert.equal(canonical.conflictAlternative.plan.mode, 'image-edit');
  assert.equal(canonical.conflictAlternative.model, 'wan2.7-image');
  assert.equal(canonical.conflictAlternative.validation.valid, true);
  assert(canonical.conflictAlternative.plan.operations.includes('background-change'));

  // Sin contexto visual no se ofrece nada: una petición generativa que solo aparece
  // en el texto pegado nunca se convierte en una acción a un toque.
  assert.equal(mixedRoute.conflictAlternative, null);
  assert.equal(realMixed.conflictAlternative, null);
  // Análisis puro y generación inequívoca tampoco generan ofertas (sin ruido).
  assert.equal(mixedRouteWithImage.conflictAlternative, null);
  assert.equal(explicitGeneration.conflictAlternative, null);
  // Una ruta que YA genera (con contexto visual, sin conflicto) no ofrece nada:
  // la alternativa existe solo cuando el guard degradó la ruta.
  assert.equal(routedCritical.action, 'generate-image');
  assert.equal(routedCritical.visualContext.hasVisualContext, true);
  assert.equal(routedCritical.conflictAlternative, null);
  assert.equal(routedImplicitEdit.conflictAlternative, null);
  assert.equal(manager.routeIntent({
    text: 'analiza esta imagen',
    attachments: [{ type: 'image', mediaType: 'image/png', base64: 'AAA', name: 'x.png' }],
    currentModel: 'qwen3.7-max'
  }).conflictAlternative, null);

  // D3: dominancia generativa segura — una señal de análisis incidental no debe
  // bloquear una instrucción generativa que domina con claridad.
  const dominantGenerative = detectUserIntentDetailed({
    text: 'mira, aplica las mejoras sugeridas y crea una nueva imagen',
    lastUploadedImage: previousImage
  });
  assert(dominantGenerative.analysisSignals.length > 0);
  assert(dominantGenerative.generationSignals.length > 0);
  assert.equal(dominantGenerative.intentConflicts.analysisAndGeneration, false);
  assert.equal(dominantGenerative.intent, 'image-variation');

  // Ninguna de las rutas mixtas ejecuta generación: ni directa ni vía tool_use.
  let leakedGenerationCalls = 0;
  for (const conflictRoute of [
    mixedRoute, mixedRouteWithImage, realMixed, realMixedWithImage, mixedEditWithContext
  ]) {
    assert.notEqual(conflictRoute.action, 'generate-image');
    if (!conflictRoute.visualExecution) continue;
    await assert.rejects(
      () => executeGenerateImageToolUse({
        toolUse: { name: 'generate_image', input: { prompt: 'imagen promocional' } },
        visualExecution: {
          ...conflictRoute.visualExecution,
          validation: { valid: true },
          model: 'wan2.7-image',
          generationPrompt: 'imagen promocional'
        },
        generateImage: async () => { leakedGenerationCalls++; return { images: ['x'] }; }
      }),
      /la tarea actual no es generativa/
    );
  }
  assert.equal(leakedGenerationCalls, 0);

  // La barrera del renderer sobre la ruta directa existe y no lanza.
  const directRouteGuardStart = rendererSource.indexOf('// Barrera de último recurso sobre la ruta directa');
  const directRouteGuardEnd = rendererSource.indexOf("if (route.action === 'generate-image') {", directRouteGuardStart);
  const directRouteGuard = rendererSource.slice(directRouteGuardStart, directRouteGuardEnd);
  assert(directRouteGuard.includes("route.detailed?.intentConflicts?.analysisAndGeneration"));
  assert(directRouteGuard.includes("route.action = 'chat'"));
  assert(!directRouteGuard.includes('throw new Error'));
  assert(!directRouteGuard.includes('sendAIImage'));
  assert(!directRouteGuard.includes('registerVisualImage('));
  assert(!directRouteGuard.includes('lastGeneratedImage'));
  assert(!directRouteGuard.includes('Store.addMessage'));
  assert(directRouteGuard.indexOf('route.action = \'chat\'') < directRouteGuardEnd - directRouteGuardStart);

  // Y se ejecuta el código real de esa barrera para comprobar el resultado.
  function runDirectRouteGuard(route, selectedModel) {
    const calls = { toasts: [], errors: 0 };
    const state = { routedIntent: route.intent };
    new Function('deps', `
      const route = deps.route;
      const model = deps.model;
      const AUTOMATIC_MODEL_ID = '__automatic__';
      let routedIntent = deps.state.routedIntent;
      const showToast = deps.showToast;
      const console = deps.console;
      ${directRouteGuard}
      deps.state.routedIntent = routedIntent;
    `)({
      route,
      model: selectedModel,
      state,
      showToast: (message, level) => { calls.toasts.push([message, level]); },
      console: { error: () => { calls.errors++; }, warn: () => {} }
    });
    return { route, calls, routedIntent: state.routedIntent };
  }

  const guardedNoImage = runDirectRouteGuard({
    action: 'generate-image',
    intent: 'image-generation',
    model: 'wan2.7-image',
    detailed: { intent: 'image-generation', intentConflicts: { analysisAndGeneration: true } },
    visualContext: { hasVisualContext: false },
    capabilities: { defaultVisionModel: 'qwen3.7-plus' }
  }, 'qwen3.7-max');
  assert.equal(guardedNoImage.route.action, 'chat');
  assert.notEqual(guardedNoImage.route.action, 'generate-image');
  assert.equal(guardedNoImage.route.intent, 'normal-chat');
  assert.equal(guardedNoImage.routedIntent, 'normal-chat');
  assert.notEqual(guardedNoImage.route.model, 'wan2.7-image');
  assert.equal(guardedNoImage.calls.errors, 1);
  assert.equal(guardedNoImage.calls.toasts.length, 1);

  const guardedWithImage = runDirectRouteGuard({
    action: 'generate-image',
    intent: 'image-edit',
    model: 'wan2.7-image',
    detailed: { intent: 'image-edit', intentConflicts: { analysisAndGeneration: true } },
    visualContext: { hasVisualContext: true },
    capabilities: { defaultVisionModel: 'qwen3.7-plus' }
  }, '__automatic__');
  assert.equal(guardedWithImage.route.action, 'chat');
  assert.equal(guardedWithImage.route.intent, 'vision-analysis');
  assert.equal(guardedWithImage.routedIntent, 'vision-analysis');
  assert.equal(guardedWithImage.route.model, 'qwen3.7-plus');
  assert.notEqual(guardedWithImage.route.model, '__automatic__');

  // Sin conflicto, la generación legítima pasa intacta.
  const untouched = runDirectRouteGuard({
    action: 'generate-image',
    intent: 'image-generation',
    model: 'wan2.7-image',
    detailed: { intent: 'image-generation', intentConflicts: { analysisAndGeneration: false } },
    visualContext: { hasVisualContext: false },
    capabilities: { defaultVisionModel: 'qwen3.7-plus' }
  }, 'qwen3.7-max');
  assert.equal(untouched.route.action, 'generate-image');
  assert.equal(untouched.route.model, 'wan2.7-image');
  assert.equal(untouched.calls.toasts.length, 0);
  assert.equal(untouched.calls.errors, 0);

  // E6: el corte respeta caracteres completos (no parte pares surrogate),
  // tanto en la rama de prosa como en el recorte de último recurso.
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const emojiTail = `${'a'.repeat(499)}😀${'b'.repeat(600)}`;
  const emojiRouting = extractRoutingInstruction(emojiTail);
  assert(!loneSurrogate.test(emojiRouting));
  assert(!JSON.stringify(emojiRouting).includes('\\ud'));
  // Sin prosa: se recorta el primer párrafo, con el emoji justo en el límite.
  const codePrefix = 'const x = "';
  const emojiCodeLine = `${codePrefix}${'a'.repeat(500 - codePrefix.length - 1)}😀${'b'.repeat(600)}";`;
  assert.equal(Array.from(emojiCodeLine).indexOf('😀'), 499);
  const emojiCodeRouting = extractRoutingInstruction(emojiCodeLine);
  assert(Array.from(emojiCodeRouting).length <= 500);
  assert(emojiCodeRouting.includes('😀'));
  assert(!loneSurrogate.test(emojiCodeRouting));
  assert(!JSON.stringify(emojiCodeRouting).includes('\\ud'));

  // El contenido íntegro nunca se recorta para el modelo ni para la DB.
  assert(rendererSource.includes('const routingInstruction = extractRoutingInstruction(text)'));
  assert(rendererSource.includes('text: routingInstruction,'));
  // Comparación robusta frente a espacios al inicio/final del mensaje.
  assert(rendererSource.includes("const routingUsesFullText = routingInstruction === text.trim()"));
  assert(rendererSource.includes('if (routingUsesFullText) {'));
  assert(!rendererSource.includes('if (routingInstruction === text) {'));
  const paddedShortText = '  analiza esto  ';
  assert.equal(extractRoutingInstruction(paddedShortText), paddedShortText.trim());

  const routedLongAnalysis = manager.routeIntent({
    text: routingInstruction,
    attachments: [{ type: 'image', mediaType: 'image/png', base64: 'AAA', name: 'reporte.png' }],
    currentModel: 'qwen3.7-max'
  });
  assert.equal(routedLongAnalysis.intent, 'vision-analysis');
  assert.equal(routedLongAnalysis.action, 'chat');
  assert.equal(routedLongAnalysis.model, 'qwen3.7-plus');
  assert.notEqual(routedLongAnalysis.action, 'generate-image');
  assert.notEqual(routedLongAnalysis.intent, 'image-generation');

  // F: una solicitud nueva y extensa cancela la acción visual pendiente.
  function runPendingReply(text, pending) {
    let generateImageCalls = 0;
    const forbidden = label => (...args) => {
      generateImageCalls += label === 'generateImage' ? 1 : 0;
      assert.fail(`no debía llamarse ${label} con ${JSON.stringify(args).slice(0, 80)}`);
    };
    const harness = new Function('deps', `
      let pendingVisualAction = deps.pendingVisualAction;
      let isGenerating = false;
      let activeProjectId = 'p1';
      let activeChatId = 'c1';
      const AUTOMATIC_MODEL_ID = '__automatic__';
      const currentProvider = 'alibaba';
      const window = deps.window;
      const visualContextMemory = {};
      const Store = deps.Store;
      const el = deps.forbidden('el');
      const withTimeout = deps.forbidden('withTimeout');
      const openChat = deps.forbidden('openChat');
      const appendMsg = deps.forbidden('appendMsg');
      const appendGeneratingPlaceholder = deps.forbidden('appendGeneratingPlaceholder');
      const removeGeneratingPlaceholder = deps.forbidden('removeGeneratingPlaceholder');
      const appendControlledIntentResponse = deps.forbidden('appendControlledIntentResponse');
      const buildImageGenerationPromptFromVisualPlan = deps.forbidden('buildImageGenerationPromptFromVisualPlan');
      const terminalImageAnswer = deps.forbidden('terminalImageAnswer');
      const registerVisualImage = deps.forbidden('registerVisualImage');
      const registerVisualEvent = deps.forbidden('registerVisualEvent');
      const registerLastVisualAnalysis = deps.forbidden('registerLastVisualAnalysis');
      const safeAssistantContent = deps.forbidden('safeAssistantContent');
      const sanitizeRemoteErrorMessage = deps.forbidden('sanitizeRemoteErrorMessage');
      const showToast = deps.forbidden('showToast');
      const updateSendButtonState = deps.forbidden('updateSendButtonState');
      ${pendingParserSource}
      ${pendingHandlerSource}
      return {
        run: text => handlePendingVisualActionReply(text),
        pending: () => pendingVisualAction
      };
    `)({
      pendingVisualAction: pending,
      forbidden,
      Store: { addMessage: forbidden('Store.addMessage') },
      window: { mika5: { ai: {
        generateImage: forbidden('generateImage'),
        chat: forbidden('chat')
      } } }
    });
    return { harness, generateImageCalls: () => generateImageCalls };
  }

  const pendingSnapshot = () => ({
    type: 'image-edit',
    provider: 'alibaba',
    model: 'wan2.7-image',
    visionModel: 'qwen3.7-plus',
    plan: { mode: 'image-edit', constraints: ['avoid-gray'] },
    visualContext: { imageRef: { base64: 'AAA', mediaType: 'image/png' } },
    generationPrompt: 'edita la imagen'
  });

  const hijackAttempt = runPendingReply(
    'Analiza este código que contiene generate_image y explica el error',
    pendingSnapshot()
  );
  assert.equal(await hijackAttempt.harness.run(
    'Analiza este código que contiene generate_image y explica el error'
  ), false);
  assert.equal(hijackAttempt.harness.pending(), null);
  assert.equal(hijackAttempt.generateImageCalls(), 0);

  const clarificationAttempt = runPendingReply('cambia el color del fondo a azul', pendingSnapshot());
  assert.equal(await clarificationAttempt.harness.run('cambia el color del fondo a azul'), false);
  assert.equal(clarificationAttempt.harness.pending(), null);
  assert.equal(clarificationAttempt.generateImageCalls(), 0);
  assert(!pendingHandlerSource.includes('additional-instruction'));
  assert(!pendingHandlerSource.includes('Aclaración guardada'));
  assert(!/color\|fondo\|logo\|texto\|contenido/.test(pendingHandlerSource));
  // Las regex cerradas se sustituyeron por parsePendingVisualActionReply: la
  // lista de cuatro cadenas exactas rechazaba confirmaciones naturales.
  assert(pendingHandlerSource.includes('const intent = parsePendingVisualActionReply(text);'));
  assert(pendingHandlerSource.includes("const analyze = intent === 'analyze';"));
  assert(pendingHandlerSource.includes("const generate = intent === 'generate';"));
  assert(!pendingHandlerSource.includes('opcion 1|analizar'));

  // H: offerConflictAlternative — registra el pendiente y NO genera nada.
  // Primero, que send() realmente la invoque tras guardar la respuesta del asistente.
  // El guardado del asistente pasa por persistAssistantTurn: si la escritura
  // falla, la respuesta se marca como no guardada en vez de darse por buena.
  const assistantSave = rendererSource.indexOf(
    'chatId: requestContext.chatId, content: answer, model: answerModel,'
  );
  const offerCall = rendererSource.indexOf('await offerConflictAlternative(activeVisualRoute, model, requestContext);');
  const autoRename = rendererSource.indexOf('// Auto-rename chat based on');
  assert(assistantSave >= 0 && offerCall > assistantSave && autoRename > offerCall);
  const offerSource = sliceRendererFunction('offerConflictAlternative');
  assert(!offerSource.includes('sendAIImage'));
  assert(!offerSource.includes('registerVisualImage('));
  assert(!offerSource.includes('lastGeneratedImage'));
  assert(!offerSource.includes('throw new Error'));
  const pendingFactorySource = sliceRendererFunction('createPendingVisualAction');
  const identitySource = sliceRendererFunction('pendingVisualActionIdentityMismatch');
  function runOfferConflictAlternative(route, selectedModel, chatId = 'c1') {
    const calls = { generateImage: 0, registerVisualImage: 0, messages: [], stored: [] };
    const harness = new Function('deps', `
      const GENERATIVE_VISUAL_MODES = ['image-generation', 'image-edit', 'image-variation'];
      const AUTOMATIC_MODEL_ID = '__automatic__';
      const activeChatId = deps.activeChatId;
      const activeProjectId = 'p1';
      const currentProvider = 'alibaba';
      let pendingVisualAction = null;
      const Store = deps.Store;
      const appendMsg = deps.appendMsg;
      const registerVisualImage = deps.registerVisualImage;
      const window = deps.window;
      const requestContext = activeChatId ? {
        chatId: activeChatId,
        projectId: activeProjectId,
        providerId: currentProvider,
        selectedModel: 'qwen3.7-max'
      } : null;
      const currentRequestView = () => ({
        chatId: activeChatId,
        projectId: activeProjectId,
        providerId: currentProvider
      });
      const shouldRenderRequestOutput = () => true;
      ${pendingFactorySource}
      ${offerSource}
      return {
        run: (route, selectedModel) => offerConflictAlternative(route, selectedModel, requestContext),
        pending: () => pendingVisualAction
      };
    `)({
      activeChatId: chatId,
      appendMsg: message => { calls.messages.push(message); },
      registerVisualImage: () => { calls.registerVisualImage++; },
      // Devuelve lo mismo que el Store real: persistUserTurn trata cualquier
      // resultado sin ok:true como fallo y aborta el turno, que es lo correcto.
      Store: { addMessage: async (...args) => {
        calls.stored.push(args);
        return { ok: true, id: 'msg-' + calls.stored.length };
      } },
      window: { mika5: { ai: { generateImage: async () => { calls.generateImage++; return { images: ['x'] }; } } } }
    });
    return { harness, calls };
  }

  const offered = runOfferConflictAlternative();
  await offered.harness.run(mixedEditWithContext, 'qwen3.7-max');
  const offeredPending = offered.harness.pending();
  assert(offeredPending, 'debe quedar una acción pendiente confirmable');
  assert.equal(offeredPending.type, 'image-edit');
  assert.equal(offeredPending.plan.mode, 'image-edit');
  assert.equal(offeredPending.model, 'wan2.7-image');
  assert.equal(offeredPending.visionModel, 'qwen3.7-plus');
  assert(offeredPending.visualContext);
  assert.equal(offered.calls.generateImage, 0);
  assert.equal(offered.calls.registerVisualImage, 0);
  assert.equal(offered.calls.messages.length, 1);
  assert.match(offered.calls.messages[0].content, /Responde 2 para aplicarla/);
  assert(!offered.calls.messages[0].content.includes('!['));
  assert.equal(offered.calls.stored.length, 1);
  assert(!offered.calls.stored[0][2].includes('!['));

  // Sin alternativa no se registra pendiente ni se escribe nada en el chat.
  for (const emptyRoute of [mixedRoute, realMixed, explicitGeneration, null, {}]) {
    const notOffered = runOfferConflictAlternative();
    await notOffered.harness.run(emptyRoute, 'qwen3.7-max');
    assert.equal(notOffered.harness.pending(), null);
    assert.equal(notOffered.calls.messages.length, 0);
    assert.equal(notOffered.calls.stored.length, 0);
    assert.equal(notOffered.calls.generateImage, 0);
  }
  // Una alternativa con plan no generativo o inválida se rechaza.
  for (const tampered of [
    { ...mixedEditWithContext, conflictAlternative: { ...alternative, plan: { ...alternative.plan, mode: 'vision-analysis' } } },
    { ...mixedEditWithContext, conflictAlternative: { ...alternative, validation: { valid: false } } },
    { ...mixedEditWithContext, conflictAlternative: { ...alternative, model: null } }
  ]) {
    const rejected = runOfferConflictAlternative();
    await rejected.harness.run(tampered, 'qwen3.7-max');
    assert.equal(rejected.harness.pending(), null);
    assert.equal(rejected.calls.messages.length, 0);
  }
  // Sin chat activo no se registra nada.
  const noChat = runOfferConflictAlternative(null, null, null);
  await noChat.harness.run(mixedEditWithContext, 'qwen3.7-max');
  assert.equal(noChat.harness.pending(), null);

  // I: la confirmación explícita sí genera, y solo para planes generativos.
  function runPendingGenerate(pending, reply, context = {}) {
    const calls = { generateImage: 0, params: null, registerVisualImage: 0, toasts: [], stored: [] };
    const harness = new Function('deps', `
      const GENERATIVE_VISUAL_MODES = ['image-generation', 'image-edit', 'image-variation'];
      const AUTOMATIC_MODEL_ID = '__automatic__';
      let pendingVisualAction = deps.pending;
      let isGenerating = false;
      let activeProjectId = deps.activeProjectId;
      let activeChatId = deps.activeChatId;
      const currentProvider = deps.currentProvider;
      const window = deps.window;
      const visualContextMemory = {};
      const Store = deps.Store;
      const el = () => ({ value: '', style: {} });
      const withTimeout = async promise => promise;
      const openChat = async () => {};
      const appendMsg = () => {};
      const appendGeneratingPlaceholder = () => {};
      const removeGeneratingPlaceholder = () => {};
      const appendControlledIntentResponse = async () => {};
      const buildImageGenerationPromptFromVisualPlan = () => 'prompt de respaldo';
      const terminalImageAnswer = images => '![Imagen generada](' + images[0] + ')';
      const registerVisualImage = deps.registerVisualImage;
      const registerVisualEvent = () => {};
      const registerLastVisualAnalysis = () => {};
      const safeAssistantContent = value => String(value || '');
      const sanitizeRemoteErrorMessage = value => String(value || '');
      const showToast = deps.showToast;
      const updateSendButtonState = () => {};
      const createRequestContext = value => Object.freeze({ requestId: 'test-request', ...value });
      const currentRequestView = () => ({
        chatId: activeChatId,
        projectId: activeProjectId,
        providerId: currentProvider
      });
      const shouldRenderRequestOutput = context => (
        context.chatId === activeChatId && context.projectId === activeProjectId
      );
      const buildEffectiveCloudScope = async () => ({ message: true, imageAttachments: true });
      const ensureCloudConsent = async () => true;
      const sendAIImage = payload => window.mika5.ai.generateImage(payload);
      const sendAIChat = payload => window.mika5.ai.chat(payload);
      ${identitySource}
      ${pendingParserSource}
      ${pendingHandlerSource}
      return { run: text => handlePendingVisualActionReply(text), pending: () => pendingVisualAction };
    `)({
      pending,
      activeChatId: 'activeChatId' in context ? context.activeChatId : 'c1',
      activeProjectId: 'activeProjectId' in context ? context.activeProjectId : 'p1',
      currentProvider: context.currentProvider || 'alibaba',
      registerVisualImage: () => { calls.registerVisualImage++; },
      showToast: (message, level) => { calls.toasts.push([message, level]); },
      // Devuelve lo mismo que el Store real: persistUserTurn trata cualquier
      // resultado sin ok:true como fallo y aborta el turno, que es lo correcto.
      Store: { addMessage: async (...args) => {
        calls.stored.push(args);
        return { ok: true, id: 'msg-' + calls.stored.length };
      } },
      window: { mika5: { ai: {
        generateImage: async params => {
          calls.generateImage++;
          calls.params = params;
          return { images: ['https://example.test/confirmed.png'] };
        },
        chat: async () => ({ message: { content: 'análisis' } })
      } } }
    });
    return { run: () => harness.run(reply), calls, harness };
  }

  // La acción pendiente queda sellada con la identidad de su contexto.
  assert.equal(offeredPending.chatId, 'c1');
  assert.equal(offeredPending.projectId, 'p1');
  assert.equal(offeredPending.provider, 'alibaba');
  assert(offeredPending.sourceImage, 'debe guardarse la imagen fuente');
  assert.equal(offeredPending.sourceVisualEntryId, offeredPending.plan.sourceImage?.visualEntryId ?? null);
  assert(typeof offeredPending.createdAt === 'number' && offeredPending.createdAt > 0);
  assert(offeredPending.generationPrompt);
  for (const field of [
    'chatId', 'projectId', 'provider', 'sourceVisualEntryId', 'sourceImage',
    'plan', 'model', 'generationPrompt', 'createdAt'
  ]) {
    assert(field in offeredPending, `falta ${field} en la acción pendiente`);
  }
  // Ambos sitios de creación usan la fábrica: nadie puede olvidar la identidad.
  assert.equal((rendererSource.match(/pendingVisualAction = createPendingVisualAction\(/g) || []).length, 2);
  assert(!/pendingVisualAction = \{/.test(rendererSource));

  // A: mismo chat, proyecto, proveedor e imagen + '2' → genera una vez.
  const confirmed = runPendingGenerate(offeredPending, '2');
  assert.equal(await confirmed.run(), true);
  assert.equal(confirmed.calls.generateImage, 1);
  assert.equal(confirmed.calls.params.model, 'wan2.7-image');
  assert.equal(confirmed.calls.params.sourceImages.length, 1);
  assert.equal(confirmed.calls.registerVisualImage, 1);
  assert.equal(confirmed.harness.pending(), null);

  // A-bis: REGRESIÓN del caso real reportado.
  //   1. adjunta logo   2. "rediseña el logo por uno más moderno"
  //   3. MIKA5 pregunta 4. "generar una nueva versión"
  // Antes: la frase no coincidía con la lista cerrada, pendingVisualAction se
  // cancelaba y el texto se reenrutaba como petición nueva y vaga → imagen casi
  // idéntica. Ahora debe ejecutar la acción pendiente conservando el prompt.
  const naturalReply = runPendingGenerate(offeredPending, 'generar una nueva versión');
  assert.equal(await naturalReply.run(), true,
    'una confirmación natural debe consumir la acción pendiente');
  assert.equal(naturalReply.calls.generateImage, 1, 'exactamente una generación');
  assert.equal(naturalReply.calls.chat ?? 0, 0, 'ningún ai.chat normal');
  // La imagen fuente original, exactamente.
  assert.equal(naturalReply.calls.params.sourceImages.length, 1);
  assert.deepEqual(naturalReply.calls.params.sourceImages[0], offeredPending.sourceImage);
  // El prompt es el de la instrucción original, no el texto de confirmación.
  assert.equal(naturalReply.calls.params.prompt, offeredPending.generationPrompt);
  assert.notEqual(naturalReply.calls.params.prompt, 'generar una nueva versión');
  assert(!/^generar una nueva versi/i.test(naturalReply.calls.params.prompt),
    'el prompt no puede quedar reducido a la confirmación');
  assert.equal(naturalReply.harness.pending(), null, 'la acción queda consumida');

  // Y una frase que NO es confirmación sigue por routing normal, sin generar.
  const notAConfirmation = runPendingGenerate(offeredPending, 'quiero generar un informe de ventas');
  assert.equal(await notAConfirmation.run(), false);
  assert.equal(notAConfirmation.calls.generateImage, 0);
  assert.equal(notAConfirmation.harness.pending(), null);

  // B–E: identidad distinta + '2' → nunca genera, cancela y avisa, y consume el '2'.
  const identityCases = [
    ['B otro chat', offeredPending, { activeChatId: 'c2' }],
    ['C otro proyecto', offeredPending, { activeProjectId: 'p2' }],
    ['D otro proveedor', offeredPending, { currentProvider: 'openai' }],
    ['E otra imagen fuente', { ...offeredPending, sourceVisualEntryId: 'visual-999' }, {}],
    ['E2 sin imagen fuente', { ...offeredPending, sourceImage: null }, {}],
    ['E3 imagen fuente vacía', {
      ...offeredPending,
      plan: { ...offeredPending.plan, sourceImage: { visualEntryId: null } },
      visualContext: null,
      sourceImage: { visualEntryId: null }
    }, {}],
    ['E4 imagen fuente sustituida', {
      ...offeredPending,
      sourceImage: { base64: 'OTRA', url: 'https://example.test/otra.png' }
    }, {}]
  ];
  for (const [label, pending, context] of identityCases) {
    const blocked = runPendingGenerate(pending, '2', context);
    assert.equal(await blocked.run(), true, `${label}: debe consumir el "2"`);
    assert.equal(blocked.calls.generateImage, 0, `${label}: no debe generar`);
    assert.equal(blocked.calls.registerVisualImage, 0, `${label}: no debe registrar imagen`);
    assert.equal(blocked.harness.pending(), null, `${label}: debe cancelar el pendiente`);
    assert.equal(blocked.calls.stored.length, 0, `${label}: no debe escribir en la DB`);
    assert(
      blocked.calls.toasts.some(([message]) =>
        message === 'La acción visual pendiente pertenece a otro chat, proyecto o imagen y fue cancelada.'),
      `${label}: debe avisar`
    );
  }
  // La misma protección aplica a la confirmación de análisis ('1').
  const blockedAnalyze = runPendingGenerate(offeredPending, '1', { activeChatId: 'c2' });
  assert.equal(await blockedAnalyze.run(), true);
  assert.equal(blockedAnalyze.calls.generateImage, 0);
  assert.equal(blockedAnalyze.harness.pending(), null);

  // Cambiar de vista o de proveedor limpia el pendiente en el punto central.
  const resetSource = sliceRendererFunction('resetViewState');
  assert(resetSource.includes('pendingVisualAction = null'));
  const switchProviderSource = sliceRendererFunction('switchProvider');
  assert(switchProviderSource.includes('pendingVisualAction = null'));
  assert(rendererSource.includes('resetViewState();'));

  // Un pendiente manipulado a un modo no generativo no genera ni confirmado.
  const tamperedPending = runPendingGenerate(
    { ...offeredPending, plan: { ...offeredPending.plan, mode: 'vision-analysis' } },
    '2'
  );
  assert.equal(await tamperedPending.run(), true);
  assert.equal(tamperedPending.calls.generateImage, 0);
  assert.equal(tamperedPending.calls.registerVisualImage, 0);
  assert.equal(tamperedPending.calls.stored.filter(args => args[1] === 'assistant').length, 0);
  assert(tamperedPending.calls.toasts.some(([message]) => /no es una tarea generativa/.test(message)));

  // Cualquier otro texto cancela la oferta sin generar.
  const cancelled = runPendingGenerate(offeredPending, 'y qué opinas del contraste?');
  assert.equal(await cancelled.run(), false);
  assert.equal(cancelled.calls.generateImage, 0);
  assert.equal(cancelled.harness.pending(), null);

  // G: terminalType image se bloquea cuando el intent no es generativo, y el
  // bloqueo degrada con gracia: la capa de presentación nunca lanza.
  const terminalImageBlock = rendererSource.slice(terminalImageStart, terminalImageEnd);
  assert(!/throw new Error/.test(terminalImageBlock));
  function runTerminalImageBlock(routedIntent, options = {}) {
    const calls = { registerVisualImage: 0, terminalImageAnswer: 0, toasts: [], warns: 0, errors: 0 };
    const state = {
      answer: 'answer' in options ? options.answer : 'análisis del código',
      answerModel: 'qwen3.7-plus'
    };
    const run = new Function('deps', `
      const out = deps.out;
      const routedIntent = deps.routedIntent;
      const activeVisualRoute = deps.activeVisualRoute;
      const activeChatId = 'c1';
      const requestContext = { chatId: activeChatId };
      const model = deps.model;
      let answer = deps.state.answer;
      let answerModel = deps.state.answerModel;
      const terminalImageAnswer = deps.terminalImageAnswer;
      const registerVisualImage = deps.registerVisualImage;
      const showToast = deps.showToast;
      const console = deps.console;
      ${terminalImageBlock}
      deps.state.answer = answer;
      deps.state.answerModel = answerModel;
    `);
    const invoke = () => run({
      out: { terminalType: 'image', images: ['https://example.test/unexpected.png'], message: { content: '' } },
      routedIntent,
      activeVisualRoute: 'activeVisualRoute' in options
        ? options.activeVisualRoute
        : { visualExecution: { model: 'wan2.7-image', plan: { mode: 'image-generation' } } },
      model: 'model' in options ? options.model : 'qwen3.7-plus',
      state,
      terminalImageAnswer: images => { calls.terminalImageAnswer++; return `![Imagen generada](${images[0]})`; },
      registerVisualImage: () => { calls.registerVisualImage++; },
      showToast: (message, level) => { calls.toasts.push([message, level]); },
      console: { warn: () => { calls.warns++; }, error: () => { calls.errors++; } }
    });
    return { invoke, calls, state };
  }

  for (const blockedIntent of ['vision-analysis', 'normal-chat']) {
    const blocked = runTerminalImageBlock(blockedIntent);
    blocked.invoke(); // no lanza: degradación con gracia en el renderer
    assert.equal(blocked.calls.registerVisualImage, 0);
    assert.equal(blocked.calls.terminalImageAnswer, 0);
    assert.equal(blocked.calls.errors, 1);
    assert.equal(blocked.calls.toasts.length, 1);
    assert.match(blocked.calls.toasts[0][0], /imagen inesperada/);
    // Se conserva el texto del modelo y el modelo de chat: nada de imagen.
    assert.equal(blocked.state.answer, 'análisis del código');
    assert.equal(blocked.state.answerModel, 'qwen3.7-plus');
    assert(!blocked.state.answer.includes('!['));
    assert.notEqual(blocked.state.answerModel, 'wan2.7-image');
    // Sin texto del modelo, se explica el bloqueo en lugar de dejar la respuesta vacía.
    const blockedEmpty = runTerminalImageBlock(blockedIntent, { answer: '' });
    blockedEmpty.invoke();
    assert.match(blockedEmpty.state.answer, /Se bloqueó una imagen inesperada/);
    assert(!blockedEmpty.state.answer.includes('!['));
    assert.equal(blockedEmpty.calls.registerVisualImage, 0);
  }
  const allowedTerminal = runTerminalImageBlock('image-generation');
  allowedTerminal.invoke();
  assert.equal(allowedTerminal.calls.registerVisualImage, 1);
  assert.equal(allowedTerminal.state.answer, '![Imagen generada](https://example.test/unexpected.png)');
  assert.equal(allowedTerminal.state.answerModel, 'wan2.7-image');
  assert.equal(allowedTerminal.calls.toasts.length, 0);
  // Metadato faltante: se degrada con una etiqueta, sin lanzar ni perder la imagen.
  const missingModel = runTerminalImageBlock('image-generation', { activeVisualRoute: null, model: '' });
  missingModel.invoke();
  assert.equal(missingModel.state.answerModel, 'modelo-desconocido');
  assert.equal(missingModel.calls.warns, 1);
  assert.equal(missingModel.calls.registerVisualImage, 1);

  // ---------------------------------------------------------------------------
  // LÍMITE DE SALIDA: las respuestas ya no se truncan a 1024 tokens.
  // ---------------------------------------------------------------------------

  // A: los presets oficiales de chat y visión piden 8192; los visuales, nada.
  assert.equal(ALIBABA_DEFAULT_MAX_TOKENS, 8192);
  assert.equal(ALIBABA_LEGACY_MAX_TOKENS, 1024);
  assert(!providerSource.includes('max_tokens: 1024'));
  const presetModels = ALIBABA_DEFAULT_CONFIG.models;
  const textPresets = presetModels.filter(model => ['chat', 'vision'].includes(model.taskType));
  assert(textPresets.length >= 4);
  for (const model of textPresets) {
    assert.equal(model.parameters.max_tokens, 8192, `${model.id} debe pedir 8192`);
  }
  for (const model of presetModels.filter(m => !['chat', 'vision'].includes(m.taskType))) {
    assert.equal(model.parameters.max_tokens, undefined, `${model.id} no lleva max_tokens`);
  }
  assert.equal(createAlibabaPresetModel({ id: 'x', taskType: 'chat' }).parameters.max_tokens, 8192);
  assert.equal(createAlibabaPresetModel({ id: 'x', taskType: 'vision' }).parameters.max_tokens, 8192);
  assert.deepEqual(createAlibabaPresetModel({ id: 'x', taskType: 'image-generation' }).parameters, {});

  // B: una configuración persistida con el valor legado se migra a 8192.
  const legacyPersisted = normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    models: [
      { id: 'qwen3.7-max', taskType: 'chat', parameters: { max_tokens: 1024 } },
      { id: 'qwen3.7-plus', taskType: 'vision', parameters: { temperature: 0.4 } }
    ]
  });
  assert.equal(legacyPersisted.models.find(m => m.id === 'qwen3.7-max').parameters.max_tokens, 8192);
  const migratedPlus = legacyPersisted.models.find(m => m.id === 'qwen3.7-plus');
  assert.equal(migratedPlus.parameters.max_tokens, 8192);
  // La migración no pisa el resto de parámetros de la usuaria.
  assert.equal(migratedPlus.parameters.temperature, 0.4);

  // C: un valor oficial elegido a mano se conserva.
  const customOfficial = normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    models: [{ id: 'qwen3.7-max', taskType: 'chat', parameters: { max_tokens: 4096 } }]
  });
  assert.equal(customOfficial.models.find(m => m.id === 'qwen3.7-max').parameters.max_tokens, 4096);

  // D: los modelos manuales/custom no se tocan, ni con el valor legado.
  const customVendor = normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    models: [{ id: 'vendor/custom', taskType: 'chat', parameters: { max_tokens: 1024 } }]
  });
  assert.equal(customVendor.models.find(m => m.id === 'vendor/custom').parameters.max_tokens, 1024);
  // El helper de migración, aislado.
  assert.equal(migrateAlibabaOfficialMaxTokens({ max_tokens: 1024 }, 'chat').max_tokens, 8192);
  assert.equal(migrateAlibabaOfficialMaxTokens({}, 'vision').max_tokens, 8192);
  assert.equal(migrateAlibabaOfficialMaxTokens({ max_tokens: 4096 }, 'chat').max_tokens, 4096);
  assert.equal(migrateAlibabaOfficialMaxTokens({ max_tokens: 1024 }, 'image-generation').max_tokens, 1024);
  assert.deepEqual(migrateAlibabaOfficialMaxTokens({ max_tokens: 1024 }, 'video-generation'), { max_tokens: 1024 });

  // E/F: el body REAL que sale por la red lleva max_tokens 8192, no solo el payload
  // construido en memoria. Se captura global.fetch.
  async function captureAlibabaChatBody({ modelId, providerConfig, response }) {
    const captured = {};
    const previousFetch = global.fetch;
    global.fetch = async (url, options) => {
      captured.url = url;
      captured.body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => response || {
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 }
        }
      };
    };
    try {
      const out = await PROVIDERS.alibaba.chat({
        model: modelId,
        messages: [{ role: 'user', content: 'hola' }],
        apiKey: 'sk-sp-test',
        providerConfig: providerConfig || ALIBABA_DEFAULT_CONFIG
      });
      return { captured, out };
    } finally {
      global.fetch = previousFetch;
    }
  }

  for (const modelId of ['qwen3.7-max', 'qwen3.7-plus']) {
    const { captured, out } = await captureAlibabaChatBody({ modelId });
    assert.equal(captured.body.model, modelId, `${modelId}: modelo en el body`);
    assert.equal(captured.body.max_tokens, 8192, `${modelId}: max_tokens real 8192`);
    assert.notEqual(captured.body.max_tokens, 1024);
    assert(Array.isArray(captured.body.messages));
    // `stopReason` nativo se conserva para el flujo visual de Alibaba...
    assert.equal(out.stopReason, 'end_turn');
    assert.deepEqual(out.rawUsage, { input_tokens: 10, output_tokens: 20 });
    // ...y encima va el contrato común, idéntico en los siete proveedores.
    assert.equal(out.provider, 'alibaba');
    assert.equal(out.model, modelId);
    assert.equal(out.finishReason, 'stop');
    assert.deepEqual(out.usage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  }

  // Config oficial con 4096 elegido a mano: el body real lleva 4096.
  const customConfig = normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    models: [{ id: 'qwen3.7-max', taskType: 'chat', parameters: { max_tokens: 4096 } }]
  });
  const customCapture = await captureAlibabaChatBody({
    modelId: 'qwen3.7-max',
    providerConfig: customConfig
  });
  assert.equal(customCapture.captured.body.max_tokens, 4096);

  // Config legada persistida con 1024: el body real ya sale con 8192.
  const legacyConfig = normalizeAlibabaConfig({
    ...ALIBABA_DEFAULT_CONFIG,
    models: [{ id: 'qwen3.7-max', taskType: 'chat', parameters: { max_tokens: 1024 } }]
  });
  const legacyCapture = await captureAlibabaChatBody({
    modelId: 'qwen3.7-max',
    providerConfig: legacyConfig
  });
  assert.equal(legacyCapture.captured.body.max_tokens, 8192);

  // G: respuesta truncada → texto conservado y stopReason propagado, sin error.
  const truncated = normalizeAlibabaAssistantOutput({
    content: [{ type: 'text', text: 'Respuesta parcial' }],
    stop_reason: 'max_tokens'
  });
  assert.equal(truncated.content, 'Respuesta parcial');
  assert.equal(truncated.stopReason, 'max_tokens');
  assert.equal(truncated.blockedToolUse, null);
  assert.equal(truncated.usage, null);
  const truncatedFromProvider = await captureAlibabaChatBody({
    modelId: 'qwen3.7-max',
    response: {
      content: [{ type: 'text', text: 'Respuesta parcial' }],
      stop_reason: 'max_tokens'
    }
  });
  assert.equal(truncatedFromProvider.out.message.content, 'Respuesta parcial');
  assert.equal(truncatedFromProvider.out.stopReason, 'max_tokens');
  assert.equal(truncatedFromProvider.out.blockedToolUse, null);
  // stop_reason nunca se convierte en error de red.
  assert(!/Error|error/.test(truncatedFromProvider.out.message.content));
  assert.equal(normalizeAlibabaAssistantOutput({ content: [] }).stopReason, null);
  // usage: solo contadores numéricos conocidos, nada más.
  assert.deepEqual(
    extractAlibabaUsage({ input_tokens: 5, output_tokens: 7, api_key: 'sk-secreto', request_id: 'r1' }),
    { input_tokens: 5, output_tokens: 7 }
  );
  assert.equal(extractAlibabaUsage(null), null);
  assert.equal(extractAlibabaUsage({ input_tokens: 'muchos' }), null);

  // H: el renderer conserva el texto y añade el aviso; no lo transforma en error.
  const noticeSource = sliceRendererFunction('appendOutputLimitNotice');
  assert(!noticeSource.includes('throw new Error'));
  assert(!noticeSource.includes('sendAIChat'));       // sin reintento automático
  assert(!noticeSource.includes('sendAIImage'));
  assert(!noticeSource.includes('registerVisualImage('));
  assert(!noticeSource.includes('**Error:**'));
  // Se invoca DESPUÉS de guardar la respuesta íntegra, así que el texto no se altera.
  // Migrado al campo normalizado del contrato: antes solo Alibaba emitía
  // 'max_tokens', así que el aviso nunca aparecía en los otros seis proveedores.
  const noticeCall = rendererSource.indexOf('await appendOutputLimitNotice(out.finishReason, requestContext);');
  assert(noticeCall > assistantSave && noticeCall < offerCall);

  function runOutputLimitNotice(stopReason, chatId = 'c1') {
    const calls = { messages: [], stored: [], toasts: [], generateImage: 0, chat: 0 };
    const harness = new Function('deps', `
      const AUTOMATIC_MODEL_ID = '__automatic__';
      const OUTPUT_LIMIT_NOTICE = ${JSON.stringify(
        rendererSource.match(/const OUTPUT_LIMIT_NOTICE = '([^']+)'/)[1]
      )};
      const activeChatId = deps.activeChatId;
      const Store = deps.Store;
      const appendMsg = deps.appendMsg;
      const showToast = deps.showToast;
      const window = deps.window;
      const requestContext = activeChatId ? {
        chatId: activeChatId,
        projectId: 'p1',
        providerId: 'alibaba',
        selectedModel: 'qwen3.7-max'
      } : null;
      const resolveRequestDestination = context => context;
      const currentRequestView = () => ({ chatId: activeChatId, projectId: 'p1' });
      const shouldRenderRequestOutput = context => Boolean(context);
      ${noticeSource}
      return stopReason => appendOutputLimitNotice(stopReason, requestContext);
    `)({
      activeChatId: chatId,
      appendMsg: message => { calls.messages.push(message); },
      showToast: (message, level) => { calls.toasts.push([message, level]); },
      // Devuelve lo mismo que el Store real: persistUserTurn trata cualquier
      // resultado sin ok:true como fallo y aborta el turno, que es lo correcto.
      Store: { addMessage: async (...args) => {
        calls.stored.push(args);
        return { ok: true, id: 'msg-' + calls.stored.length };
      } },
      window: { mika5: { ai: {
        chat: async () => { calls.chat++; return {}; },
        generateImage: async () => { calls.generateImage++; return { images: ['x'] }; }
      } } }
    });
    return { run: () => harness(stopReason), calls };
  }

  // PRUEBA OBLIGATORIA del contrato: los cuatro dialectos de truncamiento tienen
  // que llegar al aviso. Probar solo appendOutputLimitNotice() no demostraría que
  // la UI sigue avisando; esto recorre normalización → función → mensaje escrito.
  const { normalizeFinishReason } = require('../src/main/provider-capabilities');
  for (const [dialect, raw] of [
    ['OpenAI/Groq/Moonshot/llama.cpp', 'length'],
    ['Anthropic', 'max_tokens'],
    ['Alibaba', 'max_tokens'],
    ['Ollama (done_reason)', 'length']
  ]) {
    const normalized = normalizeFinishReason(raw);
    assert.equal(normalized, 'length', `${dialect}: '${raw}' debe normalizar a 'length'`);
    const notice = runOutputLimitNotice(normalized);
    assert.equal(await notice.run(), true, `${dialect}: el aviso de truncamiento debe dispararse`);
    assert.equal(notice.calls.messages.length, 1, `${dialect}: se escribe el aviso`);
  }

  const limited = runOutputLimitNotice('length');
  assert.equal(await limited.run(), true);
  assert.equal(limited.calls.messages.length, 1);
  assert.equal(limited.calls.messages[0].role, 'assistant');
  assert.match(limited.calls.messages[0].content, /alcanzó el límite de salida del modelo/);
  assert.match(limited.calls.messages[0].content, /«continúa»/);
  assert(!limited.calls.messages[0].content.includes('Error'));
  assert(!limited.calls.messages[0].content.includes('!['));
  assert.equal(limited.calls.stored.length, 1);
  assert.equal(limited.calls.stored[0][1], 'assistant');
  assert.equal(limited.calls.toasts.length, 1);
  assert.equal(limited.calls.toasts[0][1], 'info');
  assert.equal(limited.calls.generateImage, 0);
  assert.equal(limited.calls.chat, 0);

  // Sin truncado no aparece ningún aviso ni mensaje extra.
  for (const finishReason of ['stop', 'tool_use', 'content_filter', null, undefined]) {
    const normal = runOutputLimitNotice(finishReason);
    assert.equal(await normal.run(), false);
    assert.equal(normal.calls.messages.length, 0);
    assert.equal(normal.calls.stored.length, 0);
    assert.equal(normal.calls.toasts.length, 0);
  }
  // Sin chat activo no se escribe nada.
  const noChatNotice = runOutputLimitNotice('length', null);
  assert.equal(await noChatNotice.run(), false);
  assert.equal(noChatNotice.calls.stored.length, 0);

  // ---------------------------------------------------------------------------
  // LÍMITES RESIDUALES ACEPTADOS. Cada bloque fija un supuesto conocido: si un
  // cambio futuro lo altera, estos tests fallan y obligan a revisarlo a conciencia.
  // ---------------------------------------------------------------------------

  // R1: la prosa dentro del contenido pegado es indistinguible de una petición real.
  // El routing puede marcarla; la garantía son las barreras, no la heurística.
  const r1Routing = extractRoutingInstruction(
    `Analiza este ticket y dime si es viable:\n\n${'El cliente pide: genera una imagen promocional del producto.\n'.repeat(20)}`
  );
  assert(r1Routing.includes('genera una imagen promocional'));
  const r1Route = manager.routeIntent({ text: r1Routing, currentModel: 'qwen3.7-max' });
  assert.equal(r1Route.detailed.intentConflicts.analysisAndGeneration, true);
  assert.equal(r1Route.action, 'chat');
  assert.equal(r1Route.conflictAlternative, null);

  // R2: isPastedContentLine descarta prosa que empieza por palabra clave de código o
  // por CONSTANTE:, en mensajes de más de 500 caracteres.
  const r2 = extractRoutingInstruction([
    'IMPORTANTE: revisa el adjunto con calma.',
    'return al punto anterior cuando termines.',
    'Esta línea de prosa normal sí se conserva en el routing.',
    'x'.repeat(600)
  ].join('\n'));
  assert(r2.includes('Esta línea de prosa normal'));
  assert(!r2.includes('IMPORTANTE: revisa el adjunto'));
  assert(!r2.includes('return al punto anterior'));

  // R3: los mensajes de 500 caracteres o menos no pasan por el filtro (ruta rápida),
  // así que el contenido pegado corto sí puede influir en el routing.
  const r3Short = 'Analiza esto:\n{"type":"tool_use","name":"generate_image"}\ncrea una imagen de un avion';
  assert(r3Short.length <= 500);
  assert.equal(extractRoutingInstruction(r3Short), r3Short);
  assert(extractRoutingInstruction(r3Short).includes('generate_image'));
  // Aun así, el conflicto se detecta y la ruta directa queda cerrada.
  const r3Route = manager.routeIntent({ text: r3Short, currentModel: 'qwen3.7-max' });
  assert.equal(r3Route.detailed.intentConflicts.analysisAndGeneration, true);
  assert.equal(r3Route.action, 'chat');

  // R4 (RESUELTO): pendingVisualAction está aislado por chat, proyecto, proveedor e
  // imagen fuente. La identidad se valida antes de ejecutar cualquier confirmación.
  assert(pendingHandlerSource.includes('pendingVisualActionIdentityMismatch(pending)'));
  for (const check of [
    "pending.provider !== currentProvider",
    "pending.projectId !== activeProjectId",
    "pending.chatId !== activeChatId",
    "pending.sourceVisualEntryId ?? null"
  ]) {
    assert(identitySource.includes(check), `la identidad debe validar: ${check}`);
  }
  // La validación ocurre antes de escribir en la DB o de crear un chat.
  const identityCheckAt = pendingHandlerSource.indexOf('pendingVisualActionIdentityMismatch(pending)');
  const firstStoreWrite = pendingHandlerSource.indexOf('Store.addMessage');
  const chatCreation = pendingHandlerSource.indexOf('Store.createChat');
  assert(identityCheckAt >= 0 && firstStoreWrite > identityCheckAt && chatCreation > identityCheckAt);
  // La defensa interna del proveedor sigue ahí: hay awaits entre validación y generación.
  assert(pendingHandlerSource.includes('pending.provider !== requestContext.providerId'));

  // F: una solicitud textual nueva cancela el pendiente y sigue el routing normal.
  const r4 = runPendingGenerate(offeredPending, 'otra cosa cualquiera');
  assert.equal(await r4.run(), false);
  assert.equal(r4.calls.generateImage, 0);
  assert.equal(r4.harness.pending(), null);
  assert.equal(r4.calls.stored.length, 0);
  assert.equal(r4.calls.toasts.length, 0);
  const r4Long = runPendingGenerate(
    offeredPending,
    'Analiza este código que contiene generate_image y explica el error'
  );
  assert.equal(await r4Long.run(), false);
  assert.equal(r4Long.calls.generateImage, 0);
  assert.equal(r4Long.harness.pending(), null);

  // R5: frontera del margen de dominancia generativa (UNAMBIGUOUS_GENERATION_MARGIN).
  // Justo por debajo → conflicto; justo por encima → generación permitida.
  const belowMargin = detectUserIntentDetailed({
    text: 'mira esto y cambia el fondo a azul',
    attachments: [{ type: 'image', mediaType: 'image/png', base64: 'AAA' }]
  });
  assert.equal(belowMargin.intentConflicts.analysisAndGeneration, true);
  const aboveMargin = detectUserIntentDetailed({
    text: 'mira, aplica las mejoras sugeridas y crea una nueva imagen',
    lastUploadedImage: previousImage
  });
  assert.equal(aboveMargin.intentConflicts.analysisAndGeneration, false);
  assert(aboveMargin.analysisSignals.length > 0 && aboveMargin.generationSignals.length > 0);

  // R6: la rama options/shouldOfferFallback de 'unsupported' es INERTE hoy. El flujo
  // de confirmación viable es conflictAlternative + offerConflictAlternative.
  assert(providerSource.includes('const options = null;'));
  for (const inertRoute of [
    mixedEditWithContext, mixedRoute, explicitGeneration, realMixed, r1Route
  ]) {
    assert.equal(inertRoute.options, null);
  }
  assert.equal(validateVisualTaskPlan(mixedEditWithContext.plan, { vision: true }).shouldOfferFallback, false);

  console.log('Alibaba provider tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
