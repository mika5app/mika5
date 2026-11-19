'use strict';

// Ciclo de vida de los motores locales (Ollama, llama-server).
//
// No es un registro de proveedores ni sabe nada de inferencia: cada adaptador
// local declara su propio `engine` y este módulo sólo sabe localizar un
// ejecutable, arrancarlo y detener lo que él mismo arrancó.
//
// Lo que aquí es deliberado, porque arrancar procesos es la superficie más
// delicada de la aplicación:
//
//   · El ejecutable sale de una lista CERRADA de nombres. Una ruta elegida por
//     el usuario se acepta sólo si su nombre de fichero está en esa lista.
//   · `spawn` con argumentos separados y `shell: false`. Ninguna cadena se
//     interpola en una línea de órdenes.
//   · Sólo se arranca sobre bucle local.
//   · Nunca se arranca si algo ya escucha en el puerto: puede ser el servidor
//     que el usuario lanzó a mano, o un programa ajeno.
//   · Sólo se detiene lo que MIKA5 arrancó. Un servicio externo no se toca.
//   · Nada se descarga ni se instala.

const nodePath = require('path');
const nodeCrypto = require('crypto');
const { esGguf, descubrirEjecutables } = require('./engine-discovery');

/** Nombres de ejecutable que MIKA5 acepta arrancar. Nada fuera de aquí. */
const EJECUTABLES_PERMITIDOS = Object.freeze(['ollama', 'llama-server']);

/** Estados del motor. `idle` es «MIKA5 no ha arrancado nada». */
const ESTADO_MOTOR = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  RUNNING: 'running',
  FAILED: 'failed'
});

const HOSTS_DE_BUCLE_LOCAL = new Set(['127.0.0.1', '::1', 'localhost']);

function rutasDe(platform) {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

/** Nombre lógico de un ejecutable: sin directorio, sin `.exe`, en minúsculas. */
function nombreLogico(ruta, platform) {
  const base = rutasDe(platform).basename(String(ruta || ''));
  return (platform === 'win32' ? base.replace(/\.exe$/i, '') : base).toLowerCase();
}

function esFichero(fs, ruta) {
  try {
    return fs.statSync(ruta).isFile();
  } catch (_) {
    return false;
  }
}

/**
 * Valida una ruta elegida por el usuario para un motor. Devuelve la ruta o
 * lanza con un código estable. `tipo` es `executable` o `model`.
 */
function validarRutaDeMotor(tipo, ruta, spec, { fs, platform }) {
  const rutas = rutasDe(platform);
  const fallo = (codigo) => {
    const error = new Error(codigo);
    error.code = codigo;
    return error;
  };
  if (typeof ruta !== 'string' || !ruta || !rutas.isAbsolute(ruta)) throw fallo('ENGINE_PATH_INVALID');
  if (!esFichero(fs, ruta)) throw fallo('ENGINE_PATH_INVALID');
  if (tipo === 'executable') {
    if (!spec || nombreLogico(ruta, platform) !== spec.ejecutable) throw fallo('ENGINE_EXECUTABLE_NOT_ALLOWED');
    return ruta;
  }
  if (tipo === 'model') {
    // Se mira el contenido, no la extensión: los modelos que Ollama ya
    // descargó son GGUF sin extensión, y un `.gguf` puede no serlo.
    if (!esGguf(fs, ruta)) throw fallo('ENGINE_MODEL_INVALID');
    return ruta;
  }
  throw fallo('ENGINE_PATH_INVALID');
}

/**
 * Identidad de un ejecutable: su ruta REAL (sin enlaces) y el SHA-256 de su
 * contenido. Es a lo que se ata la aprobación del usuario: si el fichero
 * cambia, o si un enlace pasa a apuntar a otro, la identidad deja de coincidir
 * y la aprobación ya no vale. Devuelve null si no se puede leer.
 */
function identidadDeEjecutable(fs, ruta) {
  let fd = null;
  try {
    const real = fs.realpathSync(ruta);
    const hash = nodeCrypto.createHash('sha256');
    const bloque = Buffer.alloc(1 << 20);
    let size = 0;
    fd = fs.openSync(real, 'r');
    for (;;) {
      const leidos = fs.readSync(fd, bloque, 0, bloque.length, size);
      if (!leidos) break;
      hash.update(bloque.subarray(0, leidos));
      size += leidos;
    }
    return { path: real, sha256: hash.digest('hex'), size };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

/** ¿La aprobación guardada corresponde exactamente a este fichero? */
function aprobacionVigente(aprobacion, identidad) {
  return Boolean(aprobacion && identidad
    && aprobacion.path === identidad.path
    && aprobacion.sha256 === identidad.sha256);
}

class GestorDeMotores {
  /**
   * Todo lo que toca el sistema se inyecta, para que las pruebas ejerzan la
   * lógica real sin arrancar nada en la máquina.
   */
  constructor({
    spawn = require('child_process').spawn,
    fs = require('fs'),
    net = require('net'),
    env = process.env,
    platform = process.platform,
    plazoDeArranqueMs = 120000
  } = {}) {
    this._spawn = spawn;
    this._fs = fs;
    this._net = net;
    this._env = env;
    this._platform = platform;
    this._plazoDeArranqueMs = plazoDeArranqueMs;
    this._motores = new Map();
    this._identidades = new Map();
  }

  /** El arranque automático se puede apagar entero, p. ej. en las suites. */
  get arranqueHabilitado() {
    return this._env.MIKA5_ENGINE_AUTOSTART !== '0';
  }

  estado(providerId) {
    const motor = this._motores.get(providerId);
    if (!motor) return { state: ESTADO_MOTOR.IDLE, owned: false, errorCode: null, model: null };
    return {
      state: motor.state,
      owned: motor.state === ESTADO_MOTOR.STARTING || motor.state === ESTADO_MOTOR.RUNNING,
      errorCode: motor.errorCode || null,
      // Con qué modelo arrancó: es lo que permite saber si hay que cambiarlo.
      model: motor.model || null
    };
  }

  /** Ruta del ejecutable: la elegida por el usuario, o la primera encontrada. */
  localizar(spec, config = {}) {
    if (!spec || !EJECUTABLES_PERMITIDOS.includes(spec.ejecutable)) return null;
    const contexto = { fs: this._fs, platform: this._platform };
    if (config.executable) {
      try {
        return validarRutaDeMotor('executable', config.executable, spec, contexto);
      } catch (_) {
        return null;
      }
    }
    return this.descubrir(spec)[0] || null;
  }

  /** Identidad del ejecutable (ruta real y SHA-256), o null. */
  identidad(ruta, { fresca = false } = {}) {
    if (!ruta) return null;
    // Calcular la huella lee el fichero entero, y la interfaz pregunta en
    // bucle. Se reutiliza mientras tamaño y fecha no cambien; justo antes de
    // arrancar se pide `fresca` y se vuelve a leer siempre.
    let marca = null;
    try {
      const st = this._fs.statSync(ruta);
      if (Number.isFinite(st.size) && Number.isFinite(st.mtimeMs)) marca = `${st.size}:${st.mtimeMs}`;
    } catch (_) {
      return null;
    }
    const guardada = this._identidades.get(ruta);
    if (!fresca && marca && guardada && guardada.marca === marca) return guardada.identidad;
    const identidad = identidadDeEjecutable(this._fs, ruta);
    if (identidad && marca) this._identidades.set(ruta, { marca, identidad });
    return identidad;
  }

  /** Todos los ejecutables de este motor que hay en el equipo. */
  descubrir(spec) {
    if (!spec || !EJECUTABLES_PERMITIDOS.includes(spec.ejecutable)) return [];
    return descubrirEjecutables(spec.ejecutable, { fs: this._fs, env: this._env, platform: this._platform });
  }

  /**
   * Qué haría falta para arrancar, sin arrancar nada. Devuelve el plan o el
   * código estable de lo que falta.
   */
  diagnosticar(spec, config = {}, { fresca = false } = {}) {
    if (!spec) return { ok: false, errorCode: 'ENGINE_NOT_MANAGED' };
    if (!this.arranqueHabilitado) return { ok: false, errorCode: 'ENGINE_AUTOSTART_DISABLED' };
    if (typeof spec.arrancable === 'function' && !spec.arrancable({ env: this._env, platform: this._platform })) {
      return { ok: false, errorCode: 'ENGINE_EXTERNALLY_CONFIGURED' };
    }
    // Un servicio que el sistema operativo administra no se arranca por fuera:
    // correría con otro usuario y otra carpeta de modelos.
    if (this._platform === 'linux' && (spec.unidadesDelSistema || []).some(ruta => this._fs.existsSync(ruta))) {
      return { ok: false, errorCode: 'ENGINE_SERVICE_MANAGED' };
    }

    let url;
    try {
      url = new URL(spec.baseUrl());
    } catch (_) {
      return { ok: false, errorCode: 'ENGINE_ENDPOINT_INVALID' };
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = Number(url.port);
    if (!HOSTS_DE_BUCLE_LOCAL.has(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, errorCode: 'ENGINE_ENDPOINT_INVALID' };
    }

    const ejecutable = this.localizar(spec, config);
    if (!ejecutable) return { ok: false, errorCode: 'ENGINE_NOT_INSTALLED' };
    // MIKA5 no ejecuta un programa que el usuario no haya aprobado. Encontrar
    // un `llama-server` en una carpeta —o en el PATH— no dice quién lo puso
    // ahí. La aprobación se ata a la ruta real y al contenido del fichero, y
    // se comprueba otra vez aquí, justo antes de arrancar.
    const identidad = this.identidad(ejecutable, { fresca });
    if (!aprobacionVigente(config.approval, identidad)) {
      return { ok: false, errorCode: 'ENGINE_APPROVAL_REQUIRED' };
    }

    let model = null;
    // Con `hf` el motor descarga el modelo él mismo: no hay fichero que validar.
    const hf = spec.descargaHf && typeof config.hf === 'string' ? config.hf : null;
    if (spec.requiereModelo && !hf) {
      if (!config.model) return { ok: false, errorCode: 'ENGINE_MODEL_REQUIRED' };
      try {
        model = validarRutaDeMotor('model', config.model, spec, { fs: this._fs, platform: this._platform });
      } catch (error) {
        return { ok: false, errorCode: error.code === 'ENGINE_MODEL_INVALID' ? 'ENGINE_MODEL_INVALID' : 'ENGINE_MODEL_MISSING' };
      }
    }

    const args = spec.argumentos({ host, port, model, hf, alias: config.modelId || null });
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
      return { ok: false, errorCode: 'ENGINE_ENDPOINT_INVALID' };
    }
    // Se arranca la ruta REAL aprobada, no un enlace que puede cambiar después.
    return { ok: true, ejecutable: identidad.path, args, host, port, model: model || hf };
  }

  /** ¿Hay algo aceptando conexiones en ese puerto? */
  _puertoOcupado(host, port) {
    return new Promise((resolve) => {
      let resuelto = false;
      const cerrar = (ocupado) => {
        if (resuelto) return;
        resuelto = true;
        try { socket.destroy(); } catch (_) {}
        resolve(ocupado);
      };
      const socket = this._net.connect({ host, port });
      socket.setTimeout(1000, () => cerrar(false));
      socket.once('connect', () => cerrar(true));
      socket.once('error', () => cerrar(false));
    });
  }

  /**
   * Arranca el motor de un proveedor. Idempotente: dos llamadas simultáneas
   * comparten el mismo arranque, y un motor vivo no se duplica.
   */
  iniciar(providerId, spec, config = {}, { sinPlazo = false } = {}) {
    const actual = this._motores.get(providerId);
    if (actual && (actual.state === ESTADO_MOTOR.STARTING || actual.state === ESTADO_MOTOR.RUNNING)) {
      return actual.arranque || Promise.resolve(this.estado(providerId));
    }

    const plan = this.diagnosticar(spec, config, { fresca: true });
    if (!plan.ok) {
      this._motores.set(providerId, { state: ESTADO_MOTOR.FAILED, errorCode: plan.errorCode });
      return Promise.resolve(this.estado(providerId));
    }

    // El estado se fija ANTES de cualquier espera: es lo que impide que una
    // segunda llamada, llegada durante la comprobación del puerto, arranque
    // otro proceso.
    const motor = {
      state: ESTADO_MOTOR.STARTING, errorCode: null, child: null, timer: null, arranque: null, model: plan.model
    };
    this._motores.set(providerId, motor);
    motor.arranque = this._arrancar(providerId, motor, plan, sinPlazo).finally(() => { motor.arranque = null; });
    return motor.arranque;
  }

  async _arrancar(providerId, motor, plan, sinPlazo) {
    const fallar = (codigo) => {
      if (this._motores.get(providerId) !== motor) return;
      if (motor.timer) clearTimeout(motor.timer);
      motor.timer = null;
      motor.state = ESTADO_MOTOR.FAILED;
      motor.errorCode = codigo;
    };

    if (await this._puertoOcupado(plan.host, plan.port)) {
      fallar('ENGINE_PORT_IN_USE');
      return this.estado(providerId);
    }

    let child;
    try {
      child = this._spawn(plan.ejecutable, plan.args, {
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: 'ignore'
      });
    } catch (_) {
      fallar('ENGINE_SPAWN_FAILED');
      return this.estado(providerId);
    }
    motor.child = child;
    child.once('error', () => fallar('ENGINE_SPAWN_FAILED'));
    child.once('exit', () => {
      motor.child = null;
      // Una parada pedida por MIKA5 no es un fallo.
      if (motor.detenido) return;
      fallar('ENGINE_EXITED');
    });

    // Si nadie confirma que el servidor contesta, el proceso se da por
    // fallido y se retira: es de MIKA5, así que puede hacerlo. Una descarga
    // autorizada no tiene plazo: puede durar lo que duren varios gigas.
    if (sinPlazo) return this.estado(providerId);
    motor.timer = setTimeout(() => {
      if (motor.state !== ESTADO_MOTOR.STARTING) return;
      this._matar(motor);
      fallar('ENGINE_START_TIMEOUT');
    }, this._plazoDeArranqueMs);
    if (typeof motor.timer.unref === 'function') motor.timer.unref();

    return this.estado(providerId);
  }

  /**
   * Alguien comprobó que el servidor contesta. Un motor arrancando pasa a
   * vivo; un fallo anterior se olvida, porque el servidor está ahí —lo haya
   * arrancado MIKA5 o el usuario—.
   */
  marcarVivo(providerId) {
    const motor = this._motores.get(providerId);
    if (!motor) return;
    if (motor.state === ESTADO_MOTOR.STARTING) {
      if (motor.timer) clearTimeout(motor.timer);
      motor.timer = null;
      motor.state = ESTADO_MOTOR.RUNNING;
    } else if (motor.state === ESTADO_MOTOR.FAILED) {
      this._motores.delete(providerId);
    }
  }

  /** Olvida un fallo para permitir un reintento pedido por el usuario. */
  reiniciarFallo(providerId) {
    const motor = this._motores.get(providerId);
    if (motor && motor.state === ESTADO_MOTOR.FAILED) this._motores.delete(providerId);
  }

  _matar(motor) {
    const child = motor.child;
    if (!child) return;
    motor.detenido = true;
    // En Windows `kill()` termina sólo el proceso padre; `ollama serve` deja
    // hijos. `taskkill /T` retira el árbol. Ruta absoluta y argumentos
    // separados: tampoco aquí hay shell.
    if (this._platform === 'win32' && Number.isInteger(child.pid) && this._env.SystemRoot) {
      try {
        const taskkill = nodePath.win32.join(this._env.SystemRoot, 'System32', 'taskkill.exe');
        const asesino = this._spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore'
        });
        if (asesino && typeof asesino.once === 'function') asesino.once('error', () => { try { child.kill(); } catch (_) {} });
        return;
      } catch (_) {}
    }
    try { child.kill(); } catch (_) {}
  }

  /**
   * Detiene el motor de un proveedor, si es de MIKA5, y espera a que salga
   * para que el puerto quede libre antes de arrancar otro modelo.
   */
  detener(providerId) {
    const motor = this._motores.get(providerId);
    this._motores.delete(providerId);
    if (!motor) return Promise.resolve();
    if (motor.timer) clearTimeout(motor.timer);
    const child = motor.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const plazo = setTimeout(resolve, 5000);
      child.once('exit', () => { clearTimeout(plazo); resolve(); });
      this._matar(motor);
    });
  }

  /**
   * Gestor de paquetes oficial con el que instalar un motor, si lo hay. Sólo
   * se devuelve la orden; ejecutarla exige la autorización del usuario.
   */
  planDeInstalacion(spec) {
    const paquete = spec && spec.paquete;
    if (!paquete) return null;
    const rutas = rutasDe(this._platform);
    const buscar = (nombre, extra = []) => {
      const fichero = this._platform === 'win32' ? `${nombre}.exe` : nombre;
      const dirs = [...String(this._env.PATH || this._env.Path || '').split(rutas.delimiter), ...extra];
      for (const dir of dirs) {
        if (!dir || !rutas.isAbsolute(dir)) continue;
        const candidato = rutas.join(dir, fichero);
        if (esFichero(this._fs, candidato)) return candidato;
        // `winget.exe` es un alias de ejecución de Windows: `stat` lo rechaza
        // con EACCES y sólo `lstat` lo ve. Existe y se puede lanzar.
        try {
          if (typeof this._fs.lstatSync === 'function' && this._fs.lstatSync(candidato)) return candidato;
        } catch (_) {}
      }
      return null;
    };
    if (this._platform === 'win32' && paquete.winget) {
      const winget = buscar('winget', this._env.LOCALAPPDATA
        ? [rutas.join(this._env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')] : []);
      if (!winget) return null;
      return {
        gestor: 'winget', ejecutable: winget, paquete: paquete.winget,
        args: ['install', '--id', paquete.winget, '-e', '--source', 'winget',
          '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity']
      };
    }
    if (this._platform !== 'win32' && paquete.brew) {
      const brew = buscar('brew', ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin']);
      if (!brew) return null;
      return { gestor: 'brew', ejecutable: brew, paquete: paquete.brew, args: ['install', paquete.brew] };
    }
    return null;
  }

  /** Ejecuta la instalación ya autorizada y espera a que termine. */
  instalar(spec) {
    const plan = this.planDeInstalacion(spec);
    if (!plan) return Promise.resolve({ ok: false, errorCode: 'ENGINE_INSTALLER_UNAVAILABLE' });
    return new Promise((resolve) => {
      let child;
      try {
        child = this._spawn(plan.ejecutable, plan.args, { shell: false, windowsHide: true, stdio: 'ignore' });
      } catch (_) {
        resolve({ ok: false, errorCode: 'ENGINE_INSTALL_FAILED' });
        return;
      }
      child.once('error', () => resolve({ ok: false, errorCode: 'ENGINE_INSTALL_FAILED' }));
      child.once('exit', (codigo) => resolve(codigo === 0
        ? { ok: true } : { ok: false, errorCode: 'ENGINE_INSTALL_FAILED' }));
    });
  }

  /** Detiene únicamente los procesos que este gestor arrancó. */
  detenerTodos() {
    for (const [providerId, motor] of this._motores) {
      if (motor.timer) clearTimeout(motor.timer);
      this._matar(motor);
      this._motores.delete(providerId);
    }
  }
}

module.exports = {
  EJECUTABLES_PERMITIDOS,
  ESTADO_MOTOR,
  GestorDeMotores,
  nombreLogico,
  validarRutaDeMotor,
  identidadDeEjecutable,
  aprobacionVigente
};
