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
  // Lista oficial de modelos que bitnet.cpp soporta.
  libraryUrl: 'https://github.com/microsoft/BitNet#supported-models',
  guia: 'https://github.com/microsoft/BitNet#installation',
  // bitnet.cpp no se instala con un paquete: se compila en el equipo.
  instalacion: 'source',
  experimental: true,
  // Motores de BitNet ya compilados que MIKA5 puede instalar. bitnet.cpp no
  // publica binarios: cada entrada es una compilación de MIKA5, con su huella.
  runtimes: [],
  // Lo que pide su README para compilar: Python, CMake y Clang, además de Git
  // para obtener el código.
  requisitos: ['git', 'python', 'cmake', 'clang'],
  // bitnet.cpp sólo carga modelos de 1,58 bits. Un GGUF que declara otra
  // arquitectura —los de Ollama, los de llama.cpp— no es de BitNet; uno que no
  // declara ninguna no se da por bueno ni por malo.
  compatibilidad: ({ architecture }) => {
    if (!architecture) return 'unverified';
    return /^bitnet/.test(architecture) ? 'compatible' : 'incompatible';
  },
  // Los argumentos del lanzador oficial, `run_inference_server.py`: sólo CPU
  // (`-ngl 0`) y batching continuo (`-cb`). bitnet.cpp está hecho para CPU.
  argumentos: ({ host, port, model, alias, ctx }) => [
    '-m', model,
    ...(alias ? ['--alias', alias] : []),
    '-c', String(ctx || 4096),
    '-ngl', '0',
    '-cb',
    '--host', host, '--port', String(port)
  ],
  variantes: [{ ctx: 4096 }, { ctx: 2048 }],
  // El motor de BitNet es el `llama-server` que compila bitnet.cpp, no
  // cualquier programa con ese nombre: el de llama.cpp se llama igual y no
  // carga modelos de 1,58 bits. Se reconoce por estar dentro de un clon de
  // bitnet.cpp, que trae `run_inference_server.py` en su raíz.
  aceptaEjecutable: (ruta, { fs, platform, carpetaPropia }) => {
    const rutas = platform === 'win32' ? require('path').win32 : require('path').posix;
    let dir = rutas.dirname(ruta);
    // El motor que instaló MIKA5: descargado de su catálogo y comprobado
    // contra su SHA-256 antes de quedar ahí.
    if (carpetaPropia && dir === carpetaPropia) return true;
    for (let nivel = 0; nivel < 5; nivel += 1) {
      try {
        if (fs.statSync(rutas.join(dir, 'run_inference_server.py')).isFile()) return true;
      } catch (_) {}
      const padre = rutas.dirname(dir);
      if (padre === dir) break;
      dir = padre;
    }
    return false;
  },
  catalogo: [
    {
      id: 'bitnet-b1.58-2B-4T-i2_s', label: 'BitNet b1.58 2B 4T', architecture: 'bitnet-b1.58',
      repo: 'microsoft/bitnet-b1.58-2B-4T-gguf', revision: 'a1f2f1c765812aa8af3f6eda4a313707064bba15',
      file: 'ggml-model-i2_s.gguf', size: 1187801280, license: 'MIT',
      sha256: '4221b252fdd5fd25e15847adfeb5ee88886506ba50b8a34548374492884c2162'
    }
  ]
});

module.exports = { adaptadorBitnet };
