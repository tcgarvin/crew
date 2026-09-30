/** Full-screen loading state shown between `hookRaised` and the (mock) narrator's response. */
export function NarratorOverlay() {
  return (
    <output className="narrator-overlay" aria-live="polite">
      <div className="narrator-spinner" aria-hidden="true" />
      <p>The narrator is thinking…</p>
    </output>
  );
}
