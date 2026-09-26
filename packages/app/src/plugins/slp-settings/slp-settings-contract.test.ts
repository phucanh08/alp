import { describe, expect, it } from "vitest";
// Only the test reaches into the plugin: Metro does not resolve files outside the app workspace,
// so the app ships a mirror and this suite keeps the mirror identical to the plugin's source.
import * as plugin from "../../../../../plugins/slp/client/supervisor-gate";
import { slpSettings as pluginSettings } from "../../../../../plugins/slp/shared/settings";
import {
  isSlpEnabled,
  slpSettings,
  slpSettingsRpc,
  type SlpSettingsRead,
} from "./slp-settings-contract";

const STORED_VALUES: unknown[] = [
  {},
  { enabled: false },
  { enabled: true, supervisorModel: "claude-opus-4-1" },
  { enabled: false, supervisorModel: null },
  { supervisorModel: "claude-sonnet-4-5" },
  { enabled: "false" },
  { enabled: 0 },
  { supervisorModel: 42 },
  null,
  "enabled",
  { enabled: false, extra: "kept out by the schema" },
];

const READS: Array<{ read: SlpSettingsRead; enabled: boolean }> = [
  { read: { status: "ready", revision: "r1", values: { enabled: false } }, enabled: false },
  { read: { status: "ready", revision: "r1", values: { enabled: true } }, enabled: true },
  { read: { status: "ready", revision: "r1", values: {} }, enabled: true },
  { read: { status: "ready", revision: "r1", values: { enabled: "false" } }, enabled: true },
  { read: { status: "ready", revision: "r1", values: null }, enabled: true },
  { read: { status: "invalid", revision: "r1", error: "Unexpected token" }, enabled: true },
];

describe("app mirror of the slp settings contract", () => {
  it("names the same host-scoped settings definition as the plugin", () => {
    expect({ id: slpSettings.id, scope: slpSettings.scope, version: slpSettings.version }).toEqual({
      id: "slp",
      scope: "host",
      version: 1,
    });
    expect(slpSettings.id).toBe(pluginSettings.id);
    expect(slpSettings.scope).toBe(pluginSettings.scope);
    expect(slpSettings.version).toBe(pluginSettings.version);
  });

  it("has the plugin's defaults", () => {
    expect(slpSettings.schema.parse({})).toEqual({ enabled: true, supervisorModel: null });
    expect(slpSettings.schema.parse({})).toEqual(pluginSettings.schema.parse({}));
  });

  it("accepts and rejects the same stored values as the plugin's schema", () => {
    for (const values of STORED_VALUES) {
      const mirror = slpSettings.schema.safeParse(values);
      const source = pluginSettings.schema.safeParse(values);
      expect({ values, success: mirror.success, data: mirror.data }).toEqual({
        values,
        success: source.success,
        data: source.data,
      });
    }
  });

  it("calls the plugin's settings RPC methods", () => {
    expect([
      slpSettingsRpc.read.name,
      slpSettingsRpc.write.name,
      slpSettingsRpc.reset.name,
    ]).toEqual(["settings.slp.read", "settings.slp.write", "settings.slp.reset"]);
    expect(slpSettingsRpc.read.name).toBe(plugin.slpSettingsRpc.read.name);
    expect(slpSettingsRpc.write.name).toBe(plugin.slpSettingsRpc.write.name);
  });

  it("rules on enabled the same way as the plugin's client gate", () => {
    for (const { read, enabled } of READS) {
      expect({ read, enabled: isSlpEnabled(read) }).toEqual({ read, enabled });
      expect({ read, enabled: plugin.isSlpEnabled(read) }).toEqual({ read, enabled });
    }
  });
});
