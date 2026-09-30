const SPEEDS = [1, 2, 4, 8] as const;

export interface TopBarProps {
  readonly speed: number;
  readonly paused: boolean;
  readonly onSetSpeed: (speed: number) => void;
  readonly onTogglePause: () => void;
  readonly simTick: number;
  readonly tickRate: number;
  readonly money: number;
  readonly runAheadBufferedSeconds: number;
  readonly health: "checking" | "ok" | "error";
  readonly onNewGame: () => void;
}

function formatClock(simTick: number, tickRate: number): string {
  const totalSeconds = Math.floor(simTick / tickRate);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function TopBar({
  speed,
  paused,
  onSetSpeed,
  onTogglePause,
  simTick,
  tickRate,
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
        <span className="sim-clock">{formatClock(simTick, tickRate)}</span>
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
        {/* Polish A: in the bar rather than floating, so it never covers the ticker column. */}
        <button type="button" className="new-game-button" onClick={onNewGame}>
          New game
        </button>
      </div>
    </header>
  );
}
