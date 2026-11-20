'use strict';

// Adaptador de proveedor: anthropic.
//
// Extraído sin cambios desde `ai-providers.js`, que lo sigue componiendo en
// el registro `PROVIDERS`. El objeto conserva sus propiedades, sus firmas y su
// comportamiento: este módulo sólo cambia dónde vive el código.

const {
  assertVisionSupported, buildAnthropicImageBlocks, normalizeChatResult, resolveVisionSupport
} = require('../provider-capabilities');
const {
  errorDeRespuesta, probeDeError, probeDeExito, probeDeRespuestaInvalida, probeNoIntentada
} = require('../provider-errors');
const { createAbortContext, sanitizeForCloud } = require('../provider-runtime');

// ANTHROPIC - Cloud (No privado)
const adaptadorAnthropic = {
  name: 'Anthropic Claude (Cloud)',
  // Catálogo oficial de este proveedor, para que el usuario explore modelos.
  // Cada proveedor tiene el suyo: ninguno hereda el de otro.
  libraryUrl: 'https://platform.claude.com/docs/en/models/overview',
  privacy: 'cloud',
  requiresKey: true,
  baseUrl: 'https://api.anthropic.com/v1',
  timeout: 120000,

  async chat({ model, messages, images = [], apiKey, sanitize = true, signal }) {
    if (!apiKey) throw new Error('API Key requerida para Anthropic');
    const selectedModel = model || 'claude-opus-5-5';
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

  // El catálogo se pregunta a la Models API (`GET /v1/models`), con la clave
  // del usuario. Antes era una lista escrita aquí: ofrecía identificadores ya
  // retirados y no los modelos actuales. Consultar el catálogo no es una
  // inferencia y no factura. Se pagina con `after_id` mientras haya más.
  async listModels(apiKey, _config, options = {}) {
    if (!apiKey) return { models: [], probe: probeNoIntentada() };
    const abortContext = createAbortContext(options.signal, 30000, 'Claude');
    const encontrados = [];
    let httpStatus = 200;
    try {
      let despuesDe = null;
      // Techo de páginas: una respuesta mal formada no puede dejar un bucle.
      for (let pagina = 0; pagina < 10; pagina += 1) {
        const url = `${this.baseUrl}/models?limit=100${despuesDe ? `&after_id=${encodeURIComponent(despuesDe)}` : ''}`;
        const res = await fetch(url, {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          signal: abortContext.signal
        });
        httpStatus = res.status;
        if (!res.ok) {
          return { models: [], probe: probeDeError(errorDeRespuesta(res.status, 'Anthropic no devolvió el catálogo')) };
        }
        let data;
        try {
          data = await res.json();
        } catch (_) {
          return { models: [], probe: probeDeRespuestaInvalida({ httpStatus, authenticated: true }) };
        }
        if (!data || !Array.isArray(data.data)) {
          return { models: [], probe: probeDeRespuestaInvalida({ httpStatus, authenticated: true }) };
        }
        encontrados.push(...data.data.filter(m => m && typeof m.id === 'string'));
        if (data.has_more !== true || typeof data.last_id !== 'string' || !data.last_id) break;
        despuesDe = data.last_id;
      }
    } catch (error) {
      return { models: [], probe: probeDeError(abortContext.normalize(error)) };
    } finally {
      abortContext.cleanup();
    }
    return {
      models: encontrados.map(m => ({
        name: m.id,
        size: 0,
        digest: m.id,
        description: typeof m.display_name === 'string' ? m.display_name : '',
        // Misma regla que aplica el chat al adjuntar una imagen: el selector
        // no promete visión que luego el envío rechace.
        supportsVision: resolveVisionSupport({ providerId: 'anthropic', modelId: m.id }).supported
      })),
      probe: probeDeExito({ httpStatus, authenticated: true })
    };
  }
};

module.exports = { adaptadorAnthropic };
