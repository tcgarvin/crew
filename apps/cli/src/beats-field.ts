/**
 * `crew beats`' field section (D95, slice 5 W5): the asteroid fields a run crosses and what they
 * cost. The run schedules them itself, as a scenario would (`FieldScript`: one per leg, as the
 * kernel allows, at the start of each leg's transit), and `FieldTally` reads the events:
 *
 * - per field: its severity, rocks, hull lost, time stuck, seconds from its first rock to the
 *   first intercom report, its field-family ticker lines (`FIELD_EVENT_TYPES`), and how it ended;
 * - per severity: fields scheduled, entered and missed, and the rocks, hull and stuck time summed;
 * - for the run: scars patched and plated, machines mended, scouts sent, and whether the ship
 *   was lost (and when).
 *
 * The slice's tuning targets (ship-life plan, slice 5 "Integration order" 6) read off these: hull
 * lost per severity, ships lost only when brutal meets an empty helm or a stuck ship, time stuck
 * under a field's length, first report within thirty seconds, under twenty field lines a field.
 */
import {
  type Command,
  FIELD_SEVERITIES,
  type FieldId,
  type FieldSeverity,
  type SimEvent,
  type World,
  configTicks,
} from "@crew/sim";

/** Which fields a beats run schedules: none, one severity on every leg, or the three in turn. */
export const FIELD_PLANS = ["none", ...FIELD_SEVERITIES, "cycle"] as const;
export type FieldPlan = (typeof FIELD_PLANS)[number];

/** A field's window opens at its leg's transit and lasts this long (sim seconds). */
export const FIELD_WINDOW_SECONDS = 10;

/** The field event as the tally reads it: type, tick and payload, still discriminated. */
type FieldEvent = SimEvent extends infer E
  ? E extends SimEvent
    ? Pick<E, "type" | "tick" | "payload">
    : never
  : never;

/**
 * Schedules one field on each leg of the run, as a scenario (D92's authority), when the leg's
 * transit begins: `light`, `heavy` or `brutal` every time, or the three in turn for `cycle`.
 * Detection is `rolled`, so the helm's check plays; no scripted hits, so the dice decide.
 */
export class FieldScript {
  private lastStage: World["state"]["travel"]["stage"] | undefined;
  private legs = 0;

  constructor(
    private readonly plan: FieldPlan,
    private readonly send: (command: Omit<Command, "id">) => void,
  ) {}

  /** Called after each advance; schedules this leg's field on its first transit tick. */
  step(world: World): void {
    const stage = world.state.travel.stage;
    const entered = stage === "transit" && this.lastStage !== "transit";
    this.lastStage = stage;
    if (!entered || this.plan === "none") return;
    const severity = this.severityFor(this.legs);
    this.legs += 1;
    if (world.state.field !== undefined || world.state.hull.lostAtTick !== undefined) return;
    this.send({
      source: "scenario",
      kind: "scheduleField",
      payload: {
        severity,
        detection: "rolled",
        windowTicks: [0, configTicks(world.config.values, FIELD_WINDOW_SECONDS)],
        scripted: [],
      },
    });
  }

  private severityFor(leg: number): FieldSeverity {
    if (this.plan === "cycle") {
      const severity = FIELD_SEVERITIES[leg % FIELD_SEVERITIES.length];
      if (severity === undefined) throw new Error(`no severity for leg ${leg}`);
      return severity;
    }
    if (this.plan === "none") throw new Error("FieldScript: no severity under plan none");
    return this.plan;
  }
}

/** One field over the run. */
export interface FieldBeats {
  readonly fieldId: string;
  readonly severity: FieldSeverity;
  /** Its first rock landed (`fieldEntered`). */
  readonly entered: boolean;
  /** Its leg ended before it began (`fieldMissed`). */
  readonly missed: boolean;
  /** "crossed", "drifted", or "open" when the run (or the ship) ended inside it. */
  readonly how: "crossed" | "drifted" | "open" | "missed" | "scheduled";
  readonly impacts: number;
  readonly hullLost: number;
  readonly stuckSeconds: number;
  /** Seconds from its first rock to the first intercom report after it; null with none. */
  readonly firstReportSeconds: number | null;
  /** Notable-or-better ticker lines of the field family while it was the leg's field. */
  readonly tickerLines: number;
}

/** The fields of one severity, summed. */
export interface SeverityBeats {
  readonly scheduled: number;
  readonly entered: number;
  readonly missed: number;
  readonly impacts: number;
  readonly hullLost: number;
  readonly stuckSeconds: number;
}

export interface FieldTallyResult {
  readonly plan: FieldPlan;
  readonly fields: readonly FieldBeats[];
  readonly bySeverity: Readonly<Record<FieldSeverity, SeverityBeats>>;
  readonly scarsPatched: number;
  readonly scarsPlated: number;
  readonly machinesMended: number;
  readonly scoutsSent: number;
  readonly intercomReports: number;
  /** When the hull gave way (sim seconds), or null when the ship came through the run. */
  readonly lostAtSeconds: number | null;
  /** The hull at the end of the run. */
  readonly hullAtEnd: number;
  readonly hullMax: number;
}

interface FieldRow {
  readonly fieldId: string;
  readonly severity: FieldSeverity;
  entered: boolean;
  missed: boolean;
  how: FieldBeats["how"];
  impacts: number;
  hullLost: number;
  firstImpactTick: number | null;
  firstReportTick: number | null;
  stuckSinceTick: number | null;
  stuckTicks: number;
  tickerLines: number;
}

/** Tallies the field family's events and ticker lines over a run. */
export class FieldTally {
  private readonly rows = new Map<string, FieldRow>();
  /** The leg's field: the latest scheduled; reports and ticker lines are charged to it. */
  private current: FieldRow | undefined;
  private patched = 0;
  private plated = 0;
  private mended = 0;
  private scouts = 0;
  private reports = 0;
  private lostAtTick: number | null = null;

  constructor(
    private readonly plan: FieldPlan,
    private readonly tickRate: number,
  ) {}

  events(events: readonly FieldEvent[]): void {
    for (const event of events) this.event(event);
  }

  /** Ticker lines of the field family, charged to the leg's field. */
  tickerLines(count: number): void {
    if (count === 0) return;
    if (this.current === undefined) {
      throw new Error(`${count} field ticker lines with no field scheduled`);
    }
    this.current.tickerLines += count;
  }

  private row(fieldId: FieldId | string, what: string): FieldRow {
    const row = this.rows.get(fieldId);
    if (row === undefined) throw new Error(`${what} for field ${fieldId}, never scheduled`);
    return row;
  }

  private event(event: FieldEvent): void {
    switch (event.type) {
      case "fieldScheduled": {
        const row: FieldRow = {
          fieldId: event.payload.fieldId,
          severity: event.payload.severity,
          entered: false,
          missed: false,
          how: "scheduled",
          impacts: 0,
          hullLost: 0,
          firstImpactTick: null,
          firstReportTick: null,
          stuckSinceTick: null,
          stuckTicks: 0,
          tickerLines: 0,
        };
        this.rows.set(row.fieldId, row);
        this.current = row;
        return;
      }
      case "fieldMissed": {
        const row = this.row(event.payload.fieldId, "fieldMissed");
        row.missed = true;
        row.how = "missed";
        return;
      }
      case "fieldEntered": {
        const row = this.row(event.payload.fieldId, "fieldEntered");
        row.entered = true;
        row.how = "open";
        return;
      }
      case "asteroidImpact": {
        const row = this.row(event.payload.fieldId, "asteroidImpact");
        row.impacts += 1;
        row.hullLost += event.payload.hullDamage;
        row.firstImpactTick ??= event.tick;
        return;
      }
      case "shipStuck":
        this.row(event.payload.fieldId, "shipStuck").stuckSinceTick = event.tick;
        return;
      case "shipUnstuck":
        this.unstick(this.row(event.payload.fieldId, "shipUnstuck"), event.tick);
        return;
      case "fieldCleared": {
        const row = this.row(event.payload.fieldId, "fieldCleared");
        this.unstick(row, event.tick);
        row.how = event.payload.how;
        return;
      }
      case "intercomReport": {
        this.reports += 1;
        const row = this.current;
        if (row !== undefined && row.firstImpactTick !== null && row.firstReportTick === null) {
          row.firstReportTick = event.tick;
        }
        return;
      }
      case "hullPatched":
        this.patched += 1;
        return;
      case "hullPlated":
        this.plated += 1;
        return;
      case "machineMended":
        this.mended += 1;
        return;
      case "scoutSent":
        this.scouts += 1;
        return;
      case "shipLost":
        this.lostAtTick = event.tick;
        if (this.current !== undefined) this.unstick(this.current, event.tick);
        return;
      default:
        return;
    }
  }

  private unstick(row: FieldRow, tick: number): void {
    if (row.stuckSinceTick === null) return;
    row.stuckTicks += tick - row.stuckSinceTick;
    row.stuckSinceTick = null;
  }

  /** The tally at `endTick` (a field still stuck is counted stuck up to it). */
  result(endTick: number, hull: { readonly integrity: number; readonly max: number }) {
    const fields = [...this.rows.values()].map((row): FieldBeats => {
      const stuckTicks =
        row.stuckTicks + (row.stuckSinceTick === null ? 0 : endTick - row.stuckSinceTick);
      return {
        fieldId: row.fieldId,
        severity: row.severity,
        entered: row.entered,
        missed: row.missed,
        how: row.how,
        impacts: row.impacts,
        hullLost: row.hullLost,
        stuckSeconds: stuckTicks / this.tickRate,
        firstReportSeconds:
          row.firstImpactTick === null || row.firstReportTick === null
            ? null
            : (row.firstReportTick - row.firstImpactTick) / this.tickRate,
        tickerLines: row.tickerLines,
      };
    });
    const bySeverity = Object.fromEntries(
      FIELD_SEVERITIES.map((severity) => {
        const of = fields.filter((f) => f.severity === severity);
        const sum = (pick: (f: FieldBeats) => number) => of.reduce((n, f) => n + pick(f), 0);
        return [
          severity,
          {
            scheduled: of.length,
            entered: of.filter((f) => f.entered).length,
            missed: of.filter((f) => f.missed).length,
            impacts: sum((f) => f.impacts),
            hullLost: sum((f) => f.hullLost),
            stuckSeconds: sum((f) => f.stuckSeconds),
          },
        ];
      }),
    ) as Record<FieldSeverity, SeverityBeats>;
    const result: FieldTallyResult = {
      plan: this.plan,
      fields,
      bySeverity,
      scarsPatched: this.patched,
      scarsPlated: this.plated,
      machinesMended: this.mended,
      scoutsSent: this.scouts,
      intercomReports: this.reports,
      lostAtSeconds: this.lostAtTick === null ? null : this.lostAtTick / this.tickRate,
      hullAtEnd: hull.integrity,
      hullMax: hull.max,
    };
    return result;
  }
}

const fmt = (n: number, digits = 1): string => n.toFixed(digits);

/** The report's field section for one run. */
export function fieldSection(r: FieldTallyResult): string[] {
  if (r.plan === "none") return ["", "Fields: none scheduled (--fields none)."];
  const lines = [
    "",
    `Fields (--fields ${r.plan}, one a leg as its transit begins, detection rolled):`,
  ];
  lines.push(
    "",
    "| Severity | Scheduled | Entered | Missed | Rocks | Hull lost | Hull lost per field | Stuck s |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const severity of FIELD_SEVERITIES) {
    const s = r.bySeverity[severity];
    const perField = s.entered === 0 ? "n/a" : fmt(s.hullLost / s.entered);
    lines.push(
      `| ${severity} | ${s.scheduled} | ${s.entered} | ${s.missed} | ${s.impacts} | ${fmt(s.hullLost, 0)} | ${perField} | ${fmt(s.stuckSeconds, 0)} |`,
    );
  }
  lines.push(
    "",
    "| Field | Severity | How | Rocks | Hull lost | Stuck s | First report s | Field ticker lines |",
    "|---|---|---|---|---|---|---|---|",
    ...r.fields.map(
      (f) =>
        `| ${f.fieldId} | ${f.severity} | ${f.how} | ${f.impacts} | ${fmt(f.hullLost, 0)} | ${fmt(f.stuckSeconds, 0)} | ${f.firstReportSeconds === null ? "none" : fmt(f.firstReportSeconds)} | ${f.tickerLines} |`,
    ),
  );
  if (r.fields.length === 0) lines.push("| (none) | | | | | | | |");
  const lost = r.lostAtSeconds === null ? "no" : `yes, at ${fmt(r.lostAtSeconds, 0)} s`;
  lines.push(
    "",
    `Hull at the end: ${fmt(r.hullAtEnd, 0)}/${r.hullMax}. Ship lost: ${lost}. Scars patched ${r.scarsPatched}, plated ${r.scarsPlated}; machines mended ${r.machinesMended}; scouts sent ${r.scoutsSent}; intercom reports ${r.intercomReports}.`,
  );
  return lines;
}
