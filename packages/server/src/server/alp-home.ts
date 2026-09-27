import os from "node:os";
import path from "node:path";
import { readAlpEnv } from "./rename-migration/legacy-names.js";

function expandHomeDir(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  if (input === "~") {
    return os.homedir();
  }
  return input;
}

export function resolveAlpHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = readAlpEnv(env, "ALP_HOME") ?? "~/.alp";
  const resolved = path.resolve(expandHomeDir(raw));
  return resolved;
}
