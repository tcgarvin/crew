import type { RenderHull } from "@crew/sim";
import type { HealthState } from "../health";
import type { ShipClock } from "./clock";

const SPEEDS = [1, 2, 4, 8] as const;

/** D93: the hull bar's reading. */
export type HullLevel = "sound" | "critical";

/** D93: the bar turns red below a third of the hull's points. */
export function hullLevel(integrity: number, max: number): HullLevel {
  return integrity * 3 < max ? "critical" : "sound";
}

/** The fill's width, 0..100 %, clamped (a hull is never above its max, nor below zero). */
export function hullPercent(integrity: number, max: number): number {
  if (max <= 0) throw new Error(`hullPercent: max ${max} is not positive`);
  return Math.max(0, Math.min(100, (integrity / max) * 100));
}

/** D93: the global hull bar, FTL-style: a short meter with the points left written on it. */
export function HullBar({ hull }: { readonly hull: Pick<RenderHull, "integrity" | "max"> }) {
  const shown = Math.round(hull.integrity);
  return (
    <span
      className={`hull-bar hull-bar-${hullLevel(hull.integrity, hull.max)}`}
      role="meter"
      aria-label="Hull"
      aria-valuemin={0}
      aria-valuemax={hull.max}
      aria-valuenow={shown}
      title={`Hull ${shown} of ${hull.max}`}
    >
      <span
        className="hull-bar-fill"
        style={{ width: `${hullPercent(hull.integrity, hull.max)}%` }}
      />
      <span className="hull-bar-text">{shown}</span>
    </span>
  );
}

export interface TopBarProps {
  readonly speed: number;
  readonly paused: boolean;
  readonly onSetSpeed: (speed: number) => void;
  readonly onTogglePause: () => void;
  /** D76/D77: the ship's day and watch at the tick playback has reached. */
  readonly clock: ShipClock;
  /** D93: the hull at the tick playback has reached. */
  readonly hull: Pick<RenderHull, "integrity" | "max">;
  /** D92: the ship is on alert: the bar tints and the bell line reads "ALERT". */
  readonly alert: boolean;
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
  hull,
  alert,
  money,
  runAheadBufferedSeconds,
  health,
  onNewGame,
}: TopBarProps) {
  return (
    <header className={alert ? "top-bar top-bar-alert" : "top-bar"}>
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
          aria-label={alert ? `Day ${clock.day} · ALERT` : clock.text}
        >
          <span className="sim-clock-day">Day {clock.day}</span>
          <span className="sim-clock-sep" aria-hidden="true">
            {" · "}
          </span>
          {alert ? (
            <span className="sim-clock-alert">ALERT</span>
          ) : (
            <>
              <span className="sim-clock-watch">{clock.watch}</span>
              <span className="sim-clock-watch-short" aria-hidden="true">
                {clock.watchShort}
              </span>
            </>
          )}
        </span>
        <HullBar hull={hull} />
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
