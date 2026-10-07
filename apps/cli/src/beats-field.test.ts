import { describe, expect, it } from "vitest";
import { formatBeatsReport, runBeats } from "./beats";
import { FieldTally, fieldSection } from "./beats-field";

const TICK_RATE = 20;

const ev = (type: string, tick: number, payload: object = {}) =>
  ({ type, tick, payload }) as Parameters<FieldTally["events"]>[0][number];

const impact = (tick: number, fieldId: string, hullDamage: number) =>
  ev("asteroidImpact", tick, { fieldId, hullDamage, hits: [] });

describe("the field tally (D95)", () => {
  it("counts each field's rocks, hull lost, time stuck and first report, and sums them by severity", () => {
    const tally = new FieldTally("cycle", TICK_RATE);
    tally.events([
      ev("fieldScheduled", 100, { fieldId: "f1", severity: "heavy" }),
      ev("fieldEntered", 400, { fieldId: "f1" }),
      impact(400, "f1", 3),
      impact(600, "f1", 8),
      ev("intercomReport", 700, {}),
      ev("shipStuck", 800, { fieldId: "f1" }),
      impact(900, "f1", 3),
      ev("shipUnstuck", 1_200, { fieldId: "f1" }),
      ev("fieldCleared", 1_500, { fieldId: "f1", how: "crossed" }),
      ev("hullPatched", 1_600, {}),
      ev("machineMended", 1_700, {}),
      ev("fieldScheduled", 3_000, { fieldId: "f2", severity: "light" }),
      ev("fieldMissed", 3_100, { fieldId: "f2" }),
    ]);
    tally.tickerLines(0);
    const result = tally.result(4_000, { integrity: 86, max: 100 });
    expect(result.fields).toEqual([
      {
        fieldId: "f1",
        severity: "heavy",
        entered: true,
        missed: false,
        how: "crossed",
        impacts: 3,
        hullLost: 14,
        stuckSeconds: 20,
        firstReportSeconds: 15,
        tickerLines: 0,
      },
      {
        fieldId: "f2",
        severity: "light",
        entered: false,
        missed: true,
        how: "missed",
        impacts: 0,
        hullLost: 0,
        stuckSeconds: 0,
        firstReportSeconds: null,
        tickerLines: 0,
      },
    ]);
    expect(result.bySeverity.heavy).toEqual({
      scheduled: 1,
      entered: 1,
      missed: 0,
      impacts: 3,
      hullLost: 14,
      stuckSeconds: 20,
    });
    expect(result.bySeverity.light).toMatchObject({ scheduled: 1, missed: 1 });
    expect(result).toMatchObject({ scarsPatched: 1, machinesMended: 1, lostAtSeconds: null });
  });

  it("charges field ticker lines to the leg's field and refuses them before any field", () => {
    const tally = new FieldTally("heavy", TICK_RATE);
    expect(() => tally.tickerLines(2)).toThrow("field ticker lines with no field scheduled");
    tally.events([ev("fieldScheduled", 10, { fieldId: "f1", severity: "heavy" })]);
    tally.tickerLines(2);
    tally.tickerLines(3);
    expect(tally.result(100, { integrity: 100, max: 100 }).fields[0]?.tickerLines).toBe(5);
  });

  it("counts a stuck ship lost in the rocks as stuck until the end, and the loss", () => {
    const tally = new FieldTally("brutal", TICK_RATE);
    tally.events([
      ev("fieldScheduled", 0, { fieldId: "f1", severity: "brutal" }),
      ev("fieldEntered", 20, { fieldId: "f1" }),
      impact(20, "f1", 8),
      ev("shipStuck", 100, { fieldId: "f1" }),
      ev("shipLost", 500, {}),
    ]);
    const result = tally.result(500, { integrity: 0, max: 100 });
    expect(result.fields[0]).toMatchObject({ how: "open", stuckSeconds: 20 });
    expect(result.lostAtSeconds).toBe(25);
    const section = fieldSection(result).join("\n");
    expect(section).toContain("Ship lost: yes, at 25 s.");
    expect(section).toContain("| brutal | 1 | 1 | 0 | 1 | 8 | 8.0 | 20 |");
    expect(section).toContain("| f1 | brutal | open | 1 | 8 | 20 | none | 0 |");
  });

  it("refuses an event for a field it never saw scheduled", () => {
    const tally = new FieldTally("heavy", TICK_RATE);
    expect(() => tally.events([impact(5, "f9", 3)])).toThrow(
      "asteroidImpact for field f9, never scheduled",
    );
  });
});

describe("crew beats with fields: one ship's day with a heavy field a leg (real content)", () => {
  it("schedules a field on each leg's transit and prints the field section", () => {
    const result = runBeats({ scenario: "freight", days: 1, seed: 1, fields: "heavy" });
    expect(result.field.plan).toBe("heavy");
    expect(result.field.fields.length).toBeGreaterThanOrEqual(1);
    for (const field of result.field.fields) expect(field.severity).toBe("heavy");
    expect(result.field.bySeverity.heavy.scheduled).toBe(result.field.fields.length);
    // Slice-5 integration: the rocks actually land on real content, not only the schedule.
    expect(result.field.bySeverity.heavy.impacts).toBeGreaterThan(0);
    const report = formatBeatsReport([result]);
    expect(report).toContain(
      "Fields (--fields heavy, one a leg that holds it, as its transit begins",
    );
    expect(report).toContain(
      "| Severity | Scheduled | Entered | Missed | Rocks | Hull lost | Hull lost per field | Stuck s |",
    );
    expect(report).toMatch(/Ships lost: [01] of 1 run/);
    expect(report).toMatch(/Hull at the end: \d+\/100\. Ship lost: /);
  }, 120_000);
});
