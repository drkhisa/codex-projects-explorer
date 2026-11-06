import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(root, 'extension');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const [expectedHash, archiveName] = readFileSync(join(root, 'archives', 'SHA256SUMS'), 'utf8').trim().split(/\s+/);
assert.match(expectedHash, /^[a-f0-9]{64}$/);
assert.equal(archiveName, 'Codex-Projects-All-0.5.2.zip');
const actualHash = createHash('sha256').update(readFileSync(join(root, 'archives', archiveName))).digest('hex');
assert.equal(actualHash, expectedHash, 'The original release archive changed');

const pkg = readJson(join(extension, 'package.json'));
assert.equal(pkg.name, 'codex-projects-explorer');
assert.ok(existsSync(join(extension, pkg.main)), 'Extension entry point is missing');
const bridge = join(extension, 'browser-bridge');
const manifest = readJson(join(bridge, 'manifest.json'));
assert.equal(manifest.manifest_version, 3);
assert.ok(existsSync(join(bridge, manifest.background.service_worker)));
assert.ok(existsSync(join(bridge, manifest.action.default_popup)));
for (const content of manifest.content_scripts) {
  for (const file of content.js) assert.ok(existsSync(join(bridge, file)), `Missing browser script: ${file}`);
}

let checked = 0;
for (const dir of ['src', 'media', 'browser-bridge']) {
  for (const file of readdirSync(join(extension, dir)).filter(file => file.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', join(extension, dir, file)], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || `Syntax check failed: ${dir}/${file}`);
    checked++;
  }
}
readJson(join(root, 'installers', 'Windows', 'installer.json'));
console.log(`OK: archive SHA-256, extension/browser entry points, JSON, ${checked} JavaScript syntax checks`);
console.log('Not run: original tests/build scripts (absent from release), VS Code/browser integration, installers.');
