// alp-rename-keep-file: this suite feeds upstream names to the rename on purpose.
import assert from "node:assert/strict";
import test from "node:test";
import { renamePath, renameText } from "./rename-map.mjs";

function rename(text, filePath = "packages/server/src/example.ts") {
  return renameText(text, { path: filePath }).text;
}

test("renames the npm scope, including a bare scope segment", () => {
  assert.equal(
    rename('import { DaemonClient } from "@getpaseo/client";'),
    'import { DaemonClient } from "@alp/client";',
  );
  assert.equal(
    rename('path.join(root, "node_modules", "@getpaseo", "server")'),
    'path.join(root, "node_modules", "@alp", "server")',
  );
  assert.equal(rename("find: /^@getpaseo\\/relay$/,"), "find: /^@alp\\/relay$/,");
});

test("renames a bare getpaseo name outside upstream references", () => {
  assert.equal(rename('repoOwner: "getpaseo",'), 'repoOwner: "alp",');
  assert.equal(
    rename('expect(label("getpaseo/paseo")).toBe("paseo");'),
    'expect(label("alp/alp")).toBe("alp");',
  );
  assert.equal(rename('user.email "maestro@getpaseo.local"'), 'user.email "maestro@alp.local"');
});

test("renames env names, identifiers, and strings in every case form", () => {
  assert.equal(
    rename("process.env.PASEO_HOME ?? PASEO_LISTEN"),
    "process.env.ALP_HOME ?? ALP_LISTEN",
  );
  assert.equal(rename("const PASEO: Avatar = {};"), "const ALP: Avatar = {};");
  assert.equal(rename("resolvePaseoHome(paseoHome)"), "resolveAlpHome(alpHome)");
  assert.equal(
    rename('logger.warn("[paseo] Plugin failed")'),
    'logger.warn("[alp] Plugin failed")',
  );
  assert.equal(rename('type: "paseo_worktree_list_request"'), 'type: "alp_worktree_list_request"');
});

test("renames the MCP server prefix", () => {
  assert.equal(rename('"mcp__paseo__create_agent"'), '"mcp__alp__create_agent"');
});

test("maps sh.paseo bundle ids to the alp ids", () => {
  assert.equal(rename("env APP_ID=sh.paseo.debug"), "env APP_ID=com.anhlp.alp.debug");
  assert.equal(rename("package sh.paseo.scroll"), "package com.anhlp.alp.scroll");
  assert.equal(rename('"/cache/sh.paseo.desktop.ShipIt"'), '"/cache/com.anhlp.alp.desktop.ShipIt"');
  assert.equal(rename("appId: sh.paseo"), "appId: com.anhlp.alp");
});

test("renames on-disk names, url schemes, and local or example hosts", () => {
  assert.equal(
    rename('["paseo.json", ".paseo-managed-files.json", "paseo.pid", "paseo-plugin.json"]'),
    '["alp.json", ".alp-managed-files.json", "alp.pid", "alp-plugin.json"]',
  );
  assert.equal(rename('join(homedir(), ".paseo")'), 'join(homedir(), ".alp")');
  assert.equal(rename("open paseo://h/abc"), "open alp://h/abc");
  assert.equal(
    rename('proxyUrl: "http://web--feature--paseo.localhost:6767"'),
    'proxyUrl: "http://web--feature--alp.localhost:6767"',
  );
  assert.equal(
    rename('url: "https://gitea.example.com/acme/paseo/issues/27"'),
    'url: "https://gitea.example.com/acme/alp/issues/27"',
  );
  assert.equal(
    rename("publicBaseUrl: https://paseoapps.my.domain.com"),
    "publicBaseUrl: https://alpapps.my.domain.com",
  );
  assert.equal(
    rename('"application/x-paseo-workspace-file+json"'),
    '"application/x-alp-workspace-file+json"',
  );
});

test("renames links into the fork's own repository and domain", () => {
  assert.equal(
    rename("see https://github.com/phucanh08/alp/blob/main/plugins/slp/paseo-plugin.json"),
    "see https://github.com/phucanh08/alp/blob/main/plugins/slp/alp-plugin.json",
  );
  assert.equal(
    rename("https://alp.anhlp.com/docs/paseo-json"),
    "https://alp.anhlp.com/docs/alp-json",
  );
});

test("keeps upstream and third-party URLs, org references, and upstream domains", () => {
  const kept = [
    "[repo](https://github.com/getpaseo/paseo/issues/new)",
    'sshUrl: "git@github.com:therainisme/paseo.git",',
    "image: ghcr.io/getpaseo/paseo:latest",
    "npm i npmjs.com/package/@getpaseo/cli",
    "https://www.npmjs.com/package/@getpaseo/cli",
    "`relay.paseo.sh:443` and https://app.paseo.sh",
    "community at paseo.cafe",
    "https://github.com/getpaseo",
    "see github.com/getpaseo/paseo/pull/12",
    "https%3A%2F%2Fgithub.com%2Fgetpaseo%2Fpaseo%2Fissues",
  ];
  for (const line of kept) {
    const result = renameText(line, { path: "docs/example.md" });
    assert.equal(result.text, line);
    assert.ok(result.kept.length > 0, `expected a kept hit for ${line}`);
  }
});

test("keeps Hub-external names and the Electron browser partition", () => {
  const kept = [
    'partition: "persist:paseo-browser"',
    "prompt: ${{ paseo.prompt }}",
    "reads paseo.inputs.repo and paseo.context.",
    '"x-paseo-session-protocol": "2"',
    'const TRIGGERS = ".paseo/triggers/slack-help.yml";',
  ];
  for (const line of kept) {
    assert.equal(rename(line), line);
  }
});

test("keeps the bare .paseo bundle dir only inside Hub files", () => {
  const line = 'await requireSafeScaffoldDirectory(path.join(root, ".paseo"), ".paseo");';
  assert.equal(rename(line, "packages/cli/src/commands/hub/init.ts"), line);
  assert.equal(
    rename(
      'this.paseoHome = path.join(this.root, ".paseo");',
      "packages/server/src/server/hub/harness.ts",
    ),
    'this.alpHome = path.join(this.root, ".alp");',
  );
});

test("keeps LICENSE files whole", () => {
  const text = "Copyright 2025 Paseo\nPaseo contributors\n";
  const result = renameText(text, { path: "packages/highlight/src/astro/LICENSE" });
  assert.equal(result.text, text);
  assert.equal(result.kept.length, 2);
});

test("rewrites CHANGELOG entries from 1.0.0 up and keeps older ones", () => {
  const text = [
    "# Changelog",
    "",
    "## 1.0.1 - 2026-10-01",
    "- Fixed `paseo.json` loading",
    "## 1.0.0 - 2026-09-27",
    "- Uses `PASEO_HOME`",
    "## 0.9.2 - 2026-09-24",
    "- Paseo reads `paseo.json` ([#1](https://github.com/getpaseo/paseo/pull/1))",
    "## 0.1.0-beta.1",
    "- paseo",
    "",
  ].join("\n");
  const result = renameText(text, { path: "CHANGELOG.md" });
  const lines = result.text.split("\n");
  assert.equal(lines[3], "- Fixed `alp.json` loading");
  assert.equal(lines[5], "- Uses `ALP_HOME`");
  assert.equal(
    lines[7],
    "- Paseo reads `paseo.json` ([#1](https://github.com/getpaseo/paseo/pull/1))",
  );
  assert.equal(lines[9], "- paseo");
});

test("keeps the Upstream column of docs/breaking-changes.md", () => {
  const text = [
    "| Since | Area | Upstream | alp | Effect |",
    "| ----- | ---- | -------- | --- | ------ |",
    "| 2026-09-25 | home dir | `~/.paseo` | `~/.alp` (`PASEO_HOME` still overrides) | Paseo state |",
    "",
    "| Area | Value kept | Why |",
    "| ---- | ---------- | --- |",
    "| config | `paseo.json` | later |",
  ].join("\n");
  const result = renameText(text, { path: "docs/breaking-changes.md" });
  const lines = result.text.split("\n");
  assert.equal(
    lines[2],
    "| 2026-09-25 | home dir | `~/.paseo` | `~/.alp` (`ALP_HOME` still overrides) | Alp state |",
  );
  assert.equal(lines[6], "| config | `alp.json` | later |");
});

test("keep markers protect a line, a region, or a whole file", () => {
  const text = [
    '["paseo-help", "alp-help"], // alp-rename-keep',
    "// alp-rename-keep-start",
    'const LEGACY_HOME = ".paseo";',
    "// alp-rename-keep-end",
    'const HOME = ".paseo";',
  ].join("\n");
  const lines = rename(text).split("\n");
  assert.equal(lines[0], '["paseo-help", "alp-help"], // alp-rename-keep');
  assert.equal(lines[2], 'const LEGACY_HOME = ".paseo";');
  assert.equal(lines[4], 'const HOME = ".alp";');

  const whole = "// alp-rename-keep-file\nconst a = 'paseo';\n";
  assert.equal(rename(whole), whole);
});

test("reports each rewrite with line, from and to, and each kept hit with its rule", () => {
  const result = renameText(
    'const a = "@getpaseo/server";\nconst b = "https://github.com/getpaseo/paseo";\n',
    { path: "x.ts" },
  );
  assert.deepEqual(result.rewrites, [{ line: 1, from: "@getpaseo/server", to: "@alp/server" }]);
  assert.deepEqual(
    result.kept.map((hit) => ({ line: hit.line, rule: hit.rule, text: hit.text })),
    [{ line: 2, rule: "upstream-url", text: "https://github.com/getpaseo/paseo" }],
  );
});

test("is idempotent", () => {
  const text = [
    'import { x } from "@getpaseo/server"; // Paseo home at ~/.paseo, PASEO_HOME',
    "open https://github.com/getpaseo/paseo and paseo://h/1 with sh.paseo.debug",
    "${{ paseo.prompt }} x-paseo-daemon-id persist:paseo-browser mcp__paseo__list",
  ].join("\n");
  const once = rename(text);
  const twice = renameText(once, { path: "packages/server/src/example.ts" });
  assert.equal(twice.text, once);
  assert.deepEqual(twice.rewrites, []);
});

test("maps paths segment by segment", () => {
  const cases = [
    ["packages/server/src/server/paseo-home.ts", "packages/server/src/server/alp-home.ts"],
    ["plugins/slp/paseo-plugin.json", "plugins/slp/alp-plugin.json"],
    ["paseo.json", "alp.json"],
    [".paseo-managed-files.json", ".alp-managed-files.json"],
    [
      "docker/base/rootfs/usr/local/bin/paseo-docker-entrypoint",
      "docker/base/rootfs/usr/local/bin/alp-docker-entrypoint",
    ],
    [
      "packages/app/modules/paseo-scroll/android/src/main/java/sh/paseo/scroll/PaseoScrollPackage.kt",
      "packages/app/modules/alp-scroll/android/src/main/java/com/anhlp/alp/scroll/AlpScrollPackage.kt",
    ],
    ["packages/app/src/composer/index.ts", "packages/app/src/composer/index.ts"],
    ["LICENSE", "LICENSE"],
    [".paseo/triggers/slack-help.yml", ".paseo/triggers/slack-help.yml"],
  ];
  for (const [from, to] of cases) {
    assert.equal(renamePath(from), to);
    assert.equal(renamePath(renamePath(from)), to);
  }
});

test("import specifiers follow the path map", () => {
  const from = 'import { resolvePaseoHome } from "./paseo-home.js";';
  const renamedTarget = renamePath("packages/server/src/server/paseo-home.ts");
  assert.equal(rename(from), 'import { resolveAlpHome } from "./alp-home.js";');
  assert.ok(renamedTarget.endsWith("/alp-home.ts"));
});
