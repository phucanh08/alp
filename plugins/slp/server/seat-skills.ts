import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { resolvePaseoHome } from "./paths";
import type { Seat } from "./seat";
import { invokeSlpDev, type PluginInvoker, SEAT_RULES_TIMEOUT_MS } from "./seat-rules";

/**
 * slp-dev's `slp-dev.skills.get` (`plugins/slp-dev/shared/rpc.ts`), addressed by name like
 * `SLP_DEV_SEAT_GET`. `seat-skills.test.ts` checks it against slp-dev.
 */
export const SLP_DEV_SKILLS_GET = "slp-dev.skills.get";

const SkillsGetOutput = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() })),
});

type SkillFile = z.infer<typeof SkillsGetOutput>["files"][number];

const SEATS: readonly Seat[] = ["lead", "peer", "supervisor"];

/** Written next to `.claude-plugin/`; a seat directory whose hash matches is left alone. */
const HASH_FILE = ".content-hash";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `$PASEO_HOME/slp/seat-skills`, or null when the daemon environment has no `PASEO_HOME`. Every
 * daemon launch path sets it (`daemonLaunchEnvironment`, the dev scripts, the Docker entrypoint),
 * so null means a bare server run; the seats then go without skills rather than guess a home.
 */
export function seatSkillsRoot(env: Env = process.env, home: string = os.homedir()): string | null {
  if (!env.PASEO_HOME) return null;
  return path.join(resolvePaseoHome(env, home), "slp", "seat-skills");
}

/** Claude plugin name of a seat directory; its skills load as `slp-<seat>:<skill>`. */
export function seatPluginName(seat: Seat): string {
  return `slp-${seat}`;
}

function byPath(a: SkillFile, b: SkillFile): number {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

function contentHash(seat: Seat, files: readonly SkillFile[]): string {
  const sorted = [...files].sort(byPath);
  return createHash("sha256")
    .update(JSON.stringify({ name: seatPluginName(seat), files: sorted }))
    .digest("hex");
}

/** `<skill>/<file>` inside `skills/`; anything absolute or climbing out is refused. */
function checkedPath(file: SkillFile): string {
  const normalized = path.posix.normalize(file.path);
  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.posix.isAbsolute(normalized) ||
    !normalized.includes("/")
  ) {
    throw new Error(`refusing skill file path ${JSON.stringify(file.path)}`);
  }
  return normalized;
}

async function readHash(directory: string): Promise<string | null> {
  try {
    return await readFile(path.join(directory, HASH_FILE), "utf8");
  } catch {
    return null;
  }
}

/**
 * Builds the seat directory next to the old one and swaps it in, so the old skill set disappears
 * as a whole and an agent never sees half of the new one.
 */
async function writeSeatDirectory(
  root: string,
  seat: Seat,
  files: readonly SkillFile[],
  hash: string,
): Promise<void> {
  const directory = path.join(root, seat);
  const staging = await mkdtemp(path.join(root, `.${seat}-`));
  try {
    await mkdir(path.join(staging, ".claude-plugin"));
    await writeFile(
      path.join(staging, ".claude-plugin", "plugin.json"),
      `${JSON.stringify(
        {
          name: seatPluginName(seat),
          description: `SLP ${seat} seat skills, written by the slp plugin from slp-dev`,
        },
        null,
        2,
      )}\n`,
    );
    for (const file of files) {
      const target = path.join(staging, "skills", ...checkedPath(file).split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
      if (file.executable) await chmod(target, 0o755);
    }
    await writeFile(path.join(staging, HASH_FILE), hash);
    const retired = `${staging}-old`;
    const hadOld = await rename(directory, retired).then(
      () => true,
      () => false,
    );
    await rename(staging, directory);
    if (hadOld) await rm(retired, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export interface SeatSkills {
  /**
   * Brings `<root>/<seat>` in line with slp-dev's files for the seat and returns it, or null when
   * the seat has no skills, there is no root, or slp-dev did not answer (warned, never thrown).
   */
  ensure(seat: Seat, plugins: PluginInvoker): Promise<string | null>;
  /** `ensure` for every seat, then removes whatever else is in the root. */
  ensureAll(plugins: PluginInvoker): Promise<void>;
}

type Outcome = { kind: "directory"; directory: string } | { kind: "none" } | { kind: "failed" };

/**
 * Seat skill directories under `root`: `<root>/<seat>/` is a Claude local plugin named
 * `slp-<seat>` whose `skills/` holds exactly that seat's skills, byte for byte as slp-dev ships
 * them. Codex reads the same `skills/` as an extra skill root. Nothing is installed into the
 * user's own skill directories. Disk work runs one at a time, so concurrent agent creations never
 * swap the same directory twice.
 */
export function createSeatSkills(
  root: string | null,
  timeoutMs = SEAT_RULES_TIMEOUT_MS,
): SeatSkills {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };

  const ensureSeat = async (base: string, seat: Seat, plugins: PluginInvoker): Promise<Outcome> => {
    try {
      const { files } = await invokeSlpDev(
        plugins,
        SLP_DEV_SKILLS_GET,
        seat,
        SkillsGetOutput,
        timeoutMs,
      );
      for (const file of files) checkedPath(file);
      const directory = path.join(base, seat);
      return await serial(async () => {
        if (files.length === 0) {
          await rm(directory, { recursive: true, force: true });
          return { kind: "none" } as const;
        }
        const hash = contentHash(seat, files);
        if ((await readHash(directory)) !== hash) {
          await mkdir(base, { recursive: true });
          await writeSeatDirectory(base, seat, files, hash);
        }
        return { kind: "directory", directory } as const;
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`slp: ${seat} seat skills unavailable (${reason}); the seat gets none`);
      return { kind: "failed" };
    }
  };

  return {
    async ensure(seat, plugins) {
      if (!root) return null;
      const outcome = await ensureSeat(root, seat, plugins);
      return outcome.kind === "directory" ? outcome.directory : null;
    },
    async ensureAll(plugins) {
      if (!root) return;
      const outcomes = await Promise.all(SEATS.map((seat) => ensureSeat(root, seat, plugins)));
      // A seat slp-dev did not answer for keeps whatever directory it had.
      const keep = new Set(SEATS.filter((_, index) => outcomes[index]?.kind !== "none"));
      await serial(async () => {
        const entries = await readdir(root).catch(() => [] as string[]);
        for (const entry of entries) {
          if (!keep.has(entry as Seat)) {
            await rm(path.join(root, entry), { recursive: true, force: true });
          }
        }
      });
    },
  };
}
