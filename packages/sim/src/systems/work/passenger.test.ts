/**
 * Passengers aboard (passengers-and-galaxy §3.2, §5): a passenger on the furnished crew deck
 * never plans work or a post, but eats, sleeps and joins ambient conversation like anyone else;
 * the roster and the render frame mark them apart; while disembarking the planner leaves them
 * to commerce.
 */
import { describe, expect, it } from "vitest";
import { newActor } from "../../core/command-handlers";
import { TINY } from "../../core/fixtures/tiny-content";
import { allocateId } from "../../core/ids";
import { getRenderFrame } from "../../core/render";
import type { TileCoord } from "../../core/types/common";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { PlannerConfig } from "../../core/types/pipeline";
import { enumerateCandidates } from "../../planner/candidates";
import { selectIntent } from "../../planner/select";
import { DECK12 } from "../spatial/fixtures/deck-12x8";
import { GALLEY_TILE, JON, MARA, addCrateToLoad, crewWorld, place } from "./fixtures/crew-deck";
import { eventsOf, run } from "./fixtures/run";

/** Add a passenger (the generic template is not in this fixture; any crew def gives a body). */
function addPassenger(world: World, name: string, tile: TileCoord): ActorId {
  const def = world.content.crew[TINY.mara];
  if (def === undefined) throw new Error("fixture changed");
  const id: ActorId = allocateId(world.state, "actor");
  const actor = newActor(id, def, {
    kind: "onDeck",
    deckId: DECK12.deck,
    x: tile.x + 0.5,
    y: tile.y + 0.5,
  });
  actor.name = name;
  actor.roleTags = [];
  actor.skills = { cargo: 5 };
  actor.passenger = true;
  world.state.actors[id] = actor;
  return id;
}

function plannerConfig(world: World): PlannerConfig {
  const {
    work,
    urgency,
    needs,
    time,
    galley,
    recreation,
    social,
    mood,
    field,
    damage,
    intercom,
    expedition,
    bodies,
    medical,
  } = world.config.values;
  return {
    work,
    urgency,
    needs,
    time,
    galley,
    recreation,
    social,
    mood,
    field,
    damage,
    intercom,
    expedition,
    bodies,
    medical,
  };
}

describe("a passenger aboard", () => {
  it("never plans work or a post, even with cargo waiting and the skill for it", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    place(world, MARA, { x: 1, y: 2 });
    place(world, JON, { x: 11, y: 5 });
    const halla = addPassenger(world, "Halla Thorne", { x: 2, y: 6 });
    addCrateToLoad(world, { x: 3, y: 6 });
    // Tasks derive every few ticks; let the haul task exist before asking the passenger's view.
    run(tw, 12);
    const view = kernel.getAgentView(world, halla);
    expect(view.self.passenger).toBe(true);
    expect(view.knownTasks().length).toBeGreaterThan(0);
    const { candidates } = enumerateCandidates(view, plannerConfig(world));
    expect(candidates.filter((c) => c.choice.kind === "task")).toEqual([]);
    expect(candidates.filter((c) => c.ref === "post")).toEqual([]);
    const log = run(tw, 20 * 30);
    expect(eventsOf(log, "taskClaimed").some((e) => e.subjectIds[0] === halla)).toBe(false);
    expect(world.state.actors[halla]?.activity.kind).not.toBe("task");
  });

  it("eats from the galley and sleeps in a bunk through the needs system", () => {
    const tw = crewWorld();
    const { world } = tw;
    place(world, MARA, { x: 1, y: 2 });
    place(world, JON, { x: 11, y: 5 });
    const halla = addPassenger(world, "Halla Thorne", { x: 1, y: 5 });
    const actor = world.state.actors[halla];
    if (actor === undefined) throw new Error("no passenger");
    actor.needs.hunger = 0.6;
    const meal = run(tw, 20 * 60, () => actor.needs.hunger < 0.35);
    const ate = eventsOf(meal, "ateMeal").filter((e) => e.subjectIds[0] === halla);
    expect(ate).toHaveLength(1);
    expect(meal.labels[halla]).toContain("walking to the galley");
    const galley = actor.location;
    expect(galley.kind === "onDeck" && Math.abs(galley.x - (GALLEY_TILE.x + 0.5)) < 2).toBe(true);

    actor.needs.fatigue = 0.8;
    const nap = run(tw, 20 * 90, () => (meal.labels[halla] ?? []).includes("asleep"));
    expect([...(nap.labels[halla] ?? [])]).toContain("asleep");
    expect(eventsOf(nap, "fellAsleep").some((e) => e.subjectIds[0] === halla)).toBe(true);
  });

  it("joins ambient conversation with the crew", () => {
    const tw = crewWorld();
    const { world } = tw;
    place(world, MARA, { x: 1, y: 2 });
    place(world, JON, { x: 5, y: 6 });
    const halla = addPassenger(world, "Halla Thorne", { x: 6, y: 6 });
    const log = run(tw, 20 * 10);
    const chats = eventsOf(log, "conversation").filter((e) => e.subjectIds.includes(halla));
    expect(chats.length).toBeGreaterThan(0);
    expect(chats[0]?.payload.line).toContain("Halla Thorne");
  });

  it("is listed on the roster and in the render frame as a passenger", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    const halla = addPassenger(world, "Halla Thorne", { x: 2, y: 6 });
    const roster = kernel.getAgentView(world, MARA).roster();
    expect(roster.find((r) => r.actorId === halla)).toMatchObject({
      name: "Halla Thorne",
      passenger: true,
    });
    expect(roster.find((r) => r.actorId === MARA)?.passenger).toBeUndefined();
    const frame = getRenderFrame(world);
    expect(frame.actors.find((a) => a.id === halla)?.passenger).toBe(true);
    expect(frame.actors.find((a) => a.id === MARA)?.passenger).toBe(false);
  });

  it("drops off the roster and the render frame once off the ship (ashore, left behind or put off)", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    const halla = addPassenger(world, "Halla Thorne", { x: 2, y: 6 });
    const actor = world.state.actors[halla];
    if (actor === undefined) throw new Error("no passenger");
    actor.availability = "offShip";
    actor.location = { kind: "inExternalStore", portId: TINY.port, storeKey: "warehouse" };
    const roster = kernel.getAgentView(world, MARA).roster();
    expect(roster.map((r) => r.actorId)).toEqual([MARA, JON]);
    expect(getRenderFrame(world).actors.map((a) => a.id)).not.toContain(halla);
  });

  it("keeps out of the planner's way while disembarking", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    const halla = addPassenger(world, "Halla Thorne", { x: 2, y: 6 });
    const actor = world.state.actors[halla];
    if (actor === undefined) throw new Error("no passenger");
    actor.needs.hunger = 0.9;
    actor.disembarking = true;
    const view = kernel.getAgentView(world, halla);
    expect(view.self.disembarking).toBe(true);
    expect(enumerateCandidates(view, plannerConfig(world)).candidates).toEqual([]);
    expect(selectIntent(view, plannerConfig(world))).toEqual({ kind: "continue" });
  });
});
