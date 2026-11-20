// test/signing-readiness.test.js — La firma de codigo esta preparada y apagada.
//
// Run: node test/signing-readiness.test.js
//
// Por que existe: los verificadores de firma no se pueden ejercitar hoy contra
// una firma real (no hay certificado de Windows, ni Developer ID, ni se ha
// firmado nada con Sigstore), asi que lo unico que se puede demostrar es que
// RECHAZAN. Cada caso de aqui es una forma de publicar algo mal firmado que
// tiene que acabar en rojo. Las herramientas nativas (PowerShell, codesign,
// spctl, stapler, cosign) se sustituyen por dobles: esto prueba la logica de
// decision, no las herramientas.
//
// Ademas vigila dos cosas del repositorio que deben seguir siendo verdad antes
// y despues de activar la firma: `id-token: write` solo en un trabajo y solo
// para etiquetas, y ningun flujo que firme sin verificar despues.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  verificarAuthenticode, verificarMacos, verificarSigstore, identidadSigstore,
  EMISOR_GITHUB, SUFIJO_BUNDLE, GUION_AUTHENTICODE
} = require('../scripts/signing/verify-signatures');

const ROOT = path.join(__dirname, '..');
let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}
const leer = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const pkg = JSON.parse(leer('package.json'));
const builder = JSON.parse(leer('electron-builder.json'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-signing-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const fichero = (nombre, contenido = 'bytes') => {
  const ruta = path.join(TMP, nombre);
  fs.writeFileSync(ruta, contenido);
  return ruta;
};
const rechaza = (resultado, patron) => resultado.ok === false && resultado.problemas.some(p => patron.test(p));

console.log('\n=== 1. Windows: Authenticode ===');
const PUBLISHER = 'Editor De Prueba';
const exe = fichero('MIKA5-Setup.exe');
const FIRMA_BUENA = {
  status: 'Valid', type: 'Authenticode', publisher: PUBLISHER, issuer: 'CN=CA de prueba',
  timestamp: 'CN=Sello de prueba', productName: builder.productName, productVersion: pkg.version
};
const llamadasWin = [];
const powershell = (firma) => (comando, argumentos, entorno) => {
  llamadasWin.push({ comando, argumentos, entorno });
  return { status: 0, stdout: `${JSON.stringify(firma)}\r\n`, stderr: '', error: null };
};
const win = (firma, extra) => verificarAuthenticode({ archivos: [exe], publisher: PUBLISHER, ejecutar: powershell(firma), ...extra });

check(win(FIRMA_BUENA).ok, 'una firma valida, incrustada, sellada y del firmante esperado pasa');
check(win({ ...FIRMA_BUENA, productVersion: `${pkg.version}.0` }).ok, 'acepta la version X.Y.Z.0 que lleva el ejecutable de la aplicacion');
const ultima = llamadasWin[llamadasWin.length - 1];
check(ultima.entorno.MIKA5_VERIFY_FILE === path.resolve(exe) && !ultima.argumentos.join(' ').includes(path.basename(exe)),
  'la ruta viaja en una variable de entorno, nunca dentro del texto de PowerShell');
check(!GUION_AUTHENTICODE.includes('"') && ultima.argumentos.includes(GUION_AUTHENTICODE), 'el guion de PowerShell es constante y no lleva comillas dobles');
check(rechaza(win({ ...FIRMA_BUENA, status: 'NotSigned', type: 'None', publisher: '', timestamp: '' }), /NotSigned/), 'rechaza un ejecutable sin firmar');
check(rechaza(win({ ...FIRMA_BUENA, status: 'HashMismatch' }), /HashMismatch/), 'rechaza un ejecutable modificado despues de firmar');
check(rechaza(win({ ...FIRMA_BUENA, status: 'NotTrusted' }), /NotTrusted/), 'rechaza una cadena que no llega a una raiz de confianza');
check(rechaza(win({ ...FIRMA_BUENA, type: 'Catalog' }), /incrustada/), 'rechaza una firma de catalogo, que no viaja con el fichero');
check(rechaza(win({ ...FIRMA_BUENA, publisher: 'Otro Editor' }), /firmante/), 'rechaza una firma valida de otro firmante');
check(rechaza(win({ ...FIRMA_BUENA, publisher: `${PUBLISHER} Ltd` }), /firmante/), 'el firmante se compara exacto, no por prefijo');
check(rechaza(win({ ...FIRMA_BUENA, timestamp: '' }), /sello de tiempo/), 'rechaza una firma sin sello de tiempo');
check(rechaza(win({ ...FIRMA_BUENA, productName: 'Otro' }), /ProductName/), 'rechaza un ProductName que no es el del producto');
check(rechaza(win({ ...FIRMA_BUENA, productVersion: '9.9.9' }), /ProductVersion/), 'rechaza una version distinta de la de package.json');
check(rechaza(verificarAuthenticode({ archivos: [exe], publisher: PUBLISHER, ejecutar: () => ({ status: null, stdout: '', stderr: '', error: 'ENOENT' }) }), /ENOENT/),
  'sin PowerShell no hay veredicto: falla');
check(rechaza(verificarAuthenticode({ archivos: [exe], publisher: PUBLISHER, ejecutar: () => ({ status: 0, stdout: 'no es json', stderr: '', error: null }) }), /JSON/),
  'una respuesta que no se entiende falla');
check(rechaza(verificarAuthenticode({ archivos: [exe], ejecutar: powershell(FIRMA_BUENA) }), /--publisher/), 'sin firmante esperado no se comprueba nada: falla');
check(rechaza(verificarAuthenticode({ archivos: [], publisher: PUBLISHER, ejecutar: powershell(FIRMA_BUENA) }), /ningún ejecutable/), 'una lista vacia no es un exito');
check(rechaza(verificarAuthenticode({ archivos: [path.join(TMP, 'no-existe.exe')], publisher: PUBLISHER, ejecutar: powershell(FIRMA_BUENA) }), /no existe/),
  'un ejecutable que no existe falla aunque la herramienta dijera que si');
const dosExe = verificarAuthenticode({
  archivos: [exe, fichero('MIKA5-Portable.exe')], publisher: PUBLISHER,
  ejecutar: (c, a, e) => powershell(e.MIKA5_VERIFY_FILE.includes('Portable') ? { ...FIRMA_BUENA, status: 'NotSigned' } : FIRMA_BUENA)(c, a, e)
});
check(rechaza(dosExe, /^MIKA5-Portable\.exe: /) && dosExe.problemas.length === 1, 'un solo ejecutable sin firmar tumba el conjunto y se nombra');

console.log('\n=== 2. macOS: Developer ID, hardened runtime, notarizacion y ticket ===');
const TEAM = 'ABCDE12345';
const app = path.join(TMP, 'MIKA5.app');
fs.mkdirSync(app);
const ENTITLEMENTS = leer('build/entitlements.mac.plist');
const MAC_BUENO = {
  verify: { status: 0, stderr: `${app}: valid on disk\n` },
  display: {
    status: 0,
    stderr: [
      `Executable=${app}/Contents/MacOS/MIKA5`, 'Identifier=com.mika5.desktop',
      'CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=10+7 location=embedded',
      `Authority=Developer ID Application: Equipo De Prueba (${TEAM})`,
      'Authority=Developer ID Certification Authority', 'Authority=Apple Root CA',
      'Timestamp=1 Jan 2026 at 00:00:00', `TeamIdentifier=${TEAM}`
    ].join('\n')
  },
  entitlements: { status: 0, stdout: ENTITLEMENTS },
  spctl: { status: 0, stderr: `${app}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Equipo De Prueba (${TEAM})\n` },
  stapler: { status: 0, stdout: 'The validate action worked!\n' }
};
const herramientasMac = (cambios) => (comando, argumentos) => {
  const respuestas = { ...MAC_BUENO, ...cambios };
  let clave;
  if (comando === 'codesign' && argumentos.includes('--verify')) clave = 'verify';
  else if (comando === 'codesign' && argumentos.includes('--entitlements')) clave = 'entitlements';
  else if (comando === 'codesign') clave = 'display';
  else if (comando === 'spctl') clave = 'spctl';
  else if (comando === 'xcrun' && argumentos[0] === 'stapler' && argumentos[1] === 'validate') clave = 'stapler';
  else return { status: null, stdout: '', stderr: '', error: 'ENOENT' };
  return { stdout: '', stderr: '', error: null, ...respuestas[clave] };
};
const mac = (cambios, extra) => verificarMacos({ app, teamId: TEAM, ejecutar: herramientasMac(cambios), ...extra });
const conDisplay = (transformar) => ({ display: { status: 0, stderr: transformar(MAC_BUENO.display.stderr) } });

check(mac({}).ok, 'una aplicacion firmada, con hardened runtime, notarizada y con ticket pasa');
check(rechaza(mac({ verify: { status: 1, stderr: 'a sealed resource is missing or invalid' } }), /codesign --verify/), 'rechaza un bundle alterado despues de firmar');
check(rechaza(mac(conDisplay(t => `${t.replace(/Authority=.*\n/g, '')}\nSignature=adhoc`)), /ad-hoc/), 'rechaza una firma ad-hoc');
check(rechaza(mac(conDisplay(t => t.replace('Developer ID Application:', 'Apple Development:'))), /firmante/), 'rechaza un certificado de desarrollo');
check(rechaza(mac(conDisplay(t => t.split(TEAM).join('ZZZZZ99999'))), /firmante|TeamIdentifier/), 'rechaza un Developer ID de otro equipo');
check(rechaza(mac(conDisplay(t => t.replace('Authority=Apple Root CA\n', ''))), /Apple Root CA/), 'rechaza una cadena que no llega a la raiz de Apple');
check(rechaza(mac(conDisplay(t => t.replace('flags=0x10000(runtime)', 'flags=0x0(none)'))), /hardened runtime/), 'rechaza una firma sin hardened runtime');
check(rechaza(mac({ entitlements: { status: 0, stdout: ENTITLEMENTS.replace('</dict>', '<key>com.apple.security.get-task-allow</key><true/></dict>') } }), /entitlements/),
  'rechaza un entitlement que el repositorio no declara');
check(rechaza(mac({ entitlements: { status: 0, stdout: ENTITLEMENTS.replace('<key>com.apple.security.cs.allow-jit</key>', '') } }), /entitlements/),
  'rechaza la falta de un entitlement declarado');
check(rechaza(mac({ spctl: { status: 3, stderr: `${app}: rejected\nsource=Unnotarized Developer ID\n` } }), /spctl/), 'rechaza una aplicacion que Gatekeeper no acepta');
check(rechaza(mac({ spctl: { status: 0, stderr: `${app}: accepted\nsource=Developer ID\n` } }), /Notarized/), 'rechaza una aplicacion aceptada pero no notarizada');
check(rechaza(mac({ stapler: { status: 65, stdout: 'does not have a ticket stapled to it' } }), /stapler/), 'rechaza una aplicacion sin ticket grapado');
check(rechaza(verificarMacos({ app, teamId: TEAM, ejecutar: () => ({ status: null, stdout: '', stderr: '', error: 'ENOENT' }) }), /ENOENT/),
  'sin las herramientas nativas no hay veredicto: falla');
check(rechaza(verificarMacos({ app, ejecutar: herramientasMac({}) }), /--team-id/), 'sin Team ID esperado no se comprueba nada: falla');
check(rechaza(verificarMacos({ app: path.join(TMP, 'falta.app'), teamId: TEAM, ejecutar: herramientasMac({}) }), /no es un bundle/), 'un bundle que no existe falla');

console.log('\n=== 3. Linux: Sigstore / Cosign ===');
const repositorio = pkg.repository.url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
const IDENTIDAD = identidadSigstore({ repositorio, workflow: 'build.yml', version: pkg.version });
check(IDENTIDAD === `https://github.com/mika5app/mika5/.github/workflows/build.yml@refs/tags/v${pkg.version}`,
  `la identidad esperada es el flujo de release en la etiqueta de la version (${IDENTIDAD})`);
const appimage = fichero('MIKA5.AppImage');
fichero(`MIKA5.AppImage${SUFIJO_BUNDLE}`, '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}');
const llamadasCosign = [];
const cosign = (status) => (comando, argumentos) => {
  llamadasCosign.push({ comando, argumentos });
  return { status, stdout: '', stderr: status === 0 ? 'Verified OK\n' : 'Error: none of the expected identities matched\n', error: null };
};
const antes = fs.readFileSync(appimage);
check(verificarSigstore({ archivos: [appimage], identidad: IDENTIDAD, ejecutar: cosign(0) }).ok, 'un fichero con su bundle y la identidad esperada pasa');
check(fs.readFileSync(appimage).equals(antes), 'verificar no toca el fichero: la firma es separada');
const args = llamadasCosign[0].argumentos;
check(llamadasCosign[0].comando === 'cosign' && args[0] === 'verify-blob'
  && args[args.indexOf('--bundle') + 1] === `${appimage}${SUFIJO_BUNDLE}`
  && args[args.indexOf('--certificate-identity') + 1] === IDENTIDAD
  && args[args.indexOf('--certificate-oidc-issuer') + 1] === EMISOR_GITHUB
  && !args.some(a => /regexp/.test(a)),
  'cosign recibe el bundle, la identidad exacta y el emisor OIDC de GitHub, sin expresiones regulares');
check(rechaza(verificarSigstore({ archivos: [appimage], identidad: IDENTIDAD, ejecutar: cosign(1) }), /rechazó/), 'rechaza lo que cosign rechaza (otra identidad, bundle de otro fichero)');
check(rechaza(verificarSigstore({ archivos: [fichero('MIKA5.deb')], identidad: IDENTIDAD, ejecutar: cosign(0) }), /bundle .* no existe/), 'rechaza un fichero publicado sin su bundle');
const rpm = fichero('MIKA5.rpm');
fichero(`MIKA5.rpm${SUFIJO_BUNDLE}`, '');
check(rechaza(verificarSigstore({ archivos: [rpm], identidad: IDENTIDAD, ejecutar: cosign(0) }), /vacío/), 'rechaza un bundle vacio');
check(rechaza(verificarSigstore({ archivos: [appimage], identidad: IDENTIDAD, ejecutar: () => ({ status: null, stdout: '', stderr: '', error: 'ENOENT' }) }), /ENOENT/),
  'sin cosign no hay veredicto: falla');
for (const [mala, descripcion] of [
  [undefined, 'una identidad ausente'],
  [IDENTIDAD.replace(/refs\/tags\/v.*$/, 'refs/heads/main'), 'la identidad de una rama'],
  [IDENTIDAD.replace(/v\d+\.\d+\.\d+$/, 'v.*'), 'una identidad con comodin'],
  [IDENTIDAD.replace('https://github.com/', 'https://example.com/'), 'una identidad de otro servidor']
]) {
  check(rechaza(verificarSigstore({ archivos: [appimage], identidad: mala, ejecutar: cosign(0) }), /--identity/), `rechaza ${descripcion}`);
}

console.log('\n=== 4. El repositorio: preparado y apagado ===');
check(builder.mac.hardenedRuntime === true, 'macOS se empaqueta con hardened runtime');
for (const clave of ['entitlements', 'entitlementsInherit']) {
  check(builder.mac[clave] === 'build/entitlements.mac.plist' && fs.existsSync(path.join(ROOT, builder.mac[clave])),
    `mac.${clave} apunta a los entitlements del repositorio`);
}
// Un build de desarrollo o de CI sin certificado tiene que seguir funcionando:
// exigir la firma es cosa del build de una etiqueta, no de la configuracion.
check(builder.forceCodeSigning !== true, 'la configuracion no obliga a firmar');
check(builder.mac.notarize === undefined && builder.mac.identity === undefined,
  'ni la notarizacion ni la identidad de macOS se fijan en la configuracion: las decide el entorno del build');
check(!/"(cscLink|cscKeyPassword|certificateFile|certificatePassword|certificateSha1|azureSignOptions)"/.test(leer('electron-builder.json')),
  'la configuracion no lleva certificados ni referencias a ellos');
check(/^\s+CSC_IDENTITY_AUTO_DISCOVERY: 'false'$/m.test(leer('.github/workflows/_canonical.yml')),
  'el empaquetado canonico no busca identidades de firma por su cuenta');

// Reglas que valen antes y despues de activar la firma. Trabajan sobre el texto
// de los flujos, como public-readiness, para no depender de un parser.
const trabajosDe = (texto) => {
  const cuerpo = texto.slice(texto.search(/^jobs:\n/m));
  return cuerpo.split(/\n(?=  [A-Za-z][A-Za-z0-9_-]*:\n)/).slice(1);
};
function problemasDeFirma(flujos) {
  const problemas = [];
  let conIdToken = 0;
  for (const [nombre, texto] of Object.entries(flujos)) {
    const cabecera = texto.slice(0, texto.search(/^jobs:\n/m));
    if (/id-token/.test(cabecera)) problemas.push(`${nombre}: id-token a nivel de flujo`);
    for (const trabajo of trabajosDe(texto)) {
      if (!/id-token:\s*write/.test(trabajo)) continue;
      conIdToken += 1;
      if (!/\n    if: github\.ref_type == 'tag'/.test(trabajo)) problemas.push(`${nombre}: un trabajo con id-token no exige una etiqueta de version`);
    }
  }
  if (conIdToken > 1) problemas.push(`${conIdToken} trabajos piden id-token: write`);
  const todo = Object.values(flujos).join('\n');
  for (const [firma, plataforma] of [[/signpath\//i, 'windows'], [/CSC_LINK|APPLE_API_KEY/, 'macos'], [/cosign sign-blob/, 'linux']]) {
    if (firma.test(todo) && !todo.includes(`scripts/signing/verify-signatures.js ${plataforma}`)) {
      problemas.push(`se firma para ${plataforma} sin ejecutar despues verify-signatures.js ${plataforma}`);
    }
  }
  return problemas;
}
const flujos = {};
for (const archivo of fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter(f => /\.ya?ml$/.test(f))) {
  flujos[archivo] = leer(`.github/workflows/${archivo}`);
}
const reales = problemasDeFirma(flujos);
check(reales.length === 0, `los ${Object.keys(flujos).length} flujos cumplen las reglas de firma (${reales.join('; ') || 'sin problemas'})`);

const FLUJO = (permisosGlobales, trabajos) => `on:\n  push:\npermissions:\n  contents: read\n${permisosGlobales}jobs:\n${trabajos}`;
const TRABAJO = (nombre, condicion, cuerpo) => `  ${nombre}:\n${condicion}    runs-on: ubuntu-latest\n${cuerpo}`;
const SI_TAG = "    if: github.ref_type == 'tag'\n";
const ID_TOKEN = '    permissions:\n      id-token: write\n';
check(problemasDeFirma({ 'a.yml': FLUJO('', TRABAJO('sign-linux', SI_TAG, `${ID_TOKEN}    steps:\n      - run: cosign sign-blob --yes x\n      - run: node scripts/signing/verify-signatures.js linux x\n`)) }).length === 0,
  'un unico trabajo de etiqueta con id-token que firma y verifica es aceptable');
check(problemasDeFirma({ 'a.yml': FLUJO('  id-token: write\n', TRABAJO('build', '', '')) }).length > 0, 'el guardian rechaza id-token a nivel de flujo');
check(problemasDeFirma({ 'a.yml': FLUJO('', TRABAJO('sign', '', ID_TOKEN)) }).length > 0, 'rechaza id-token en un trabajo que no exige etiqueta');
check(problemasDeFirma({ 'a.yml': FLUJO('', TRABAJO('uno', SI_TAG, ID_TOKEN) + TRABAJO('dos', SI_TAG, ID_TOKEN)) }).length > 0, 'rechaza id-token en mas de un trabajo');
check(problemasDeFirma({ 'a.yml': FLUJO('', TRABAJO('sign', SI_TAG, `${ID_TOKEN}    steps:\n      - run: cosign sign-blob --yes x\n`)) }).length > 0,
  'rechaza firmar con cosign sin verificar despues');
check(problemasDeFirma({ 'a.yml': FLUJO('', TRABAJO('sign', SI_TAG, '    steps:\n      - uses: signpath/github-action-submit-signing-request@v3\n')) }).length > 0,
  'rechaza pedir una firma a SignPath sin verificar el resultado');
check(problemasDeFirma({ 'a.yml': FLUJO('', TRABAJO('package', '', '    env:\n      CSC_LINK: x\n')) }).length > 0,
  'rechaza firmar para macOS sin verificar el resultado');

// Mientras nada notarice, lo publicado no puede decir otra cosa.
const notariza = /APPLE_API_KEY|APPLE_ID/.test(Object.values(flujos).join('\n'));
check(notariza || (/not notarized/.test(leer('README.md')) && /not notarized/.test(flujos['build.yml'])),
  'mientras ningun flujo notarice, el README y las notas de release dicen que macOS no esta notarizado');

console.log(`\n${'='.repeat(46)}`);
console.log(`Signing readiness tests passed (${passed} comprobaciones)`);
console.log(`${'='.repeat(46)}`);
