'use strict';

// Aviso de nueva versión estable.
//
// Sólo AVISA. No descarga, no instala y no ejecuta nada: los instaladores de
// MIKA5 no llevan una firma de confianza, y sin ella una instalación
// automática no podría comprobar que el paquete es auténtico. Actualizar es
// abrir la página oficial de la versión, donde están los paquetes y sus sumas.
//
// La consulta va a la versión publicada más reciente del repositorio público
// de MIKA5 en GitHub. No envía nada del usuario: ni la versión instalada, ni
// un identificador, ni telemetría. GitHub ve una petición anónima, como la de
// cualquier navegador.

const ORIGEN = 'https://api.github.com/repos/mika5app/mika5-releases/releases/latest';
const PAGINA_PERMITIDA = 'https://github.com/mika5app/mika5-releases/releases/';
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const MAX_NOTAS = 4000;
const MAX_RESPUESTA = 512 * 1024;

/** Compara dos versiones `x.y.z`. Devuelve -1, 0 o 1, o null si alguna no lo es. */
function compararVersiones(a, b) {
  const pa = VERSION_RE.exec(String(a || '').trim());
  const pb = VERSION_RE.exec(String(b || '').trim());
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i += 1) {
    const diferencia = Number(pa[i]) - Number(pb[i]);
    if (diferencia !== 0) return diferencia > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Consulta la última versión estable. Nunca lanza: devuelve `ok: false` con
 * un código estable. `fetchFn` se inyecta para las pruebas.
 */
async function consultarActualizacion({ versionInstalada, fetchFn = fetch, plazoMs = 8000 } = {}) {
  const fallo = (errorCode) => ({ ok: false, errorCode, installed: versionInstalada || null });
  if (compararVersiones(versionInstalada, versionInstalada) !== 0) return fallo('UPDATE_VERSION_UNKNOWN');

  let res;
  try {
    res = await fetchFn(ORIGEN, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MIKA5' },
      redirect: 'error',
      signal: AbortSignal.timeout(plazoMs)
    });
  } catch (_) {
    return fallo('UPDATE_SOURCE_UNREACHABLE');
  }
  if (!res || !res.ok) return fallo('UPDATE_SOURCE_UNREACHABLE');

  let datos;
  try {
    const texto = await res.text();
    if (texto.length > MAX_RESPUESTA) return fallo('UPDATE_RESPONSE_INVALID');
    datos = JSON.parse(texto);
  } catch (_) {
    return fallo('UPDATE_RESPONSE_INVALID');
  }

  // Sólo vale una versión estable publicada, con etiqueta `vX.Y.Z`, y un
  // enlace que apunte al repositorio oficial. Cualquier otra cosa se descarta
  // en vez de enseñarse.
  const comparacion = datos && compararVersiones(datos.tag_name, versionInstalada);
  if (!datos || datos.draft === true || datos.prerelease === true || comparacion === null
    || typeof datos.html_url !== 'string' || !datos.html_url.startsWith(PAGINA_PERMITIDA)) {
    return fallo('UPDATE_RESPONSE_INVALID');
  }

  return {
    ok: true,
    installed: String(versionInstalada).replace(/^v/, ''),
    latest: String(datos.tag_name).replace(/^v/, ''),
    updateAvailable: comparacion > 0,
    notes: typeof datos.body === 'string' ? datos.body.slice(0, MAX_NOTAS) : '',
    url: datos.html_url,
    publishedAt: typeof datos.published_at === 'string' ? datos.published_at : null
  };
}

module.exports = { ORIGEN, PAGINA_PERMITIDA, compararVersiones, consultarActualizacion };
