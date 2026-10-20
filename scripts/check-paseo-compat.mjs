#!/usr/bin/env node
// Paseo compatibility guard for @anhlp/alp-paseo (t-e5dc).
//
// beta.2 stopped loading for users who upgraded to Paseo 0.12.0: the Paseo host refuses a plugin
// whose paseo-plugin.json `requirements.paseo` excludes its own version
// (`assertPluginCompatibility` in @getpaseo/protocol/plugin-requirements, called before the plugin
// is compiled), and `npm install` resolves the `@getpaseo/*` peers against the same range.
//
//   node scripts/check-paseo-compat.mjs           offline, in validate:paseo: the manifest range
//       and the four @getpaseo/* peer ranges are one valid semver range, the installed SDK
//       satisfies it, and the installed host check accepts it.
//   node scripts/check-paseo-compat.mjs --latest  network, scheduled (.github/workflows/paseo-compat.yml):
//       the latest published @getpaseo/* release lies inside the range, the latest host check
//       (its own plugin-requirements module) accepts the packed manifest, and npm installs the
//       packed plugin tarball with that release as its peers under --strict-peer-deps.
//   node scripts/check-paseo-compat.mjs --floor   prints the lowest version the range admits.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnCommand } from './spawn-command.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN_DIR = path.join(ROOT, 'integrations/paseo');
export const SDK = ['@getpaseo/plugin', '@getpaseo/client', '@getpaseo/protocol', '@getpaseo/relay'];

const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !['--latest', '--floor'].includes(arg))) throw new Error('Usage: check-paseo-compat.mjs [--latest | --floor]');
const latest = args.includes('--latest');

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const pkg = readJson(path.join(PLUGIN_DIR, 'package.json'));
const manifest = readJson(path.join(PLUGIN_DIR, 'paseo-plugin.json'));
const problems = [];

function run(command, commandArgs, options = {}) {
  const result = spawnSync(...spawnCommand(command, commandArgs), { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout;
}

/** semver and the host check, loaded from an installed @getpaseo/protocol (semver is its own dependency). */
async function hostCheck(protocolDir) {
  const require = createRequire(path.join(protocolDir, 'package.json'));
  const { assertPluginCompatibility } = await import(pathToFileURL(path.join(protocolDir, 'dist/plugin-requirements.js')).href);
  return { semver: require('semver'), assertPluginCompatibility, version: readJson(path.join(protocolDir, 'package.json')).version };
}

// 1. One range: the host reads the manifest, npm reads the peers. They must not drift apart.
const range = manifest.requirements?.paseo;
if (typeof range !== 'string') problems.push('paseo-plugin.json has no requirements.paseo');
for (const name of SDK) {
  if (pkg.peerDependencies?.[name] !== range) problems.push(`peerDependencies["${name}"] is ${JSON.stringify(pkg.peerDependencies?.[name])}, paseo-plugin.json requirements.paseo is ${JSON.stringify(range)}`);
}

/** Where the plugin resolves an SDK package: its own node_modules first (npm nests there on a conflict), then the root. */
function sdkDir(name) {
  const nested = path.join(PLUGIN_DIR, 'node_modules', name);
  return existsSync(path.join(nested, 'package.json')) ? nested : path.join(ROOT, 'node_modules', name);
}

const installed = await hostCheck(sdkDir('@getpaseo/protocol'));
if (args.includes('--floor')) {
  // The lowest release the range admits: CI installs it to test the lower bound it claims.
  console.log(installed.semver.minVersion(range).version);
  process.exit(0);
}
if (range !== undefined && installed.semver.validRange(range) === null) problems.push(`requirements.paseo ${JSON.stringify(range)} is not a semver range`);

// 2. The SDK this checkout builds and tests with lies inside the range it declares.
for (const name of SDK) {
  const version = readJson(path.join(sdkDir(name), 'package.json')).version;
  if (!installed.semver.satisfies(version, range ?? '')) problems.push(`installed ${name}@${version} is outside ${range}`);
}
try {
  installed.assertPluginCompatibility({ id: manifest.id, requirements: manifest.requirements, version: installed.version, runtime: 'daemon' });
} catch (error) {
  problems.push(`installed host check (@getpaseo/protocol@${installed.version}): ${error.message}`);
}

if (latest && problems.length === 0) await checkLatest();

if (problems.length) {
  console.error(`Paseo compatibility check failed (requirements.paseo ${JSON.stringify(range)}):\n- ${problems.join('\n- ')}`);
  if (latest) console.error('\nA new Paseo release is outside the supported range: test the plugin against it, then widen the range in integrations/paseo/package.json (peers) and paseo-plugin.json together, and the docs requirement tables.');
  process.exit(1);
}
console.log(`Paseo compatibility: requirements.paseo and @getpaseo/* peers are ${range}; installed SDK ${installed.version} accepted${latest ? '; latest published release accepted (see above)' : ''}.`);

async function checkLatest() {
  const work = mkdtempSync(path.join(os.tmpdir(), 'alp-paseo-compat-'));
  try {
    // a. The latest release of every SDK package (Paseo releases them in lockstep with the app).
    const versions = {};
    for (const name of SDK) {
      const tags = JSON.parse(run('npm', ['view', name, 'dist-tags', '--json']));
      versions[name] = tags.latest;
      if (!installed.semver.satisfies(tags.latest, range)) problems.push(`latest ${name}@${tags.latest} is outside ${range}`);
      for (const [tag, version] of Object.entries(tags)) {
        // A prerelease of the next minor is an early warning, not a failure: users of stable Paseo are not affected yet.
        if (tag !== 'latest' && installed.semver.gt(version, tags.latest) && !installed.semver.satisfies(installed.semver.coerce(version), range)) {
          console.log(`::warning::${name}@${version} (dist-tag ${tag}) is outside ${range}`);
        }
      }
    }
    console.log(`Latest Paseo SDK: ${SDK.map(name => `${name}@${versions[name]}`).join(', ')}`);

    // b. Pack the plugin and the @anhlp packages it depends on (manifests only matter here, so no build).
    const tarballs = path.join(work, 'tarballs');
    const workspaces = ['integrations/paseo', ...Object.keys(pkg.dependencies).filter(name => name.startsWith('@anhlp/')).map(name => `packages/${name.slice('@anhlp/alp-'.length)}`)];
    mkdirSync(tarballs);
    const files = [];
    for (const workspace of workspaces) {
      const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tarballs], { cwd: path.join(ROOT, workspace) }));
      files.push(path.join(tarballs, packed.filename));
    }

    // c. A user's npm install of the packed plugin with the latest Paseo SDK as peers: --strict-peer-deps
    //    turns a peer range that excludes it into ERESOLVE. --dry-run resolves the full tree without writing it.
    const consumer = path.join(work, 'consumer');
    mkdirSync(consumer);
    writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'alp-paseo-compat-consumer', private: true }));
    const specs = SDK.map(name => `${name}@${versions[name]}`);
    const install = spawnSync(...spawnCommand('npm', ['install', '--dry-run', '--strict-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', ...files, ...specs]), { cwd: consumer, encoding: 'utf8' });
    if (install.status !== 0) problems.push(`npm install --strict-peer-deps of the packed plugin with ${specs.join(' ')} failed:\n${install.stdout}${install.stderr}`);
    else console.log(`npm resolves the packed plugin with ${specs.join(' ')} under --strict-peer-deps`);

    // d. The host check of the latest release, on the manifest inside the packed tarball.
    const host = path.join(work, 'host');
    mkdirSync(host);
    writeFileSync(path.join(host, 'package.json'), JSON.stringify({ name: 'alp-paseo-compat-host', private: true }));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=peer', `@getpaseo/protocol@${versions['@getpaseo/protocol']}`], { cwd: host });
    run('tar', ['xzf', files[0], '-C', work, 'package/paseo-plugin.json']);
    const packedManifest = readJson(path.join(work, 'package/paseo-plugin.json'));
    const latestHost = await hostCheck(path.join(host, 'node_modules/@getpaseo/protocol'));
    try {
      latestHost.assertPluginCompatibility({ id: packedManifest.id, requirements: packedManifest.requirements, version: latestHost.version, runtime: 'daemon' });
      console.log(`Paseo ${latestHost.version}'s own plugin check accepts the packed manifest (requirements.paseo ${packedManifest.requirements?.paseo})`);
    } catch (error) {
      problems.push(`Paseo ${latestHost.version}'s plugin check rejects the packed manifest: ${error.message}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
