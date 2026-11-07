#!/usr/bin/env node
'use strict';

// Copy one producer's exact inventory after native verification. The caller
// builds once in a clean dist, verifies that app, then stages without rebuilding.
// Usage: stage-artifacts.js producer dist staging commit [native-stdout-file]
const fs = require('fs');
const path = require('path');
const {
  construirManifiesto, artefactosDe, construirProof, ARQUITECTURA_NATIVA, PRODUCTORES
} = require('./artifact-manifest');

function stageArtifacts({ producer, dir, staging, commit, architectureFile, version }) {
  if (!Object.hasOwn(PRODUCTORES, producer)) throw new Error('Unknown producer');
  const manifest = construirManifiesto({ commit, version });
  const expected = artefactosDe(manifest, producer).map(a => a.name).sort();
  const source = fs.lstatSync(dir);
  if (!source.isDirectory() || source.isSymbolicLink()) throw new Error('Invalid dist directory');
  // Include every installer extension, even one belonging to another producer.
  // Extra/misnamed artifacts must not disappear when we copy the expected set.
  const actual = fs.readdirSync(dir).filter(n => /\.(exe|dmg|zip|appimage|deb|rpm)$/i.test(n)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Unexpected artifact inventory');
  let detectedArchitecture;
  if (PRODUCTORES[producer].platform === 'macos') {
    if (!architectureFile) throw new Error('Missing native architecture output');
    const raw = fs.readFileSync(architectureFile, 'utf8');
    if (!/^(x64|arm64)\n$/.test(raw)) throw new Error('Invalid native architecture output');
    const detected = raw.slice(0, -1);
    if (detected !== PRODUCTORES[producer].arch) throw new Error('Contrary architecture');
    detectedArchitecture = [ARQUITECTURA_NATIVA[detected]];
  } else if (architectureFile) {
    throw new Error('Unexpected architecture output for this producer');
  }
  for (const name of expected) {
    const info = fs.lstatSync(path.join(dir, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`Invalid artifact: ${name}`);
  }
  // Fresh destination only: never overwrite output from another build/job.
  fs.mkdirSync(staging);
  for (const name of expected) {
    fs.copyFileSync(path.join(dir, name), path.join(staging, name), fs.constants.COPYFILE_EXCL);
  }
  const proof = construirProof({ producer, dir: staging, commit, version, detectedArchitecture });
  fs.writeFileSync(path.join(staging, 'artifact-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  return proof;
}

module.exports = { stageArtifacts };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 4 || args.length > 5) throw new Error('Expected producer dist staging commit [native-stdout-file]');
    const [producer, dir, staging, commit, architectureFile] = args;
    const proof = stageArtifacts({ producer, dir, staging, commit, architectureFile });
    console.error(`Staged ${proof.files.length} artifacts for ${proof.producer}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
