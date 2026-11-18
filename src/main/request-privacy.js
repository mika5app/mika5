'use strict';

const { ollamaApi } = require('./ollama');
const { consentCoversScope } = require('../renderer/cloud-consent');

function ollamaModelPrivacy(info, model) {
  // Remote aliases need not contain :cloud. Prefer the runtime metadata;
  // keep the documented cloud tag conservative on older Ollama versions.
  return info?.remote_host || info?.remote_model || /(?:[:\-])cloud(?:$|:)/i.test(model)
    ? 'cloud' : 'private';
}

// Servidores locales sin modelos remotos: siempre privados. Cualquier otro id
// que no sea Ollama se trata como cloud, que es el lado seguro del error.
const PROVEEDORES_SIEMPRE_LOCALES = new Set(['llamacpp', 'bitnet']);

async function resolveRequestPrivacy(providerId, model, options = {}) {
  if (providerId !== 'local') return { privacy: PROVEEDORES_SIEMPRE_LOCALES.has(providerId) ? 'private' : 'cloud' };
  const info = await (options.show || ollamaApi.show)(model, { signal: options.signal });
  if (!info || typeof info !== 'object' || Array.isArray(info) || info.error) {
    throw new Error('No se pudo verificar el destino del modelo Ollama. Vuelve a intentarlo.');
  }
  return { privacy: ollamaModelPrivacy(info, model) };
}

function assertRequestConsent(params, privacy) {
  if (privacy !== 'cloud') return;
  const consent = params.cloudConsent;
  const scope = {
    ...params.dataScope,
    providerId: params.providerId,
    projectScope: params.projectScope,
    message: true,
    history: Boolean(params.dataScope?.history || params.messages?.some(m => m.role === 'assistant')),
    imageAttachments: Boolean(params.images?.length || params.sourceImages?.length || params.dataScope?.imageAttachments)
  };
  if (!/^global$|^project:[A-Za-z0-9._:-]{1,128}$/.test(params.projectScope || '')
    || consent?.requestId !== params.requestId || consent?.model !== params.model
    || !consentCoversScope(consent, scope)) {
    throw new Error('CLOUD_CONSENT_REQUIRED');
  }
}

module.exports = { ollamaModelPrivacy, resolveRequestPrivacy, assertRequestConsent };
