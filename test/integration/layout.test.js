import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { integrationTests, packageTests, packages, testFiles, workspaceDirectory } from '../../scripts/test-lib.mjs';
import { paseoImportSpecifiers, referencedPackages } from '../support/layout.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const manifest = name => JSON.parse(readFileSync(path.join(root, workspaceDirectory(name), 'package.json'), 'utf8'));
const coreWorkspaces = ['protocol', 'core', 'runtime', 'client', 'daemon', 'cli'];
// The workspaces a package may depend on; its tests may name no other package's files.
const allowed = {
  protocol: [], core: ['protocol'], runtime: ['core', 'protocol'], client: ['core', 'protocol'],
  daemon: ['runtime', 'core', 'client', 'protocol'], cli: ['client', 'core', 'protocol'],
  paseo: ['daemon', 'runtime', 'client', 'core', 'protocol'],
};

/**
 * Tests are package-owned (packages/<name>/tests, importing only that package and its declared
 * dependencies) or cross-package (test/integration). These assertions keep that split from drifting:
 * no test file strays outside it, none is selected twice, and no core package test reaches the
 * optional Paseo plugin or a package that depends on it.
 */
test('test files live only in a package tests directory or test/integration', () => {
  const stray = [];
  const walk = (directory, inTests) => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(relative, inTests || entry.name === 'tests');
      else if (/\.test\.[cm]?[jt]s$/.test(entry.name) && !inTests) stray.push(relative);
    }
  };
  for (const group of ['packages', 'integrations', 'apps']) {
    for (const entry of readdirSync(path.join(root, group), { withFileTypes: true })) if (entry.isDirectory()) walk(`${group}/${entry.name}`, false);
  }
  for (const entry of readdirSync(path.join(root, 'test'), { withFileTypes: true })) {
    if (entry.isFile() && /\.test\./.test(entry.name)) stray.push(`test/${entry.name}`);
  }
  assert.deepEqual(stray, []);
  assert.ok(integrationTests().length > 0, 'test/integration is empty');
});

test('the root runner selects every test file exactly once', () => {
  const selected = [...packages.flatMap(name => packageTests(name)), ...integrationTests()];
  assert.equal(new Set(selected).size, selected.length);
  const present = [...testFiles('packages'), ...testFiles('integrations'), ...testFiles('apps')].filter(file => file.includes('/tests/')).concat(testFiles('test')).filter(file => !file.includes('/node_modules/'));
  assert.deepEqual([...selected].sort(), [...new Set(present)].sort());
});

test('every workspace with tests runs them through its own npm test', () => {
  for (const name of packages) {
    const script = manifest(name).scripts?.test;
    if (packageTests(name).length) assert.equal(script, `node ../../scripts/test-package.mjs ${name}`, `${name} must run its own tests`);
  }
});

test('no core workspace test imports the Paseo plugin or its SDK', () => {
  const violations = [];
  for (const name of coreWorkspaces) {
    for (const file of packageTests(name)) {
      const specifiers = paseoImportSpecifiers(readFileSync(path.join(root, file), 'utf8'), file);
      if (specifiers.length) violations.push(`${file} imports ${specifiers.join(', ')}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('a package test names only its own package and its declared dependencies', () => {
  const violations = [];
  for (const name of packages) {
    for (const file of packageTests(name)) {
      for (const other of referencedPackages(readFileSync(path.join(root, file), 'utf8'), file)) {
        if (other !== name && !allowed[name].includes(other)) violations.push(`${file} names ${workspaceDirectory(other)}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
