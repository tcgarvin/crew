import type { HealthState } from "../health";
import type { ShipClock } from "./clock";

const SPEEDS = [1, 2, 4, 8] as const;

export interface TopBarProps {
  readonly speed: number;
  readonly paused: boolean;
  readonly onSetSpeed: (speed: number) => void;
  readonly onTogglePause: () => void;
  /** D76/D77: the ship's day and watch at the tick playback has reached. */
  readonly clock: ShipClock;
  readonly money: number;
  readonly runAheadBufferedSeconds: number;
  readonly health: HealthState;
  readonly onNewGame: () => void;
}

export function TopBar({
  speed,
  paused,
  onSetSpeed,
  onTogglePause,
  clock,
  money,
  runAheadBufferedSeconds,
  health,
  onNewGame,
}: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="top-bar-group">
        <button
          type="button"
          className={`speed-button pause-button ${paused ? "active" : ""}`}
          onClick={onTogglePause}
          aria-pressed={paused}
        >
          {paused ? "▶" : "⏸"}
        </button>
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className={`speed-button ${!paused && speed === s ? "active" : ""}`}
            onClick={() => onSetSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
      <div className="top-bar-group top-bar-clock">
        {/* D72: in portrait the day and the watch stack on two short lines in the 36 px bar. */}
        <span
          className="sim-clock"
          title={`${clock.whoIsOn} (${clock.elapsed} since the start)`}
          aria-label={clock.text}
        >
          <span className="sim-clock-day">Day {clock.day}</span>
          <span className="sim-clock-sep" aria-hidden="true">
            {" · "}
          </span>
          <span className="sim-clock-watch">{clock.watch}</span>
          <span className="sim-clock-watch-short" aria-hidden="true">
            {clock.watchShort}
          </span>
        </span>
        <span className="run-ahead" title="Sim run-ahead buffer (D14)">
          ▶ +{runAheadBufferedSeconds.toFixed(0)}s buffered
        </span>
      </div>
      <div className="top-bar-group">
        <span className="money">{money}cr</span>
        <span
          className={`health-dot ${health}`}
          title={`API health: ${health}`}
          aria-label={`API health: ${health}`}
        />
        {/* Polish A: in the bar rather than floating, so it never covers the log column. */}
        <button type="button" className="new-game-button" onClick={onNewGame}>
          New game
        </button>
      </div>
    </header>
  );
}
