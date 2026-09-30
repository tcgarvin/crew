import type { TravelStage } from "@crew/sim";

export interface TravelBarProps {
  readonly stage: TravelStage;
  /** [0, 1] through the current stage (route progress while in transit). */
  readonly progress: number;
}

/**
 * Thin progress bar under the ship headline while the ship is not docked. Polish A: the headline
 * says what the stage is, so the bar itself carries no label.
 */
export function TravelBar({ stage, progress }: TravelBarProps) {
  if (stage === "docked") return null;
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <div className="travel-bar" title={`${pct}%`}>
      <div className="travel-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
