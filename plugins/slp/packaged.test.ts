import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { compilePlugin } from "@server/server/plugins/compiler";
import { afterEach, expect, test } from "vitest";

/**
 * The packaged desktop app ships this directory with no `@getpaseo/*` declaration files reachable
 * from it, so any type import outside the plugin SDK fails the compiler's type-dependency check
 * there while still compiling inside the repo. Compiling a copy outside the repo reproduces the
 * packaged resolution.
 */
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compiles from a copy with no @getpaseo packages reachable, as the packaged app loads it", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "slp-packaged-"));
  temporaryDirectories.push(directory);
  cpSync(import.meta.dirname, directory, {
    recursive: true,
    filter: (source) => path.basename(source) !== "node_modules",
  });
  expect(() =>
    createRequire(path.join(directory, "index.server.ts")).resolve("@getpaseo/client"),
  ).toThrow();

  const result = await compilePlugin({
    client: path.join(directory, "index.client.tsx"),
    server: path.join(directory, "index.server.ts"),
  });

  expect(result.clientBundle).toEqual(expect.any(String));
  expect(result.serverBundle).toEqual(expect.any(String));
});
