export interface NarratorOverlayProps {
  /**
   * D43: the attempt about to be made while the client retries a failed narrator call
   * (undefined = the first call is still in flight). Shown so a viewer who has reached the hook
   * knows the wait is a retry, not a hang.
   */
  readonly attempt?: number;
}

/** Full-screen loading state shown between `hookRaised` and the narrator's response. */
export function NarratorOverlay({ attempt }: NarratorOverlayProps) {
  const suffix = attempt === undefined ? "" : ` (retrying, attempt ${attempt})`;
  return (
    <output className="narrator-overlay" aria-live="polite">
      <div className="narrator-spinner" aria-hidden="true" />
      <p>The narrator is thinking…{suffix}</p>
    </output>
  );
}
