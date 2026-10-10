import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import type { CommandOfKind } from "../../core/types/commands";
import type { ActorId, MachineId } from "../../core/types/ids";
import { FIX, PORTS, advanceToStage, freightTestWorld } from "../travel/fixtures";
import { registerField } from "./index";

type Payload = CommandOfKind<"scheduleField">["payload"];
type Test = ReturnType<typeof freightTestWorld>;

/** The freight fixture with the field registered (the gate's command; the system is a stub). */
function fieldWorld(): Test {
  const test = freightTestWorld();
  registerField(test.registry);
  return test;
}

const heavy: Payload = {
  severity: "heavy",
  detection: "rolled",
  windowTicks: [20, 40],
  scripted: [],
};

function schedule(test: Test, payload: Payload) {
  return test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "scenario", kind: "scheduleField", payload }),
  );
}

const rejection = (result: ReturnType<typeof schedule>) =>
  result.status === "rejected" ? result.rejection : undefined;

function planCourse(test: Test): void {
  test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "scenario", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
  );
  test.kernel.advance(test.world, 1);
}

function engineId(test: Test): MachineId {
  const engine = Object.values(test.world.state.machines).find((m) => m.defId === FIX.engine);
  if (engine === undefined) throw new Error("no engine");
  return engine.id;
}

describe("scheduleField (§scheduling-a-field, slice 5 calls 2, 19, 20)", () => {
  it("is refused docked with no course, and placed scheduled once a course is planned", () => {
    const test = fieldWorld();
    expect(rejection(schedule(test, heavy))?.reason).toContain("no course planned");
    planCourse(test);
    expect(schedule(test, heavy).status).toBe("accepted");
    test.kernel.advance(test.world, 1);
    const field = test.world.state.field;
    expect(field?.phase).toEqual({ kind: "scheduled" });
    expect(field?.severity).toBe("heavy");
    expect(field?.startsAtTick).toBeGreaterThanOrEqual(test.world.state.tick + 19);
  });

  it("holds one field per leg", () => {
    const test = fieldWorld();
    planCourse(test);
    schedule(test, heavy);
    test.kernel.advance(test.world, 1);
    expect(rejection(schedule(test, heavy))?.reason).toContain("one per leg");
  });

  it("is dropped, missed, when the course is given up before the leg begins", () => {
    const test = fieldWorld();
    planCourse(test);
    schedule(test, heavy);
    test.kernel.advance(test.world, 1);
    // The course given up in port: docked again with nothing planned.
    test.world.state.travel = { stage: "docked", portId: PORTS.a };
    const events = test.kernel.advance(test.world, 1).events;
    expect(events.some((e) => e.type === "fieldMissed")).toBe(true);
    expect(test.world.state.field).toBeUndefined();
  });

  it("refuses a person as a target until bodies, and an unknown machine", () => {
    const test = fieldWorld();
    planCourse(test);
    const at = (target: Payload["scripted"][number]["target"]): Payload => ({
      ...heavy,
      scripted: [{ atSeconds: 10, target }],
    });
    const person = rejection(schedule(test, at({ kind: "actor", actorId: "a1" as ActorId })));
    expect(person?.reason).toContain("people are not targets");
    const ghost = rejection(
      schedule(test, at({ kind: "machine", machineId: "m999" as MachineId })),
    );
    expect(ghost?.code).toBe("unknownEntity");
    expect(schedule(test, at({ kind: "machine", machineId: engineId(test) })).status).toBe(
      "accepted",
    );
  });

  it("refuses more scripted impacts than maxScripted, and one past the field's length", () => {
    const test = fieldWorld();
    planCourse(test);
    const target = { kind: "machine" as const, machineId: engineId(test) };
    const four = Array.from({ length: 4 }, (_, i) => ({
      atSeconds: i,
      target,
      rock: "small" as const,
    }));
    expect(rejection(schedule(test, { ...heavy, scripted: four }))?.code).toBe("outOfBounds");
    const late = [{ atSeconds: 135, target }];
    expect(rejection(schedule(test, { ...heavy, scripted: late }))?.code).toBe("outOfBounds");
  });

  it("refuses scripted impacts that alone would sink the ship, pricing an unsized rock large", () => {
    const test = fieldWorld();
    planCourse(test);
    const target = { kind: "machine" as const, machineId: engineId(test) };
    test.world.state.hull = {
      integrity: 16,
      max: 100,
      scars: [
        {
          id: "r1" as never,
          fieldId: "f1" as never,
          tile: { x: 1, y: 1 },
          compartmentId: Object.keys(test.world.state.compartments)[0] as never,
          rock: "large",
          damage: 84,
          recovered: 0,
          patched: false,
          tick: 0,
        },
      ],
    };
    test.world.state.nextId = { ...test.world.state.nextId, field: 2, scar: 2 };
    // Two unsized rocks: 16 at the large price, the whole hull left.
    const sinking = [
      { atSeconds: 5, target },
      { atSeconds: 10, target },
    ];
    expect(rejection(schedule(test, { ...heavy, scripted: sinking }))?.reason).toContain(
      "would sink the ship",
    );
    const survivable = sinking.map((impact) => ({ ...impact, rock: "small" as const }));
    expect(schedule(test, { ...heavy, scripted: survivable }).status).toBe("accepted");
  });

  it("never starts sooner than the warning, so the helm's check is never already past", () => {
    const test = fieldWorld();
    planCourse(test);
    schedule(test, { ...heavy, windowTicks: [0, 0] });
    test.kernel.advance(test.world, 1);
    const warning = test.world.config.values.field.warningSeconds;
    const tickRate = test.world.config.values.time.tickRate;
    expect(test.world.state.field?.startsAtTick).toBeGreaterThanOrEqual(
      test.world.state.tick + warning * tickRate,
    );
  });

  it("is refused once the ship is lost", () => {
    const test = fieldWorld();
    planCourse(test);
    test.world.state.hull.lostAtTick = test.world.state.tick;
    expect(rejection(schedule(test, heavy))?.reason).toContain("the ship is lost");
  });

  it("is refused once the leg's transit is over", () => {
    const test = fieldWorld();
    planCourse(test);
    advanceToStage(test.kernel, test.world, "approaching");
    expect(rejection(schedule(test, heavy))?.reason).toContain("transit is over");
  });
});
