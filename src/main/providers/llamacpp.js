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
  comoIniciar: 'llama-server -m modelo.gguf --port 8080',
  paquete: { winget: 'ggml.llamacpp', brew: 'llama.cpp' },
  guia: 'https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md',
  // Catálogo general de GGUF. Que un modelo esté ahí no garantiza que este
  // motor lo cargue: la compatibilidad se comprueba al cargarlo.
  libraryUrl: 'https://huggingface.co/models?library=gguf',
  descargaHf: true,
  // llama.cpp carga muchas arquitecturas, pero no todas ni en todas sus
  // versiones: de un fichero ajeno no se afirma nada. Lo único con evidencia es
  // lo que el propio llama-server descargó a su caché.
  compatibilidad: ({ source, architecture }) => {
    if (architecture && /^bitnet/.test(architecture)) return 'incompatible';
    // Los modelos de embeddings son GGUF, pero no conversan.
    if (architecture && /bert|embed/.test(architecture)) return 'incompatible';
    return source === 'llama.cpp' ? 'compatible' : 'unverified';
  },
  // Modelos pequeños, de sus autores, con licencia abierta. Cada entrada fija
  // la revisión exacta, el tamaño y el SHA-256 que publica Hugging Face: lo
  // descargado se comprueba contra eso antes de usarse.
  catalogo: [
    {
      id: 'qwen2.5-0.5b-instruct-q4_k_m', label: 'Qwen2.5 0.5B Instruct', architecture: 'qwen2',
      repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', revision: '9217f5db79a29953eb74d5343926648285ec7e67',
      file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', size: 491400032, license: 'Apache-2.0',
      sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db'
    },
    {
      id: 'qwen2.5-1.5b-instruct-q4_k_m', label: 'Qwen2.5 1.5B Instruct', architecture: 'qwen2',
      repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', revision: '91cad51170dc346986eccefdc2dd33a9da36ead9',
      file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', size: 1117320736, license: 'Apache-2.0',
      sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e'
    },
    {
      id: 'Phi-3-mini-4k-instruct-q4', label: 'Phi-3 mini 4k Instruct', architecture: 'phi3',
      repo: 'microsoft/Phi-3-mini-4k-instruct-gguf', revision: 'a64113399c2f6b8ad3e11c394733a2ddadaa7f33',
      file: 'Phi-3-mini-4k-instruct-q4.gguf', size: 2393231072, license: 'MIT',
      sha256: '8a83c7fb9049a9b2e92266fa7ad04933bb53aa1e85136b7b30f1b8000ff2edef'
    }
  ]
});

module.exports = { adaptadorLlamacpp };
