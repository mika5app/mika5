'use strict';

// Descarga de un modelo del catálogo, autorizada por el usuario.
//
// Sólo descarga lo que un adaptador declara en su catálogo: repositorio,
// revisión exacta, fichero, tamaño y SHA-256. El renderer elige una entrada
// por su identificador y nunca aporta una URL. Lo descargado se escribe a un
// fichero temporal y sólo pasa a ser un modelo si su tamaño y su SHA-256
// coinciden con los declarados; si no, se borra.
//
// Una descarga a la vez, con progreso y cancelación. No instala ni ejecuta
// nada.

const nodeCrypto = require('crypto');
const nodePath = require('path');

const ORIGEN = 'https://huggingface.co';
// Un motor ya compilado sólo se descarga de las versiones públicas de MIKA5.
const ORIGEN_DE_MOTORES = 'https://github.com/mika5app/mika5-releases/releases/download/';

function urlDe(entrada) {
  if (entrada.url) return entrada.url;
  const segmento = (texto) => String(texto).split('/').map(encodeURIComponent).join('/');
  return `${ORIGEN}/${segmento(entrada.repo)}/resolve/${encodeURIComponent(entrada.revision)}/${segmento(entrada.file)}`;
}

/** Una entrada de catálogo es válida sólo si fija todo lo que se va a comprobar. */
function entradaValida(entrada) {
  const huella = Boolean(entrada
    && /^[0-9a-f]{64}$/.test(String(entrada.sha256))
    && Number.isInteger(entrada.size) && entrada.size > 0);
  // Motor ya compilado: URL exacta dentro de las versiones de MIKA5.
  if (entrada && entrada.url !== undefined) {
    return huella
      && typeof entrada.url === 'string' && entrada.url.startsWith(ORIGEN_DE_MOTORES)
      && !/[\s?#]|\.\./.test(entrada.url.slice(ORIGEN_DE_MOTORES.length))
      && /^[\w.-]+$/.test(String(entrada.file)) && !/\.gguf$/i.test(String(entrada.file));
  }
  return Boolean(entrada
    && /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(String(entrada.repo))
    && /^[0-9a-f]{40}$/.test(String(entrada.revision))
    && /^[\w.-]+\.gguf$/i.test(String(entrada.file))
    && /^[0-9a-f]{64}$/.test(String(entrada.sha256))
    && Number.isInteger(entrada.size) && entrada.size > 0);
}

class GestorDeDescargas {
  constructor({ fs = require('fs'), fetchFn = fetch } = {}) {
    this._fs = fs;
    this._fetch = fetchFn;
    this._actual = null;
  }

  /** Estado de la descarga en curso o de la última. Sin rutas ni URL. */
  estado() {
    const d = this._actual;
    if (!d) return { state: 'idle' };
    return {
      state: d.state, providerId: d.providerId, id: d.entrada.id, label: d.entrada.label,
      received: d.recibidos, total: d.entrada.size, errorCode: d.errorCode || null
    };
  }

  enCurso() {
    return Boolean(this._actual && this._actual.state === 'downloading');
  }

  /** Ruta donde queda (o quedaría) un modelo del catálogo. */
  destino(dir, entrada) {
    return nodePath.join(dir, entrada.file);
  }

  /** ¿Ya está descargado y completo? El tamaño basta para no bajarlo otra vez. */
  yaDescargado(dir, entrada) {
    try {
      return this._fs.statSync(this.destino(dir, entrada)).size === entrada.size;
    } catch (_) {
      return false;
    }
  }

  /**
   * Empieza una descarga. Devuelve enseguida; el progreso se consulta con
   * `estado()`. `alTerminar` se llama una vez, con el estado final.
   */
  iniciar({ providerId, entrada, dir, alTerminar }) {
    if (this.enCurso()) return { ok: false, errorCode: 'MODEL_DOWNLOAD_BUSY' };
    if (!entradaValida(entrada)) return { ok: false, errorCode: 'MODEL_DOWNLOAD_INVALID' };
    if (this.yaDescargado(dir, entrada)) return { ok: true, already: true };

    const descarga = {
      providerId, entrada, state: 'downloading', recibidos: 0, errorCode: null,
      abort: new AbortController()
    };
    this._actual = descarga;
    this._descargar(descarga, dir).then((errorCode) => {
      descarga.state = errorCode ? (errorCode === 'MODEL_DOWNLOAD_CANCELED' ? 'canceled' : 'failed') : 'done';
      descarga.errorCode = errorCode;
      if (typeof alTerminar === 'function') alTerminar(this.estado());
    });
    return { ok: true, already: false };
  }

  cancelar() {
    if (this.enCurso()) {
      // Que la petición se abortase no dice por qué: sólo esto es «cancelada».
      this._actual.cancelada = true;
      this._actual.abort.abort();
    }
    return this.estado();
  }

  async _descargar(descarga, dir) {
    const { entrada } = descarga;
    const final = this.destino(dir, entrada);
    const parcial = `${final}.part`;
    let salida = null;
    // Motivo ya decidido antes de cortar la petición: cortar provoca un error
    // de red, y ese error no debe tapar la razón real.
    let veredicto = null;
    // En Windows un fichero abierto no se puede borrar: primero se cierra la
    // escritura y se espera a que el sistema suelte el fichero.
    const descartar = async () => {
      if (salida) {
        const abierta = salida;
        salida = null;
        await new Promise((resolve) => {
          abierta.once('close', resolve);
          abierta.destroy();
        });
      }
      try { this._fs.unlinkSync(parcial); } catch (_) {}
    };
    try {
      this._fs.mkdirSync(dir, { recursive: true });
      const res = await this._fetch(urlDe(entrada), { signal: descarga.abort.signal, redirect: 'follow' });
      if (!res || !res.ok || !res.body) return 'MODEL_DOWNLOAD_FAILED';

      const hash = nodeCrypto.createHash('sha256');
      salida = this._fs.createWriteStream(parcial);
      const escrito = new Promise((resolve, reject) => {
        salida.once('error', reject);
        salida.once('finish', resolve);
      });
      // Si la descarga se descarta antes de terminar, nadie espera a esta
      // promesa: su rechazo no debe quedar sin atender.
      escrito.catch(() => {});
      for await (const parte of res.body) {
        const bloque = Buffer.from(parte);
        descarga.recibidos += bloque.length;
        // Más bytes de los declarados: no es el fichero del catálogo.
        if (descarga.recibidos > entrada.size) {
          veredicto = 'MODEL_DOWNLOAD_CHECKSUM';
          descarga.abort.abort();
          await descartar();
          return veredicto;
        }
        hash.update(bloque);
        if (!salida.write(bloque)) await new Promise(resolve => salida.once('drain', resolve));
      }
      salida.end();
      await escrito;
      salida = null;

      if (descarga.recibidos !== entrada.size || hash.digest('hex') !== entrada.sha256) {
        await descartar();
        return 'MODEL_DOWNLOAD_CHECKSUM';
      }
      this._fs.renameSync(parcial, final);
      // Un motor tiene que poder ejecutarse; en Windows no hace falta marcarlo.
      if (entrada.url && process.platform !== 'win32') this._fs.chmodSync(final, 0o755);
      return null;
    } catch (error) {
      await descartar();
      if (veredicto) return veredicto;
      if (descarga.cancelada) return 'MODEL_DOWNLOAD_CANCELED';
      return error && error.code === 'ENOSPC' ? 'MODEL_DOWNLOAD_NO_SPACE' : 'MODEL_DOWNLOAD_FAILED';
    }
  }
}

module.exports = { ORIGEN, ORIGEN_DE_MOTORES, GestorDeDescargas, urlDe, entradaValida };
