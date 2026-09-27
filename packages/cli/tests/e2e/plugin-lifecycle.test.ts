#!/usr/bin/env npx tsx
import { resolveCliVersion } from "../../src/version.js";
import { readPluginManifest } from "../../../server/src/server/plugins/manifest.js";

import {
  startNpmRegistry,
  npmPluginPackages,
} from "../../../../scripts/test-support/npm-registry.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { connectToDaemon } from "../../src/utils/client.ts";
import { createE2ETestContext } from "../helpers/test-daemon.ts";

const pluginSource = `export default function contribute(plugin: unknown) {
  void plugin;
  return () => undefined;
}`;

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "alp-plugin-cli-e2e-"));
  const gitDirectory = await mkdtemp(path.join(tmpdir(), "alp-plugin-git-cli-e2e-"));
  const registry = await startNpmRegistry(npmPluginPackages());
  const context = await createE2ETestContext({ timeout: 45_000, env: registry.env });
  try {
    const scaffold = path.join(context.workDir, "authored-plugin");
    const init = await context.alp(["plugin", "init", scaffold, "--json"]);
    assert.equal(init.exitCode, 0, init.stderr);
    const manifestPath = path.join(scaffold, "alp-plugin.json");
    const manifest = await readPluginManifest(scaffold);
    assert.deepEqual(manifest.requirements, { alp: `>=${resolveCliVersion()}` });
    await writeFile(
      path.join(directory, "alp-plugin.json"),
      JSON.stringify({ id: "cli-e2e", requirements: { alp: `>=${resolveCliVersion()}` } }),
    );
    await writeFile(path.join(directory, "index.server.ts"), pluginSource);

    const install = await context.alp(["plugin", "install", directory, "--json"]);
    assert.equal(install.exitCode, 0, install.stderr);
    assert.equal(JSON.parse(install.stdout).id, "cli-e2e");

    const client = await connectToDaemon({
      target: { kind: "endpoint", host: `127.0.0.1:${context.port}` },
    });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.close();

    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, requirements: { alp: ">=999.0.0" } }),
    );
    const incompatibleInstall = await context.alp(["plugin", "install", scaffold, "--json"]);
    assert.equal(incompatibleInstall.exitCode, 1);
    assert.match(incompatibleInstall.stderr, /requires Alp >=999.0.0/);
    const afterRejection = await context.alp(["plugin", "ls", "--json"]);
    assert.equal(afterRejection.exitCode, 0, afterRejection.stderr);
    assert.deepEqual(
      JSON.parse(afterRejection.stdout).map((plugin: { id: string }) => plugin.id),
      ["cli-e2e"],
    );
    await writeFile(manifestPath, JSON.stringify(manifest));
    const scaffoldInstall = await context.alp(["plugin", "install", scaffold, "--json"]);
    assert.equal(scaffoldInstall.exitCode, 0, scaffoldInstall.stderr);
    assert.equal(JSON.parse(scaffoldInstall.stdout).status, "running");

    await git(gitDirectory, ["init", "-b", "main"]);
    await git(gitDirectory, ["config", "user.name", "Alp Tests"]);
    await git(gitDirectory, ["config", "user.email", "alp@example.test"]);
    await writeFile(
      path.join(gitDirectory, "alp-plugin.json"),
      JSON.stringify({ id: "git-cli-e2e", requirements: { alp: `>=${resolveCliVersion()}` } }),
    );
    await writeFile(path.join(gitDirectory, "index.server.ts"), pluginSource);
    await git(gitDirectory, ["add", "-A"]);
    await git(gitDirectory, ["commit", "-m", "initial"]);

    const gitInstall = await context.alp([
      "plugin",
      "add",
      `git:${pathToFileURL(gitDirectory).href}`,
      "--json",
    ]);
    assert.equal(gitInstall.exitCode, 0, gitInstall.stderr);
    assert.equal(JSON.parse(gitInstall.stdout).source, "git");

    await writeFile(
      path.join(gitDirectory, "index.server.ts"),
      `${pluginSource}\nconst updated = true;\n`,
    );
    await git(gitDirectory, ["add", "-A"]);
    await git(gitDirectory, ["commit", "-m", "update"]);
    const status = await context.alp(["plugin", "status", "git-cli-e2e", "--json"]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout)[0].status, "running");
    assert.equal(JSON.parse(status.stdout)[0].commit, JSON.parse(gitInstall.stdout).commit);

    const update = await context.alp(["plugin", "update", "git-cli-e2e", "--yes", "--json"]);
    assert.equal(update.exitCode, 0, update.stderr);
    assert.equal(JSON.parse(update.stdout)[0].outcome, "updated");

    const installedCommit = JSON.parse(update.stdout)[0].plugin.installation.currentRevision;
    const buildMarker = path.join(context.workDir, "incompatible-build-ran");
    await writeFile(
      path.join(gitDirectory, "alp-plugin.json"),
      JSON.stringify({
        id: "git-cli-e2e",
        requirements: { alp: ">=999.0.0" },
        build: [
          [
            process.execPath,
            "-e",
            'require("node:fs").writeFileSync(process.argv[1], "ran")',
            buildMarker,
          ],
        ],
      }),
    );
    await git(gitDirectory, ["add", "-A"]);
    await git(gitDirectory, ["commit", "-m", "requires a future Alp"]);
    const incompatibleUpdate = await context.alp([
      "plugin",
      "update",
      "git-cli-e2e",
      "--yes",
      "--json",
    ]);
    assert.equal(incompatibleUpdate.exitCode, 1);
    assert.match(JSON.parse(incompatibleUpdate.stdout)[0].error, /requires Alp >=999.0.0/);
    await assert.rejects(readFile(buildMarker), { code: "ENOENT" });
    const retained = await context.alp(["plugin", "ls", "git-cli-e2e", "--json"]);
    assert.equal(retained.exitCode, 0, retained.stderr);
    assert.equal(JSON.parse(retained.stdout)[0].commit, installedCommit);
    assert.equal(JSON.parse(retained.stdout)[0].status, "running");
    const incompatibleAdd = await context.alp([
      "plugin",
      "add",
      pathToFileURL(gitDirectory).href,
      "--id",
      "future-plugin",
      "--json",
    ]);
    assert.equal(incompatibleAdd.exitCode, 1);
    assert.match(incompatibleAdd.stderr, /requires Alp >=999.0.0/);
    await assert.rejects(readFile(buildMarker), { code: "ENOENT" });

    const reload = await context.alp(["plugin", "reload", "cli-e2e", "--json"]);
    assert.equal(reload.exitCode, 0, reload.stderr);
    assert.equal(JSON.parse(reload.stdout).status, "running");

    const disable = await context.alp(["plugin", "disable", "cli-e2e", "--json"]);
    assert.equal(disable.exitCode, 0, disable.stderr);
    assert.equal(JSON.parse(disable.stdout).status, "disabled");

    const enable = await context.alp(["plugin", "enable", "cli-e2e", "--json"]);
    assert.equal(enable.exitCode, 0, enable.stderr);
    assert.equal(JSON.parse(enable.stdout).status, "running");

    const remove = await context.alp(["plugin", "remove", "cli-e2e", "--json"]);
    assert.equal(remove.exitCode, 0, remove.stderr);
    const removeGit = await context.alp(["plugin", "remove", "git-cli-e2e", "--json"]);
    assert.equal(removeGit.exitCode, 0, removeGit.stderr);
    const removeScaffold = await context.alp(["plugin", "remove", "authored-plugin", "--json"]);
    assert.equal(removeScaffold.exitCode, 0, removeScaffold.stderr);
    for (const source of ["npm:alp-fixture-plugin@^1.0.0", "npm:@alp-fixture/review@2.0.0"]) {
      const npmInstall = await context.alp(["plugin", "install", source, "--path", ".", "--json"]);
      assert.equal(npmInstall.exitCode, 0, npmInstall.stderr);
      assert.equal(JSON.parse(npmInstall.stdout).id, "npm-review");
      assert.equal(JSON.parse(npmInstall.stdout).status, "running");
      assert.equal(
        JSON.parse(npmInstall.stdout).installation.currentRevision,
        source.includes("@alp-fixture") ? "2.0.0" : "1.1.0",
      );
      const npmDisabled = await context.alp(["plugin", "disable", "npm-review", "--json"]);
      assert.equal(npmDisabled.exitCode, 0, npmDisabled.stderr);
      const restart = await context.alp(["daemon", "restart", "--timeout", "45", "--json"], {
        timeout: 60_000,
      });
      assert.equal(restart.exitCode, 0, restart.stderr);
      assert.notEqual(
        JSON.parse(restart.stdout).workerPid,
        JSON.parse(restart.stdout).previousWorkerPid,
      );
      const persisted = await context.alp(["plugin", "ls", "npm-review", "--json"]);
      assert.equal(persisted.exitCode, 0, persisted.stderr);
      assert.equal(JSON.parse(persisted.stdout)[0].status, "disabled");
      assert.equal(JSON.parse(persisted.stdout)[0].path, JSON.parse(npmInstall.stdout).path);
      assert.deepEqual(
        JSON.parse(persisted.stdout)[0].installation,
        JSON.parse(npmInstall.stdout).installation,
      );
      const npmEnabled = await context.alp(["plugin", "enable", "npm-review", "--json"]);
      assert.equal(npmEnabled.exitCode, 0, npmEnabled.stderr);
      assert.equal(JSON.parse(npmEnabled.stdout).status, "running");
      const npmReload = await context.alp(["plugin", "reload", "npm-review", "--json"]);
      assert.equal(npmReload.exitCode, 0, npmReload.stderr);
      const npmRemove = await context.alp(["plugin", "remove", "npm-review", "--json"]);
      assert.equal(npmRemove.exitCode, 0, npmRemove.stderr);
    }
    const list = await context.alp(["plugin", "ls", "--json"]);
    assert.equal(list.exitCode, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), []);
  } finally {
    await context.stop();
    await registry.close();
    await rm(directory, { recursive: true, force: true });
    await rm(gitDirectory, { recursive: true, force: true });
  }
}

await main();
