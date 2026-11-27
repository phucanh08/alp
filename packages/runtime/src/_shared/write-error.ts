/** Tells `onError` of a failed write (t-e80a); what it throws must not change how the write failed. */
export function tell(onError: (error: unknown) => void, error: unknown) {
  try { onError(error); } catch {}
}
