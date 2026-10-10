import type { DecisionCardText } from "@crew/content";
import { useState } from "react";
import type { CardEntry, LogEntry } from "./log";

export interface LogProps {
  /** What playback has reached, newest first (`visibleLog`). */
  readonly entries: readonly LogEntry[];
  /** The text of a logged card: the narrator's prose when it has some, else the template. */
  readonly cardText: (entry: CardEntry) => DecisionCardText;
  /** Bring a waiting card back up. */
  readonly onOpenDecision: () => void;
}

/**
 * §the-log-in-playback-order: the ship's log, one feed newest on top: event lines, and the cards
 * the captain was shown with how they answered. On a portrait screen it is a compact strip under
 * the canvas, so the ship stays legible, with a toggle to open it out (the stylesheet hides the
 * toggle in landscape, where the log is a full-height column).
 */
export function Log({ entries, cardText, onOpenDecision }: LogProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={expanded ? "log-panel log-panel-expanded" : "log-panel"}>
      <ul className="log" aria-label="Ship's log">
        {entries.map((entry) => (
          <li key={entry.key} className={`log-item log-${entry.kind}`}>
            <LogItem entry={entry} cardText={cardText} onOpenDecision={onOpenDecision} />
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="log-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? "Show less of the log" : "Show more of the log"}
        onClick={() => setExpanded((was) => !was)}
      >
        {expanded ? "▾" : "▴"}
      </button>
    </section>
  );
}

function LogItem({
  entry,
  cardText,
  onOpenDecision,
}: { readonly entry: LogEntry } & Omit<LogProps, "entries">) {
  switch (entry.kind) {
    case "event":
      return (
        <p
          className={`log-line log-line-${entry.significance}${entry.highlight === true ? " log-line-highlight" : ""}`}
        >
          {entry.text}
        </p>
      );
    case "card":
      return <LoggedCard entry={entry} card={cardText(entry)} onOpenDecision={onOpenDecision} />;
  }
}

function LoggedCard({
  entry,
  card,
  onOpenDecision,
}: {
  readonly entry: CardEntry;
  readonly card: DecisionCardText;
  readonly onOpenDecision: () => void;
}) {
  const header = (
    <>
      <span className="log-card-kicker">{card.speaker ?? "Card"}</span>
      <span className="log-card-title">{card.title}</span>
      {card.closesThread === undefined ? null : (
        // §closing-cards: the narrator ended a story thread with this card.
        <span className="log-card-closed">
          ✓ Story closed{card.closesThread === "" ? "" : `: ${card.closesThread}`}
        </span>
      )}
    </>
  );
  if (entry.answer === undefined) {
    return (
      <button type="button" className="log-card log-card-waiting" onClick={onOpenDecision}>
        {header}
        <span className="log-card-answer">Waiting for you — tap to decide</span>
      </button>
    );
  }
  const label = entry.answer.side === "left" ? card.leftLabel : card.rightLabel;
  return (
    <details className="log-card">
      <summary>
        {header}
        <span className="log-card-answer">→ {label}</span>
      </summary>
      <p className="log-card-prose">{card.situation}</p>
      <p className="log-card-aftermath">{entry.answer.caption}</p>
    </details>
  );
}
