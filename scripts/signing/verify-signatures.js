#!/usr/bin/env node
'use strict';

// Verifica la firma de los artefactos FINALES de una release, antes de calcular
// sus SHA-256 definitivos y de publicarlos.
//
//   node scripts/signing/verify-signatures.js windows --publisher=<CN exacto> <exe>...
//   node scripts/signing/verify-signatures.js macos   --team-id=<10 caracteres> <MIKA5.app>
//   node scripts/signing/verify-signatures.js linux   --identity=<identidad del flujo> <fichero>...
//
// Hoy ningún flujo lo invoca: los binarios no se firman y no existe certificado
// alguno. Está preparado para el día en que se active la firma — ver
// docs/signpath-integration.md — y por eso vive fuera de scripts/ci/: mientras
// ningún flujo lo ejecute no forma parte de la infraestructura de empaquetado.
// Al cablearlo hay que añadir `scripts/signing/` al scope `packaging` de
// scripts/ci/changed-scope.js en ese mismo cambio.
//
// Regla común: todo falla cerrado. Lo que no se pudo comprobar es un fallo, no
// un aviso, y la identidad esperada del firmante se pasa siempre desde fuera —
// aquí no hay ningún publisher, Team ID ni identidad por defecto, porque
// todavía no existen y un valor inventado sólo serviría para aprobar lo que no
// toca.
//
// Qué demuestra cada plataforma y qué no:
//
//   windows  Lo que dice WinVerifyTrust en esa máquina (firma íntegra y cadena
//            hasta una raíz de confianza), que la firma va incrustada en el
//            fichero y sellada en el tiempo, y que el firmante es el esperado.
//   macos    codesign (firma íntegra, Developer ID del equipo esperado, hardened
//            runtime y los entitlements del repositorio), Gatekeeper (spctl:
//            notarizado) y el ticket grapado (stapler).
//   linux    cosign verify-blob contra el bundle que acompaña al fichero, con
//            la identidad exacta del flujo y el emisor OIDC de GitHub. Que la
//            firma separada no alteró el binario lo demuestra
//            scripts/ci/verify-artifacts.js, que recalcula el SHA-256 que el
//            productor tomó antes de firmar.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const EMISOR_GITHUB = 'https://token.actions.githubusercontent.com';
const SUFIJO_BUNDLE = '.sigstore.json';

// Texto constante y sin comillas dobles. La ruta viaja en una variable de
// entorno y nunca se interpola: un fallo de comillas en una línea de PowerShell
// no da un error de sintaxis, ejecuta el instalador que se pretendía examinar.
const GUION_AUTHENTICODE = [
  '$ErrorActionPreference = \'Stop\'',
  '$f = $env:MIKA5_VERIFY_FILE',
  '$s = Get-AuthenticodeSignature -LiteralPath $f',
  '$v = (Get-Item -LiteralPath $f).VersionInfo',
  '$cn = \'\'',
  'if ($s.SignerCertificate) { $cn = $s.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }',
  '[pscustomobject]@{ status = $s.Status.ToString(); type = $s.SignatureType.ToString(); publisher = [string]$cn;' +
    ' issuer = [string]$s.SignerCertificate.Issuer; timestamp = [string]$s.TimeStamperCertificate.Subject;' +
    ' productName = [string]$v.ProductName; productVersion = [string]$v.ProductVersion } | ConvertTo-Json -Compress'
].join('; ');

/** Ejecución real, sin shell y con los argumentos separados. */
function ejecutarReal(comando, argumentos, entorno) {
  const r = spawnSync(comando, argumentos, {
    encoding: 'utf8', shell: false, windowsHide: true, env: { ...process.env, ...(entorno || {}) }
  });
  return {
    status: r.error ? null : r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    error: r.error ? (r.error.code || r.error.message) : null
  };
}

function archivoRegular(ruta) {
  let info;
  try { info = fs.lstatSync(ruta); } catch { return 'no existe'; }
  if (info.isSymbolicLink()) return 'es un enlace simbólico';
  if (!info.isFile()) return 'no es un archivo regular';
  if (info.size === 0) return 'está vacío';
  return null;
}

function metadatosDelProducto(opciones) {
  const raiz = (opciones && opciones.raiz) || RAIZ;
  return {
    producto: (opciones && opciones.producto) || JSON.parse(fs.readFileSync(path.join(raiz, 'electron-builder.json'), 'utf8')).productName,
    version: (opciones && opciones.version) || JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')).version
  };
}

// --- Windows: Authenticode --------------------------------------------------

function verificarAuthenticode(opciones) {
  const problemas = [];
  const { archivos, publisher } = opciones;
  const ejecutar = opciones.ejecutar || ejecutarReal;
  if (typeof publisher !== 'string' || publisher.trim() === '') {
    return { ok: false, problemas: ['falta --publisher: el nombre exacto del firmante esperado no se supone'] };
  }
  if (!Array.isArray(archivos) || archivos.length === 0) {
    return { ok: false, problemas: ['no se indicó ningún ejecutable'] };
  }
  const { producto, version } = metadatosDelProducto(opciones);

  for (const archivo of archivos) {
    const nombre = path.basename(archivo);
    const anotar = (mensaje) => problemas.push(`${nombre}: ${mensaje}`);
    const defecto = archivoRegular(archivo);
    if (defecto) { anotar(defecto); continue; }

    const r = ejecutar('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', GUION_AUTHENTICODE],
      { MIKA5_VERIFY_FILE: path.resolve(archivo) });
    if (r.error || r.status !== 0) {
      anotar(`no se pudo consultar la firma (${r.error || `PowerShell salió con ${r.status}`})`);
      continue;
    }
    let firma;
    try { firma = JSON.parse(r.stdout.trim()); } catch { anotar('la consulta de firma no devolvió JSON'); continue; }

    // `Valid` es el veredicto de WinVerifyTrust: bytes íntegros y cadena hasta
    // una raíz en la que esa máquina confía. Cualquier otro estado
    // (NotSigned, HashMismatch, NotTrusted, UnknownError) es un rechazo.
    if (firma.status !== 'Valid') anotar(`estado de la firma: ${firma.status || 'desconocido'} (se exige Valid)`);
    // Una firma de catálogo vive en la máquina que la comprueba, no en el
    // fichero: no viajaría con la descarga.
    if (firma.type !== 'Authenticode') anotar(`tipo de firma: ${firma.type || 'ninguno'} (se exige una firma incrustada)`);
    if (firma.publisher !== publisher) anotar(`firmante ${JSON.stringify(firma.publisher || '')}, se esperaba ${JSON.stringify(publisher)}`);
    // Sin sello de tiempo la firma deja de validar cuando caduca el certificado.
    if (!firma.timestamp) anotar('la firma no lleva sello de tiempo');
    if (firma.productName !== producto) anotar(`ProductName ${JSON.stringify(firma.productName || '')}, se esperaba ${JSON.stringify(producto)}`);
    // electron-builder escribe X.Y.Z en los instaladores y X.Y.Z.0 en el
    // ejecutable de la aplicación (medido sobre un build 0.3.1 sin firmar).
    if (firma.productVersion !== version && firma.productVersion !== `${version}.0`) {
      anotar(`ProductVersion ${JSON.stringify(firma.productVersion || '')}, se esperaba ${version}`);
    }
  }
  return { ok: problemas.length === 0, problemas, comprobados: archivos.length };
}

// --- macOS: Developer ID, hardened runtime, notarización y ticket -------------

function clavesDeEntitlements(xml) {
  return [...String(xml).matchAll(/<key>([^<]+)<\/key>/g)].map(m => m[1]).sort();
}

function verificarMacos(opciones) {
  const problemas = [];
  const anotar = (mensaje) => problemas.push(mensaje);
  const { app, teamId } = opciones;
  const ejecutar = opciones.ejecutar || ejecutarReal;
  if (!/^[A-Z0-9]{10}$/.test(String(teamId || ''))) {
    return { ok: false, problemas: ['falta --team-id o no tiene la forma de un Team ID de Apple (10 caracteres A-Z, 0-9)'] };
  }
  if (typeof app !== 'string' || !app.endsWith('.app') || !fs.existsSync(app) || !fs.lstatSync(app).isDirectory()) {
    return { ok: false, problemas: [`no es un bundle .app existente: ${app}`] };
  }
  const correr = (comando, argumentos, descripcion) => {
    const r = ejecutar(comando, argumentos);
    if (r.error || r.status !== 0) {
      anotar(`${descripcion}: ${r.error || `salió con ${r.status}`} ${(r.stderr || r.stdout).trim().split('\n')[0] || ''}`.trim());
      return null;
    }
    return `${r.stdout}\n${r.stderr}`;
  };

  correr('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], 'codesign --verify');

  const detalle = correr('codesign', ['--display', '--verbose=4', app], 'codesign --display');
  if (detalle !== null) {
    const lineas = detalle.split('\n').map(l => l.trim());
    const autoridades = lineas.filter(l => l.startsWith('Authority=')).map(l => l.slice('Authority='.length));
    if (lineas.includes('Signature=adhoc')) anotar('la firma es ad-hoc, no de un Developer ID');
    if (!autoridades[0] || !autoridades[0].startsWith('Developer ID Application: ') || !autoridades[0].endsWith(` (${teamId})`)) {
      anotar(`el firmante es ${JSON.stringify(autoridades[0] || '')}, se esperaba «Developer ID Application: … (${teamId})»`);
    }
    for (const eslabon of ['Developer ID Certification Authority', 'Apple Root CA']) {
      if (!autoridades.includes(eslabon)) anotar(`la cadena no pasa por ${eslabon}`);
    }
    if (!lineas.includes(`TeamIdentifier=${teamId}`)) anotar(`TeamIdentifier no es ${teamId}`);
    const flags = lineas.find(l => l.startsWith('CodeDirectory ')) || '';
    if (!/flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/.test(flags)) anotar('el hardened runtime no está activo');
  }

  // Los entitlements firmados tienen que ser los del repositorio: ni uno más
  // (permiso que nadie revisó) ni uno menos (la aplicación no arrancaría).
  const esperados = clavesDeEntitlements(fs.readFileSync(opciones.entitlements || path.join(RAIZ, 'build', 'entitlements.mac.plist'), 'utf8'));
  const firmados = correr('codesign', ['--display', '--entitlements', '-', '--xml', app], 'codesign --entitlements');
  if (firmados !== null && JSON.stringify(clavesDeEntitlements(firmados)) !== JSON.stringify(esperados)) {
    anotar(`los entitlements firmados no coinciden con build/entitlements.mac.plist (${clavesDeEntitlements(firmados).join(', ') || 'ninguno'})`);
  }

  const gatekeeper = correr('spctl', ['--assess', '--type', 'execute', '--verbose=4', app], 'spctl --assess');
  if (gatekeeper !== null && !/source=Notarized Developer ID/.test(gatekeeper)) {
    anotar('Gatekeeper acepta la aplicación, pero no como «Notarized Developer ID»');
  }
  correr('xcrun', ['stapler', 'validate', app], 'stapler validate');

  return { ok: problemas.length === 0, problemas, comprobados: 1 };
}

// --- Linux: Sigstore / Cosign sin claves --------------------------------------

// Sólo una etiqueta de versión firma. Una identidad de rama, un comodín o una
// expresión regular aceptarían una firma hecha desde otro punto del repositorio.
const IDENTIDAD_VALIDA = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml@refs\/tags\/v\d+\.\d+\.\d+$/;

/** La identidad que Fulcio certifica para un trabajo definido en `workflow`. */
function identidadSigstore({ repositorio, workflow, version }) {
  return `https://github.com/${repositorio}/.github/workflows/${workflow}@refs/tags/v${version}`;
}

function verificarSigstore(opciones) {
  const problemas = [];
  const { archivos, identidad } = opciones;
  const ejecutar = opciones.ejecutar || ejecutarReal;
  if (!IDENTIDAD_VALIDA.test(String(identidad || ''))) {
    return { ok: false, problemas: ['falta --identity o no es la identidad exacta de un flujo en una etiqueta de versión (…/.github/workflows/<flujo>.yml@refs/tags/vX.Y.Z)'] };
  }
  if (!Array.isArray(archivos) || archivos.length === 0) {
    return { ok: false, problemas: ['no se indicó ningún fichero'] };
  }
  for (const archivo of archivos) {
    const nombre = path.basename(archivo);
    const anotar = (mensaje) => problemas.push(`${nombre}: ${mensaje}`);
    const defecto = archivoRegular(archivo);
    if (defecto) { anotar(defecto); continue; }
    const bundle = `${archivo}${SUFIJO_BUNDLE}`;
    const defectoBundle = archivoRegular(bundle);
    if (defectoBundle) { anotar(`el bundle ${path.basename(bundle)} ${defectoBundle}`); continue; }

    const r = ejecutar('cosign', ['verify-blob', '--bundle', bundle,
      '--certificate-identity', identidad, '--certificate-oidc-issuer', EMISOR_GITHUB, archivo]);
    if (r.error || r.status !== 0) {
      anotar(`cosign verify-blob rechazó la firma (${r.error || `salió con ${r.status}`})`);
    }
  }
  return { ok: problemas.length === 0, problemas, comprobados: archivos.length };
}

// --- CLI ----------------------------------------------------------------------

const AYUDA = `
Verifica la firma de artefactos finales de release. Falla cerrado.

  windows --publisher=<CN exacto del certificado> <exe>...
  macos   --team-id=<Team ID de Apple> <MIKA5.app>
  linux   --identity=<https://github.com/<org>/<repo>/.github/workflows/<flujo>.yml@refs/tags/vX.Y.Z> <fichero>...

Sale con 0 si todo cuadra y con 1 en cuanto algo no lo hace o no se pudo comprobar.
`.trim();

function principal(argv) {
  const [plataforma, ...resto] = argv;
  const opciones = {};
  const rutas = [];
  for (const argumento of resto) {
    const m = /^--([a-z-]+)=(.*)$/.exec(argumento);
    if (m) opciones[m[1]] = m[2];
    else if (argumento.startsWith('--')) { process.stderr.write(`${AYUDA}\n`); return 1; }
    else rutas.push(argumento);
  }
  let resultado;
  if (plataforma === 'windows') resultado = verificarAuthenticode({ archivos: rutas, publisher: opciones.publisher });
  else if (plataforma === 'macos' && rutas.length === 1) resultado = verificarMacos({ app: rutas[0], teamId: opciones['team-id'] });
  else if (plataforma === 'linux') resultado = verificarSigstore({ archivos: rutas, identidad: opciones.identity });
  else { process.stderr.write(`${AYUDA}\n`); return plataforma === '--help' ? 0 : 1; }

  if (resultado.ok) {
    process.stderr.write(`${resultado.comprobados} artefacto(s) con firma verificada (${plataforma})\n`);
    return 0;
  }
  process.stderr.write(`${resultado.problemas.length} problema(s):\n`);
  for (const problema of resultado.problemas) process.stderr.write(`  - ${problema}\n`);
  return 1;
}

module.exports = {
  verificarAuthenticode, verificarMacos, verificarSigstore, identidadSigstore,
  clavesDeEntitlements, EMISOR_GITHUB, SUFIJO_BUNDLE, GUION_AUTHENTICODE
};

if (require.main === module) {
  process.exit(principal(process.argv.slice(2)));
}
