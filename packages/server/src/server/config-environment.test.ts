// alp-rename-keep-file: these cases set the PASEO_* names alp 1.0.0 read.
import { describe, expect, test } from "vitest";

import { configurationEnvironment, daemonLaunchEnvironment } from "./config-environment.js";
import { setLegacyNameReporter, type LegacyNameUse } from "./rename-migration/legacy-names.js";

describe("configurationEnvironment", () => {
  test("reads a daemon setting from its PASEO_* name when the ALP_* name is unset", () => {
    const uses: LegacyNameUse[] = [];
    setLegacyNameReporter((use) => uses.push(use));

    const env = configurationEnvironment({
      PASEO_LISTEN: "127.0.0.1:7001",
      PASEO_RELAY_ENABLED: "false",
      ALP_LOG_LEVEL: "debug",
      PASEO_LOG_LEVEL: "error",
    });

    expect(env.ALP_LISTEN).toBe("127.0.0.1:7001");
    expect(env.ALP_RELAY_ENABLED).toBe("false");
    expect(env.ALP_LOG_LEVEL).toBe("debug");
    expect(uses.map((use) => use.legacy).sort()).toEqual(["PASEO_LISTEN", "PASEO_RELAY_ENABLED"]);
  });
});

describe("daemonLaunchEnvironment", () => {
  test("a managed launch strips the PASEO_* daemon settings along with the ALP_* ones", () => {
    const env = daemonLaunchEnvironment({
      env: {
        PASEO_LISTEN: "127.0.0.1:7001",
        ALP_LISTEN: "127.0.0.1:7002",
        PASEO_HOST: "remote:6767",
        PASEO_DESKTOP_MANAGED: "1",
        PASEO_HOME: "/old/home",
        KEEP_ME: "yes",
      },
      home: "/new/home",
      mode: "managed",
    });

    expect(env.PASEO_LISTEN).toBeUndefined();
    expect(env.ALP_LISTEN).toBeUndefined();
    expect(env.PASEO_HOST).toBeUndefined();
    expect(env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(env.ALP_HOME).toBe("/new/home");
    expect(env.KEEP_ME).toBe("yes");
  });

  test("a deployment launch keeps the PASEO_* daemon settings it was given", () => {
    const env = daemonLaunchEnvironment({
      env: { PASEO_LISTEN: "127.0.0.1:7001" },
      home: "/new/home",
      mode: "deployment",
    });

    expect(env.PASEO_LISTEN).toBe("127.0.0.1:7001");
  });
});
