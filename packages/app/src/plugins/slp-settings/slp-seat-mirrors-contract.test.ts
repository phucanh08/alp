import { describe, expect, it } from "vitest";
// Only the test reaches into the plugin: Metro does not resolve files outside the app workspace,
// so the app ships mirrors and this suite keeps each one identical to the plugin's source. See
// slp-settings-contract.test.ts for the settings-schema mirror this pattern first proved out.
import { DEFAULT_SEAT_FAMILY } from "../../../../../plugins/slp/server/ensure";
import { familyOf, SEAT_LABEL, seatOfLabels } from "../../../../../plugins/slp/server/seat";
import { LEAD_LABELS, SLP_SEAT_PROVIDERS } from "@/composer/draft/slp-seat";
import { SUPERVISOR_PROVIDER } from "@/screens/settings/slp-settings-card";

const SAMPLE_PROVIDERS = ["claude", "codex", "mock", "opencode", "copilot", "pi"];

describe("app mirror of the slp seat labels", () => {
  it("runs SLP seats on the same providers the plugin's familyOf names", () => {
    for (const provider of SAMPLE_PROVIDERS) {
      expect({ provider, isSeatProvider: SLP_SEAT_PROVIDERS.has(provider) }).toEqual({
        provider,
        isSeatProvider: familyOf(provider) !== null,
      });
    }
  });

  it("sends a label the plugin reads back as the Lead seat", () => {
    expect(seatOfLabels(LEAD_LABELS)).toBe("lead");
  });

  it("sends the label under the plugin's own seat label key", () => {
    expect(Object.keys(LEAD_LABELS)).toEqual([SEAT_LABEL]);
  });

  it("shows the Supervisor's model options for the family the plugin seats it on", () => {
    expect(SUPERVISOR_PROVIDER).toBe(DEFAULT_SEAT_FAMILY);
  });
});
