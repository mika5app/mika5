'use strict';

// Aviso de nueva versión: comparación de versiones y validación de la fuente.
//
// La consulta real a GitHub no se hace aquí: `fetch` se sustituye por
// respuestas guionizadas. Lo que se comprueba es qué se acepta, qué se
// descarta y que un fallo nunca se convierte en «hay una versión nueva».
//
//   npm run test:update-check

const assert = require('assert');
const {
  ORIGEN, PAGINA_PERMITIDA, compararVersiones, consultarActualizacion
} = require('../src/main/update-check');

let comprobaciones = 0;
function check(condicion, mensaje) {
  assert(condicion, mensaje);
  comprobaciones += 1;
  console.log(`  ✓ ${mensaje}`);
}

const respuesta = (cuerpo, ok = true) => async () => ({
  ok, text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo))
});
const publicada = (extra = {}) => ({
  tag_name: 'v0.4.0', draft: false, prerelease: false, body: 'Novedades de la 0.4.0',
  html_url: `${PAGINA_PERMITIDA}tag/v0.4.0`, published_at: '2026-12-01T00:00:00Z', ...extra
});

(async () => {
  console.log('\n=== 1. Comparación de versiones ===');
  check(compararVersiones('0.3.2', '0.3.1') === 1 && compararVersiones('0.3.1', '0.3.2') === -1, 'compara el parche');
  check(compararVersiones('0.10.0', '0.9.9') === 1, '0.10.0 es mayor que 0.9.9: se compara por números, no por texto');
  check(compararVersiones('1.0.0', '0.99.99') === 1, 'la versión mayor manda');
  check(compararVersiones('v0.3.1', '0.3.1') === 0, 'el prefijo «v» no cambia la versión');
  for (const rara of ['', 'latest', '0.3', '0.3.1-beta', '0.3.1.4', null, '1.2.x']) {
    check(compararVersiones(rara, '0.3.1') === null, `${JSON.stringify(rara)} no es una versión comparable`);
  }

  console.log('\n=== 2. Fuente oficial ===');
  check(ORIGEN === 'https://api.github.com/repos/mika5app/mika5-releases/releases/latest',
    'se consulta la última versión estable del repositorio público de MIKA5');
  const vistas = [];
  const espia = async (url, opciones) => { vistas.push({ url, opciones }); return respuesta(publicada())(); };
  const nueva = await consultarActualizacion({ versionInstalada: '0.3.1', fetchFn: espia });
  check(nueva.ok && nueva.updateAvailable && nueva.installed === '0.3.1' && nueva.latest === '0.4.0',
    'con una versión publicada mayor se informa instalada y disponible');
  check(nueva.notes === 'Novedades de la 0.4.0' && nueva.url === `${PAGINA_PERMITIDA}tag/v0.4.0`,
    'se devuelven las novedades y el enlace oficial');
  check(vistas.length === 1 && vistas[0].url === ORIGEN && vistas[0].opciones.redirect === 'error',
    'una sola petición, a la fuente oficial, sin seguir redirecciones');
  const enviado = JSON.stringify(vistas[0].opciones.headers) + vistas[0].url;
  check(!/0\.3\.1/.test(enviado) && !('body' in vistas[0].opciones),
    'la petición no lleva la versión instalada ni ningún dato del usuario');

  const igual = await consultarActualizacion({ versionInstalada: '0.4.0', fetchFn: respuesta(publicada()) });
  check(igual.ok && igual.updateAvailable === false, 'con la misma versión no hay aviso');
  const adelantada = await consultarActualizacion({ versionInstalada: '0.5.0', fetchFn: respuesta(publicada()) });
  check(adelantada.ok && adelantada.updateAvailable === false, 'una compilación más nueva que la publicada no recibe aviso');

  console.log('\n=== 3. Lo que se descarta ===');
  const descartes = [
    ['un borrador', publicada({ draft: true })],
    ['una versión preliminar', publicada({ prerelease: true })],
    ['una etiqueta que no es una versión', publicada({ tag_name: 'nightly' })],
    ['un enlace a otro sitio', publicada({ html_url: 'https://ejemplo.test/descarga.exe' })],
    ['un enlace a otro repositorio', publicada({ html_url: 'https://github.com/otro/mika5-releases/releases/tag/v0.4.0' })],
    ['una respuesta sin datos', null],
    ['un cuerpo que no es JSON', '<html>error</html>']
  ];
  for (const [nombre, cuerpo] of descartes) {
    const r = await consultarActualizacion({ versionInstalada: '0.3.1', fetchFn: respuesta(cuerpo) });
    check(r.ok === false && r.errorCode === 'UPDATE_RESPONSE_INVALID' && !r.updateAvailable && !r.url,
      `${nombre} se descarta: ni aviso ni enlace`);
  }
  const caida = await consultarActualizacion({ versionInstalada: '0.3.1', fetchFn: async () => { throw new Error('ENOTFOUND'); } });
  check(caida.ok === false && caida.errorCode === 'UPDATE_SOURCE_UNREACHABLE', 'sin red se dice que no se pudo consultar');
  const limite = await consultarActualizacion({ versionInstalada: '0.3.1', fetchFn: respuesta({}, false) });
  check(limite.ok === false && limite.errorCode === 'UPDATE_SOURCE_UNREACHABLE', 'un error del servidor no se convierte en aviso');
  const sinVersion = await consultarActualizacion({ versionInstalada: 'desconocida', fetchFn: espia });
  check(sinVersion.errorCode === 'UPDATE_VERSION_UNKNOWN' && vistas.length === 1,
    'sin versión instalada conocida no se hace ninguna petición');
  const largas = await consultarActualizacion({ versionInstalada: '0.3.1', fetchFn: respuesta(publicada({ body: 'x'.repeat(20000) })) });
  check(largas.ok && largas.notes.length === 4000, 'las novedades se acotan');

  console.log(`\nupdate-check: ${comprobaciones} comprobaciones OK`);
})().catch((error) => { console.error(error); process.exit(1); });
