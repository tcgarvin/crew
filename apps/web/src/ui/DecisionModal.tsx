import type { Decision } from "@crew/sim";

export interface DecisionModalProps {
  readonly decision: Decision;
  readonly onChoose: (side: "left" | "right") => void;
  readonly onInspect: () => void;
}

function textOf(ref: { readonly prose?: string; readonly key: string }): string {
  return ref.prose ?? ref.key;
}

/** Full-screen binary card (GDD §22): title, situation prose, two big buttons. */
export function DecisionModal({ decision, onChoose, onInspect }: DecisionModalProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <dialog> needs showModal()/open-state wiring beyond W7's scope; role="dialog" is the documented fallback.
    <div className="decision-modal" role="dialog" aria-modal="true">
      <div className="decision-card">
        <h1 className="decision-title">A decision is needed</h1>
        <p className="decision-prose">{textOf(decision.prompt)}</p>
        <div className="decision-options">
          <button
            type="button"
            className="decision-option decision-option-left"
            onClick={() => onChoose("left")}
          >
            {textOf(decision.left.label)}
          </button>
          <button
            type="button"
            className="decision-option decision-option-right"
            onClick={() => onChoose("right")}
          >
            {textOf(decision.right.label)}
          </button>
        </div>
        <button type="button" className="decision-inspect" onClick={onInspect}>
          Inspect ship
        </button>
      </div>
    </div>
  );
}

export interface DecisionPillProps {
  readonly onClick: () => void;
}

/** Persistent pill that brings the card back after "inspect ship" hid it. */
export function DecisionPill({ onClick }: DecisionPillProps) {
  return (
    <button type="button" className="decision-pill" onClick={onClick}>
      Decision waiting
    </button>
  );
}
