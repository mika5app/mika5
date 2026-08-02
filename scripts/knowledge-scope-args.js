// scripts/knowledge-scope-args.js
//
// Parseo y validación de argumentos de la herramienta de mantenimiento de
// alcance de conocimiento. Módulo puro: sin Electron, sin filesystem, sin
// SQLite — para poder probarlo con `node` a secas.
//
// La validación es deliberadamente hostil: modificar una base sólo se permite
// cuando TODAS las banderas necesarias están presentes y explícitas. No hay
// valores por defecto que apunten a la instalación real.

"use strict";

const path = require("path");

const CONFIRM_TOKEN = "REPAIR-KNOWLEDGE-SCOPE";

const ARG_ERRORS = {
  MISSING_USER_DATA: "ARG_MISSING_USER_DATA",
  MISSING_VALUE: "ARG_MISSING_VALUE",
  UNKNOWN_FLAG: "ARG_UNKNOWN_FLAG",
  MISSING_CONFIRM: "ARG_MISSING_CONFIRM",
  BAD_CONFIRM: "ARG_BAD_CONFIRM",
  REAL_USER_DATA_NOT_ALLOWED: "ARG_REAL_USER_DATA_NOT_ALLOWED",
  REBASE_EQUALS_USER_DATA: "ARG_REBASE_EQUALS_USER_DATA"
};

// Windows no distingue mayúsculas en rutas; comparar en crudo dejaría pasar
// "C:\...\MIKA5-DESKTOP" como si fuera un directorio distinto del real.
function samePath(a, b) {
  if (!a || !b) return false;
  const normalize = p => path.resolve(p).replace(/[\\/]+$/, "");
  const left = normalize(a);
  const right = normalize(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * @param {string[]} argv          argumentos ya sin `node`/script
 * @param {string|null} realUserData  userData de la instalación real, para exigir
 *                                    la bandera extra si coinciden
 * @returns {{ok:true, options:object} | {ok:false, error:string, detail?:string}}
 */
function parseArgs(argv, realUserData = null) {
  const options = {
    userData: null,
    rebaseFromUserData: null,
    execute: false,
    confirm: null,
    allowRealUserData: false
  };

  const takesValue = new Set(["--user-data", "--rebase-from-user-data", "--confirm"]);

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (takesValue.has(flag)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: ARG_ERRORS.MISSING_VALUE, detail: flag };
      }
      i++;
      if (flag === "--user-data") options.userData = value;
      else if (flag === "--rebase-from-user-data") options.rebaseFromUserData = value;
      else options.confirm = value;
      continue;
    }
    if (flag === "--execute") { options.execute = true; continue; }
    if (flag === "--allow-real-user-data") { options.allowRealUserData = true; continue; }
    return { ok: false, error: ARG_ERRORS.UNKNOWN_FLAG, detail: flag };
  }

  // --user-data es obligatorio SIEMPRE, también para inspeccionar. Nunca se
  // asume el userData de la instalación real.
  if (!options.userData) return { ok: false, error: ARG_ERRORS.MISSING_USER_DATA };

  if (options.execute) {
    if (!options.confirm) return { ok: false, error: ARG_ERRORS.MISSING_CONFIRM };
    if (options.confirm !== CONFIRM_TOKEN) return { ok: false, error: ARG_ERRORS.BAD_CONFIRM };
  }

  // Apuntar a la instalación real exige una tercera bandera explícita, tanto
  // para inspeccionar como para reparar.
  if (realUserData && samePath(options.userData, realUserData) && !options.allowRealUserData) {
    return { ok: false, error: ARG_ERRORS.REAL_USER_DATA_NOT_ALLOWED };
  }

  // Rebasar sobre sí mismo no es un ensayo: sería operar sobre el origen.
  if (options.rebaseFromUserData && samePath(options.rebaseFromUserData, options.userData)) {
    return { ok: false, error: ARG_ERRORS.REBASE_EQUALS_USER_DATA };
  }

  return { ok: true, options };
}

const REPAIR_STATES = {
  REPAIR_COMPLETE: { name: "REPAIR_COMPLETE", exit: 0 },
  REPAIR_NOT_COMMITTED: { name: "REPAIR_NOT_COMMITTED", exit: 2 },
  REPAIR_COMMITTED_CLEANUP_INCOMPLETE: { name: "REPAIR_COMMITTED_CLEANUP_INCOMPLETE", exit: 3 }
};

/**
 * Estado final a partir del resultado de la reparación.
 *
 * Clave: si SQLite YA confirmó y quedó residuo en disco, el estado NO puede ser
 * el mismo que "no se tocó nada". Decir que se revirtió sería falso — la base
 * está correcta y apunta a copias verificadas; lo que queda son duplicados.
 * Por eso sale con código distinto de cero pero no se anuncia una reversión.
 */
function selectRepairState(repair) {
  if (!repair || !repair.ok) return REPAIR_STATES.REPAIR_NOT_COMMITTED;
  if (repair.cleanupFailures > 0) return REPAIR_STATES.REPAIR_COMMITTED_CLEANUP_INCOMPLETE;
  return REPAIR_STATES.REPAIR_COMPLETE;
}

module.exports = {
  parseArgs, samePath, selectRepairState,
  CONFIRM_TOKEN, ARG_ERRORS, REPAIR_STATES
};
