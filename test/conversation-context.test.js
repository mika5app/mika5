'use strict';

// Conversaciones largas: sin límite por número de mensajes, con techo de contexto.
//
// Historia de lo que esto impide: MIKA5 avisaba a los 25 mensajes, detenía el
// envío con un diálogo a los 30 y recortaba a los 40. Ninguna de las tres
// cifras medía nada real, y «guardar para liberar espacio» no liberaba nada.
//
// Aquí se ejecuta la función REAL del renderer, extraída de app.js. Lo que no
// se prueba aquí —que el diálogo no aparece al enviar, y que los mensajes
// siguen en disco— está en las suites de Electron:
// electron-renderer-integration y db.
//
//   npm run test:conversation-context

const assert = require('assert');
const path = require('path');
const { readRendererSource } = require('./helpers/renderer-source');

const renderer = readRendererSource(path.join(__dirname, '../src/renderer/app.js'));

let comprobaciones = 0;
function check(condicion, mensaje) {
  assert(condicion, mensaje);
  comprobaciones += 1;
  console.log(`  ✓ ${mensaje}`);
}

console.log('\n=== 1. El límite por número de mensajes no existe ===');
for (const resto of ['CONTEXT_MANAGEMENT', 'SOFT_LIMIT', 'HARD_LIMIT', 'AUTO_SAVE_TRIGGER',
  'manageConversationContext', 'suggestSaveConversation', 'showContextWarning', 'smartContextTrim']) {
  check(!renderer.text.includes(resto), `app.js ya no contiene ${resto}`);
}
check(!/liberar espacio/i.test(renderer.text), 'ningún texto pide guardar «para liberar espacio»');

const presupuesto = Number(/const MAX_CONTEXT_CHARS = (\d+);/.exec(renderer.text)?.[1]);
const paresMinimos = Number(/const MIN_RECENT_PAIRS = (\d+);/.exec(renderer.text)?.[1]);
check(presupuesto > 0 && paresMinimos > 0, `el techo es un presupuesto de contexto (${presupuesto} caracteres)`);

const trimContextToBudget = new Function('MAX_CONTEXT_CHARS', 'MIN_RECENT_PAIRS', `
  ${renderer.slice('trimContextToBudget')}
  return trimContextToBudget;
`)(presupuesto, paresMinimos);

const conversacion = (n, largo) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `mensaje ${i} `.padEnd(largo, 'x')
}));
const caracteres = (mensajes) => mensajes.reduce((suma, m) => suma + m.content.length, 0);

console.log('\n=== 2. 26, 100 y 500 mensajes ===');
for (const n of [26, 100, 500]) {
  const cortos = conversacion(n, 40);
  const enviados = trimContextToBudget(cortos);
  if (caracteres(cortos) <= presupuesto) {
    check(enviados === cortos, `${n} mensajes cortos caben: se envían los ${n}, sin omitir ninguno`);
  } else {
    check(enviados.at(-1) === cortos.at(-1) && caracteres(enviados.slice(1)) <= presupuesto,
      `${n} mensajes cortos no caben enteros: se envían los más recientes dentro del presupuesto`);
  }

  const largos = conversacion(n, 400);
  const recortados = trimContextToBudget(largos);
  if (caracteres(largos) <= presupuesto) {
    check(recortados === largos, `${n} mensajes largos caben: se envían los ${n}, sin omitir ninguno`);
    continue;
  }
  const omitidos = n - (recortados.length - 1);
  check(recortados[0].role === 'system' && recortados[0].content.includes(String(omitidos)),
    `${n} mensajes largos: se dice cuántos se omitieron (${omitidos})`);
  check(recortados.at(-1) === largos.at(-1), `${n} mensajes largos: el último mensaje siempre viaja`);
  check(caracteres(recortados.slice(1)) <= presupuesto,
    `${n} mensajes largos: lo enviado no supera el presupuesto (${caracteres(recortados.slice(1))} ≤ ${presupuesto})`);
  check(largos.length === n, `${n} mensajes largos: la conversación original no se toca`);
  const recientes = recortados.slice(1);
  check(recientes.every((m, i) => m === largos[n - recientes.length + i]),
    `${n} mensajes largos: lo conservado es el tramo más reciente, en orden`);
}

console.log('\n=== 3. El techo no crece con la conversación ===');
const en500 = caracteres(trimContextToBudget(conversacion(500, 400)).slice(1));
const en5000 = caracteres(trimContextToBudget(conversacion(5000, 400)).slice(1));
check(en5000 <= presupuesto && Math.abs(en5000 - en500) <= 400,
  `con 5000 mensajes se envía lo mismo que con 500 (${en5000} frente a ${en500})`);

const gigantes = conversacion(6, presupuesto);
const minimos = trimContextToBudget(gigantes);
// Comportamiento que ya existía y no se cambia: con mensajes enormes se
// conservan los más recientes aunque superen el presupuesto, para que el
// modelo nunca reciba sólo el último mensaje sin nada de lo anterior.
check(minimos.length - 1 === paresMinimos * 2 - 1 && minimos.at(-1) === gigantes.at(-1),
  `aunque los mensajes sean enormes se conservan los ${paresMinimos * 2 - 1} más recientes`);

console.log(`\nconversation-context: ${comprobaciones} comprobaciones OK`);
