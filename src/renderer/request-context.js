(function requestContextModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MIKA5RequestContext = api;
}(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  'use strict';

  function fallbackRequestId() {
    const random = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(random);
    } else {
      for (let index = 0; index < random.length; index += 1) {
        random[index] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function createRequestContext({
    requestId,
    chatId,
    projectId,
    providerId,
    selectedModel,
    startedAt = Date.now()
  } = {}) {
    const resolvedRequestId = requestId
      || globalThis.crypto?.randomUUID?.()
      || fallbackRequestId();
    if (!chatId || !projectId || !providerId || !selectedModel) {
      throw new Error('Request context requires chat, project, provider and model');
    }
    return Object.freeze({
      requestId: resolvedRequestId,
      chatId,
      projectId,
      providerId,
      selectedModel,
      startedAt
    });
  }

  function isSameRequestView(context, currentState = {}) {
    return Boolean(context)
      && context.chatId === currentState.chatId
      && context.projectId === currentState.projectId;
  }

  function shouldRenderRequestOutput(context, currentState = {}) {
    return isSameRequestView(context, currentState);
  }

  function resolveRequestDestination(context) {
    if (!context?.chatId || !context?.projectId) {
      throw new Error('Invalid request destination');
    }
    return Object.freeze({
      chatId: context.chatId,
      projectId: context.projectId,
      providerId: context.providerId,
      selectedModel: context.selectedModel
    });
  }

  async function settleRequestOutput({
    context,
    responsePromise,
    currentState,
    persist,
    render,
    registerVisual
  }) {
    const output = await responsePromise;
    const destination = resolveRequestDestination(context);
    if (registerVisual) await registerVisual(output, destination, context);
    await persist(output, destination, context);
    if (shouldRenderRequestOutput(context, currentState())) {
      await render(output, destination, context);
    }
    return output;
  }

  return {
    createRequestContext,
    isSameRequestView,
    shouldRenderRequestOutput,
    resolveRequestDestination,
    settleRequestOutput
  };
}));
