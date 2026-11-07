'use strict';

// `killSurvivors()` contra procesos DE VERDAD.
//
// Por qué existe: la primera versión de esta limpieza se probaba con un `exec`
// falso que siempre devolvía "2". Eso comprobaba el texto del comando, no que
// matase nada. Y no mataba: la ruta se incrustaba con `JSON.stringify()`, que
// en Windows duplica las barras (`C:\\Users\\...`), y PowerShell no interpreta
// `\` como escape — la cadena buscada llevaba barras dobles y no casaba con
// ninguna línea de comandos real. Verde y sin efecto.
//
// Dejar cuatro Electron ajenos vivos durante una corrida demostraba el caso
// negativo —que no mata de más— y ninguno de los dos positivos: que mata al
// propio, y que distingue.
//
// Aquí se lanzan dos procesos reales y se comprueban las tres cosas.
//
// Distinción que sólo esta prueba puede sostener: el valor que devuelve
// `killSurvivors()` cuenta señales enviadas sin error, no bajas confirmadas.
// Que el proceso deje de existir se verifica aquí, reconsultando el PID después
// de esperar. Las pruebas unitarias de test/electron-test-isolation.test.js
// cubren la forma de la selección y el recuento, y no observan ninguna muerte.
//
//   node test/kill-survivors.test.js

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { killSurvivors, PROFILE_PREFIX } = require('../scripts/run-electron-test.js');

let comprobaciones = 0;
const fallos = [];
function check(condicion, mensaje) {
  comprobaciones += 1;
  if (condicion) console.log(`  ✓ ${mensaje}`);
  else { fallos.push(mensaje); console.log(`  ✗ ${mensaje}`); }
}

/**
 * Proceso de larga duración que lleva `marca` en su línea de comandos, que es
 * exactamente por donde `killSurvivors()` selecciona.
 */
function lanzarConMarca(marca) {
  const hijo = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', marca], {
    stdio: 'ignore',
    detached: false
  });
  return hijo;
}

function sigueVivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function esperar(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function principal() {
  // Dos perfiles del mismo estilo: uno es "el de esta ejecución" y el otro
  // hace de proceso ajeno. Los dos existen de verdad.
  const perfilPropio = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
  const perfilAjeno = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));

  const propio = lanzarConMarca(perfilPropio);
  const ajeno = lanzarConMarca(perfilAjeno);
  await esperar(1200); // que Windows publique la línea de comandos

  console.log('\n=== 1. Los dos procesos están vivos antes de limpiar ===');
  check(sigueVivo(propio.pid), `el proceso de esta ejecución existe (pid ${propio.pid})`);
  check(sigueVivo(ajeno.pid), `y el ajeno también (pid ${ajeno.pid})`);

  console.log('\n=== 2. La limpieza señaliza al propio, y el propio desaparece ===');
  // Dos afirmaciones distintas, comprobadas por separado: lo que la función
  // informa (señales enviadas sin error) y lo que de verdad ocurre (el proceso
  // deja de existir). La segunda exige reconsultar el PID, y eso lo hace esta
  // prueba, no la función.
  const senalizados = killSurvivors(perfilPropio);
  check(senalizados >= 1,
    `informa de al menos un superviviente señalizado (${senalizados})`);
  await esperar(1200);
  check(!sigueVivo(propio.pid),
    `y el proceso de esta ejecución ya no existe (pid ${propio.pid})`);

  console.log('\n=== 3. Y no toca el ajeno ===');
  check(sigueVivo(ajeno.pid),
    `el proceso ajeno sigue vivo (pid ${ajeno.pid})`);

  console.log('\n=== 4. Limpiar el ajeno también funciona, por su propia ruta ===');
  // Simétrico a propósito: si la primera limpieza hubiese señalizado por
  // nombre, el ajeno ya no existiría y esta comprobación no distinguiría nada.
  const senalizados2 = killSurvivors(perfilAjeno);
  check(senalizados2 >= 1, `también se le encuentra por SU ruta (${senalizados2})`);
  await esperar(1200);
  check(!sigueVivo(ajeno.pid), 'y deja de existir cuando se le apunta a él');

  console.log('\n=== 5. Una ruta sin supervivientes no señaliza nada ni falla ===');
  const vacio = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
  const ninguno = killSurvivors(vacio);
  check(ninguno === 0, `sin procesos que casen devuelve 0 (${ninguno})`);
  fs.rmSync(vacio, { recursive: true, force: true });

  console.log('\n=== 6. Una ruta no reconocible no dispara nada ===');
  for (const invalido of ['', null, undefined, path.join(os.tmpdir(), 'otra-cosa'), '/', 'C:\\']) {
    check(killSurvivors(invalido) === 0,
      `${JSON.stringify(invalido)} no envía ninguna señal de terminación`);
  }

  console.log('\n=== 7. La ruta no se incrusta en el script ===');
  {
    // La regresión concreta: `JSON.stringify()` metía barras dobles en el
    // script y la comparación no casaba nunca. Se comprueba sobre la fuente
    // porque el síntoma era silencio, no error.
    const fuente = fs.readFileSync(path.join(__dirname, '../scripts/run-electron-test.js'), 'utf8');
    const cuerpo = fuente.slice(fuente.indexOf('function killSurvivors'),
      fuente.indexOf('\n}\n', fuente.indexOf('function killSurvivors')));
    const codigo = cuerpo.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(!/JSON\.stringify\s*\(\s*profileDir/.test(codigo),
      'la ruta no se serializa dentro del script de PowerShell');
    check(/MIKA5_TEST_PROFILE_DIR/.test(codigo),
      'viaja por variable de entorno, donde no hay que escapar nada');
    check(/ProcessId -ne \$PID/.test(codigo),
      'el propio PowerShell queda excluido de la selección');
  }

  for (const dir of [perfilPropio, perfilAjeno]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (fallos.length) {
    console.error(`\nkill-survivors: ${fallos.length} de ${comprobaciones} comprobaciones fallaron`);
    for (const f of fallos) console.error('  FALLO: ' + f);
    process.exitCode = 1;
    return;
  }
  console.log(`\nKill survivors tests passed (${comprobaciones} comprobaciones)`);
}

principal().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
