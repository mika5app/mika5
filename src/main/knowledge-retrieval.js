'use strict';

// Qué fragmentos de los documentos acompañan a una pregunta.
//
// Un documento largo no cabe entero en el contexto del modelo. Antes se
// mandaban los primeros fragmentos, en orden, hasta llenar el presupuesto: de
// un código de dos mil artículos el modelo sólo veía los diecinueve primeros,
// y contestaba —con razón— que el artículo 380 no estaba en lo que tenía
// delante. El documento sí estaba guardado e indexado entero; lo que faltaba
// era elegir.
//
// Aquí se elige por las palabras de la pregunta. Es búsqueda léxica, no
// semántica, a propósito: no depende de que haya un modelo de embeddings
// cargado, y para una referencia exacta —«artículo 380», «cláusula 12»,
// un nombre propio— es justo lo que acierta.
//
// Función pura: recibe las filas ya filtradas por alcance y no toca la base
// de datos. El aislamiento entre proyectos y chats se decide antes de llegar.

const PALABRAS_VACIAS = new Set((
  'a al algo ante aqui asi como con cual cuales cuando de del desde donde dos el ella ellas ellos en entre era es esa ese '
  + 'eso esta este esto estan fue ha hay la las le les lo los mas me mi mis muy no nos o para pero por que quien se sea ser '
  + 'si sin sobre son su sus te tiene tu un una uno unos y ya dice dicen dime decir indica indicame explica explicame '
  + 'puedes quiero favor segun documento documentos archivo archivos texto contenido '
  + 'the of and to in is it that this what which who how does do say says tell me about from with for on are was be an as'
).split(' '));

/** Minúsculas y sin acentos: «Artículo» y «articulo» son la misma palabra. */
function normalizar(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function palabrasDe(texto) {
  return normalizar(texto).match(/[a-z0-9ñ]+/g) || [];
}

/**
 * Términos con que buscar: palabras con significado y números. Los números
 * nunca se descartan, por cortos que sean: en «artículo 5» el 5 es la pregunta.
 */
function terminosDe(consulta) {
  const vistos = new Set();
  const terminos = [];
  for (const palabra of palabrasDe(consulta)) {
    const esNumero = /^\d+$/.test(palabra);
    if (!esNumero && (palabra.length < 3 || PALABRAS_VACIAS.has(palabra))) continue;
    if (vistos.has(palabra)) continue;
    vistos.add(palabra);
    terminos.push({ palabra, esNumero });
  }
  return terminos;
}

/** Pares «palabra número» de la consulta: «articulo 380», «clausula 12». */
function referenciasDe(consulta) {
  const palabras = palabrasDe(consulta);
  const referencias = [];
  for (let i = 0; i + 1 < palabras.length; i += 1) {
    if (/^\d+$/.test(palabras[i + 1]) && !/^\d+$/.test(palabras[i]) && palabras[i].length >= 3) {
      // Con límite de palabra a los dos lados: «articulo 38» no es el 380.
      referencias.push(new RegExp(`(?:^|[^a-z0-9ñ])${palabras[i]}\\.?\\s+${palabras[i + 1]}(?![0-9])`));
    }
  }
  return referencias;
}

function contar(texto, palabra) {
  const patron = new RegExp(`(?:^|[^a-z0-9ñ])${palabra}(?![a-z0-9ñ])`, 'g');
  return (texto.match(patron) || []).length;
}

/**
 * Elige fragmentos para una pregunta dentro de un presupuesto de caracteres.
 *
 * `filas` trae `title`, `chunk_index` y `chunk_text`. Devuelve
 * `{ fragmentos, seleccion }`: `seleccion` es `relevance` si la pregunta
 * encontró algo, y `none` si no —entonces quien llama usa su orden de
 * siempre—. Los fragmentos vuelven en orden de documento.
 */
function seleccionarFragmentos(filas, { consulta, limite } = {}) {
  const terminos = terminosDe(consulta);
  const referencias = referenciasDe(consulta);
  if (!filas.length || !terminos.length) return { fragmentos: [], seleccion: 'none' };

  const textos = filas.map(fila => normalizar(fila.chunk_text));
  // Un término que sale en casi todos los fragmentos no distingue nada.
  const apariciones = terminos.map(({ palabra }) => textos.map(texto => contar(texto, palabra)));
  const peso = apariciones.map((porFragmento, t) => {
    const con = porFragmento.filter(n => n > 0).length;
    if (!con) return 0;
    const rareza = Math.log(1 + filas.length / con);
    return rareza * (terminos[t].esNumero ? 2 : 1);
  });

  const puntuados = filas.map((fila, i) => {
    let puntos = 0;
    for (let t = 0; t < terminos.length; t += 1) {
      const n = apariciones[t][i];
      // La segunda aparición vale menos que la primera: repetir no es acertar más.
      if (n) puntos += peso[t] * (1 + Math.log(n));
    }
    // Una referencia exacta manda sobre cualquier coincidencia suelta.
    for (const referencia of referencias) {
      if (referencia.test(textos[i])) puntos += 50;
    }
    return { fila, i, puntos };
  }).filter(p => p.puntos > 0);

  if (!puntuados.length) return { fragmentos: [], seleccion: 'none' };
  puntuados.sort((a, b) => b.puntos - a.puntos || a.i - b.i);

  const elegidos = new Map();
  let usados = 0;
  const anadir = (i) => {
    if (elegidos.has(i) || i < 0 || i >= filas.length) return false;
    const largo = String(filas[i].chunk_text || '').length;
    if (usados + largo > limite) return false;
    elegidos.set(i, filas[i]);
    usados += largo;
    return true;
  };
  // El mejor fragmento entra aunque él solo supere el presupuesto: devolver
  // nada porque el acierto es largo sería volver al fallo de antes.
  elegidos.set(puntuados[0].i, puntuados[0].fila);
  usados += String(puntuados[0].fila.chunk_text || '').length;
  // Su continuación va detrás: un artículo puede partirse entre dos fragmentos.
  const siguiente = puntuados[0].i + 1;
  if (siguiente < filas.length && filas[siguiente].title === puntuados[0].fila.title) anadir(siguiente);
  for (const { i } of puntuados.slice(1)) anadir(i);

  const fragmentos = [...elegidos.entries()].sort((a, b) => a[0] - b[0]).map(([, fila]) => fila);
  return { fragmentos, seleccion: 'relevance' };
}

module.exports = { normalizar, terminosDe, referenciasDe, seleccionarFragmentos };
