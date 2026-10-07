/**
 * Damage response's task derivation (slice 5 calls 21–23, D94's scouts) on the damage fixture:
 * a damaged machine derives one welder repair sized by what is missing; a scar derives a patch
 * while a kit is aboard and a plate while docked with plating aboard; the plating shortfall
 * derives commerce's purchase; a room to check derives a walk to its door.
 */
import { describe, expect, it } from "vitest";
import { allocateId } from "../../core/ids";
import type { DerivationCtx, Problem, ProblemOfKind } from "../../core/types/work";
import { LOUNGE, loungeStepCtx, runFor } from "../recreation/fixtures/lounge-deck";
import { PORTS } from "../travel/fixtures";
import {
  BENCH_SEAT,
  DAMAGE,
  LOUNGE_FLOOR,
  damageWorld,
  machineAt,
  room,
  strike,
} from "./fixtures/damage-deck";
import { damageMachine } from "./machines";
import { damageTaskDerivations } from "./tasks";

type World = ReturnType<typeof damageWorld>["world"];

const derivation = (world: World): DerivationCtx => ({
  content: world.content,
  config: world.config.values,
  tick: world.state.tick,
  state: world.state,
});

function openProblem<K extends Problem["kind"]>(world: World, kind: K): ProblemOfKind<K> {
  const found = Object.values(world.state.work.problems).find(
    (p): p is ProblemOfKind<K> => p.kind === kind && p.status === "open",
  );
  if (found === undefined) throw new Error(`no open ${kind}`);
  return found;
}

function settled(options: Parameters<typeof damageWorld>[0] = {}) {
  const fixture = damageWorld(options);
  runFor(fixture, 1);
  return fixture;
}

describe("machineDamaged → repairDamage", () => {
  it("is one welder job for an engineer at the machine, sized by the integrity missing", () => {
    const { world } = settled();
    const bench = world.state.machines[machineAt(world, "workbench")];
    if (bench === undefined) throw new Error("no workbench");
    damageMachine(loungeStepCtx(world).ctx, bench, 0.4);
    const [spec, ...rest] = damageTaskDerivations.machineDamaged(
      openProblem(world, "machineDamaged"),
      derivation(world),
    );
    expect(rest).toHaveLength(0);
    expect(spec).toMatchObject({
      type: "repairDamage",
      target: { kind: "machine", machineId: bench.id },
      baseUrgency: "essentialOperation",
      requiredSkills: [{ skill: "engineering", min: 1 }],
      requiredTools: ["welder"],
      consumables: [],
      interactionTiles: [BENCH_SEAT],
      progressRef: { kind: "integrity", machineId: bench.id },
      completion: { kind: "problemResolved" },
    });
    expect(spec?.estimatedWorkSeconds).toBeCloseTo(0.4 * 30);
  });
});

describe("hullScar → patchHull and plateHull", () => {
  it("patches with a kit aboard, beside the scar, and plates nothing without plating", () => {
    const { world } = settled();
    const hit = strike(world, LOUNGE_FLOOR);
    const specs = damageTaskDerivations.hullScar(openProblem(world, "hullScar"), derivation(world));
    expect(specs.map((s) => s.type)).toEqual(["patchHull"]);
    expect(specs[0]).toMatchObject({
      target: { kind: "scar", scarId: hit.scarId },
      requiredSkills: [{ skill: "engineering", min: 1 }],
      requiredTools: ["welder"],
      consumables: [{ itemDefId: DAMAGE.kit, count: 1 }],
      progressRef: { kind: "scar", scarId: hit.scarId },
      completion: { kind: "stepsDone" },
      estimatedWorkSeconds: 20,
    });
    // The scar's own tile first, then its neighbours in the lounge but for the two a machine
    // stands on (the games table at (5,2) and the vid screen at (7,1)).
    const tiles = specs[0]?.interactionTiles ?? [];
    expect(tiles[0]).toEqual(LOUNGE_FLOOR);
    expect(tiles).toHaveLength(7);
    expect(tiles).not.toContainEqual({ x: 5, y: 2 });
    expect(tiles).not.toContainEqual({ x: 7, y: 1 });
  });

  it("derives nothing with neither a kit nor a plate aboard", () => {
    const { world } = settled({ kits: false });
    strike(world, LOUNGE_FLOOR);
    expect(
      damageTaskDerivations.hullScar(openProblem(world, "hullScar"), derivation(world)),
    ).toEqual([]);
  });

  it("plates while docked with a plate aboard, and patches no scar already patched", () => {
    const { world } = settled();
    const hit = strike(world, LOUNGE_FLOOR);
    const scar = world.state.hull.scars.find((s) => s.id === hit.scarId);
    if (scar === undefined) throw new Error("no scar");
    // Patched already (by hand here: the hull bar is not what this test reads).
    scar.patched = true;
    const plateId = allocateId(world.state, "item");
    world.state.items[plateId] = {
      id: plateId,
      defId: DAMAGE.plating,
      stacking: "stack",
      count: 1,
      reserved: 0,
      location: { kind: "onDeck", deckId: LOUNGE.deck, x: 3.5, y: 2.5 },
    };
    const specs = damageTaskDerivations.hullScar(openProblem(world, "hullScar"), derivation(world));
    expect(specs.map((s) => s.type)).toEqual(["plateHull"]);
    expect(specs[0]).toMatchObject({
      consumables: [{ itemDefId: DAMAGE.plating, count: 1 }],
      completion: { kind: "problemResolved" },
      estimatedWorkSeconds: 40,
    });
  });
});

describe("hullDamaged → buyParts", () => {
  it("buys the plates from the market the ship is docked at", () => {
    const fixture = settled({ plating: { count: 5, price: 20 } });
    const { world } = fixture;
    strike(world, LOUNGE_FLOOR);
    strike(world, BENCH_SEAT);
    runFor(fixture, 0.05);
    const problem = openProblem(world, "hullDamaged");
    expect(problem.payload).toEqual({ itemDefId: DAMAGE.plating, count: 2 });
    const [spec] = damageTaskDerivations.hullDamaged(problem, derivation(world));
    expect(spec).toMatchObject({
      type: "buyParts",
      target: { kind: "market", portId: PORTS.a },
      progressRef: { kind: "market", portId: PORTS.a, itemDefId: DAMAGE.plating, count: 2 },
    });
  });
});

describe("compartmentToCheck → checkCompartment", () => {
  it("walks to the room's door tiles, with no skill or tool, for checkSeconds", () => {
    const { world } = settled();
    const gym = room(world, "gym");
    const [spec] = damageTaskDerivations.compartmentToCheck(
      {
        id: "p999" as never,
        kind: "compartmentToCheck",
        payload: { compartmentId: gym },
        owner: "damage",
        visibility: "public",
        dedupeKey: `check:${gym}`,
        status: "open",
        createdTick: world.state.tick,
        revision: 1,
        baseUrgency: "essentialOperation",
        location: { kind: "compartment", compartmentId: gym },
      },
      derivation(world),
    );
    expect(spec).toMatchObject({
      type: "checkCompartment",
      target: { kind: "compartment", compartmentId: gym },
      requiredSkills: [],
      requiredTools: [],
      estimatedWorkSeconds: 3,
    });
    // The gym (columns 9-11) opens onto the lounge west of column 9 and the bunkroom east of 11.
    const columns = new Set(spec?.interactionTiles.map((t) => t.x));
    expect([...columns].sort((a, b) => a - b)).toEqual([9, 11]);
  });
});
