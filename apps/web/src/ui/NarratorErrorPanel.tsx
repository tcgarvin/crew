/**
 * D43: the full-screen panel shown when the narrator kept failing (or cannot be retried). The
 * game is paused behind it; the only way on is Retry, which restarts the backoff sequence. There
 * is deliberately no "continue without the narrator": a hook is never acknowledged without an
 * answer in play.
 */

/** Plain-words text for a failure reason (`NarratorFailure.reason`). */
export function narratorReasonText(reason: string): string {
  switch (reason) {
    case "notConfigured":
      return "No narrator is configured for this server";
    case "apiError":
      return "The model service returned an error";
    case "timeout":
      return "The model did not answer in time";
    case "truncated":
    case "schemaInvalid":
    case "refusal":
    case "malformed":
      return "The model's answer could not be used";
    case "network":
      return "Could not reach the server";
    case "server":
      return "The server returned an error";
    case "request":
      return "The server rejected the request";
    case "budget":
      return "The narrator's call budget for this game is used up for now";
    case "snapshot":
      return "The game state could not be captured for the narrator";
    default:
      return "The narrator could not answer";
  }
}

export interface NarratorErrorPanelProps {
  readonly reason: string;
  readonly message: string;
  readonly onRetry: () => void;
}

export function NarratorErrorPanel({ reason, message, onRetry }: NarratorErrorPanelProps) {
  return (
    <div className="narrator-overlay narrator-error" role="alertdialog" aria-modal="true">
      <h2 className="narrator-error-title">The narrator is unavailable</h2>
      <p className="narrator-error-reason">{narratorReasonText(reason)}</p>
      <p className="narrator-error-detail">{message}</p>
      <button type="button" className="narrator-error-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
