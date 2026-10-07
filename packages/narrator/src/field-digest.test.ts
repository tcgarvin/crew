/**
 * D92-D95 in the digest (slice 5 call 15): the field scheduled, in progress and crossed; the
 * alert; the hull with its scars; repairs at port and leaving with them unfinished; damage the
 * crew know of against damage nobody has seen; the intercom. The world comes from the in-code
 * fixtures and the field, scars, problems and facts are written by hand, so these hold whatever
 * the field and damage systems do.
 */
import type {
  ActorId,
  CompartmentId,
  EventId,
  FieldId,
  ItemDefId,
  MachineId,
  PortDefId,
  ProblemId,
  SaveEnvelope,
  ScarId,
  SimEvent,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildDigest } from "./digest";
import {
  INTERCOM_LINES_SHOWN,
  damageKnowledgeLine,
  fieldBudgetLine,
  fieldDigestLines,
  hullLine,
  portRepairLine,
} from "./field-digest";
import { approachRequest, quietTooLongRequest } from "./fixtures";
import { EMPTY_NOTES } from "./notes";
import { content } from "./test-support";

type State = SaveEnvelope["state"];
type Field = NonNullable<State["field"]>;
type Scar = State["hull"]["scars"][number];

const FIELD = "f1" as FieldId;

function inTransit(): SaveEnvelope {
  return structuredClone(quietTooLongRequest(content()).snapshot) as SaveEnvelope;
}

/** Docked at Kessler Drift, optionally with a course set onward. */
function dockedAt(plannedDestinationId?: string): SaveEnvelope {
  const snapshot = structuredClone(approachRequest(content()).snapshot) as SaveEnvelope;
  snapshot.state.travel = {
    stage: "docked",
    portId: "port.kessler_drift" as PortDefId,
    ...(plannedDestinationId === undefined
      ? {}
      : { plannedDestinationId: plannedDestinationId as PortDefId }),
  };
  return snapshot;
}

function room(state: State, key: string): CompartmentId {
  const compartment = Object.values(state.compartments).find((c) => c.key === key);
  if (compartment === undefined) throw new Error(`fixture: no room ${key}`);
  return compartment.id;
}

function machineOf(state: State, defId: string): MachineId {
  const machine = Object.values(state.machines).find((m) => m.defId === defId);
  if (machine === undefined) throw new Error(`fixture: no ${defId}`);
  return machine.id;
}

function actorNamed(state: State, name: string): ActorId {
  const actor = Object.values(state.actors).find((a) => a.name === name);
  if (actor === undefined) throw new Error(`fixture: no ${name}`);
  return actor.id;
}

function withField(state: State, field: Partial<Field>): Field {
  const placed: Field = {
    id: FIELD,
    severity: "heavy",
    detection: "rolled",
    startsAtTick: state.tick + 400,
    phase: { kind: "scheduled" },
    impacts: 0,
    stuckImpacts: 0,
    hullLost: 0,
    scripted: [],
    ...field,
  };
  state.field = placed;
  return placed;
}

/** A scar; the hull's integrity follows the scars, as the kernel's invariant keeps it. */
function scar(state: State, n: number, roomKey: string, extra: Partial<Scar> = {}): Scar {
  const made: Scar = {
    id: `r${n}` as ScarId,
    fieldId: FIELD,
    tile: { x: 1, y: 1 },
    compartmentId: room(state, roomKey),
    rock: "small",
    damage: 3,
    recovered: 0,
    patched: false,
    tick: state.tick - 100,
    ...extra,
  };
  state.hull.scars.push(made);
  state.hull.integrity =
    state.hull.max - state.hull.scars.reduce((sum, s) => sum + s.damage - s.recovered, 0);
  return made;
}

function problem(
  state: State,
  n: number,
  kind: string,
  payload: object,
  visibility = "discovered",
) {
  const id = `p${n}` as ProblemId;
  state.work.problems[id] = {
    id,
    kind,
    payload,
    owner: "damage",
    visibility,
    dedupeKey: `${kind}:${n}`,
    status: "open",
    createdTick: state.tick - 50,
    revision: 0,
    baseUrgency: "essential",
    location: { kind: "none" },
  } as never;
  return id;
}

function knows(state: State, actorId: ActorId, problemId: ProblemId): void {
  const actor = state.actors[actorId];
  if (actor === undefined) throw new Error("fixture: no actor");
  (actor.knowledge as Record<string, unknown>)[`${problemId}/problem`] = {
    subjectId: problemId,
    factType: "problem",
    value: { problemId, revision: 0 },
    observedTick: state.tick - 40,
    learnedTick: state.tick - 40,
    sourceId: actorId,
    evidence: "direct",
    certainty: "confirmed",
  };
}

function event<T extends SimEvent["type"]>(
  tick: number,
  type: T,
  payload: Extract<SimEvent, { type: T }>["payload"],
): SimEvent {
  return {
    id: `e${tick}` as EventId,
    tick,
    seq: 0,
    type,
    subjectIds: [],
    causeIds: [],
    source: "sim",
    significance: "notable",
    payload,
  } as unknown as SimEvent;
}

function lines(snapshot: SaveEnvelope, events: readonly SimEvent[] = []): string[] {
  return fieldDigestLines(snapshot.state, content(), snapshot.config, events);
}

describe("the field digest: no field, a whole hull", () => {
  it("says only the hull, unmarked, and that this leg has no field yet", () => {
    const snapshot = inTransit();
    expect(lines(snapshot)).toEqual(["hull: 100/100, unmarked"]);
    expect(fieldBudgetLine(snapshot.state)).toBe("fields: one per leg, none placed on this one");
    const text = buildDigest(snapshot, [], EMPTY_NOTES, content(), undefined).text;
    expect(text).toContain("\nhull: 100/100, unmarked\n");
    expect(text).toContain("fields: one per leg, none placed on this one");
  });
});

describe("the field digest: the leg's field", () => {
  it("shows a scheduled field with its detection and scripted hits, marked as nobody aboard knowing", () => {
    const snapshot = inTransit();
    const state = snapshot.state;
    const engine = machineOf(state, "machine.engine");
    withField(state, {
      detection: "unseen",
      startsAtTick: state.tick + 40 * snapshot.config.time.tickRate,
      scripted: [
        {
          atSeconds: 115,
          target: { kind: "machine", machineId: engine },
          rock: "small",
          effect: "knockout",
        },
        { atSeconds: 20, target: { kind: "compartment", compartmentId: room(state, "galley") } },
      ],
    });
    expect(lines(snapshot)[0]).toBe(
      `field scheduled: heavy asteroid field, unseen (no warning: the first rock is the news), begins in ~40s; your scripted hits: knockout on the Main Engine (${engine}) at 115s (small rock); a rolled hit on the Galley at 20s [scheduled; nobody aboard knows]`,
    );
    expect(fieldBudgetLine(state)).toBe("fields: this leg has its field");
  });

  it("says a scheduled field waits for transit while docked with a course set, and the helm's check for a rolled one", () => {
    const snapshot = dockedAt("port.ossory_station");
    const state = snapshot.state;
    withField(state, { startsAtTick: state.tick + 60 * snapshot.config.time.tickRate });
    expect(lines(snapshot)[0]).toBe(
      "field scheduled: heavy asteroid field, rolled (the helm's check ~12s before it), begins once she is in transit, no sooner than ~60s from now [scheduled; nobody aboard knows]",
    );
  });

  it("shows a field in progress: rocks, hull lost, how it was noticed, stuck or moving, the helm, the alert", () => {
    const snapshot = inTransit();
    const state = snapshot.state;
    const rate = snapshot.config.time.tickRate;
    withField(state, {
      startsAtTick: state.tick - 60 * rate,
      phase: {
        kind: "active",
        enteredTick: state.tick - 60 * rate,
        endsAtProgress: 300,
        stuckSinceTick: state.tick - 10 * rate,
      },
      noticedAtTick: state.tick - 50 * rate,
      impacts: 5,
      stuckImpacts: 2,
      hullLost: 18,
    });
    state.alert = { sinceTick: state.tick - 50 * rate, cause: "field", reports: {} };
    const [field, alert] = lines(snapshot);
    expect(field).toBe(
      `field: IN A HEAVY ASTEROID FIELD since t${state.tick - 60 * rate} (~60s), nobody saw it coming: noticed at the first rock, t${state.tick - 50 * rate}; 5 rocks so far, 18 hull points lost; STUCK since t${state.tick - 10 * rate} (engines out; drifts clear after 4 more rocks unless the engines come back); nobody at the helm`,
    );
    expect(alert).toBe(
      `alert: general alert since t${state.tick - 50 * rate} (field); until the rocks are behind her`,
    );
  });

  it("says a field the helm sighted was sighted, and that the ship is under way through it", () => {
    const snapshot = inTransit();
    const state = snapshot.state;
    withField(state, {
      startsAtTick: state.tick - 100,
      phase: { kind: "active", enteredTick: state.tick - 100, endsAtProgress: 300 },
      noticedAtTick: state.tick - 340,
      impacts: 1,
      hullLost: 3,
    });
    const [field] = lines(snapshot);
    expect(field).toContain(`sighted by the helm at t${state.tick - 340}`);
    expect(field).toContain("1 rock so far, 3 hull points lost; under way through it;");
  });

  it("shows a field crossed or drifted clear, with what it cost", () => {
    const snapshot = inTransit();
    const state = snapshot.state;
    withField(state, {
      phase: {
        kind: "ended",
        enteredTick: state.tick - 900,
        endedTick: state.tick - 20,
        how: "drifted",
      },
      impacts: 11,
      hullLost: 41,
    });
    expect(lines(snapshot)[0]).toBe(
      `field: drifted clear of a heavy asteroid field at t${state.tick - 20}: 11 rocks, 41 hull points lost`,
    );
    const alertClears = snapshot.config.time.tickRate * 30;
    state.alert = {
      sinceTick: state.tick - 800,
      cause: "field",
      clearsAtTick: state.tick + alertClears,
      reports: {},
    };
    expect(lines(snapshot)[1]).toBe(
      `alert: general alert since t${state.tick - 800} (field); stands down in ~30s`,
    );
  });
});

describe("the field digest: the hull", () => {
  it("counts scars unpatched and patched by room", () => {
    const snapshot = inTransit();
    const state = snapshot.state;
    withField(state, {});
    scar(state, 1, "cargoHold");
    scar(state, 2, "cargoHold", { rock: "large", damage: 8 });
    scar(state, 3, "galley", { patched: true, recovered: 1.5 });
    expect(hullLine(state, content())).toBe(
      "hull: 88/100; 2 scars unpatched (Cargo Hold x2); 1 patched, still to plate at a port (Galley)",
    );
  });

  it("says she left port damaged when scars from an earlier leg are still aboard in flight", () => {
    const snapshot = inTransit();
    const state = snapshot.state;
    scar(state, 1, "engineering", { fieldId: "f0" as FieldId, damage: 8, rock: "large" });
    expect(hullLine(state, content())).toBe(
      "hull: 92/100; 1 scar unpatched (Engineering); none patched; 1 scar from an earlier leg still costs 8 points: she left port damaged",
    );
  });

  it("says when the ship is lost", () => {
    const snapshot = inTransit();
    const state = snapshot.state;
    state.hull = { ...state.hull, integrity: 0, lostAtTick: state.tick - 5 };
    expect(hullLine(state, content())).toBe(
      `hull: 0/100: LOST at t${state.tick - 5}; the game is over`,
    );
    expect(fieldBudgetLine(state)).toBe("fields: none (the ship is lost)");
  });
});

describe("the field digest: repairs at port", () => {
  const plating = "item.hull_plating" as ItemDefId;

  it("says what is left to plate, that plating is sold here, and what the crew are buying", () => {
    const snapshot = dockedAt();
    const state = snapshot.state;
    scar(state, 1, "cargoHold", { patched: true, recovered: 1.5 });
    scar(state, 2, "galley");
    state.markets["port.kessler_drift" as PortDefId] = { [plating]: { count: 4, price: 90 } };
    problem(state, 1, "hullDamaged", { itemDefId: plating, count: 2 }, "public");
    expect(portRepairLine(state, content())).toBe(
      "repairs at port: 2 scars to plate (5 hull points to win back); hull plating sold here x4; the crew are buying 2 plates",
    );
  });

  it("says when this port has no plating, and when she is leaving with the repairs unfinished", () => {
    const snapshot = dockedAt("port.ossory_station");
    const state = snapshot.state;
    scar(state, 1, "cargoHold");
    state.markets["port.kessler_drift" as PortDefId] = {};
    expect(portRepairLine(state, content())).toBe(
      "repairs at port: 1 scar to plate (3 hull points to win back); no hull plating at Kessler Drift: the scars stay; LEAVING WITH REPAIRS UNFINISHED: course set for Ossory Station with the hull at 97/100",
    );
  });

  it("says nothing in flight or with a whole hull", () => {
    const flight = inTransit();
    scar(flight.state, 1, "galley");
    expect(portRepairLine(flight.state, content())).toBeUndefined();
    expect(portRepairLine(dockedAt().state, content())).toBeUndefined();
  });
});

describe("the field digest: damage known against damage that exists", () => {
  it("splits open damage by whether anyone aboard holds it", () => {
    const snapshot = inTransit();
    const state = snapshot.state;
    const stove = machineOf(state, "machine.galley_stove");
    const pump = machineOf(state, "machine.coolant_pump");
    const hold = scar(state, 1, "cargoHold");
    const galley = scar(state, 2, "galley");
    problem(state, 1, "hullScar", {
      scarId: hold.id,
      compartmentId: hold.compartmentId,
      tile: hold.tile,
    });
    const seen = problem(state, 2, "hullScar", {
      scarId: galley.id,
      compartmentId: galley.compartmentId,
      tile: galley.tile,
    });
    const damaged = problem(state, 3, "machineDamaged", { machineId: stove });
    problem(state, 4, "machineDamaged", { machineId: pump });
    const cook = actorNamed(state, "Bettina Solheim");
    knows(state, cook, seen);
    knows(state, cook, damaged);
    expect(damageKnowledgeLine(state, content())).toBe(
      `damage the crew know of: a scar in the Galley; the Galley Stove (${stove}) damaged. damage nobody aboard has seen: a scar in the Cargo Hold; the Coolant Pump (${pump}) damaged`,
    );
  });

  it("is absent with no open damage", () => {
    expect(damageKnowledgeLine(inTransit().state, content())).toBeUndefined();
  });
});

describe("the field digest: the intercom", () => {
  it("repeats the intercom reports since the last call, newest last, as the ticker says them", () => {
    const snapshot = inTransit();
    const state = snapshot.state;
    const cook = actorNamed(state, "Bettina Solheim");
    const stove = machineOf(state, "machine.galley_stove");
    const panel = machineOf(state, "machine.intercom");
    const galley = room(state, "galley");
    const reports = Array.from({ length: INTERCOM_LINES_SHOWN + 1 }, (_, i) =>
      event(state.tick - 10 + i, "intercomReport", {
        actorId: cook,
        panelId: panel,
        compartmentId: galley,
        damage: [
          { kind: "scar", compartmentId: galley },
          { kind: "machine", machineId: stove, out: true },
        ],
      }),
    );
    const said = lines(snapshot, reports).filter((l) => l.startsWith("intercom "));
    expect(said).toHaveLength(INTERCOM_LINES_SHOWN);
    expect(said[INTERCOM_LINES_SHOWN - 1]).toBe(
      `intercom t${state.tick - 10 + INTERCOM_LINES_SHOWN}: Bettina Solheim on the intercom: the galley's hit, the galley stove's out`,
    );
  });
});
