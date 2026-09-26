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

type SlpGate = "off" | "on";

// Mirrors `SEAT_LABEL`/the `lead` seat value in plugins/slp/server/seat.ts, which the app cannot
// import; exported so `slp-seat-mirrors-contract.test.ts` can tie it to the plugin's source.
export const LEAD_LABELS: Readonly<Record<string, string>> = { "slp.role": "lead" };

// SLP seats run only on these providers; on any other the plugin ignores `slp.role`. Mirrors
// `familyOf` in plugins/slp/server/seat.ts, which the app cannot import; exported for the same
// contract test.
export const SLP_SEAT_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex"]);

function isSlpSeatProvider(provider: string | null): boolean {
  return provider !== null && SLP_SEAT_PROVIDERS.has(provider);
}

// Unknown does not seat: only a ready, enabled read turns the gate on. The plugin's own ruling —
// a failed read of its stored value counts as enabled — is about the server reading a corrupt
// value it must run with regardless; the app not yet having a ready read is a different case, and
// the feature contract has no fallback for it.
function resolveSlpGate(settings: SlpSettings): SlpGate {
  return settings.status === "ready" && settings.enabled ? "on" : "off";
}

/** A draft's seat as labels for the provider a create request goes out on. */
export type SeatLabelsFor = (provider: string) => Record<string, string> | null;

/** Labels for a create request sent on `provider`; the draft's seat survives a provider switch. */
export function resolveDraftSeatLabels(
  settings: SlpSettings,
  seat: DraftSeat,
  provider: string | null,
): Record<string, string> | null {
  if (!isSlpSeatProvider(provider)) return null;
  if (resolveSlpGate(settings) === "off" || seat === "chat") return null;
  return { ...LEAD_LABELS };
}

export function resolveDraftSeatPill(
  settings: SlpSettings,
  seat: DraftSeat,
  provider: string | null,
): DraftSeatPill {
  if (resolveSlpGate(settings) === "off" || !isSlpSeatProvider(provider)) {
    return { status: "hidden" };
  }
  return { status: "shown", seat, disabled: false };
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
