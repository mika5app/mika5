'use strict';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

class RequestRegistry {
  constructor() {
    this.controllers = new Map();
  }

  start(requestId) {
    if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
      throw new Error('requestId inválido');
    }
    if (this.controllers.has(requestId)) {
      throw new Error('requestId duplicado');
    }
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    return controller;
  }

  finish(requestId) {
    return this.controllers.delete(requestId);
  }

  abort(requestId) {
    const controller = this.controllers.get(requestId);
    if (!controller) return { ok: true, aborted: false };
    controller.abort();
    return { ok: true, aborted: true };
  }

  has(requestId) {
    return this.controllers.has(requestId);
  }

  get size() {
    return this.controllers.size;
  }
}

module.exports = { RequestRegistry, REQUEST_ID_PATTERN };
