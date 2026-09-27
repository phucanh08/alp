import { expect, test } from "vitest";
import { slpSettings } from "../shared/settings";
import { isEnabled, supervisorCheckMinutes, supervisorModel } from "./settings";

test("a ready state reads its own enabled value", () => {
  expect(
    isEnabled({
      status: "ready",
      revision: "r1",
      values: { enabled: true, supervisorModel: null, supervisorCheckMinutes: 10 },
    }),
  ).toBe(true);
  expect(
    isEnabled({
      status: "ready",
      revision: "r1",
      values: { enabled: false, supervisorModel: null, supervisorCheckMinutes: 10 },
    }),
  ).toBe(false);
});

test("an invalid state counts as the default: enabled", () => {
  expect(isEnabled({ status: "invalid", revision: "r1", error: "bad json" })).toBe(true);
});

test("a ready state reads its own supervisorModel value", () => {
  expect(
    supervisorModel({
      status: "ready",
      revision: "r1",
      values: { enabled: true, supervisorModel: "claude-sonnet-5", supervisorCheckMinutes: 10 },
    }),
  ).toBe("claude-sonnet-5");
  expect(
    supervisorModel({
      status: "ready",
      revision: "r1",
      values: { enabled: true, supervisorModel: null, supervisorCheckMinutes: 10 },
    }),
  ).toBeNull();
});

test("an invalid state counts as the default: no supervisorModel", () => {
  expect(supervisorModel({ status: "invalid", revision: "r1", error: "bad json" })).toBeNull();
});

test("settings saved before supervisorCheckMinutes existed read it as the default, 10", () => {
  expect(slpSettings.version).toBe(1);
  expect(slpSettings.schema.parse({ enabled: true, supervisorModel: null })).toEqual({
    enabled: true,
    supervisorModel: null,
    supervisorCheckMinutes: 10,
  });
  expect(slpSettings.schema.parse({})).toEqual({
    enabled: true,
    supervisorModel: null,
    supervisorCheckMinutes: 10,
  });
});

test("supervisorCheckMinutes is a whole number of minutes, 0 or more", () => {
  expect(slpSettings.schema.parse({ supervisorCheckMinutes: 0 }).supervisorCheckMinutes).toBe(0);
  expect(slpSettings.schema.parse({ supervisorCheckMinutes: 25 }).supervisorCheckMinutes).toBe(25);
  expect(slpSettings.schema.safeParse({ supervisorCheckMinutes: -1 }).success).toBe(false);
  expect(slpSettings.schema.safeParse({ supervisorCheckMinutes: 2.5 }).success).toBe(false);
  expect(slpSettings.schema.safeParse({ supervisorCheckMinutes: "10" }).success).toBe(false);
});

test("the check interval an enabled host runs on is its supervisorCheckMinutes", () => {
  expect(
    supervisorCheckMinutes({
      status: "ready",
      revision: "r1",
      values: { enabled: true, supervisorModel: null, supervisorCheckMinutes: 7 },
    }),
  ).toBe(7);
  expect(
    supervisorCheckMinutes({
      status: "ready",
      revision: "r1",
      values: { enabled: true, supervisorModel: null, supervisorCheckMinutes: 0 },
    }),
  ).toBe(0);
});

test("SLP off turns the check off whatever supervisorCheckMinutes says", () => {
  expect(
    supervisorCheckMinutes({
      status: "ready",
      revision: "r1",
      values: { enabled: false, supervisorModel: null, supervisorCheckMinutes: 7 },
    }),
  ).toBe(0);
});

test("an invalid state counts as the default: every 10 minutes", () => {
  expect(supervisorCheckMinutes({ status: "invalid", revision: "r1", error: "bad json" })).toBe(10);
});
