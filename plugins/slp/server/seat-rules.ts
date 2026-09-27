import type { PluginHookContext } from "@alp/plugin/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type Seat, stripFrontmatter } from "./seat";

/**
 * slp-dev's `slp-dev.seat.get` (`plugins/slp-dev/shared/rpc.ts`), addressed by name: the plugin
 * compiler bundles each plugin on its own, so slp cannot import slp-dev's module.
 * `seat-rules.test.ts` checks these against slp-dev.
 */
export const SLP_DEV_PLUGIN_ID = "slp-dev";
export const SLP_DEV_SEAT_GET = "slp-dev.seat.get";

const SeatGetOutput = z.object({ definition: z.string(), skills: z.array(z.string()) });

/** Longest agent creation waits on slp-dev before the seat goes on with the runtime block only. */
export const SEAT_RULES_TIMEOUT_MS = 5_000;

export type PluginInvoker = Pick<PluginHookContext["alp"]["plugins"], "invoke">;

export interface SeatRules {
  /** Where the rule text came from: the override file's absolute path, `slp-dev`, or null for none. */
  source: string | null;
  /** Rule text without frontmatter; null when neither an override nor slp-dev supplied one. */
  body: string | null;
  /** Skills slp-dev lists for the seat; empty when slp-dev did not answer. */
  skills: string[];
}

/** Calls one slp-dev RPC for a seat and validates the answer; rejects past `timeoutMs`. */
export async function invokeSlpDev<Output extends z.ZodType>(
  plugins: PluginInvoker,
  method: string,
  seat: Seat,
  output: Output,
  timeoutMs: number,
): Promise<z.infer<Output>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const answer = await Promise.race([
      plugins.invoke(SLP_DEV_PLUGIN_ID, method, { seat }),
      timeout,
    ]);
    const parsed = output.safeParse(answer);
    if (!parsed.success) throw new Error(`invalid answer: ${parsed.error.message}`);
    return parsed.data;
  } finally {
    clearTimeout(timer);
  }
}

async function readOverride(cwd: string, seat: Seat): Promise<SeatRules | null> {
  const override = path.join(cwd, ".slp", "agents", `${seat}.md`);
  try {
    const text = await readFile(override, "utf8");
    return { source: override, body: stripFrontmatter(text).trim(), skills: [] };
  } catch {
    return null;
  }
}

/**
 * A seat's rule text and skills. The text is `.slp/agents/<seat>.md` in the agent cwd when the
 * repository has one, slp-dev's otherwise; the skills always come from slp-dev. slp-dev absent,
 * failing, or slower than `timeoutMs` leaves the text to the override alone and the skills empty,
 * with a warning: agent creation never waits on slp-dev longer than that. `.claude/agents/` is
 * Claude Code's own subagent directory and is never read.
 */
export async function readSeatRules(
  cwd: string,
  seat: Seat,
  plugins: PluginInvoker,
  timeoutMs = SEAT_RULES_TIMEOUT_MS,
): Promise<SeatRules> {
  const [answer, override] = await Promise.all([
    invokeSlpDev(plugins, SLP_DEV_SEAT_GET, seat, SeatGetOutput, timeoutMs).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    readOverride(cwd, seat),
  ]);
  if (!answer.ok) {
    const reason = answer.error instanceof Error ? answer.error.message : String(answer.error);
    console.warn(
      `slp: ${seat} seat rules from slp-dev unavailable (${reason}); ` +
        (override ? `using ${override.source}, no skills` : "runtime block only"),
    );
    return override ?? { source: null, body: null, skills: [] };
  }
  const skills = [...answer.value.skills];
  if (override) return { ...override, skills };
  return {
    source: SLP_DEV_PLUGIN_ID,
    body: stripFrontmatter(answer.value.definition).trim(),
    skills,
  };
}
