// test/public-readiness.test.js — Lo que el repositorio promete al hacerse
// publico y al pedir firma de codigo tiene que seguir siendo verdad.
//
// Run: node test/public-readiness.test.js
//
// Por que existe: son documentos y reglas faciles de romper sin que ninguna
// otra suite lo note. Una politica de firma que diga que los binarios estan
// firmados cuando no lo estan, o un flujo que entregue un secreto a un pull
// request de fuera, no hace fallar ninguna prueba de la aplicacion.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}
const leer = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

console.log('\n=== 1. Documentos que un repositorio Community publico necesita ===');
for (const archivo of ['LICENSE', 'README.md', 'BUILDING.md', 'CONTRIBUTING.md', 'COMMUNITY.md', 'SECURITY.md',
  'CODE_OF_CONDUCT.md', 'TRADEMARK.md', 'PRIVACY.md', 'CODE_SIGNING_POLICY.md', '.github/CODEOWNERS']) {
  check(fs.existsSync(path.join(ROOT, archivo)) && leer(archivo).trim().length > 40, `${archivo} existe`);
}
check(/^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s*\n\s*Version 3,/.test(leer('LICENSE')), 'LICENSE es el texto de AGPL-3.0');
const pkg = JSON.parse(leer('package.json'));
check(pkg.license === 'AGPL-3.0', 'package.json declara AGPL-3.0');
check(/Developer Certificate of Origin/.test(leer('CONTRIBUTING.md')) && !/contributor licen[cs]e agreement/i.test(leer('CONTRIBUTING.md')),
  'las contribuciones entran con DCO, sin un acuerdo que permita relicenciarlas');

console.log('\n=== 2. Privacidad ===');
const DECLARACION = 'This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.';
check(leer('PRIVACY.md').includes(DECLARACION), 'PRIVACY.md lleva la declaracion de no transferencia');
check(leer('CODE_SIGNING_POLICY.md').includes(DECLARACION) && /\(PRIVACY\.md\)/.test(leer('CODE_SIGNING_POLICY.md')),
  'la politica de firma repite la declaracion y enlaza la de privacidad');

console.log('\n=== 3. Politica de firma: no afirma lo que no es ===');
const firma = leer('CODE_SIGNING_POLICY.md');
check(/^# Code signing policy/m.test(firma), 'usa el termino «Code signing policy»');
const flujos = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter(f => /\.ya?ml$/.test(f));
const usaSignPath = flujos.some(f => /signpath/i.test(leer(`.github/workflows/${f}`)));
check(usaSignPath || /are not code-signed yet/.test(firma),
  'mientras ningun flujo firme, la politica dice que los binarios no estan firmados');
check(usaSignPath || /not code-signed yet/.test(leer('README.md')), 'y el README tambien');
for (const rol of ['Authors', 'Reviewers', 'Approvers']) {
  check(new RegExp(`\\| ${rol}[^|]*\\| \\[@[A-Za-z0-9-]+\\]\\(https://github\\.com/`).test(firma), `nombra quien tiene el rol ${rol}`);
}
check(/SignPath\.io/.test(firma) && /SignPath Foundation/.test(firma), 'nombra a SignPath.io y a SignPath Foundation');
check(/^\* @[A-Za-z0-9-]+$/m.test(leer('.github/CODEOWNERS')), 'CODEOWNERS asigna revisor a todo cambio');

console.log('\n=== 4. Los secretos no llegan a codigo no confiable ===');
check(flujos.length >= 4, `se revisan los ${flujos.length} flujos de trabajo`);
for (const archivo of flujos) {
  const texto = leer(`.github/workflows/${archivo}`);
  check(!/pull_request_target/.test(texto), `${archivo}: no usa pull_request_target`);
  if (!/secrets\./.test(texto)) continue;
  const disparaConPr = /^\s{2}pull_request:/m.test(texto);
  // Un flujo que tambien corre en pull requests solo puede leer secretos en
  // trabajos condicionados a una etiqueta de version.
  if (disparaConPr) {
    const trabajos = texto.split(/\n(?=  [a-z][a-z0-9_-]*:\n)/).filter(t => /secrets\./.test(t));
    check(trabajos.length > 0 && trabajos.every(t => /\n    if: github\.ref_type == 'tag'/.test(t)),
      `${archivo}: todo trabajo que lee un secreto exige una etiqueta de version`);
  } else {
    check(/^\s{2}(push|workflow_dispatch):/m.test(texto), `${archivo}: lee secretos y no se dispara con pull requests`);
  }
}

// El flujo que despliega la web recibe la clave SSH del servidor. Con el
// repositorio publico, una accion de terceros referida por etiqueta podria
// cambiar de contenido sin que nada aqui cambie.
{
  const despliegue = leer('.github/workflows/deploy-landing.yml');
  check(/^permissions:\n  contents: read\n/m.test(despliegue), 'deploy-landing.yml: su token solo puede leer');
  const acciones = [...despliegue.matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map(m => m[1]);
  check(acciones.length === 3 && acciones.every(a => /@[0-9a-f]{40}$/.test(a)),
    `deploy-landing.yml: sus ${acciones.length} acciones van fijadas a un commit exacto, no a una etiqueta`);
  check(!/^\s{2}pull_request/m.test(despliegue) && /persist-credentials: false/.test(despliegue),
    'deploy-landing.yml: no corre en pull requests ni deja credenciales en la copia de trabajo');
}

console.log('\n=== 4b. Protecciones preparadas para cuando el repositorio sea publico ===');
{
  const regla = (nombre) => JSON.parse(leer(`.github/rulesets/${nombre}.json`));
  const main = regla('main');
  const tipos = (r) => r.rules.map(x => x.type).sort().join();
  check(main.target === 'branch' && main.enforcement === 'active'
    && main.conditions.ref_name.include.join() === 'refs/heads/main' && main.bypass_actors.length === 0,
    'main: regla activa sobre refs/heads/main, sin nadie que la salte');
  check(tipos(main) === 'deletion,non_fast_forward,pull_request,required_status_checks',
    'main: pull request obligatorio, checks obligatorios, sin force-push ni borrado');
  // Los checks exigidos son los que el flujo produce de verdad en todo pull
  // request: el nombre del trabajo que llama al flujo canonico, mas cada
  // trabajo que corre siempre. Un nombre inventado dejaria main sin poder
  // fusionar nada; uno de un trabajo condicional (package), tambien.
  const build = leer('.github/workflows/build.yml');
  const canonico = leer('.github/workflows/_canonical.yml');
  const llamador = /\n  ([a-z][a-z0-9_-]*):\n    uses: \.\/\.github\/workflows\/_canonical\.yml/.exec(build)[1];
  const sistemas = /\n  quality-gates:\n[\s\S]*?matrix:\n\s+os: \[([^\]]+)\]/.exec(canonico)[1].split(',').map(x => x.trim());
  const esperados = [`${llamador} / source`, ...sistemas.map(os => `${llamador} / quality-gates (${os})`)].sort();
  const exigidos = main.rules.find(r => r.type === 'required_status_checks').parameters.required_status_checks;
  check(/\n  source:\n/.test(canonico) && !/\n  source:\n(?:    .*\n)*?    if:/.test(canonico)
    && exigidos.map(c => c.context).sort().join('|') === esperados.join('|'),
    `main exige exactamente los checks que siempre corren (${esperados.join(', ')})`);
  check(/^  pull_request:\n    branches:\n      - main\n/m.test(build) && !/^  pull_request:\n(?:    .*\n)*?    paths/m.test(build),
    'y el flujo corre en todo pull request a main, sin filtro de rutas que deje un check sin informar');
  check(main.rules.find(r => r.type === 'pull_request').parameters.required_approving_review_count === 0,
    'main: cero aprobaciones exigidas mientras haya una sola persona (nadie aprueba su propio pull request)');

  const fijas = regla('release-tags-immutable');
  const crear = regla('release-tags-create');
  check([fijas, crear].every(r => r.target === 'tag' && r.enforcement === 'active' && r.conditions.ref_name.include.join() === 'refs/tags/v*'),
    'las dos reglas de tags cubren refs/tags/v*');
  check(tipos(fijas) === 'deletion,non_fast_forward,update' && fijas.bypass_actors.length === 0,
    'un tag de version no se mueve ni se borra, y nadie lo salta');
  check(tipos(crear) === 'creation' && crear.bypass_actors.some(a => a.actor_type === 'RepositoryRole' && a.actor_id === 5 && a.bypass_mode === 'always'),
    'solo un administrador crea tags de version: asi se puede seguir publicando');
  // El flujo de release se dispara con el tag: si la regla de creacion no
  // dejara pasar a nadie, no habria forma de publicar.
  check(/tags:\n\s+- 'v\*\.\*\.\*'/.test(build), 'y el release sigue disparandose con un tag v*.*.*');

  const ajustes = JSON.parse(leer('.github/repository-settings.json')).security_and_analysis;
  check(ajustes.secret_scanning.status === 'enabled' && ajustes.secret_scanning_push_protection.status === 'enabled',
    'los ajustes preparados activan el escaneo de secretos y su bloqueo al subir');

  const guia = leer('docs/going-public.md');
  const ordenes = [...guia.matchAll(/```powershell\n([\s\S]*?)```/g)].flatMap(m => m[1].trim().split('\n'));
  check(ordenes.length >= 10 && ordenes.every(o => /^gh (repo edit|api|pr checks) /.test(o)),
    `la guia de publicacion solo contiene ordenes de gh (${ordenes.length})`);
  const ficheros = ordenes.map(o => /--input (\S+)/.exec(o)).filter(Boolean).map(m => m[1]);
  check(ficheros.length === 4 && ficheros.every(f => fs.existsSync(path.join(ROOT, f))),
    'y cada fichero que esas ordenes envian existe');
  check(!/<<|\$\(|`n/.test(ordenes.join('\n')), 'ninguna orden depende de sintaxis que PowerShell no entienda igual que bash');
}

console.log('\n=== 4c. Credenciales: ni en el arbol ni al alcance de un commit descuidado ===');
{
  // Una clave de Buttondown estuvo escrita en el JavaScript de la landing
  // (abril a junio de 2026) y sigue en la historia y en dos tags. Lo que se
  // puede garantizar desde aqui es que no vuelva: el formulario usa el punto
  // de alta publico, que no lleva clave, y nada bajo web/ envia cabeceras de
  // autorizacion.
  const web = fs.readdirSync(path.join(ROOT, 'web'), { recursive: true })
    .filter(f => /\.(html|js)$/.test(String(f))).map(f => path.join('web', String(f)));
  const conClave = web.filter(f => /BUTTONDOWN_API_KEY|['"]Authorization['"]\s*:|Bearer\s+['"`]|Token\s+['"`]\s*\+/.test(leer(f)));
  check(web.length >= 4 && conClave.length === 0,
    `ninguna pagina ni script de la web lleva una clave o una cabecera de autorizacion (${conClave.join(', ') || 'ninguno'})`);
  const altas = [...leer('web/landing.html').matchAll(/action="(https:\/\/buttondown\.com\/[^"]+)"/g)].map(m => m[1]);
  check(altas.length === 1 && /^https:\/\/buttondown\.com\/api\/emails\/embed-subscribe\/[a-z0-9-]+$/.test(altas[0]),
    'el formulario de la lista de espera usa el alta publica de Buttondown, sin clave');
  // UUID o cadena larga asignada a algo que se llama clave, token o secreto.
  const sospechosos = [];
  (function recorrer(dir) {
    for (const nombre of fs.readdirSync(dir)) {
      if (['.git', 'node_modules', 'dist', 'vendor', 'package-lock.json'].includes(nombre)) continue;
      const ruta = path.join(dir, nombre);
      const st = fs.statSync(ruta);
      if (st.isDirectory()) { recorrer(ruta); continue; }
      if (st.size > 2 * 1024 * 1024 || !/\.(js|json|html|yml|yaml|sh|env|txt)$/.test(nombre) || /\.test\.js$/.test(nombre)) continue;
      const texto = fs.readFileSync(ruta, 'utf8');
      if (/\b[A-Za-z_]*(API_?KEY|TOKEN|SECRET|PASSWORD)[A-Za-z_]*\s*[:=]\s*['"](?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_\-]{32,})['"]/i.test(texto)) {
        sospechosos.push(path.relative(ROOT, ruta));
      }
    }
  })(ROOT);
  check(sospechosos.length === 0, `ningun fichero asigna un valor literal a una clave, token o secreto (${sospechosos.join(', ') || 'ninguno'})`);

  const ignorados = leer('.gitignore').split('\n').map(l => l.trim());
  check(ignorados.includes('.env') && ignorados.includes('.env.*') && ignorados.includes('!.env.example')
    && ignorados.indexOf('!.env.example') > ignorados.indexOf('.env.*'),
    '.gitignore protege .env y sus variantes, y deja pasar .env.example');
}

console.log('\n=== 4d. El repositorio es publico y lo dice ===');
{
  const contribuir = leer('CONTRIBUTING.md');
  check(!/not public yet|is not public|private repository/i.test(contribuir)
    && contribuir.includes('https://github.com/mika5app/mika5') && /pull request against `main`/.test(contribuir),
    'CONTRIBUTING.md ya no dice que el repositorio es privado: explica fork y pull request');
  check(/never have access to the project's secrets/.test(contribuir) && /\.env\.example/.test(contribuir),
    'y avisa de como se tratan los secretos y la configuracion local');
  check(leer('COMMUNITY.md').includes('https://github.com/mika5app/mika5\n')
    && /Future paid functionality may be offered separately/.test(leer('COMMUNITY.md'))
    && /remains licensed under the AGPL-3\.0/.test(leer('COMMUNITY.md')),
    'COMMUNITY.md enlaza el codigo publico y conserva la descripcion de Community AGPL y lo comercial aparte');
}

console.log('\n=== 5. Nada personal en lo que se publica ===');
const ignorar = new Set(['.git', 'node_modules', 'dist', 'vendor', 'package-lock.json']);
const personales = [];
(function recorrer(dir) {
  for (const nombre of fs.readdirSync(dir)) {
    if (ignorar.has(nombre)) continue;
    const ruta = path.join(dir, nombre);
    const st = fs.statSync(ruta);
    if (st.isDirectory()) { recorrer(ruta); continue; }
    if (st.size > 2 * 1024 * 1024 || !/\.(js|json|md|html|yml|yaml|txt|sh|css|xml)$/.test(nombre)) continue;
    const texto = fs.readFileSync(ruta, 'utf8');
    // Rutas de perfil de una persona concreta y buzones personales. Los avisos
    // de terceros llevan los correos de sus autores: no son nuestros.
    if (/[A-Za-z]:\\Users\\(?!runneradmin|Public|<)[A-Za-z0-9._-]+\\/.test(texto)
      || (/[A-Za-z0-9._%+-]+@(hotmail|outlook|live)\.[a-z.]+/.test(texto) && !/THIRD_PARTY_NOTICES/.test(nombre))) {
      personales.push(path.relative(ROOT, ruta));
    }
  }
})(ROOT);
check(personales.length === 0, `ningun fichero lleva rutas de perfil ni buzones personales (${personales.join(', ') || 'ninguno'})`);

console.log(`\n${'='.repeat(46)}`);
console.log(`Public readiness tests passed (${passed} comprobaciones)`);
console.log(`${'='.repeat(46)}`);
