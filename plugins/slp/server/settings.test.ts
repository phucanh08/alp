import { expect, test } from "vitest";
import { isEnabled, supervisorModel } from "./settings";

test("a ready state reads its own enabled value", () => {
  expect(
    isEnabled({
      status: "ready",
      revision: "r1",
      values: { enabled: true, supervisorModel: null },
    }),
  ).toBe(true);
  expect(
    isEnabled({
      status: "ready",
      revision: "r1",
      values: { enabled: false, supervisorModel: null },
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
      values: { enabled: true, supervisorModel: "claude-sonnet-5" },
    }),
  ).toBe("claude-sonnet-5");
  expect(
    supervisorModel({
      status: "ready",
      revision: "r1",
      values: { enabled: true, supervisorModel: null },
    }),
  ).toBeNull();
});

test("an invalid state counts as the default: no supervisorModel", () => {
  expect(supervisorModel({ status: "invalid", revision: "r1", error: "bad json" })).toBeNull();
});
