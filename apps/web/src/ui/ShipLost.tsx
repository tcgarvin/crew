/**
 * D93 (call 13): the end screen. Hull at zero is game over: no partial survival, nothing to
 * continue. It shows the ship's last day (`lastDay`) and the one way on, a new game through the
 * same path as the top bar's button.
 */
import type { LastDay } from "./shipLost";

export interface ShipLostProps {
  readonly lastDay: LastDay;
  readonly onNewGame: () => void;
}

export function ShipLost({ lastDay, onNewGame }: ShipLostProps) {
  return (
    <div
      className="narrator-overlay ship-lost"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ship-lost-title"
    >
      <h2 id="ship-lost-title" className="ship-lost-title">
        The ship is lost
      </h2>
      <p className="ship-lost-when">
        {lastDay.day} · {lastDay.bound}
      </p>
      {lastDay.lines.length > 0 && (
        <ol className="ship-lost-lines" aria-label="The last lines of the log">
          {lastDay.lines.map((line) => (
            <li key={line.key}>{line.text}</li>
          ))}
        </ol>
      )}
      <button type="button" className="ship-lost-new-game" onClick={onNewGame}>
        New game
      </button>
    </div>
  );
}
