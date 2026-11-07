'use strict';

// Adaptador de proveedor: anthropic.
//
// Extraído sin cambios desde `ai-providers.js`, que lo sigue componiendo en
// el registro `PROVIDERS`. El objeto conserva sus propiedades, sus firmas y su
// comportamiento: este módulo sólo cambia dónde vive el código.

const {
  assertVisionSupported, buildAnthropicImageBlocks, normalizeChatResult, resolveVisionSupport
} = require('../provider-capabilities');
const { probeNoIntentada } = require('../provider-errors');
const { createAbortContext, sanitizeForCloud } = require('../provider-runtime');

// ANTHROPIC - Cloud (No privado)
const adaptadorAnthropic = {
  name: 'Anthropic Claude (Cloud)',
  privacy: 'cloud',
  requiresKey: true,
  baseUrl: 'https://api.anthropic.com/v1',
  timeout: 120000,

  async chat({ model, messages, images = [], apiKey, sanitize = true, signal }) {
    if (!apiKey) throw new Error('API Key requerida para Anthropic');
    const selectedModel = model || 'claude-3-5-haiku-20241022';
    assertVisionSupported({
      providerId: 'anthropic',
      modelId: selectedModel,
      imageCount: images.length
    });

    // Combine ALL system messages (project context + RAG context) into one string
    // Anthropic's API takes a single top-level "system" field
    const systemParts = messages
      .filter(m => m.role === 'system')
      .map(m => sanitize ? sanitizeForCloud(m.content) : m.content)
      .filter(Boolean);
    const systemContent = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

    // Anthropic requires strict user/assistant alternation — merge consecutive same-role msgs
    const rawConversation = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: sanitize ? sanitizeForCloud(m.content) : m.content
      }));

    // Merge consecutive messages of the same role
    const conversation = rawConversation.reduce((acc, msg) => {
      if (acc.length > 0 && acc[acc.length - 1].role === msg.role) {
        acc[acc.length - 1].content += '\n\n' + msg.content;
      } else {
        acc.push({ ...msg });
      }
      return acc;
    }, []);

    // Anthropic requires conversation to start with 'user'
    if (conversation.length > 0 && conversation[0].role !== 'user') {
      conversation.unshift({ role: 'user', content: '.' });
    }
    if (conversation.length === 0) {
      throw new Error('No hay mensajes de usuario para enviar a Anthropic');
    }

    if (images.length) {
      const imageBlocks = buildAnthropicImageBlocks(images);
      const lastUserIndex = conversation.map(m => m.role).lastIndexOf('user');
      const lastUser = conversation[lastUserIndex];
      lastUser.content = [{ type: 'text', text: lastUser.content }, ...imageBlocks];
    }

    const abortContext = createAbortContext(signal, this.timeout, 'Claude');

    try {
      const body = {
        model: selectedModel,
        max_tokens: 8096,
        messages: conversation
      };
      if (systemContent) body.system = systemContent;

      const res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: abortContext.signal
      });

      if (res.status === 401) throw new Error('API Key inválida o expirada');
      if (res.status === 429) throw new Error('Rate limit excedido');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Anthropic Error: ${res.status}`);
      }

      const data = await res.json();
      const textParts = (Array.isArray(data.content) ? data.content : [])
        .filter(block => block?.type === 'text')
        .map(block => block.text)
        .filter(Boolean);
      return normalizeChatResult({
        providerId: 'anthropic',
        model: data.model || selectedModel,
        content: textParts.join('\n\n'),
        rawUsage: data.usage,
        rawFinishReason: data.stop_reason
      });
    } catch (error) {
      throw abortContext.normalize(error);
    } finally {
      abortContext.cleanup();
    }
  },

  async listModels(apiKey) {
    if (!apiKey) return { models: [] };
    // Anthropic no tiene endpoint público de modelos — lista actualizada 2025/2026
    const catalog = [
      { name: 'claude-opus-4-5', size: 0, description: 'Claude Opus 4.5 — máxima capacidad' },
      { name: 'claude-sonnet-4-5-20251001', size: 0, description: 'Claude Sonnet 4.5 — rápido y capaz' },
      { name: 'claude-3-5-sonnet-20241022', size: 0, description: 'Claude 3.5 Sonnet — equilibrio ideal' },
      { name: 'claude-3-5-haiku-20241022', size: 0, description: 'Claude 3.5 Haiku — ultra-rápido' },
      { name: 'claude-3-opus-20240229', size: 0, description: 'Claude 3 Opus — razonamiento profundo' },
      { name: 'claude-3-haiku-20240307', size: 0, description: 'Claude 3 Haiku — económico y veloz' }
    ];
    return {
      models: catalog.map(model => ({
        ...model,
        supportsVision: resolveVisionSupport({ providerId: 'anthropic', modelId: model.name }).supported
      })),
      // Catálogo declarado en el propio adaptador: no se ha hablado con
      // ningún servidor, así que no hay evidencia que aportar.
      probe: probeNoIntentada()
    };
  }
};

module.exports = { adaptadorAnthropic };
