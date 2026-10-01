import type { DecisionCardText } from "@crew/content";

export interface DecisionModalProps {
  /** Template text immediately; the narrator's prose replaces it if and when it arrives. */
  readonly card: DecisionCardText;
  readonly onChoose: (side: "left" | "right") => void;
  readonly onInspect: () => void;
  /**
   * D26: set once a side is chosen. The card stays up showing this caption with both buttons
   * disabled, then the host closes it.
   */
  readonly aftermath?: { readonly side: "left" | "right"; readonly caption: string };
}

/** Full-screen binary card (GDD §22): title, situation prose, two big buttons. */
export function DecisionModal({ card, onChoose, onInspect, aftermath }: DecisionModalProps) {
  const chosen = aftermath?.side;
  const optionClass = (side: "left" | "right") =>
    `decision-option decision-option-${side}${chosen === side ? " chosen" : ""}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <dialog> needs showModal()/open-state wiring beyond W7's scope; role="dialog" is the documented fallback.
    <div className="decision-modal" role="dialog" aria-modal="true">
      <div className="decision-card">
        <h1 className="decision-title">{card.title}</h1>
        {card.speaker === undefined ? null : (
          // D29: who is speaking; the hook for a face later.
          <p className="decision-speaker">{card.speaker}</p>
        )}
        <p className="decision-prose">{card.situation}</p>
        <div className="decision-options">
          <button
            type="button"
            className={optionClass("left")}
            disabled={chosen !== undefined}
            onClick={() => onChoose("left")}
          >
            {card.leftLabel}
          </button>
          <button
            type="button"
            className={optionClass("right")}
            disabled={chosen !== undefined}
            onClick={() => onChoose("right")}
          >
            {card.rightLabel}
          </button>
        </div>
        {aftermath === undefined ? (
          <button type="button" className="decision-inspect" onClick={onInspect}>
            Inspect ship
          </button>
        ) : (
          <output className="decision-aftermath" aria-live="polite">
            {aftermath.caption}
          </output>
        )}
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
