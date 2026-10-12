import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Inspect npm's actual file selection without publishing or creating a tarball.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check through npm run check:package.');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const [packed] = JSON.parse(
  execFileSync(process.execPath, [npm, 'pack', '--dry-run', '--ignore-scripts', '--json'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  }),
);
assert.equal(manifest.name, 'chirp-wa');
assert.deepEqual(manifest.bin, { chirp: 'dist/cli.js' });
assert.equal(packed.name, manifest.name);
assert.equal(packed.version, manifest.version);
const files = new Set(packed.files.map((file) => file.path));
for (const required of [
  'package.json',
  'README.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'CHANGELOG.md',
  'dist/cli.js',
  'dist/THIRD_PARTY_LICENSES.txt',
]) {
  assert.ok(files.has(required), `Missing package file: ${required}`);
}
for (const path of files) {
  assert.match(
    path,
    /^(?:package\.json|README\.md|CONTRIBUTING\.md|LICENSE|CHANGELOG\.md|docs\/[\w-]+\.md|dist\/cli\.js|dist\/THIRD_PARTY_LICENSES\.txt|dist\/chunks\/[\w-]+\.js|dist\/protocol\/type-\d+\.cjs)$/,
    `Unexpected package file: ${path}`,
  );
}
assert.ok(
  [...files].some((path) => path.startsWith('dist/chunks/')),
  'Missing bundled chunks',
);
assert.ok(
  [...files].filter((path) => path.startsWith('dist/protocol/')).length > 100,
  'Missing lazy protocol factories',
);
assert.match(readFileSync('dist/cli.js', 'utf8').split('\n')[0], /^#!.*node/);
console.log(
  `Validated ${packed.filename}: ${files.size} files, ${(packed.size / 1024 / 1024).toFixed(2)} MiB compressed; command: chirp.`,
);
