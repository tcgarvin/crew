import type { DecisionCardText } from "@crew/content";

export interface DecisionModalProps {
  /** Template text immediately; the narrator's prose replaces it if and when it arrives. */
  readonly card: DecisionCardText;
  readonly onChoose: (side: "left" | "right") => void;
  readonly onInspect: () => void;
}

/** Full-screen binary card (GDD §22): title, situation prose, two big buttons. */
export function DecisionModal({ card, onChoose, onInspect }: DecisionModalProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <dialog> needs showModal()/open-state wiring beyond W7's scope; role="dialog" is the documented fallback.
    <div className="decision-modal" role="dialog" aria-modal="true">
      <div className="decision-card">
        <h1 className="decision-title">{card.title}</h1>
        <p className="decision-prose">{card.situation}</p>
        <div className="decision-options">
          <button
            type="button"
            className="decision-option decision-option-left"
            onClick={() => onChoose("left")}
          >
            {card.leftLabel}
          </button>
          <button
            type="button"
            className="decision-option decision-option-right"
            onClick={() => onChoose("right")}
          >
            {card.rightLabel}
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
      Decision waiting — tap to decide
    </button>
  );
}
