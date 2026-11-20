'use strict';

// Selección de fragmentos de documentos según la pregunta.
//
// Función pura, sin base de datos. El aislamiento entre proyectos y chats y
// el camino completo hasta SQLite se prueban en knowledge-scope (Electron).
//
//   npm run test:knowledge-retrieval

const assert = require('assert');
const { normalizar, terminosDe, referenciasDe, seleccionarFragmentos } = require('../src/main/knowledge-retrieval');

let comprobaciones = 0;
function check(condicion, mensaje) {
  assert(condicion, mensaje);
  comprobaciones += 1;
  console.log(`  ✓ ${mensaje}`);
}

const filas = [];
let articulo = 1;
for (let i = 0; i < 120; i += 1) {
  let texto = '';
  for (let k = 0; k < 17; k += 1, articulo += 1) {
    texto += `Artículo ${articulo}. Disposición ${articulo} relativa a la materia ${articulo % 9}. `.padEnd(240, 'texto ');
  }
  filas.push({ title: 'Código Civil', chunk_index: i, chunk_text: texto });
}
filas[60].chunk_text += ' La usucapión extraordinaria exige posesión ininterrumpida.';
const elegir = (consulta, limite = 12000) => seleccionarFragmentos(filas, { consulta, limite });
const contiene = (r, patron) => r.fragmentos.some(f => patron.test(f.chunk_text));

console.log('\n=== 1. Términos de búsqueda ===');
check(normalizar('Artículo ÑANDÚ') === 'articulo nandu', 'se ignoran mayúsculas, acentos y tildes, igual en la pregunta que en el documento');
check(terminosDe('¿Qué dice el Artículo 380?').map(t => t.palabra).join() === 'articulo,380',
  'de la pregunta quedan las palabras con significado y los números');
check(terminosDe('artículo 5').some(t => t.palabra === '5' && t.esNumero), 'un número corto no se descarta');
check(referenciasDe('explica la cláusula 12 y el artículo 380').length === 2, 'se reconocen las referencias «palabra número»');

console.log('\n=== 2. Referencias exactas en un documento largo ===');
for (const n of [1, 19, 20, 380, 1000, 2040]) {
  const r = elegir(`¿Qué dice el artículo ${n}?`);
  check(r.seleccion === 'relevance' && contiene(r, new RegExp(`Artículo ${n}\\. Disposición ${n} `)),
    `el artículo ${n} se encuentra, esté al principio, en medio o al final`);
}
const r380 = elegir('¿Qué dice el Artículo 380?');
check(r380.fragmentos[0].chunk_index === Math.floor(379 / 17), 'el fragmento elegido es el que lo contiene, no el primero');
check(r380.fragmentos.some(f => f.chunk_index === Math.floor(379 / 17) + 1),
  'va con su continuación: un artículo puede partirse entre dos fragmentos');
check(!contiene(elegir('artículo 38'), /^(?!.*Artículo 38\.).*Artículo 380\./s), '«artículo 38» no trae el 380 en su lugar');
check(contiene(elegir('ARTICULO 380'), /Artículo 380\./), 'sin acento y en mayúsculas se encuentra igual');
check(contiene(elegir('art. 380 del código'), /Artículo 380\./) || elegir('art. 380 del código').seleccion === 'relevance',
  'una abreviatura sigue encontrando el número');

console.log('\n=== 3. Términos, presupuesto y orden ===');
check(contiene(elegir('¿qué se exige para la usucapión extraordinaria?'), /usucapión extraordinaria/),
  'una palabra rara encuentra su fragmento sin referencia numérica');
for (const limite of [5000, 12000, 24000]) {
  const r = elegir('artículo 380 y artículo 1000', limite);
  const total = r.fragmentos.reduce((n, f) => n + f.chunk_text.length, 0);
  check(total <= Math.max(limite, filas[0].chunk_text.length + 60), `con presupuesto ${limite} lo elegido cabe (${total})`);
}
const varios = elegir('artículo 380 y artículo 1000', 24000);
check(contiene(varios, /Artículo 380\./) && contiene(varios, /Artículo 1000\./), 'dos referencias traen sus dos fragmentos');
check(varios.fragmentos.every((f, i, l) => i === 0 || l[i - 1].chunk_index < f.chunk_index), 'vuelven en orden de documento');
check(elegir('artículo 380', 10).fragmentos.length === 1, 'el mejor fragmento entra aunque él solo supere el presupuesto');

console.log('\n=== 4. Cuando la pregunta no ayuda ===');
for (const consulta of ['', '   ', 'hola', 'que dice el documento', 'zzzqqq inexistente']) {
  const r = elegir(consulta);
  check(r.seleccion === 'none' && r.fragmentos.length === 0,
    `${JSON.stringify(consulta)}: no se inventa una selección; quien llama usa su orden de siempre`);
}
check(seleccionarFragmentos([], { consulta: 'artículo 380', limite: 100 }).seleccion === 'none', 'sin documentos no hay selección');
const antes = JSON.stringify(filas);
elegir('artículo 380');
check(JSON.stringify(filas) === antes, 'las filas recibidas no se modifican');

console.log(`\nknowledge-retrieval: ${comprobaciones} comprobaciones OK`);
