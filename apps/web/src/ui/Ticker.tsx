import type { TickerEntry } from "@crew/sim";

export interface TickerProps {
  readonly entries: readonly TickerEntry[];
}

/** Last ~6 notable events, newest on top, fading with age (PLAN §6 W7). */
export function Ticker({ entries }: TickerProps) {
  return (
    <ul className="ticker" aria-label="Recent events">
      {entries.map((entry, i) => (
        <li
          key={`${entry.tick}-${i}`}
          className={`ticker-entry ticker-${entry.significance}`}
          style={{ opacity: 1 - i * 0.14 }}
        >
          {entry.text}
        </li>
      ))}
    </ul>
  );
}
