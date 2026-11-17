import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');
const manifest = JSON.parse(read('package.json'));

/** Host packages named by an import specifier or an `import()` call in the Host half. */
function hostSpecifiers() {
  const files = ['index.js', ...readdirSync(new URL('lib/', root)).filter((name) => name.endsWith('.js')).map((name) => join('lib', name))];
  const found = new Map();
  for (const file of files) {
    for (const match of read(file).matchAll(/['"](@deepseek-ai\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g)) {
      found.set(match[1], [...(found.get(match[1]) ?? []), file]);
    }
  }
  return found;
}

test('every host package the Host half imports is declared as a peer dependency', () => {
  // The host routes a linked plugin's imports of its own packages only when the
  // plugin's package.json lists them as peers; otherwise Node's default
  // resolution runs and fails ("Cannot find package ... imported from ...").
  const peers = manifest.peerDependencies ?? {};
  const specifiers = hostSpecifiers();
  assert.ok(specifiers.size > 0, 'the scan found at least one host specifier');
  for (const [name, files] of specifiers) {
    assert.ok(name in peers, `${name} is imported by ${files.join(', ')} but not listed in peerDependencies`);
  }
});

test('peer ranges accept the host version this plugin targets, prereleases included', () => {
  // `>=0.2.0-rc.2` would not match 0.2.2-rc.1: a prerelease satisfies a range only
  // through a comparator on the same major.minor.patch.
  const target = manifest.engines.dsh.replace(/^>=/, '');
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    assert.equal(range, `>=${target}`, `${name} follows engines.dsh`);
  }
});

test('the packed file list covers everything the Host half loads', () => {
  const files = manifest.files;
  for (const entry of ['index.js', 'client.js', 'lib/*.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(files.includes(entry), `files lists ${entry}`);
  }
});
