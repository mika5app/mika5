'use strict';

// Adaptador de proveedor: bitnet (bitnet.cpp, https://github.com/microsoft/BitNet).
//
// bitnet.cpp es un fork de llama.cpp: su `run_inference_server.py` arranca el
// mismo `llama-server`, con la misma API OpenAI-compatible. Por eso comparte
// cliente con llamacpp en vez de duplicarlo.
//
// El puerto por defecto de `run_inference_server.py` también es el 8080. MIKA5
// usa el 8081 para que BitNet y llama.cpp puedan correr a la vez y para que la
// sonda de un proveedor no dé por vivo al otro: en el mismo puerto, MIKA5 no
// podría saber cuál de los dos servidores le está respondiendo.

const { crearAdaptadorServidorLlama } = require('./llama-server');

const adaptadorBitnet = crearAdaptadorServidorLlama({
  providerId: 'bitnet',
  name: 'BitNet (Local)',
  etiqueta: 'BitNet',
  baseUrl: 'http://127.0.0.1:8081/v1',
  comoIniciar: 'python run_inference_server.py -m models/BitNet-b1.58-2B-4T/ggml-model-i2_s.gguf --port 8081',
  // bitnet.cpp no tiene paquete: se compila desde su repositorio.
  guia: 'https://github.com/microsoft/BitNet#installation'
});

module.exports = { adaptadorBitnet };
