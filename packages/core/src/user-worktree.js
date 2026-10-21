import { spawn } from 'node:child_process';
import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';

/** Bounded, no-follow administrative reads; no Git process is needed to re-check a grant. */
async function control(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096) throw new Error('Invalid Git administrative file');
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error('Git administrative file exceeds limit');
    return bytes
      .subarray(0, bytesRead)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  } finally {
    await handle.close();
  }
}
export async function repositoryIdentity(directory) {
  if ((await realpath(directory)) !== directory) throw new Error('Repository root is not canonical');
  const entry = path.join(directory, '.git');
  const info = await lstat(entry);
  let gitDir;
  if (info.isDirectory()) gitDir = await realpath(entry);
  else {
    const value = await control(entry);
    if (!value.startsWith('gitdir: ') || /[\r\n\0]/.test(value)) throw new Error('Invalid Git control link');
    gitDir = await realpath(path.resolve(directory, value.slice(8)));
  }
  const commonEntry = path.join(gitDir, 'commondir');
  const hasCommon = await lstat(commonEntry).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const commonDir = hasCommon ? await realpath(path.resolve(gitDir, await control(commonEntry))) : gitDir;
  if (gitDir !== commonDir) {
    if (
      path.dirname(gitDir) !== path.join(commonDir, 'worktrees') ||
      path.resolve(gitDir, await control(path.join(gitDir, 'gitdir'))) !== entry
    )
      throw new Error('Git worktree backlink changed');
  }
  const head = await control(path.join(gitDir, 'HEAD'));
  const branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : null;
  if (branch !== null && (!branch || /[\r\n\0]/.test(branch))) throw new Error('Invalid branch reference');
  return { gitDir, commonDir, branch };
}

/** User workspace primitives. Assignment cleanup's force/rm semantics must never be used here. */
export function userWorktreeGit({ executable = '/usr/bin/git', timeoutMs = 15_000, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (process.platform === 'win32') throw new Error('User worktree operations are unavailable on this host');
  if (!path.isAbsolute(executable)) throw new Error('Git executable must be host configured and absolute');
  const disabled = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'core.pager=cat',
    '-c',
    'maintenance.auto=false',
    '-c',
    'gc.auto=0',
    '-c',
    'protocol.allow=never',
    '-c',
    'submodule.recurse=false'
  ];
  // No inherited Git context, PATH or user/system config. Repository config is data, never a program.
  const env = {
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: 'C',
    LC_ALL: 'C'
  };
  async function raw(cwd, args, extra = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...disabled, ...extra, ...args], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: true
      });
      let size = 0;
      let overflow = false;
      const stdout = [];
      const stderr = [];
      const kill = () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(() => {
        overflow = true;
        kill();
      }, timeoutMs);
      const collect = (sink) => (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          overflow = true;
          kill();
        } else sink.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (overflow) reject(new Error('Git operation exceeded its host limit'));
        else
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8')
          });
      });
    });
  }
  async function filterOverrides(cwd) {
    // Status/removal may run clean/process filters as well as creation's smudge filter.
    const filters = await raw(cwd, [
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^filter\\..*\\.(smudge|clean|process|required)$'
    ]);
    if (filters.code !== 0 && filters.code !== 1) throw new Error('Cannot inspect repository filters');
    const neutral = filters.stdout
      .split('\0')
      .filter(Boolean)
      .flatMap((key) => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`]);
    return neutral;
  }
  async function run(cwd, args, extra = []) {
    return raw(cwd, args, [...(await filterOverrides(cwd)), ...extra]);
  }
  async function checked(cwd, args, extra = []) {
    const result = await run(cwd, args, extra);
    if (result.code !== 0) throw new Error('Git workspace operation refused');
    return result.stdout.trim();
  }
  async function directory(value) {
    const canonical = await realpath(value);
    if (canonical !== value || !(await lstat(value)).isDirectory())
      throw new Error('Workspace paths must be canonical directories');
    return canonical;
  }
  async function facts(source) {
    await directory(source);
    const top = await checked(source, ['rev-parse', '--show-toplevel']);
    if ((await realpath(top)) !== source) throw new Error('Workspace must be a repository top level');
    const commonDir = await realpath(
      await checked(source, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    );
    const identity = await repositoryIdentity(source);
    if (identity.commonDir !== commonDir) throw new Error('Repository identity changed');
    const head = await checked(source, ['rev-parse', '--verify', 'HEAD']);
    const branch = await run(source, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return { commonDir, gitDir: identity.gitDir, head, branch: branch.code === 0 ? branch.stdout.trim() : null };
  }
  async function list(source) {
    const result = await checked(source, ['worktree', 'list', '--porcelain', '-z']);
    return result
      .split('\0\0')
      .filter(Boolean)
      .map((block) =>
        Object.fromEntries(
          block
            .split('\0')
            .filter(Boolean)
            .map((line) => {
              const i = line.indexOf(' ');
              return i < 0 ? [line, true] : [line.slice(0, i), line.slice(i + 1)];
            })
        )
      );
  }
  async function inspect(source, target, branch) {
    const row = (await list(source)).find((row) => row.worktree === target);
    if (!row) return undefined;
    await directory(target);
    if (row.branch !== `refs/heads/${branch}` || row.locked || row.prunable)
      throw new Error('Managed worktree identity changed');
    const origin = await facts(source);
    const destination = await facts(target);
    if (origin.commonDir !== destination.commonDir) throw new Error('Managed worktree repository changed');
    return row;
  }
  async function assertClean(target) {
    const flags = await checked(target, ['ls-files', '-v', '-z']);
    if (flags.split('\0').some((row) => row && (row[0] === 'S' || /[a-z]/.test(row[0]))))
      throw new Error('Worktree has hidden index state');
    if ((await checked(target, ['ls-files', '--stage', '-z'])).split('\0').some((row) => row.startsWith('160000 ')))
      throw new Error('Worktree has submodules');
    // Ignored data is user data too. Never force a delete or fall back to recursive rm.
    if ((await checked(target, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'])).length)
      throw new Error('Worktree contains uncommitted or ignored files');
  }
  return {
    facts,
    inspect,
    assertClean,
    async checkoutFacts(directory) {
      const canonical = await realpath(directory);
      const repoRoot = await checked(canonical, ['rev-parse', '--show-toplevel']);
      const branch = await run(canonical, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const remote = await run(canonical, ['config', '--get', 'remote.origin.url']);
      const status = await checked(canonical, ['status', '--porcelain=v1', '--untracked-files=all']);
      return {
        isGit: /** @type {const} */ (true),
        repoRoot,
        currentBranch: branch.code === 0 ? branch.stdout.trim() : null,
        remoteUrl: remote.code === 0 ? remote.stdout.trim() || null : null,
        isDirty: !!status
      };
    },
    async create(source, parent, name, branch, head) {
      await directory(parent);
      if (!/^wks_[0-9a-f]{16}$/.test(name) || branch !== `alp/workspace/${name}` || !/^[0-9a-f]{40,64}$/.test(head))
        throw new Error('Invalid generated worktree identity');
      const target = path.join(parent, name);
      if (
        await lstat(target).catch((error) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        })
      )
        throw new Error('Worktree destination already exists');
      await checked(source, ['worktree', 'add', '--quiet', '--no-checkout', '-b', branch, target, head]);
      // Conditional gitdir/onbranch config is resolved in the new checkout before materialization.
      await checked(target, ['reset', '--hard', '--no-recurse-submodules', head]);
      if (!(await inspect(source, target, branch))) throw new Error('Worktree creation needs reconciliation');
      return target;
    },
    async remove(source, target, branch) {
      if (!(await inspect(source, target, branch))) throw new Error('Managed worktree is missing');
      await assertClean(target);
      await checked(source, ['worktree', 'remove', target], await filterOverrides(target));
      if ((await list(source)).some((row) => row.worktree === target))
        throw new Error('Worktree removal needs reconciliation');
    }
  };
}
