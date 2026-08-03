(function cloudConsentModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MIKA5CloudConsent = api;
}(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  'use strict';

  const CLOUD_CONSENT_SCHEMA_VERSION = 1;
  const CATEGORIES = [
    'message', 'history', 'projectInstructions', 'textAttachments',
    'imageAttachments', 'ragContext'
  ];

  function buildCloudDataScope(input = {}) {
    return {
      message: input.message !== false,
      history: Boolean(input.history),
      projectInstructions: Boolean(input.projectInstructions),
      textAttachments: Boolean(input.textAttachments),
      imageAttachments: Boolean(input.imageAttachments),
      ragContext: Boolean(input.ragContext),
      historyMessageCount: Math.max(0, Number(input.historyMessageCount) || 0),
      attachmentNames: Array.isArray(input.attachmentNames) ? input.attachmentNames.filter(Boolean) : [],
      imageNames: Array.isArray(input.imageNames) ? input.imageNames.filter(Boolean) : [],
      ragDocumentTitles: Array.isArray(input.ragDocumentTitles) ? input.ragDocumentTitles.filter(Boolean) : [],
      ragDocumentCount: Math.max(0, Number(input.ragDocumentCount) || 0),
      ...(input.providerId ? { providerId: String(input.providerId) } : {}),
      ...(input.projectScope ? { projectScope: String(input.projectScope) } : {})
    };
  }

  function projectScope(projectId) {
    return projectId ? `project:${projectId}` : 'global';
  }

  function buildCloudConsentKey(providerId, projectId) {
    if (!providerId) throw new Error('providerId requerido');
    return `cloud-consent:v${CLOUD_CONSENT_SCHEMA_VERSION}:${providerId}:${projectScope(projectId)}`;
  }

  function consentCoversScope(consent, scope) {
    const normalized = normalizeStoredConsent(consent);
    if (!normalized) return false;
    if (scope?.providerId && normalized.providerId !== scope.providerId) return false;
    if (scope?.projectScope && normalized.projectScope !== scope.projectScope) return false;
    return CATEGORIES.every(category => !scope?.[category] || normalized.categories[category]);
  }

  function mergeConsentScope(consent, scope, identity = {}) {
    const normalized = normalizeStoredConsent(consent);
    const categories = {};
    for (const category of CATEGORIES) {
      categories[category] = Boolean(normalized?.categories?.[category] || scope?.[category]);
    }
    return {
      providerId: identity.providerId || normalized?.providerId,
      projectScope: identity.projectScope || normalized?.projectScope,
      categories,
      schemaVersion: CLOUD_CONSENT_SCHEMA_VERSION,
      grantedAt: normalized?.grantedAt || new Date().toISOString()
    };
  }

  function summarizeCloudScope(scope = {}) {
    const items = [];
    if (scope.message) items.push({ category: 'message', labelKey: 'cloudConsent.category.message', count: 1 });
    if (scope.history) items.push({
      category: 'history',
      labelKey: 'cloudConsent.category.history',
      count: scope.historyMessageCount || 0
    });
    if (scope.projectInstructions) items.push({
      category: 'projectInstructions',
      labelKey: 'cloudConsent.category.projectInstructions',
      count: 1
    });
    if (scope.textAttachments) items.push({
      category: 'textAttachments',
      labelKey: 'cloudConsent.category.textAttachments',
      count: scope.attachmentNames?.length || 0,
      names: scope.attachmentNames || []
    });
    if (scope.imageAttachments) items.push({
      category: 'imageAttachments',
      labelKey: 'cloudConsent.category.imageAttachments',
      count: scope.imageNames?.length || 0,
      names: scope.imageNames || []
    });
    if (scope.ragContext) items.push({
      category: 'ragContext',
      labelKey: 'cloudConsent.category.ragContext',
      count: scope.ragDocumentCount || 0,
      names: scope.ragDocumentTitles || []
    });
    return items;
  }

  function normalizeStoredConsent(value) {
    if (!value) return null;
    let parsed = value;
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value); } catch (_) { return null; }
    }
    if (parsed?.schemaVersion !== CLOUD_CONSENT_SCHEMA_VERSION) return null;
    if (!parsed.providerId || !parsed.projectScope || !parsed.categories) return null;
    const categories = {};
    for (const category of CATEGORIES) categories[category] = Boolean(parsed.categories[category]);
    return {
      providerId: String(parsed.providerId),
      projectScope: String(parsed.projectScope),
      categories,
      schemaVersion: CLOUD_CONSENT_SCHEMA_VERSION,
      grantedAt: String(parsed.grantedAt || '')
    };
  }

  return {
    CLOUD_CONSENT_SCHEMA_VERSION,
    buildCloudDataScope,
    buildCloudConsentKey,
    consentCoversScope,
    mergeConsentScope,
    summarizeCloudScope,
    normalizeStoredConsent,
    projectScope
  };
}));
