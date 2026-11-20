import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageError } from './usage.js';

/**
 * alp desktop (t-81b0.5): opens ALP's desktop app (apps/desktop, an Electron shell for macOS). The
 * app is looked for, in order:
 *   1. ALP.app in /Applications, then in ~/Applications (macOS), opened with `open`;
 *   2. a checkout named by ALP_DESKTOP_CHECKOUT (the repository root, or its apps/desktop), whose
 *      app is built (`bun install && bun run build` in apps/desktop), run with its own Electron;
 *   3. neither: how to get it, and exit 1.
 * Nothing secret passes here: the app asks `alp dashboard --print` for its address itself.
 */

/** @param {string} file */
const isDirectory = file => stat(file).then(info => info.isDirectory(), () => false);
/** @param {string} file */
const isFile = file => stat(file).then(info => info.isFile(), () => false);

/**
 * The desktop app's directory in a checkout: `dir` itself or `dir/apps/desktop`, whichever holds the
 * package named alp-desktop.
 * @param {string} dir
 */
async function desktopPackage(dir) {
  for (const candidate of [path.join(dir, 'apps', 'desktop'), dir]) {
    const manifest = await readFile(path.join(candidate, 'package.json'), 'utf8').then(text => { try { return JSON.parse(text); } catch { return undefined; } }, () => undefined);
    if (manifest?.name === 'alp-desktop') return candidate;
  }
  return undefined;
}

/**
 * Where the app is and how to start it. Exported for tests.
 * @param {{ platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv, applications?: string[] }} [options]
 * @returns {Promise<{ kind: 'app', app: string, command: string, args: string[] }
 *   | { kind: 'checkout', dir: string, command: string, args: string[] }
 *   | { kind: 'missing', reason?: string }>}
 */
export async function resolveDesktop({ platform = process.platform, home = os.homedir(), env = process.env, applications } = {}) {
  if (platform === 'darwin') {
    for (const directory of applications ?? ['/Applications', path.join(home, 'Applications')]) {
      const app = path.join(directory, 'ALP.app');
      if (await isDirectory(app)) return { kind: 'app', app, command: 'open', args: [app] };
    }
  }
  const checkout = env.ALP_DESKTOP_CHECKOUT;
  if (!checkout) return { kind: 'missing' };
  const dir = await desktopPackage(path.resolve(checkout));
  if (!dir) return { kind: 'missing', reason: `ALP_DESKTOP_CHECKOUT=${checkout} is not an ALP checkout: neither it nor its apps/desktop holds the alp-desktop package.` };
  const electron = path.join(dir, 'node_modules', '.bin', platform === 'win32' ? 'electron.cmd' : 'electron');
  if (!(await isFile(electron)) || !(await isFile(path.join(dir, 'dist', 'main.cjs')))) {
    return { kind: 'missing', reason: `The desktop app in ${dir} is not built: run \`bun install && bun run build\` there, then run alp desktop again.` };
  }
  return { kind: 'checkout', dir, command: electron, args: [dir] };
}

const INSTRUCTIONS = `ALP's desktop app is not installed.
  - Put ALP.app in /Applications (or ~/Applications), or
  - point ALP_DESKTOP_CHECKOUT at an ALP checkout whose apps/desktop is built:
      cd <checkout>/apps/desktop && bun install && bun run build
      ALP_DESKTOP_CHECKOUT=<checkout> alp desktop
Meanwhile, \`alp dashboard\` opens ALP in your browser.`;

/**
 * @param {string[]} args
 * @param {{ resolve?: typeof resolveDesktop, launch?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void> }} [deps]
 */
export async function desktopCommand(args, { resolve = resolveDesktop, launch = start } = {}) {
  if (args.length) throw new UsageError();
  const found = await resolve();
  if (found.kind === 'missing') {
    if (found.reason) console.error(found.reason);
    console.error(INSTRUCTIONS);
    process.exitCode = 1;
    return;
  }
  const env = { ...process.env };
  // An agent's shell (and Electron's own tools) may set it; Electron would then run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  await launch(found.command, found.args, env);
  console.log(found.kind === 'app' ? `Opened ${found.app}.` : `Started the desktop app from ${found.dir}.`);
}

/** Starts `command` detached, resolving once it spawned. @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} env */
function start(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, env });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
