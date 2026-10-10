/** §hull-scars-and-ship-loss (call 13): the end screen and its account of the ship's last day. */
import type { PortDef, PortDefId, Tick } from "@crew/sim";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShipLost } from "./ShipLost";
import type { LogEntry } from "./log";
import { LAST_LINES, lastDay } from "./shipLost";

const ports = {
  "port.ossory": { name: "Ossory Station" },
  "port.hub": { name: "Crossroads Hub" },
} as unknown as Readonly<Record<PortDefId, PortDef>>;

function line(tick: number, text: string): LogEntry {
  return {
    kind: "event",
    key: `event:${tick}:${text}`,
    tick: tick as Tick,
    text,
    significance: "notable",
  };
}

const transit = { state: "transit", toPortId: "port.ossory" as PortDefId } as const;

describe("lastDay", () => {
  it("gives the day, the port the ship was bound for and the log's last lines", () => {
    const log = Array.from({ length: LAST_LINES + 3 }, (_, i) => line(i, `line ${i}`));
    const day = lastDay(transit, 3, log, 100 as Tick, ports);
    expect(day.day).toBe("Day 3");
    expect(day.bound).toBe("Bound for Ossory Station");
    expect(day.lines.map((l) => l.text)).toEqual(
      Array.from({ length: LAST_LINES }, (_, i) => `line ${i + 3}`),
    );
  });

  it("leaves out lines after the loss and the cards", () => {
    const log: LogEntry[] = [
      line(10, "Rock strike in the hold"),
      { kind: "card", key: "card:d1", tick: 11 as Tick, decision: {} as never },
      line(12, "The hull gave way. The ship is lost."),
      line(40, "run-ahead"),
    ];
    const day = lastDay(transit, 1, log, 12 as Tick, ports);
    expect(day.lines.map((l) => l.text)).toEqual([
      "Rock strike in the hold",
      "The hull gave way. The ship is lost.",
    ]);
  });

  it("has no lines for a lost save loaded afresh, and says where a docked ship was", () => {
    const day = lastDay(
      { state: "docked", toPortId: "port.hub" as PortDefId },
      5,
      [],
      9 as Tick,
      ports,
    );
    expect(day.lines).toEqual([]);
    expect(day.bound).toBe("At Crossroads Hub");
  });

  it("throws for a port the content does not have", () => {
    expect(() =>
      lastDay({ state: "transit", toPortId: "port.nowhere" as PortDefId }, 1, [], 0 as Tick, ports),
    ).toThrow(/port\.nowhere/);
  });
});

describe("ShipLost", () => {
  it("shows the last day and a New game button", () => {
    const html = renderToStaticMarkup(
      <ShipLost
        lastDay={lastDay(
          transit,
          3,
          [line(1, "The hull gave way. The ship is lost.")],
          1 as Tick,
          ports,
        )}
        onNewGame={() => {}}
      />,
    );
    expect(html).toContain("The ship is lost");
    expect(html).toContain("Day 3 · Bound for Ossory Station");
    expect(html).toContain("<li>The hull gave way. The ship is lost.</li>");
    expect(html).toContain(">New game<");
  });

  it("leaves out the list when no lines were kept", () => {
    const html = renderToStaticMarkup(
      <ShipLost lastDay={lastDay(transit, 3, [], 1 as Tick, ports)} onNewGame={() => {}} />,
    );
    expect(html).not.toContain("<ol");
  });
});
