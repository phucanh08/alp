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
    expect(resolveDraftSeatLabels(unavailable, "lead", "claude")).toBeNull();
  });

  it("sends no label when SLP is switched off on the host", () => {
    expect(resolveDraftSeatLabels(ready(false), "lead", "claude")).toBeNull();
  });

  it("asks for a Lead when SLP is on and the draft is on Lead", () => {
    expect(resolveDraftSeatLabels(ready(true), "lead", "claude")).toEqual({ "slp.role": "lead" });
  });

  it("sends no label for plain chat so the plugin decides", () => {
    expect(resolveDraftSeatLabels(ready(true), "chat", "claude")).toBeNull();
  });

  it("sends no label when the settings read failed — unknown does not seat", () => {
    expect(resolveDraftSeatLabels(readFailed, "lead", "claude")).toBeNull();
    expect(resolveDraftSeatLabels(readFailed, "chat", "claude")).toBeNull();
  });

  it("sends no label while settings load — unknown does not seat", () => {
    expect(resolveDraftSeatLabels(loading, "lead", "claude")).toBeNull();
  });

  it("asks for a Lead on codex as on claude", () => {
    expect(resolveDraftSeatLabels(ready(true), "lead", "codex")).toEqual({ "slp.role": "lead" });
  });

  it("sends no label on a provider SLP seats do not run on", () => {
    expect(resolveDraftSeatLabels(ready(true), "lead", "mock")).toBeNull();
    expect(resolveDraftSeatLabels(ready(true), "lead", "opencode")).toBeNull();
    expect(resolveDraftSeatLabels(ready(true), "lead", "copilot")).toBeNull();
  });

  it("sends no label before a provider is selected", () => {
    expect(resolveDraftSeatLabels(ready(true), "lead", null)).toBeNull();
  });
});

describe("draft seat pill", () => {
  it("is hidden when the host has no slp plugin", () => {
    expect(resolveDraftSeatPill(unavailable, "lead", "claude")).toEqual({ status: "hidden" });
  });

  it("is hidden when SLP is switched off on the host", () => {
    expect(resolveDraftSeatPill(ready(false), "chat", "claude")).toEqual({ status: "hidden" });
  });

  it("shows the draft's seat when SLP is on", () => {
    expect(resolveDraftSeatPill(ready(true), "lead", "claude")).toEqual({
      status: "shown",
      seat: "lead",
      disabled: false,
    });
    expect(resolveDraftSeatPill(ready(true), "chat", "claude")).toEqual({
      status: "shown",
      seat: "chat",
      disabled: false,
    });
  });

  it("is hidden when the settings read failed — unknown does not seat", () => {
    expect(resolveDraftSeatPill(readFailed, "lead", "claude")).toEqual({ status: "hidden" });
  });

  it("is hidden while settings load — unknown does not seat", () => {
    expect(resolveDraftSeatPill(loading, "lead", "claude")).toEqual({ status: "hidden" });
  });

  it("is hidden on a provider SLP seats do not run on", () => {
    expect(resolveDraftSeatPill(ready(true), "lead", "mock")).toEqual({ status: "hidden" });
    expect(resolveDraftSeatPill(ready(true), "chat", "pi")).toEqual({ status: "hidden" });
    expect(resolveDraftSeatPill(ready(true), "lead", "opencode")).toEqual({ status: "hidden" });
  });

  it("is hidden before a provider is selected", () => {
    expect(resolveDraftSeatPill(ready(true), "lead", null)).toEqual({ status: "hidden" });
  });

  it("shows on codex as on claude", () => {
    expect(resolveDraftSeatPill(ready(true), "chat", "codex")).toEqual({
      status: "shown",
      seat: "chat",
      disabled: false,
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
    const firstAttempt = resolveDraftSeatLabels(ready(true), seatOf("draft-a"), "claude");
    const retry = resolveDraftSeatLabels(ready(true), seatOf("draft-a"), "claude");

    expect(firstAttempt).toBeNull();
    expect(retry).toBeNull();

    const leadFirst = resolveDraftSeatLabels(ready(true), seatOf("draft-b"), "claude");
    const leadRetry = resolveDraftSeatLabels(ready(true), seatOf("draft-b"), "claude");
    expect(leadFirst).toEqual({ "slp.role": "lead" });
    expect(leadRetry).toEqual({ "slp.role": "lead" });
  });

  it("applies again when the draft switches back from a provider SLP seats do not run on", () => {
    useDraftSeatStore.getState().setSeat({ draftId: "draft-a", seat: "chat" });

    expect(resolveDraftSeatPill(ready(true), seatOf("draft-a"), "mock")).toEqual({
      status: "hidden",
    });
    expect(resolveDraftSeatPill(ready(true), seatOf("draft-a"), "claude")).toEqual({
      status: "shown",
      seat: "chat",
      disabled: false,
    });
    expect(resolveDraftSeatLabels(ready(true), seatOf("draft-b"), "mock")).toBeNull();
    expect(resolveDraftSeatLabels(ready(true), seatOf("draft-b"), "codex")).toEqual({
      "slp.role": "lead",
    });
  });

  it("is dropped once the draft's agent exists", () => {
    useDraftSeatStore.getState().setSeat({ draftId: "draft-a", seat: "chat" });
    useDraftSeatStore.getState().clear({ draftId: "draft-a" });

    expect(useDraftSeatStore.getState().seatByDraftId).toEqual({});
  });
});
