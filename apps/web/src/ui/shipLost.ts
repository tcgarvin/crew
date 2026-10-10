/**
 * §hull-scars-and-ship-loss (call 13): the end screen's words. The hull gave way and the run is
 * over; the screen gives the ship's last day (the day, the port it was bound for, the last lines of
 * the log) over a New game button. Pure, no React; `ShipLost.tsx` renders it.
 */
import type { PortDef, PortDefId, RenderTravel, Tick } from "@crew/sim";
import type { LogEntry } from "./log";

/** Log lines the end screen shows, the newest last. */
export const LAST_LINES = 6;

export interface LastDay {
  /** "Day 3". */
  readonly day: string;
  /** "Bound for Ossory Station", or "At Ossory Station" if the ship was lost alongside. */
  readonly bound: string;
  /**
   * The log's last event lines up to the loss, oldest first, with their log keys; empty when none
   * were kept (a lost save loaded afresh has no log).
   */
  readonly lines: readonly { readonly key: string; readonly text: string }[];
}

function portName(ports: Readonly<Record<PortDefId, PortDef>>, id: PortDefId): string {
  const port = ports[id];
  if (port === undefined) throw new Error(`lastDay: no port ${id} in the content`);
  return port.name;
}

/**
 * The last day of a lost ship, from the frame playback reached (its travel), the ship's day then
 * and the log (only lines at or before `lostTick`, so run-ahead never shows here either).
 */
export function lastDay(
  travel: Pick<RenderTravel, "state" | "toPortId">,
  day: number,
  log: readonly LogEntry[],
  lostTick: Tick,
  ports: Readonly<Record<PortDefId, PortDef>>,
): LastDay {
  const port = portName(ports, travel.toPortId);
  const lines = log
    .flatMap((entry) =>
      entry.kind === "event" && entry.tick <= lostTick
        ? [{ key: entry.key, text: entry.text }]
        : [],
    )
    .slice(-LAST_LINES);
  return {
    day: `Day ${day}`,
    bound: travel.state === "docked" ? `At ${port}` : `Bound for ${port}`,
    lines,
  };
}
