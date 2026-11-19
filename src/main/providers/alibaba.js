'use strict';

// Adaptador de proveedor: alibaba.
//
// Extraído sin cambios desde `ai-providers.js`, que lo sigue componiendo en
// el registro `PROVIDERS`. El objeto conserva sus propiedades, sus firmas y su
// comportamiento: este módulo sólo cambia dónde vive el código.

const { normalizeChatResult } = require('../provider-capabilities');
const { probeNoIntentada } = require('../provider-errors');
const { createAbortContext } = require('../provider-runtime');

// Los helpers de configuración de Alibaba siguen en `ai-providers.js` y se
// extraen en su propia fase. Hasta entonces llegan por parámetro: importarlos
// desde aquí crearía un ciclo con el módulo que compone el registro.
function crearAdaptadorAlibaba({
  ALIBABA_DEFAULT_MODEL_ID,
  ALIBABA_PROVIDER_ID,
  ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT,
  buildAnthropicMessagesPayload,
  fetchWithProviderRetry,
  getAlibabaHttpError,
  normalizeAlibabaAssistantOutput,
  normalizeAlibabaConfig,
  normalizeAlibabaInputImage
}) {
  return {
    name: 'Alibaba Cloud Model Studio',
    // Catálogo oficial de este proveedor, para que el usuario explore modelos.
    libraryUrl: 'https://www.alibabacloud.com/help/en/model-studio/models',
    privacy: 'cloud',
    requiresKey: true,

    /**
     * Alibaba es el único adaptador con configuración editable, así que estar
     * «configurado» es más que tener credencial: sin endpoint no hay a dónde
     * enviar. Devuelve un veredicto estructurado con código estable, no un
     * booleano, para que la interfaz pueda decir qué falta.
     */
    validateConfig(providerConfig, apiKey) {
      if (!apiKey) return { ok: false, errorCode: 'PROVIDER_CREDENTIAL_REQUIRED' };
      const config = normalizeAlibabaConfig(providerConfig);
      if (!config.endpoint) return { ok: false, errorCode: 'PROVIDER_ENDPOINT_REQUIRED' };
      if (!Array.isArray(config.models) || config.models.length === 0) {
        return { ok: false, errorCode: 'PROVIDER_CATALOG_REQUIRED' };
      }
      return { ok: true };
    },

    visualCapabilities: {
      vision: true,
      sourceImages: true,
      imageEdit: true,
      imageVariation: true,
      defaultVisionModel: 'qwen3.7-plus',
      defaultImageModel: 'wan2.7-image'
    },
    timeout: 120000,

    async chat({ model, messages, images = [], apiKey, sanitize = true, providerConfig, signal }) {
      if (!apiKey) throw new Error('API Key requerida para Alibaba Cloud Model Studio');
      const config = normalizeAlibabaConfig(providerConfig);
      const selectedModelId = model || ALIBABA_DEFAULT_MODEL_ID;
      const selectedModel = config.models.find(item => item.id === selectedModelId);
      if (!selectedModel) throw new Error('El modelo no está configurado para Alibaba');
      if (selectedModel.taskType === 'image-generation') {
        throw new Error('Este modelo genera imágenes. Usa generateImage.');
      }
      if (selectedModel.taskType === 'video-generation') {
        throw new Error('Este modelo genera video y no puede usarse en chat.');
      }

      const abortContext = createAbortContext(signal, this.timeout, 'Alibaba');
      try {
        const res = await fetchWithProviderRetry(`${config.endpoint}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(buildAnthropicMessagesPayload({
            model: selectedModel,
            messages,
            images,
            sanitize
          })),
          signal: abortContext.signal
        }, {
          providerLabel: 'Alibaba Cloud Model Studio',
          attempts: 2
        });
        if (!res.ok) {
          throw new Error(getAlibabaHttpError(res.status));
        }
        const data = await res.json();
        const normalizedOutput = normalizeAlibabaAssistantOutput(data);
        return normalizeChatResult({
          providerId: ALIBABA_PROVIDER_ID,
          model: selectedModel.id,
          content: normalizedOutput.content,
          rawUsage: normalizedOutput.usage,
          rawFinishReason: normalizedOutput.stopReason,
          extra: {
            // Campos nativos de Alibaba: se conservan junto a los normalizados
            // porque el flujo visual (tool use, truncamiento) los usa tal cual.
            stopReason: normalizedOutput.stopReason,
            rawUsage: normalizedOutput.usage,
            blockedToolUse: normalizedOutput.blockedToolUse
          }
        });
      } catch (error) {
        throw abortContext.normalize(error);
      } finally {
        abortContext.cleanup();
      }
    },

    async listModels(_apiKey, providerConfig) {
      const config = normalizeAlibabaConfig(providerConfig);
      return {
        models: config.models
          .filter(model => model.taskType === 'chat' || model.taskType === 'vision')
          .map(model => ({
          name: model.id,
          description: model.displayName,
          taskType: model.taskType,
          supportsVision: model.capabilities.vision === true,
          capabilities: model.capabilities,
          parameters: model.parameters
        })),
        // El catálogo sale de la configuración del usuario, no de la red.
        probe: probeNoIntentada()
      };
    },

      async generateImage({
        model,
        prompt,
        sourceImages = [],
        apiKey,
        providerConfig,
        signal
      }) {
        if (!apiKey) throw new Error('API Key requerida para Alibaba Cloud Model Studio');
        const config = normalizeAlibabaConfig(providerConfig);
        const selectedModel = config.models.find(item => item.id === model);
        if (!selectedModel || selectedModel.taskType !== 'image-generation') {
          throw new Error('Selecciona un modelo de generación de imagen de Alibaba');
        }
        const cleanPrompt = String(prompt || '').trim();
        if (!cleanPrompt) throw new Error('Escribe una descripción para crear la imagen');

        const normalizedInputImages = (Array.isArray(sourceImages) ? sourceImages : [])
          .slice(0, 9)
          .map(normalizeAlibabaInputImage);

        const content = [
          ...normalizedInputImages.map(image => ({ image })),
          { text: cleanPrompt }
        ];

        const abortContext = createAbortContext(signal, this.timeout, 'Alibaba Cloud Model Studio');
        try {
          const res = await fetchWithProviderRetry(ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: selectedModel.id,
              input: { messages: [{ role: 'user', content }] },
              parameters: { size: '1024*1024' }
            }),
            signal: abortContext.signal
          }, {
            providerLabel: 'Alibaba Cloud Model Studio',
            attempts: 2
          });
          if (!res.ok) throw new Error(getAlibabaHttpError(res.status));
          const data = await res.json();
          const images = (data.output?.choices || [])
            .flatMap(choice => choice.message?.content || [])
            .map(item => item.image)
            .filter(image => {
              try {
                return new URL(image).protocol === 'https:';
              } catch (_) {
                return false;
              }
            });
          if (!images.length) throw new Error('Alibaba no devolvió ninguna imagen');
          return {
            ok: true,
            images,
            requestId: data.request_id || data.requestId || null
          };
        } catch (error) {
          throw abortContext.normalize(error);
        } finally {
          abortContext.cleanup();
        }
      }
  };
}

module.exports = { crearAdaptadorAlibaba };
