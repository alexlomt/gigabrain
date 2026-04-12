import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const run = async () => {
  const packagePath = path.join(repoRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const required = [
    'memory_api/app.py',
    'memory_api/README.md',
    'memory_api/requirements.txt',
    'memory_api/static/',
  ];
  for (const entry of required) {
    assert.equal(
      files.includes(entry),
      true,
      `published package metadata must ship ${entry}`,
    );
  }
  assert.equal(
    files.includes('memory_api/'),
    false,
    'published package metadata must not ship the entire memory_api directory because that can sweep in local virtualenvs',
  );
};

export { run };
