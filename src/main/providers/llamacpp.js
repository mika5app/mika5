'use strict';

// Adaptador de proveedor: llamacpp.
//
// Extraído sin cambios desde `ai-providers.js`, que lo sigue componiendo en
// el registro `PROVIDERS`. El cliente HTTP vive ahora en `llama-server.js`
// porque BitNet habla el mismo protocolo; propiedades, firmas y mensajes de
// este adaptador no cambian.

const { crearAdaptadorServidorLlama } = require('./llama-server');

// LLAMA.CPP - Local (servidor OpenAI-compatible)
const adaptadorLlamacpp = crearAdaptadorServidorLlama({
  providerId: 'llamacpp',
  name: 'llama.cpp (Local)',
  etiqueta: 'llama.cpp',
  baseUrl: 'http://127.0.0.1:8080/v1',
  comoIniciar: 'llama-server -m modelo.gguf --port 8080'
});

module.exports = { adaptadorLlamacpp };
