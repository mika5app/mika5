'use strict';

// Orchestration and artifact fixtures; these do NOT provide native macOS proof.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { stageArtifacts } = require('../scripts/ci/stage-artifacts');
const { matchingZips } = require('../scripts/ci/check-electron-cache');
const { construirManifiesto, PRODUCTORES } = require('../scripts/ci/artifact-manifest');
const { verificarStaging } = require('../scripts/ci/verify-artifacts');

const root = path.join(__dirname, '..');
const readWorkflow = name => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
const commands = job => (job?.steps || []).map(s => s.run || '').join('\n');
const dependencies = job => [].concat(job?.needs || []);

function canonicalProblems(wf) {
  const problems = [];
  const requireRule = (ok, message) => { if (!ok) problems.push(message); };
  const jobs = wf.jobs || {};
  requireRule(Boolean(wf.on?.workflow_call), 'reusable interface');
  requireRule(wf.permissions?.contents === 'read', 'read-only permissions');
  requireRule(!/secrets\.|contents":\s*"write|continue-on-error/.test(JSON.stringify(wf)), 'no secrets or tolerated failures');
  requireRule(commands(jobs.source).includes('node scripts/ci/audit.js'), 'audit policy');
  requireRule(commands(jobs.source).includes('node scripts/ci/changed-scope.js --scope=packaging'), 'scope detector');
  requireRule(commands(jobs.source).includes('"$GITHUB_REF_TYPE" == tag'), 'tags always package');
  requireRule(dependencies(jobs['quality-gates']).includes('source'), 'gates require audited source');
  requireRule(JSON.stringify(jobs['quality-gates']?.strategy?.matrix?.os) === JSON.stringify(['ubuntu-latest', 'windows-latest']), 'both gate platforms');
  requireRule((commands(jobs['quality-gates']).match(/npm run test:all/g) || []).length === 2, 'both full gate batteries');
  requireRule(commands(jobs['quality-gates']).includes('npm run test:gui'), 'Linux GUI gate');
  requireRule(dependencies(jobs.package).includes('quality-gates'), 'packages require gates');
  requireRule(jobs.package?.if === "needs.source.outputs.package == 'true'", 'packaging scope condition');
  const rows = jobs.package?.strategy?.matrix?.include || [];
  requireRule(JSON.stringify(rows.map(r => r.producer).sort()) === JSON.stringify(Object.keys(PRODUCTORES).sort()), 'exact producer matrix');
  const mac = rows.filter(r => r.platform === 'darwin');
  requireRule(mac.some(r => r.arch === 'x64' && r.os === 'macos-15-intel')
    && mac.some(r => r.arch === 'arm64' && r.os === 'macos-15'), 'native macOS runners');
  const producer = commands(jobs.package);
  for (const script of ['check-electron-cache.js', 'check-icon.sh', 'verify-macos-package.sh', 'stage-artifacts.js']) {
    requireRule(producer.includes(`scripts/ci/${script}`), `producer control ${script}`);
  }
  requireRule(producer.includes('scripts/verify-packaged-windows.js'), 'Windows packaged checks');
  requireRule(producer.includes('dpkg-deb -x') && producer.includes('--appimage-extract-and-run'), 'Linux package checks');
  requireRule(!/\bls\b[^\n]*\||head -1|eval\s/.test(producer), 'unambiguous discovery');
  requireRule((producer.match(/--publish never/g) || []).length === 3, 'all platform builds disable publishing');
  requireRule(dependencies(jobs['verify-artifacts']).includes('package'), 'verification requires all producers');
  requireRule(commands(jobs['verify-artifacts']).includes('node scripts/ci/verify-artifacts.js --dir=staging --commit="$GITHUB_SHA"'), 'hash and commit verification');
  const downloads = (jobs['verify-artifacts']?.steps || []).filter(s => s.uses?.startsWith('actions/download-artifact@'));
  requireRule(JSON.stringify(downloads.map(s => s.with.name).sort()) === JSON.stringify(Object.keys(PRODUCTORES).sort()), 'exact artifact downloads');
  for (const job of Object.values(jobs)) {
    for (const step of job.steps || []) {
      if (step.uses?.startsWith('actions/upload-artifact@') && step.if !== 'failure()') {
        requireRule(step.with?.['if-no-files-found'] === 'error', 'missing artifacts fail');
      }
    }
  }
  return problems;
}

const canonical = readWorkflow('_canonical.yml');
assert.deepStrictEqual(canonicalProblems(canonical), []);
for (const mutate of [
  w => { w.jobs.package.needs = ['source']; },
  w => { w.jobs.source.steps = []; },
  w => { w.jobs['quality-gates'].strategy.matrix.os.pop(); },
  w => { w.jobs.package.strategy.matrix.include.pop(); },
  w => { w.jobs['verify-artifacts'].steps = []; },
  w => { w.jobs.package['continue-on-error'] = true; }
]) {
  const bad = structuredClone(canonical);
  mutate(bad);
  assert(canonicalProblems(bad).length > 0, 'Broken orchestration must be rejected');
}

for (const name of ['build.yml', 'security-validation.yml', 'integration.yml']) {
  const caller = readWorkflow(name);
  assert.strictEqual(caller.jobs.canonical.uses, './.github/workflows/_canonical.yml');
  assert(!caller.jobs.canonical.secrets, `${name} must not pass release secrets to validation`);
  if (name !== 'build.yml') {
    assert.strictEqual(caller.jobs.canonical.with['force-package'], true);
    assert.deepStrictEqual(Object.keys(caller.jobs), ['canonical']);
  }
}
const release = readWorkflow('build.yml');
assert.strictEqual(release.jobs.canonical.with['force-package'], "${{ github.ref_type == 'tag' }}");
assert(dependencies(release.jobs['prepare-release']).includes('canonical'));
assert(dependencies(release.jobs['finalize-release']).includes('canonical'));
const download = release.jobs['finalize-release'].steps.find(s => s.uses?.startsWith('actions/download-artifact@'));
assert.strictEqual(download.with['artifact-ids'], '${{ needs.canonical.outputs.artifact-id }}');
assert.strictEqual(download.with['merge-multiple'], true);
assert(commands(release.jobs['finalize-release']).includes('scripts/ci/verify-artifacts.js'));
assert(!Object.values(release.jobs).some(j => /npm run build:/.test(commands(j))), 'Release must reuse verified builds');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-artifact-fixtures-'));
const commit = 'a'.repeat(40);
const version = '0.3.1';
const manifest = construirManifiesto({ commit, version });
const staging = path.join(tmp, 'staging');
fs.mkdirSync(staging);
try {
  for (const [producer, info] of Object.entries(PRODUCTORES)) {
    const dir = path.join(tmp, producer);
    fs.mkdirSync(dir);
    for (const artifact of manifest.artifacts.filter(a => a.producer === producer)) {
      fs.writeFileSync(path.join(dir, artifact.name), `fixture bytes for ${artifact.name}`);
    }
    const architectureFile = info.platform === 'macos' ? path.join(tmp, `${producer}.stdout`) : undefined;
    if (architectureFile) fs.writeFileSync(architectureFile, `${info.arch}\n`);
    const args = { producer, dir, staging: path.join(staging, producer), commit, version, architectureFile };
    const rejected = () => assert.throws(() => stageArtifacts({ ...args, staging: path.join(tmp, 'must-not-exist') }));
    const name = manifest.artifacts.find(a => a.producer === producer).name;
    const saved = fs.readFileSync(path.join(dir, name));
    fs.unlinkSync(path.join(dir, name)); rejected();
    fs.writeFileSync(path.join(dir, name), ''); rejected();
    fs.writeFileSync(path.join(dir, name), saved);
    fs.writeFileSync(path.join(dir, 'unexpected.zip'), 'extra'); rejected();
    fs.unlinkSync(path.join(dir, 'unexpected.zip'));
    if (architectureFile) {
      for (const output of ['', 'x64', 'x64\nextra\n', 'x86_64\n', 'x64 arm64\n', `${info.arch === 'x64' ? 'arm64' : 'x64'}\n`]) {
        fs.writeFileSync(architectureFile, output); rejected();
      }
      fs.writeFileSync(architectureFile, `${info.arch}\n`);
      assert.throws(() => stageArtifacts({ ...args, architectureFile: undefined }), /Missing native/);
    }
    stageArtifacts(args);
    assert.throws(() => stageArtifacts(args), /EEXIST/);
  }
  const verify = () => verificarStaging({ dir: staging, version, commit });
  const verified = verify();
  assert.strictEqual(verified.ok, true, JSON.stringify(verified.problemas));
  assert.strictEqual(verify().comprobados, 9);
  assert.strictEqual(verificarStaging({ dir: staging, version, commit: 'b'.repeat(40) }).ok, false);
  const first = manifest.artifacts[0];
  fs.appendFileSync(path.join(staging, first.producer, first.name), 'tampered');
  assert.strictEqual(verify().ok, false, 'Changed bytes after producer proof are rejected');
  const cache = path.join(tmp, 'cache');
  fs.mkdirSync(cache);
  assert.deepStrictEqual(matchingZips(cache, 'expected.zip'), []);
  for (const sub of ['one', 'two']) {
    fs.mkdirSync(path.join(cache, sub));
    fs.writeFileSync(path.join(cache, sub, 'expected.zip'), 'fixture');
  }
  assert.strictEqual(matchingZips(cache, 'expected.zip').length, 2, 'Ambiguous cache candidates remain visible');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('Canonical workflow and artifact fixtures PASS (no native macOS proof)');
