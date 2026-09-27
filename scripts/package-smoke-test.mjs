import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(
  readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
);
const tempRoot = mkdtempSync(join(tmpdir(), 'smartrent-package-smoke-'));

try {
  const packOutput = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', tempRoot],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  const [packedArtifact] = JSON.parse(packOutput);
  assert.ok(packedArtifact, 'npm pack did not report an artifact');

  const packedFiles = new Set(packedArtifact.files.map(({ path }) => path));
  for (const entry of [packageJson.main, packageJson.types]) {
    assert.ok(entry, 'package main and types fields must be set');
    assert.ok(
      packedFiles.has(entry),
      `npm package is missing its declared entry: ${entry}`,
    );
    assert.ok(
      existsSync(join(repositoryRoot, entry)),
      `declared package entry does not exist after build: ${entry}`,
    );
  }
  assert.ok(
    ![...packedFiles].some((file) => file.startsWith('dist/src/')),
    'package contains a stale nested dist/src build tree',
  );
  assert.ok(
    ![...packedFiles].some(
      (file) =>
        file.startsWith('src/') ||
        (file.endsWith('.ts') && !file.endsWith('.d.ts')),
    ),
    'package must load compiled JavaScript rather than source TypeScript',
  );

  const archivePath = join(tempRoot, packedArtifact.filename);
  assert.ok(existsSync(archivePath), 'npm pack archive was not created');
  const extractedRoot = join(tempRoot, 'unpacked');
  mkdirSync(extractedRoot);
  execFileSync('tar', ['-xzf', archivePath, '-C', extractedRoot]);
  const extractedPackage = join(extractedRoot, 'package');
  assert.ok(existsSync(join(extractedPackage, packageJson.main)));

  const extractedModules = join(extractedPackage, 'node_modules');
  const repositoryModules = realpathSync(join(repositoryRoot, 'node_modules'));
  symlinkSync(repositoryModules, extractedModules, 'dir');
  const scopedPackageLink = join(
    tempRoot,
    'node_modules',
    ...packageJson.name.split('/'),
  );
  mkdirSync(dirname(scopedPackageLink), { recursive: true });
  symlinkSync(extractedPackage, scopedPackageLink, 'dir');

  const smokeRunner = join(tempRoot, 'load-packaged-plugin.mjs');
  writeFileSync(
    smokeRunner,
    `import assert from 'node:assert/strict';
globalThis.fetch = async () => { throw new Error('network access is disabled in this smoke test'); };
const plugin = await import(${JSON.stringify(packageJson.name)});
assert.equal(typeof plugin.default, 'function');
const registrations = [];
plugin.default({ registerPlatform: (...args) => registrations.push(args) });
assert.equal(registrations.length, 1);
assert.equal(registrations[0][0], ${JSON.stringify(packageJson.name)});
assert.equal(registrations[0][1], ${JSON.stringify(packageJson.homebridge.pluginAlias)});
assert.equal(typeof registrations[0][2], 'function');
process.stdout.write('Packed Homebridge registration entry loaded; no bridge instance or SmartRent connection started.\\n');
`,
  );

  const smokeEnvironment = { ...process.env };
  for (const name of Object.keys(smokeEnvironment)) {
    if (name.startsWith('SMARTRENT_')) delete smokeEnvironment[name];
  }
  execFileSync(process.execPath, [smokeRunner], {
    cwd: tempRoot,
    env: smokeEnvironment,
    stdio: 'inherit',
  });

  process.stdout.write(
    `Package smoke test passed: ${packedArtifact.filename}; main=${packageJson.main}; types=${packageJson.types}.\n`,
  );
} finally {
  if (existsSync(tempRoot) && !lstatSync(tempRoot).isSymbolicLink()) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
