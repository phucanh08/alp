import { create } from "zustand";
import type { SlpSettings } from "@/plugins/slp-settings/use-slp-settings";

/**
 * The SLP seat the Human asks for while an agent is still a draft. `chat` sends no `slp.role`, so
 * the slp plugin makes the agent an independent Peer. Seats are frozen at creation: nothing reads
 * or offers this choice once the agent exists.
 */
export type DraftSeat = "lead" | "chat";

export type DraftSeatPill =
  | { status: "hidden" }
  | { status: "shown"; seat: DraftSeat; disabled: boolean };

type SlpGate = "off" | "loading" | "on";

const LEAD_LABELS: Readonly<Record<string, string>> = { "slp.role": "lead" };

// A failed settings read counts as enabled, the plugin's own ruling. While settings load the app
// still asks for the draft's seat; the plugin decides with the setting it actually has.
function resolveSlpGate(settings: SlpSettings): SlpGate {
  switch (settings.status) {
    case "unavailable":
      return "off";
    case "loading":
      return "loading";
    case "error":
      return "on";
    case "ready":
      return settings.enabled ? "on" : "off";
  }
}

export function resolveDraftSeatLabels(
  settings: SlpSettings,
  seat: DraftSeat,
): Record<string, string> | null {
  if (resolveSlpGate(settings) === "off" || seat === "chat") return null;
  return { ...LEAD_LABELS };
}

export function resolveDraftSeatPill(settings: SlpSettings, seat: DraftSeat): DraftSeatPill {
  const gate = resolveSlpGate(settings);
  if (gate === "off") return { status: "hidden" };
  return { status: "shown", seat, disabled: gate === "loading" };
}

interface DraftSeatState {
  seatByDraftId: Record<string, DraftSeat>;
  setSeat: (input: { draftId: string; seat: DraftSeat }) => void;
  clear: (input: { draftId: string }) => void;
}

/** In memory only: the choice outlives a draft tab remount, never the draft. */
export const useDraftSeatStore = create<DraftSeatState>((set) => ({
  seatByDraftId: {},
  setSeat: ({ draftId, seat }) =>
    set((state) => ({ seatByDraftId: { ...state.seatByDraftId, [draftId]: seat } })),
  clear: ({ draftId }) =>
    set((state) => {
      const seatByDraftId = { ...state.seatByDraftId };
      delete seatByDraftId[draftId];
      return { seatByDraftId };
    }),
}));

export function selectDraftSeat(
  state: Pick<DraftSeatState, "seatByDraftId">,
  draftId: string,
): DraftSeat {
  return state.seatByDraftId[draftId] ?? "lead";
}

export function useDraftSeat(draftId: string): DraftSeat {
  return useDraftSeatStore((state) => selectDraftSeat(state, draftId));
}
