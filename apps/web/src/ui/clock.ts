/**
 * The top bar's clock (D76, D77): the ship's day and the watch, "Day 2 · White watch", from the
 * tick playback has reached. Pure, no React; `TopBar.tsx` renders it.
 *
 * A watch is named for the section that stands it (the scenario's watch bill, section `i` on
 * watch `i` of the day); a watch of the day with no section is "Watch 3".
 */
import type { ConfigDef, ContentBundle, ScenarioDefId, Tick } from "@crew/sim";
import { watchIndexAt, watchOfDay } from "@crew/sim";

export interface ShipClock {
  /** 1 for the first day. */
  readonly day: number;
  /** "White watch", or "Watch 3" when no section stands this watch of the day. */
  readonly watch: string;
  /** "White", or "Watch 3": the narrowest phones' top bar has no room for the word "watch". */
  readonly watchShort: string;
  /** "Day 2 · White watch". */
  readonly text: string;
  /** Who is on: "White watch: Jax Okonkwo, Tomas Ruiz" (the clock's tooltip). */
  readonly whoIsOn: string;
  /** Sim time since the start, "m:ss", for the tooltip. */
  readonly elapsed: string;
}

/** A section of the bill as the clock needs it: its key and its members' names. */
export interface ClockSection {
  readonly key: string;
  readonly names: readonly string[];
}

/** "white" → "White". */
export function sectionName(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** The scenario's watch bill as names, in section order; empty when it has no bill. */
export function clockSections(bundle: ContentBundle, scenarioId: ScenarioDefId): ClockSection[] {
  const bill = bundle.scenarios[scenarioId]?.watchBill;
  if (bill === undefined) return [];
  return bill.sections.map((section) => ({
    key: section.key,
    names: section.members.map((defId) => bundle.crew[defId]?.name ?? defId),
  }));
}

function formatElapsed(tick: Tick, tickRate: number): string {
  const totalSeconds = Math.floor(tick / tickRate);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function shipClock(
  tick: Tick,
  config: ConfigDef,
  sections: readonly ClockSection[],
): ShipClock {
  const whole = Math.max(0, Math.floor(tick));
  const day = Math.floor(watchIndexAt(config, whole) / config.time.watchesPerDay) + 1;
  const index = watchOfDay(config, whole);
  const section = sections[index];
  const watchShort = section === undefined ? `Watch ${index + 1}` : sectionName(section.key);
  const watch = section === undefined ? watchShort : `${watchShort} watch`;
  const whoIsOn =
    section === undefined || section.names.length === 0
      ? `${watch}: no section stands it`
      : `${watch}: ${section.names.join(", ")}`;
  return {
    day,
    watch,
    watchShort,
    text: `Day ${day} · ${watch}`,
    whoIsOn,
    elapsed: formatElapsed(whole, config.time.tickRate),
  };
}
