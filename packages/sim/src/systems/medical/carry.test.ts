/**
 * §extraction on the medical fixture: a crew member down on the bridge with wounds to treat is
 * carried to the medbay bed in the hold and treated there; the carry is derived only while they
 * are down off a free bed; a carrier who stops sets them down where they stand, and the carry is
 * derived afresh from there; a patient who dies in someone's arms is set down.
 */
import { describe, expect, it } from "vitest";
import type { World } from "../../core/types/kernel";
import type { TaskSpec } from "../../core/types/work";
import { abortActivity } from "../work/execute";
import { medBedOf, onTheBed } from "./bed";
import {
  BEDSIDE,
  JAX,
  PRIYA,
  actorOf,
  bodiesWorldViolations,
  medicalWorld,
  ofType,
  runFor,
  runUntil,
  stepCtxOf,
  underWay,
  woundNow,
  woundedProblems,
} from "./fixtures/medical-deck";
import { sweepWounded } from "./medical";
import { medicalTaskDerivations } from "./tasks";

/** A tile on the bridge, across the ship from the bed. */
const BRIDGE = { x: 13, y: 3 };

/** Put `PRIYA` on the bridge and break both her legs: down (no movement), not bleeding. */
function downOnTheBridge(world: World): void {
  const priya = actorOf(world, PRIYA);
  if (priya.location.kind !== "onDeck") throw new Error("Priya is not on deck");
  priya.location = { ...priya.location, x: BRIDGE.x + 0.5, y: BRIDGE.y + 0.5 };
  woundNow(world, PRIYA, { part: "leftLeg", severity: "grave", type: "blunt" });
  woundNow(world, PRIYA, { part: "rightLeg", severity: "grave", type: "blunt" });
  if (priya.availability !== "incapacitated") throw new Error("Priya is not down");
}

function derive(world: World): TaskSpec[] {
  const { ctx } = stepCtxOf(world);
  sweepWounded(ctx);
  const problem = woundedProblems(world).find((p) => p.status === "open");
  if (problem === undefined) throw new Error("no wounded problem");
  return medicalTaskDerivations.crewWounded(problem, {
    content: world.content,
    config: world.config.values,
    tick: world.state.tick,
    state: world.state,
  });
}

const carrierOf = (world: World) =>
  Object.values(world.state.actors).find((a) => {
    const location = actorOf(world, PRIYA).location;
    return location.kind === "carriedBy" && location.actorId === a.id;
  });

const labels = (world: World): string[] =>
  Object.values(world.state.actors).map((a) =>
    a.activity.kind === "idle" ? "" : (a.activity.label ?? ""),
  );

describe("the carry's derivation (§extraction)", () => {
  it("is derived for a crew member down off a free bed, in place of the treatment", () => {
    const { world } = medicalWorld();
    downOnTheBridge(world);
    const specs = derive(world);
    expect(specs).toMatchObject([
      {
        derivationKey: `carry:0:${BRIDGE.x},${BRIDGE.y}`,
        type: "carryCasualty",
        target: { kind: "actor", actorId: PRIYA },
        requiredSkills: [],
        consumables: [],
        workerSlots: 1,
        progressRef: { kind: "casualty", actorId: PRIYA },
        completion: { kind: "stepsDone" },
        baseUrgency: "routineObligation",
      },
    ]);
    // The carrier stands beside her, never on her tile.
    const tiles = specs[0]?.interactionTiles ?? [];
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles).not.toContainEqual(BRIDGE);
    for (const t of tiles) {
      expect(Math.max(Math.abs(t.x - BRIDGE.x), Math.abs(t.y - BRIDGE.y))).toBe(1);
    }
  });

  it("is essential while a wound bleeds", () => {
    const { world } = medicalWorld();
    downOnTheBridge(world);
    woundNow(world, PRIYA, { part: "leftArm", severity: "serious", type: "blaster" });
    expect(derive(world)).toMatchObject([
      { type: "carryCasualty", baseUrgency: "essentialOperation" },
    ]);
  });

  it("is not derived while someone else lies at the bed", () => {
    const { world } = medicalWorld();
    downOnTheBridge(world);
    const jax = actorOf(world, JAX);
    if (jax.location.kind !== "onDeck") throw new Error("Jax is not on deck");
    jax.location = { ...jax.location, x: BEDSIDE.x + 0.5, y: BEDSIDE.y + 0.5 };
    expect(derive(world)).toEqual([]);
  });

  it("is not derived for someone who can walk, or who already lies at the bed", () => {
    const walking = medicalWorld();
    woundNow(walking.world, PRIYA, { part: "leftLeg", severity: "serious", type: "blaster" });
    expect(derive(walking.world).map((s) => s.type)).toEqual(["treatWounds"]);

    const onBed = medicalWorld();
    downOnTheBridge(onBed.world);
    const priya = actorOf(onBed.world, PRIYA);
    if (priya.location.kind !== "onDeck") throw new Error("Priya is not on deck");
    priya.location = { ...priya.location, x: BEDSIDE.x + 0.5, y: BEDSIDE.y + 0.5 };
    expect(derive(onBed.world).map((s) => s.type)).toEqual(["treatWounds"]);
  });
});

describe("the carry (§extraction)", () => {
  it("carries a downed crew member to the bed, and a medic treats them there", () => {
    const test = medicalWorld();
    const { world } = test;
    downOnTheBridge(world);
    runUntil(test, 120, (w) => carrierOf(w) !== undefined);
    const carrier = carrierOf(world);
    expect(carrier).toBeDefined();
    if (carrier === undefined) return;
    // The body goes where the carrier goes.
    runFor(test, 1);
    expect(actorOf(world, PRIYA).location).toEqual({ kind: "carriedBy", actorId: carrier.id });
    expect(labels(world)).toContain("carrying Priya Kessler to the medbay");

    const carried = runUntil(test, 120, (w) => carrierOf(w) === undefined);
    const bed = medBedOf(world.state, world.content);
    if (bed === undefined) throw new Error("no bed");
    expect(onTheBed(world.state, bed, actorOf(world, PRIYA))).toBe(true);
    expect(ofType(carried, "casualtyCarried")).toMatchObject([
      { payload: { actorId: PRIYA, byActorId: carrier.id } },
    ]);

    runUntil(test, 180, (w) =>
      actorOf(w, PRIYA).body.wounds.every((x) => x.treatedTick !== undefined),
    );
    expect(actorOf(world, PRIYA).body.wounds.every((x) => x.treatedTick !== undefined)).toBe(true);
    expect(actorOf(world, PRIYA).availability).toBe("incapacitated");
    expect(onTheBed(world.state, bed, actorOf(world, PRIYA))).toBe(true);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("a carrier who stops sets the patient down where they stand, and the carry starts afresh", () => {
    const test = medicalWorld();
    const { world } = test;
    downOnTheBridge(world);
    runUntil(test, 120, (w) => carrierOf(w) !== undefined);
    runFor(test, 2);
    const carrier = carrierOf(world);
    if (carrier === undefined) throw new Error("nobody carries Priya");
    const { ctx } = stepCtxOf(world);
    abortActivity(ctx, carrier, "interrupted");
    const priya = actorOf(world, PRIYA);
    expect(priya.location).toMatchObject({ kind: "onDeck" });
    const at = carrier.location;
    if (at.kind !== "onDeck" || priya.location.kind !== "onDeck") throw new Error("off deck");
    expect([priya.location.x, priya.location.y]).toEqual([at.x, at.y]);
    const tile = { x: Math.floor(at.x), y: Math.floor(at.y) };
    expect(derive(world)).toMatchObject([{ derivationKey: `carry:0:${tile.x},${tile.y}` }]);

    const events = runUntil(test, 240, (w) =>
      actorOf(w, PRIYA).body.wounds.every((x) => x.treatedTick !== undefined),
    );
    expect(ofType(events, "casualtyCarried")).toHaveLength(1);
    expect(ofType(events, "woundTreated")).toHaveLength(1);
  });

  it("a patient who dies in the carrier's arms is set down, and the carry ends", () => {
    const test = medicalWorld();
    const { world } = test;
    // Under way: docked at a port, the dead would be carried ashore at once (§laid-to-rest).
    underWay(test, false);
    downOnTheBridge(world);
    runUntil(test, 120, (w) => carrierOf(w) !== undefined);
    const carrier = carrierOf(world);
    if (carrier === undefined) throw new Error("nobody carries Priya");
    actorOf(world, PRIYA).body.blood = 0.1;
    runUntil(test, 5, (w) => actorOf(w, PRIYA).availability === "dead");
    runFor(test, 1);
    expect(actorOf(world, PRIYA).availability).toBe("dead");
    expect(actorOf(world, PRIYA).location.kind).toBe("onDeck");
    expect(carrierOf(world)).toBeUndefined();
    const activity = actorOf(world, carrier.id).activity;
    const task = activity.kind === "task" ? world.state.work.tasks[activity.taskId] : undefined;
    expect(task?.type).not.toBe("carryCasualty");
    expect(
      Object.values(world.state.work.tasks).filter(
        (t) => t.type === "carryCasualty" && t.status !== "cancelled" && t.status !== "completed",
      ),
    ).toEqual([]);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("a bed taken mid-carry stops it; the carry comes back once the bed is free", () => {
    const test = medicalWorld();
    const { world } = test;
    downOnTheBridge(world);
    runUntil(test, 120, (w) => carrierOf(w) !== undefined);
    const carrier = carrierOf(world);
    if (carrier === undefined) throw new Error("nobody carries Priya");
    // Jax lies down at the bed (down himself, so he stays there).
    const jax = actorOf(world, JAX);
    if (jax.location.kind !== "onDeck") throw new Error("Jax is not on deck");
    jax.location = { ...jax.location, x: BEDSIDE.x + 0.5, y: BEDSIDE.y + 0.5 };
    woundNow(world, JAX, { part: "head", severity: "graze", type: "stun" });
    woundNow(world, JAX, { part: "head", severity: "graze", type: "stun" });
    expect(jax.availability).toBe("incapacitated");
    runFor(test, 3);
    expect(actorOf(world, PRIYA).location.kind).toBe("onDeck");
    const live = (w: World) =>
      Object.values(w.state.work.tasks).filter(
        (t) => t.type === "carryCasualty" && t.status !== "cancelled" && t.status !== "completed",
      );
    expect(live(world)).toEqual([]);

    jax.location = { ...jax.location, x: 6.5, y: 2.5 };
    const events = runUntil(test, 180, onBed);
    expect(ofType(events, "casualtyCarried")).toHaveLength(1);
  });
});

function onBed(world: World): boolean {
  const bed = medBedOf(world.state, world.content);
  return bed !== undefined && onTheBed(world.state, bed, actorOf(world, PRIYA));
}
