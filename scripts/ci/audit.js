#!/usr/bin/env node
'use strict';

// La política de auditoría de dependencias, en un solo sitio.
//
//   node scripts/ci/audit.js
//
// Hoy security-validation.yml repite estos dos pasos en sus siete jobs: catorce
// invocaciones que auditan el mismo package-lock.json una vez por plataforma,
// cuando el resultado no depende del sistema operativo. Este script es esa misma
// política, sin cambiarla:
//
//   1. npm audit --omit=dev     (producción)
//   2. npm audit                (todo)
//
// Sin --audit-level, sin allowlist, sin excepciones y sin `|| true`. El segundo
// comando sólo se ejecuta si el primero pasó, que es lo que hacen hoy dos pasos
// consecutivos de un job: si `Production audit` falla, `Full audit` no llega a
// correr. Cualquier código de salida distinto de cero se propaga.
//
// Dos propiedades de esta política son deliberadas y NO se corrigen aquí:
//
//   - `npm audit` consulta el registro de avisos en tiempo de ejecución, así que
//     su resultado puede cambiar para un mismo commit según el día.
//   - Sin --audit-level, una vulnerabilidad de severidad baja basta para parar
//     una release.
//
// Ambas están documentadas como decisiones pendientes. Trasladarlas tal cual es
// el objetivo: este script no es el sitio donde cambiar de opinión sobre ellas.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');

// Orden significativo: producción primero, igual que en el workflow.
const COMANDOS = [
  { etiqueta: 'auditoría de producción', argumentos: ['audit', '--omit=dev'] },
  { etiqueta: 'auditoría completa', argumentos: ['audit'] }
];

/**
 * Localiza el `npm-cli.js` que acompaña al Node en ejecución.
 *
 * No se invoca `npm` a través del PATH. En Windows eso significaría depender de
 * que `npm.cmd` esté delante del que sea, y obligaría a `shell: true` para que
 * un `.cmd` se pueda ejecutar — dos formas de acabar auditando con un npm que no
 * es el de esta CI. Ejecutar el propio `npm-cli.js` con `process.execPath`
 * garantiza el mismo runtime, no necesita shell y se comporta igual en los tres
 * sistemas. El layout del directorio sí cambia entre ellos, y por eso hay dos
 * candidatos.
 */
function resolverNpmCli(ejecutable) {
  const dir = path.dirname(ejecutable || process.execPath);
  const candidatos = [
    // Windows: node.exe y node_modules/ comparten directorio.
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Linux y macOS: el binario vive en bin/ y los módulos en lib/.
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  for (const candidato of candidatos) {
    if (fs.existsSync(candidato)) return path.normalize(candidato);
  }
  // Fallar aquí es preferible a caer al PATH: un npm distinto auditaría con otra
  // resolución de dependencias y el resultado dejaría de significar lo mismo.
  const error = new Error(
    `no se encuentra npm-cli.js junto a ${ejecutable || process.execPath}; se probó:\n  ${candidatos.map(c => path.normalize(c)).join('\n  ')}`);
  error.code = 'NPM_CLI_NO_ENCONTRADO';
  throw error;
}

/** Ejecución real. Se aísla para que las pruebas puedan sustituirla. */
function ejecutarNpm(argumentos, opciones) {
  const npmCli = resolverNpmCli(process.execPath);
  const resultado = spawnSync(process.execPath, [npmCli, ...argumentos], {
    cwd: (opciones && opciones.cwd) || RAIZ,
    stdio: 'inherit',
    // Sin shell: el ejecutable es Node y los argumentos van tal cual.
    shell: false
  });
  if (resultado.error) throw resultado.error;
  // Un proceso terminado por señal no tiene status; no se trata como éxito.
  return typeof resultado.status === 'number' ? resultado.status : 1;
}

/**
 * @param {object} [opciones]
 * @param {(argumentos: string[], opciones: object) => number} [opciones.ejecutar]
 *        Sólo para pruebas. La entrada CLI nunca lo pasa, así que no existe
 *        forma de saltarse la auditoría en una ejecución real.
 * @returns {number} código de salida
 */
function auditar(opciones) {
  const ejecutar = (opciones && opciones.ejecutar) || ejecutarNpm;
  const cwd = (opciones && opciones.cwd) || RAIZ;

  for (const { etiqueta, argumentos } of COMANDOS) {
    console.log(`\n=== npm ${argumentos.join(' ')} — ${etiqueta} ===`);
    const codigo = ejecutar(argumentos, { cwd });
    if (codigo !== 0) {
      console.log(`\nLa ${etiqueta} falló con código ${codigo}. No se continúa.`);
      return codigo;
    }
  }

  console.log('\nAuditoría de dependencias superada');
  return 0;
}

module.exports = { auditar, resolverNpmCli, COMANDOS };

if (require.main === module) {
  process.exit(auditar({}));
}
