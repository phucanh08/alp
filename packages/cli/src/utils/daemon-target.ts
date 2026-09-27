import { resolveAlpHome } from "@alp/server/daemon-control";
import { readAlpEnv } from "./legacy-env.js";

export type DaemonTarget = { kind: "instance"; home: string } | { kind: "endpoint"; host: string };

export function selectDaemonTarget(
  options: { home?: string; host?: string },
  env: NodeJS.ProcessEnv = process.env,
  localOnly = false,
): DaemonTarget {
  for (const key of ["home", "host"] as const) {
    if (options[key] !== undefined && !options[key]!.trim())
      throw { code: "TARGET_INVALID", message: `--${key} requires a non-empty value.` };
  }
  if (options.home !== undefined && options.host !== undefined)
    throw { code: "TARGET_AMBIGUOUS", message: "Choose either --home or --host, not both." };
  const envHome = readAlpEnv(env, "ALP_HOME");
  const envHost = readAlpEnv(env, "ALP_HOST");
  if (localOnly) {
    if (options.host !== undefined)
      throw {
        code: "LOCAL_OPERATION",
        message: "This is a local operation; use --home. --host is not supported.",
      };
    return {
      kind: "instance",
      home: resolveAlpHome({ ALP_HOME: options.home ?? envHome }),
    };
  }
  if (options.home !== undefined)
    return { kind: "instance", home: resolveAlpHome({ ALP_HOME: options.home }) };
  if (options.host !== undefined) return { kind: "endpoint", host: options.host };
  if (envHome && envHost)
    throw {
      code: "TARGET_AMBIGUOUS",
      message: "ALP_HOME and ALP_HOST are both set. Choose --home or --host explicitly.",
    };
  if (envHost) return { kind: "endpoint", host: envHost };
  return { kind: "instance", home: resolveAlpHome({ ALP_HOME: envHome }) };
}

export function describeDaemonTarget(target: DaemonTarget): string {
  if (target.kind === "instance") return `home ${target.home}`;
  try {
    const url = new URL(target.host);
    if (url.password) url.password = "REDACTED";
    for (const key of url.searchParams.keys())
      if (/password|token|secret/i.test(key)) url.searchParams.set(key, "REDACTED");
    if (url.hash) url.hash = "REDACTED";
    return url.toString();
  } catch {
    return target.host.replace(/([?&](?:password|token|secret)=)[^&]*/gi, "$1REDACTED");
  }
}
