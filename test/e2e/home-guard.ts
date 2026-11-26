// Shared guard for e2e lanes that start and stop an alpd on an ALP home (t-cad9). A lane must never
// run on the user's own ALP home: it would stop their alpd and write into their library. On
// 2026-11-24 an earlier guard realpath'd the whole ALP_HOME, failed because the leaf did not exist
// yet, fell back to the unresolved string and let a symlink into ~/.alp through. This guard fails
// closed instead:
//   - it resolves the deepest EXISTING ancestor with realpath and appends only components that are
//     truly absent (lstat ENOENT), so a missing leaf under a symlink is followed, and a dangling
//     symlink is refused rather than appended as a plain name;
//   - any other resolution error (EACCES, ELOOP, ENOTDIR, ...) refuses;
//   - it refuses the real account's ~/.alp, anything inside it, anything that contains it, and
//     anything inside the account's home directory unless it lies inside a scratch root the caller
//     names explicitly (ALP_TEST_SCRATCH_ROOT, itself checked).
// ALP_TEST_PROTECT_HOME adds another home to protect (the guard test uses a fake home under mktemp);
// it can only add protection, never remove the real account's.
import { lstatSync, realpathSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';

export class HomeGuardError extends Error {}

type Env = Record<string, string | undefined>;

// The errno code of a thrown fs error, if any.
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

const fold = (value: string) => (process.platform === 'darwin' || process.platform === 'win32' ? value.toLowerCase() : value);

/** The real location `value` names, or a HomeGuardError. Missing tail components are kept as names. */
export function resolveDeep(value: unknown) {
  if (typeof value !== 'string' || !value) throw new HomeGuardError('empty path');
  if (!path.isAbsolute(value)) throw new HomeGuardError(`not an absolute path: ${value}`);
  let existing = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      existing = realpathSync.native(existing);
      break;
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw new HomeGuardError(`cannot resolve ${existing}: ${codeOf(error) ?? error}`);
      // ENOENT from realpath also covers a dangling symlink (or a link through one); only a name
      // that is itself absent may be carried as a plain component.
      let present = true;
      try { lstatSync(existing); } catch (inner) {
        if (codeOf(inner) !== 'ENOENT') throw new HomeGuardError(`cannot inspect ${existing}: ${codeOf(inner) ?? inner}`);
        present = false;
      }
      if (present) throw new HomeGuardError(`${existing} exists but does not resolve (dangling or broken symlink)`);
      const parent = path.dirname(existing);
      if (parent === existing) throw new HomeGuardError(`no existing ancestor of ${value}`);
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return path.join(existing, ...missing);
}

/** True when `child` is `parent` or under it (case-folded where the file system usually is). */
export function within(child: string, parent: string) {
  const relative = path.relative(fold(parent), fold(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The account's home directories to protect: the real one, plus ALP_TEST_PROTECT_HOME if set. */
function protectedHomes(env: Env) {
  let account: string;
  try { account = userInfo().homedir; } catch (error) { throw new HomeGuardError(`cannot read the account's home directory: ${(error as Error | null)?.message ?? error}`); }
  const homes = [account];
  if (env.ALP_TEST_PROTECT_HOME) homes.push(env.ALP_TEST_PROTECT_HOME);
  return homes.map(home => {
    const real = resolveDeep(home);
    return { home: real, alp: resolveDeep(path.join(real, '.alp')) };
  });
}

/**
 * Checks that `candidate` may serve as a lane's ALP home. Returns the resolved path, or throws a
 * HomeGuardError on any doubt. Pure apart from realpath/lstat/userInfo.
 */
export function checkScratchHome(candidate: string, env: Env = process.env) {
  const resolved = resolveDeep(candidate);
  const homes = protectedHomes(env);
  const scratch = env.ALP_TEST_SCRATCH_ROOT ? resolveDeep(env.ALP_TEST_SCRATCH_ROOT) : undefined;
  for (const { home, alp } of homes) {
    if (within(resolved, alp) || within(alp, resolved)) throw new HomeGuardError(`${candidate} resolves to ${resolved}, which is or holds the user's ALP home ${alp}`);
    if (scratch && (within(alp, scratch) || within(scratch, alp) || within(home, scratch))) throw new HomeGuardError(`ALP_TEST_SCRATCH_ROOT ${scratch} is, holds or is inside the user's ALP home or holds their home`);
    if (within(resolved, home) && !(scratch && within(resolved, scratch))) throw new HomeGuardError(`${candidate} resolves to ${resolved}, inside the user's home ${home}; name a scratch root there with ALP_TEST_SCRATCH_ROOT`);
  }
  return resolved;
}

/**
 * The lane's ALP home. With ALP_HOME set (and `acceptGiven`) it is checked and kept; otherwise a new
 * temporary home is made under a checked tmpdir and checked again. Exits 2 with a message on refusal,
 * before the lane runs anything.
 */
export async function laneHome({ env = process.env, prefix, acceptGiven = true, exit = (code: number) => process.exit(code) }: { env?: Env, prefix: string, acceptGiven?: boolean, exit?: (code: number) => void }) {
  try {
    if (acceptGiven && env.ALP_HOME) return { home: checkScratchHome(env.ALP_HOME, env), owned: false };
    checkScratchHome(tmpdir(), env);
    const made = await mkdtemp(path.join(tmpdir(), prefix));
    return { home: checkScratchHome(made, env), owned: true };
  } catch (error) {
    if (!(error instanceof HomeGuardError)) throw error;
    console.error(`Refusing to run this lane: ${error.message}. It starts and stops an alpd on its ALP home. Unset ALP_HOME for a temporary home, or pass a scratch one.`);
    exit(2);
    throw error;
  }
}
