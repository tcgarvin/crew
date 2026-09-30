import type { TravelStage } from "@crew/sim";

export interface TravelBarProps {
  readonly stage: TravelStage;
  /** [0, 1] through the current stage (route progress while in transit). */
  readonly progress: number;
}

const STAGE_LABEL: Readonly<Record<TravelStage, string>> = {
  docked: "Docked",
  preparingDeparture: "Preparing to depart",
  undocking: "Undocking",
  departing: "Departing",
  transit: "In transit",
  approaching: "Approaching",
  docking: "Docking",
};

/** Thin progress bar under the top bar while the ship is not docked. */
export function TravelBar({ stage, progress }: TravelBarProps) {
  if (stage === "docked") return null;
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <div className="travel-bar" title={`${STAGE_LABEL[stage]} ${pct}%`}>
      <div className="travel-bar-fill" style={{ width: `${pct}%` }} />
      <span className="travel-bar-label">{STAGE_LABEL[stage]}</span>
    </div>
  );
}
