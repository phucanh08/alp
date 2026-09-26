import { afterEach, describe, expect, it } from "vitest";
import type { SlpSettings } from "@/plugins/slp-settings/use-slp-settings";
import {
  resolveDraftSeatLabels,
  resolveDraftSeatPill,
  selectDraftSeat,
  useDraftSeatStore,
} from "./slp-seat";

const unavailable: SlpSettings = { status: "unavailable" };
const loading: SlpSettings = { status: "loading" };
const readFailed: SlpSettings = { status: "error", error: "read failed", enabled: true };

function ready(enabled: boolean): SlpSettings {
  return {
    status: "ready",
    enabled,
    supervisorModel: null,
    saving: false,
    saveError: null,
    save: async () => true,
  };
}

function seatOf(draftId: string) {
  return selectDraftSeat(useDraftSeatStore.getState(), draftId);
}

afterEach(() => {
  useDraftSeatStore.setState({ seatByDraftId: {} });
});

describe("draft seat labels", () => {
  it("sends no label when the host has no slp plugin", () => {
    expect(resolveDraftSeatLabels(unavailable, "lead")).toBeNull();
  });

  it("sends no label when SLP is switched off on the host", () => {
    expect(resolveDraftSeatLabels(ready(false), "lead")).toBeNull();
  });

  it("asks for a Lead when SLP is on and the draft is on Lead", () => {
    expect(resolveDraftSeatLabels(ready(true), "lead")).toEqual({ "slp.role": "lead" });
  });

  it("sends no label for plain chat so the plugin decides", () => {
    expect(resolveDraftSeatLabels(ready(true), "chat")).toBeNull();
  });

  it("asks for a Lead when the settings read failed, which counts as enabled", () => {
    expect(resolveDraftSeatLabels(readFailed, "lead")).toEqual({ "slp.role": "lead" });
    expect(resolveDraftSeatLabels(readFailed, "chat")).toBeNull();
  });

  it("asks for a Lead while settings load and leaves the ruling to the plugin", () => {
    expect(resolveDraftSeatLabels(loading, "lead")).toEqual({ "slp.role": "lead" });
  });
});

describe("draft seat pill", () => {
  it("is hidden when the host has no slp plugin", () => {
    expect(resolveDraftSeatPill(unavailable, "lead")).toEqual({ status: "hidden" });
  });

  it("is hidden when SLP is switched off on the host", () => {
    expect(resolveDraftSeatPill(ready(false), "chat")).toEqual({ status: "hidden" });
  });

  it("shows the draft's seat when SLP is on", () => {
    expect(resolveDraftSeatPill(ready(true), "lead")).toEqual({
      status: "shown",
      seat: "lead",
      disabled: false,
    });
    expect(resolveDraftSeatPill(ready(true), "chat")).toEqual({
      status: "shown",
      seat: "chat",
      disabled: false,
    });
  });

  it("shows the draft's seat when the settings read failed", () => {
    expect(resolveDraftSeatPill(readFailed, "lead")).toEqual({
      status: "shown",
      seat: "lead",
      disabled: false,
    });
  });

  it("shows the seat it will send, disabled, while settings load", () => {
    expect(resolveDraftSeatPill(loading, "lead")).toEqual({
      status: "shown",
      seat: "lead",
      disabled: true,
    });
  });
});

describe("draft seat choice", () => {
  it("starts a new draft on Lead", () => {
    expect(seatOf("draft-new")).toBe("lead");
  });

  it("belongs to one draft only", () => {
    useDraftSeatStore.getState().setSeat({ draftId: "draft-a", seat: "chat" });

    expect(seatOf("draft-a")).toBe("chat");
    expect(seatOf("draft-b")).toBe("lead");
  });

  it("gives a retry of the same draft the labels of its first attempt", () => {
    useDraftSeatStore.getState().setSeat({ draftId: "draft-a", seat: "chat" });
    const firstAttempt = resolveDraftSeatLabels(ready(true), seatOf("draft-a"));
    const retry = resolveDraftSeatLabels(ready(true), seatOf("draft-a"));

    expect(firstAttempt).toBeNull();
    expect(retry).toBeNull();

    const leadFirst = resolveDraftSeatLabels(ready(true), seatOf("draft-b"));
    const leadRetry = resolveDraftSeatLabels(ready(true), seatOf("draft-b"));
    expect(leadFirst).toEqual({ "slp.role": "lead" });
    expect(leadRetry).toEqual({ "slp.role": "lead" });
  });

  it("is dropped once the draft's agent exists", () => {
    useDraftSeatStore.getState().setSeat({ draftId: "draft-a", seat: "chat" });
    useDraftSeatStore.getState().clear({ draftId: "draft-a" });

    expect(useDraftSeatStore.getState().seatByDraftId).toEqual({});
  });
});
