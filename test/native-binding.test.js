'use strict';

// Procedencia del binding nativo y comportamiento real de SQLite bajo Electron.
//
// Por qué existe: al migrar a Electron 43, la versión fijada entonces
// —`better-sqlite3@12.6.2`— no compiló contra V8: `External::Value()`,
// `External::New()`, `PropertyCallbackInfo::This()` y la sobrecarga de
// `SetNativeDataProperty` desaparecieron o cambiaron. La 12.11.1 comparte ese
// mismo código fuente.
//
// Eso NO significa que toda la serie 12 quede fuera: `better-sqlite3@12.12.0`
// existe y contempla Electron 43. Se eligió la 13.0.3 por otra razón —usa N-API
// en vez de la API de V8 y trae los binarios dentro del propio paquete npm para
// win32, darwin y linux en x64 y arm64, glibc y musl—, que es la matriz que
// necesita el empaquetado multiplataforma.
//
// Eso cambia de dónde sale el `.node`, y ahí caben dos fallos silenciosos:
//
//   1. Que se cargue un binding COMPILADO que alguien dejó en `build/Release`.
//      Funciona en la máquina que lo compiló y revienta en cualquier otra.
//   2. Que el prebuild no exista para la plataforma y `lib/binding.js` caiga al
//      camino de node-gyp sin que nadie lo note hasta empaquetar.
//
// Ninguna de las dos la detecta una prueba que sólo abra una base y consulte:
// las dos rutas producen un SQLite que funciona. Por eso aquí se comprueba de
// dónde SALE el binding, no sólo que responda.
//
// Se ejecuta con Electron, no con node: el ABI, la versión de N-API y el
// binario cargado son los del runtime empaquetado, no los del Node del sistema.
//
//   npm run test:native-binding

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

const RAIZ = path.join(__dirname, '..');
const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-native-'));

// `electron` se sustituye ANTES de cargar db.js: la prueba nunca toca el
// userData real de la usuaria.
const mock = path.join(perfil, 'mock-electron.js');
fs.writeFileSync(mock, 'module.exports = {\n'
  + `  app: { getPath: () => ${JSON.stringify(perfil)} },\n`
  + '  safeStorage: { isEncryptionAvailable: () => false }\n'
  + '};\n');
const resolverOriginal = Module._resolveFilename;
Module._resolveFilename = function (peticion, padre, ...resto) {
  if (peticion === 'electron') return mock;
  return resolverOriginal.call(this, peticion, padre, ...resto);
};

let ok = 0;
const fallos = [];
function check(condicion, mensaje) {
  if (condicion) { ok += 1; console.log(`  ✓ ${mensaje}`); }
  else { fallos.push(mensaje); console.log(`  ✗ ${mensaje}`); }
}

// ---------------------------------------------------------------------------
// 1. Runtime real
// ---------------------------------------------------------------------------
console.log('\n=== 1. Runtime ===');
const v = process.versions;
console.log(`  electron=${v.electron} node=${v.node} v8=${v.v8} `
  + `modules=${v.modules} napi=${v.napi} ${process.platform}/${process.arch}`);

check(Boolean(v.electron), `corre dentro de Electron (${v.electron})`);
check(Number(v.napi) >= 8, `el runtime declara N-API (napi=${v.napi})`);

// El ABI que declara el paquete electron y el que reporta el proceso tienen que
// ser el mismo. Si divergen, el binario extraído no es el del paquete.
const abiDeclarado = fs.readFileSync(path.join(RAIZ, 'node_modules/electron/abi_version'), 'utf8').trim();
check(abiDeclarado === String(v.modules),
  `el ABI del proceso coincide con el declarado por electron (${v.modules} == ${abiDeclarado})`);

// ---------------------------------------------------------------------------
// 2. Procedencia del binding
// ---------------------------------------------------------------------------
console.log('\n=== 2. Procedencia del binding ===');
const raizBs = path.dirname(require.resolve('better-sqlite3/package.json'));
const versionBs = require('better-sqlite3/package.json').version;
const fijada = require(path.join(RAIZ, 'package.json')).dependencies['better-sqlite3'];

check(versionBs === fijada,
  `better-sqlite3 instalado es exactamente el fijado (${versionBs} == ${fijada})`);
check(!/^[~^]/.test(fijada), `la dependencia está fijada sin rango (${fijada})`);

const prebuild = path.join(raizBs, 'prebuilds', `${process.platform}-${process.arch}.node`);
check(fs.existsSync(prebuild), `existe el prebuild de esta plataforma (${path.basename(prebuild)})`);

// Ningún binding compilado puede convivir con el prebuild: `lib/binding.js`
// prefiere el prebuild, así que uno compilado quedaría muerto y confundiría el
// diagnóstico del día que algo falle. Y si algún día el prebuild desapareciera,
// se cargaría en su lugar sin avisar.
for (const modo of ['Release', 'Debug']) {
  const compilado = path.join(raizBs, 'build', modo, 'better_sqlite3.node');
  check(!fs.existsSync(compilado), `no hay binding compilado en build/${modo}`);
}

// La prueba decisiva: se carga el prebuild, y no otra cosa. Si `require` acabase
// en el camino de node-gyp, esta ruta no aparecería.
const cargadorNode = Module._extensions['.node'];
const rutasCargadas = [];
Module._extensions['.node'] = function (modulo, ruta) {
  rutasCargadas.push(ruta);
  return cargadorNode(modulo, ruta);
};
const Database = require('better-sqlite3');
Module._extensions['.node'] = cargadorNode;

// El cargador de Electron no siempre pasa por `Module._extensions`, así que la
// ausencia de rutas no es un fallo; cuando sí las hay, se exigen correctas.
if (rutasCargadas.length) {
  check(rutasCargadas.every(r => path.resolve(r) === path.resolve(prebuild)),
    `el único .node cargado es el prebuild (${rutasCargadas.join(', ')})`);
} else {
  console.log('  · el cargador de Electron no expone la ruta; se comprueba por exclusión');
  check(!fs.existsSync(path.join(raizBs, 'build', 'Release', 'better_sqlite3.node'))
    && !fs.existsSync(path.join(raizBs, 'build', 'Debug', 'better_sqlite3.node'))
    && fs.existsSync(prebuild),
    'el prebuild es el único binding que `lib/binding.js` puede resolver');
}

// ---------------------------------------------------------------------------
// 3. SQLite real, con el código de MIKA5
// ---------------------------------------------------------------------------
console.log('\n=== 3. SQLite con initDb() real ===');
const { initDb, dbApi, getDb } = require(path.join(RAIZ, 'src/main/db.js'));
initDb();
const db = getDb();
check(Boolean(db), 'initDb() deja una conexión abierta');

const rutaBase = path.join(perfil, 'mika5.db');
check(fs.existsSync(rutaBase), 'la base se creó en el userData aislado');

// PRAGMAs que MIKA5 exige de verdad; los dos son requisito, no configuración.
check(String(db.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal',
  'journal_mode = WAL');
check(Number(db.pragma('foreign_keys', { simple: true })) === 1, 'foreign_keys = ON');

console.log(`  · SQLite ${db.prepare('SELECT sqlite_version() AS v').get().v}`);

const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
for (const t of ['projects', 'chats', 'messages', 'knowledge_items', 'knowledge_chunks', 'app_state']) {
  check(tablas.includes(t), `el esquema declara ${t}`);
}

console.log('\n=== 4. CRUD por la API real ===');
const proyecto = dbApi.createProject({ name: 'Proyecto nativo', description: 'prueba' });
check(Boolean(proyecto && proyecto.id), 'createProject() devuelve un proyecto');
check(dbApi.listProjects().some(p => p.id === proyecto.id), 'listProjects() lo incluye');

dbApi.updateProject(proyecto.id, { name: 'Renombrado' });
check(dbApi.listProjects().find(p => p.id === proyecto.id).name === 'Renombrado',
  'updateProject() persiste el cambio');

const chat = dbApi.createChat({ projectId: proyecto.id, title: 'Chat nativo' });
check(Boolean(chat && chat.id), 'createChat() devuelve un chat');
check(dbApi.listChats(proyecto.id).some(c => c.id === chat.id), 'listChats() lo incluye');

console.log('\n=== 5. Sentencias preparadas ===');
const insertar = db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)');
insertar.run('posicional', 'uno');
check(db.prepare('SELECT value FROM app_state WHERE key = ?').get('posicional').value === 'uno',
  'parámetros posicionales');

db.prepare('INSERT INTO app_state (key, value) VALUES (@k, @v)').run({ k: 'nombrado', v: 'dos' });
check(db.prepare('SELECT value FROM app_state WHERE key = @k').get({ k: 'nombrado' }).value === 'dos',
  'parámetros nombrados');

db.prepare('UPDATE app_state SET value = ? WHERE key = ?').run('uno-bis', 'posicional');
check(db.prepare('SELECT value FROM app_state WHERE key = ?').get('posicional').value === 'uno-bis',
  'UPDATE');

db.prepare('DELETE FROM app_state WHERE key = ?').run('nombrado');
check(db.prepare('SELECT value FROM app_state WHERE key = ?').get('nombrado') === undefined,
  'DELETE');

console.log('\n=== 6. Transacciones ===');
const insertarVarios = db.transaction((filas) => {
  for (const f of filas) insertar.run(f.k, f.v);
});
insertarVarios([{ k: 'tx1', v: 'a' }, { k: 'tx2', v: 'b' }]);
check(db.prepare("SELECT COUNT(*) AS n FROM app_state WHERE key LIKE 'tx%'").get().n === 2,
  'una transacción correcta confirma todas las filas');

// El rollback tiene que revertir TODO, no dejar la primera fila dentro.
let lanzo = false;
try {
  db.transaction(() => {
    insertar.run('rb1', 'a');
    insertar.run('rb1', 'duplicada');  // PRIMARY KEY: revienta
  })();
} catch (e) {
  lanzo = true;
  check(e.constructor.name === 'SqliteError', `el error es un SqliteError (${e.constructor.name})`);
  check(e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY', `con código específico (${e.code})`);
}
check(lanzo, 'la transacción con error lanza');
check(db.prepare("SELECT COUNT(*) AS n FROM app_state WHERE key = 'rb1'").get().n === 0,
  'el rollback no deja ninguna fila a medias');

console.log('\n=== 7. Cierre, reapertura y persistencia ===');
const proyectosAntes = dbApi.listProjects().length;
const mensajesAntes = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
db.close();
check(!db.open, 'la conexión queda cerrada');

initDb();
const db2 = getDb();
check(db2.open, 'reabre sin error');
check(dbApi.listProjects().length === proyectosAntes,
  `los proyectos sobreviven a la reapertura (${proyectosAntes})`);
check(db2.prepare('SELECT COUNT(*) AS n FROM messages').get().n === mensajesAntes,
  'los mensajes sobreviven a la reapertura');
check(db2.prepare('SELECT value FROM app_state WHERE key = ?').get('posicional').value === 'uno-bis',
  'app_state sobrevive a la reapertura');
db2.close();

// ---------------------------------------------------------------------------
// 8. Base preexistente: las migraciones reales, sin perder datos
// ---------------------------------------------------------------------------
console.log('\n=== 8. Base con esquema anterior ===');
//
// El esquema de abajo es el ANTERIOR a las migraciones de db.js: sin
// `system_prompt`, `icon`, `color`, `attachments`, `reply_to_id` ni `model`.
// `initDb()` las añade con ALTER TABLE, y lo que se comprueba es que las añade
// SIN tocar las filas que ya estaban.
const perfilViejo = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-legacy-'));
const baseVieja = path.join(perfilViejo, 'mika5.db');
{
  const vieja = new Database(baseVieja);
  vieja.exec(`
    CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE chats (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      title TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  vieja.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('p-viejo', 'Antiguo', 'desc', 1);
  vieja.prepare('INSERT INTO chats VALUES (?,?,?,?)').run('c-viejo', 'p-viejo', 'Chat antiguo', 2);
  vieja.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run('m-viejo', 'c-viejo', 'user', 'hola', 3);
  vieja.prepare('INSERT INTO app_state VALUES (?,?)').run('clave', 'valor');
  vieja.close();
}

// Recuento ANTES, con una conexión de sólo lectura: no se altera nada al medir.
const antes = (() => {
  const ro = new Database(baseVieja, { readonly: true });
  const r = {
    projects: ro.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
    chats: ro.prepare('SELECT COUNT(*) AS n FROM chats').get().n,
    messages: ro.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
    contenido: ro.prepare('SELECT content FROM messages WHERE id = ?').get('m-viejo').content,
    columnasProjects: ro.prepare('PRAGMA table_info(projects)').all().map(c => c.name)
  };
  ro.close();
  return r;
})();
check(!antes.columnasProjects.includes('system_prompt'),
  'la base de partida NO tiene las columnas que añaden las migraciones');

// `initDb()` apunta al userData, así que se le da el directorio de la base vieja.
fs.writeFileSync(mock, 'module.exports = {\n'
  + `  app: { getPath: () => ${JSON.stringify(perfilViejo)} },\n`
  + '  safeStorage: { isEncryptionAvailable: () => false }\n'
  + '};\n');
delete require.cache[mock];
delete require.cache[require.resolve(path.join(RAIZ, 'src/main/db.js'))];
const dbViejo = require(path.join(RAIZ, 'src/main/db.js'));
dbViejo.initDb();
const migrada = dbViejo.getDb();

const columnas = (t) => migrada.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
for (const c of ['system_prompt', 'icon', 'color']) {
  check(columnas('projects').includes(c), `la migración añade projects.${c}`);
}
check(columnas('chats').includes('system_prompt'), 'la migración añade chats.system_prompt');
for (const c of ['attachments', 'reply_to_id', 'model']) {
  check(columnas('messages').includes(c), `la migración añade messages.${c}`);
}
check(migrada.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
  .map(r => r.name).includes('knowledge_items'),
  'la migración crea las tablas de Knowledge que faltaban');

const despues = {
  projects: migrada.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
  chats: migrada.prepare('SELECT COUNT(*) AS n FROM chats').get().n,
  messages: migrada.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
  contenido: migrada.prepare('SELECT content FROM messages WHERE id = ?').get('m-viejo').content
};
check(despues.projects === antes.projects && despues.chats === antes.chats
  && despues.messages === antes.messages,
  `los recuentos no cambian (${antes.projects}/${antes.chats}/${antes.messages})`);
check(despues.contenido === antes.contenido,
  `el contenido de un mensaje anterior se conserva ("${despues.contenido}")`);

// Idempotencia: volver a migrar no puede duplicar ni romper.
migrada.close();
dbViejo.initDb();
const otraVez = dbViejo.getDb();
check(otraVez.prepare('SELECT COUNT(*) AS n FROM messages').get().n === antes.messages,
  'migrar dos veces no altera los datos');
otraVez.close();

// ---------------------------------------------------------------------------
Module._resolveFilename = resolverOriginal;
try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (_) { /* Windows */ }
try { fs.rmSync(perfilViejo, { recursive: true, force: true }); } catch (_) { /* Windows */ }

console.log(`\n${'='.repeat(40)}`);
if (fallos.length) {
  console.error(`native-binding: ${fallos.length} de ${ok + fallos.length} comprobaciones fallaron:`);
  for (const f of fallos) console.error(`  FALLO: ${f}`);
  process.exit(1);
}
console.log(`native-binding: ${ok} comprobaciones OK`);
assert.strictEqual(fallos.length, 0);
process.exit(0);
