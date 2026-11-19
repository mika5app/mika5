'use strict';

// Doble de `llama-server` para las pruebas de arranque de motores.
//
// Acepta los mismos argumentos que MIKA5 le pasa al real (`-m`, `--host`,
// `--port`) y habla el mismo protocolo: mientras «carga el modelo» contesta
// 503, como hace el servidor de verdad, y después sirve `/v1/models` y
// `/v1/chat/completions`. No es un proveedor ni se distribuye.

const http = require('http');

const args = process.argv.slice(2);
const valorDe = (nombre) => {
  const i = args.indexOf(nombre);
  return i >= 0 ? args[i + 1] : undefined;
};
const host = valorDe('--host');
const port = Number(valorDe('--port'));
const modelo = valorDe('-m');
const cargaMs = Number(process.env.FAKE_LLAMA_LOAD_MS || 0);

if (!host || !Number.isInteger(port) || !modelo) process.exit(2);
if (process.env.FAKE_LLAMA_EXIT_IMMEDIATELY === '1') process.exit(3);

// Fallos de arranque que el servidor real da en equipos con poca memoria
// gráfica, con el mismo texto en su salida de errores.
const contexto = Number(valorDe('-c') || 0);
const soloCpu = valorDe('-ngl') === '0';
const techo = Number(process.env.FAKE_LLAMA_FAIL_CTX_ABOVE || 0);
if ((techo && contexto > techo) || (process.env.FAKE_LLAMA_REQUIRE_CPU === '1' && !soloCpu)) {
  process.stderr.write('ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory\n');
  process.exit(1);
}
if (process.env.FAKE_LLAMA_UNSUPPORTED === '1') {
  process.stderr.write("error loading model architecture: unknown model architecture: 'rara'\n");
  process.exit(1);
}

const listoDesde = Date.now() + cargaMs;
const servidor = http.createServer((req, res) => {
  const json = (status, cuerpo) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cuerpo));
  };
  if (Date.now() < listoDesde) {
    return json(503, { error: { message: 'Loading model', type: 'unavailable_error', code: 503 } });
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    return json(200, { object: 'list', data: [{ id: 'modelo-de-prueba', object: 'model' }] });
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let cuerpo = '';
    req.on('data', (parte) => { cuerpo += parte; });
    req.on('end', () => {
      let peticion = {};
      try { peticion = JSON.parse(cuerpo); } catch (_) {}
      json(200, {
        model: 'modelo-de-prueba',
        choices: [{
          message: { role: 'assistant', content: `eco:${JSON.stringify(peticion.messages || [])}` },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });
    });
    return undefined;
  }
  return json(404, { error: { message: 'not found' } });
});

servidor.listen(port, host);
process.on('SIGTERM', () => process.exit(0));
