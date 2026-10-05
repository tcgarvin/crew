/**
 * The planner's helm rule (`planner/helm.ts`, D77) on the bridge fixture: only the sim's chosen
 * may claim a helm post, and helm tasks and the course plot skip `deferTo` and the off-duty rule.
 * Here rather than beside `planner/helm.ts` because the planner's boundary keeps its own tests off
 * the systems' fixtures.
 */
import { describe, expect, it } from "vitest";
import { watchTicks } from "../../core/clock";
import { cmd } from "../../core/fixtures/test-world";
import type { TestWorld } from "../../core/fixtures/test-world";
import type { ActorId } from "../../core/types/ids";
import type { PlannerConfig } from "../../core/types/pipeline";
import type { TaskView } from "../../core/types/view";
import { type CandidateSet, enumerateCandidates } from "../../planner/candidates";
import { PORTS, advanceThroughHooks } from "../travel/fixtures";
import { directSight, writeFact } from "../work/facts";
import { DERIVATION_EVERY_TICKS } from "../work/work";
import { JAX, MARA, NOOR, bridgeWorld, placeOnBridgeDeck } from "./fixtures/bridge-deck";

function plannerConfig(fixture: TestWorld): PlannerConfig {
  const { work, urgency, needs, time, galley } = fixture.world.config.values;
  return { work, urgency, needs, time, galley };
}

function candidatesOf(fixture: TestWorld, actorId: ActorId): CandidateSet & { tasks: TaskView[] } {
  const view = fixture.registry.buildAgentView(fixture.world, actorId);
  return { ...enumerateCandidates(view, plannerConfig(fixture)), tasks: [...view.knownTasks()] };
}

const refOf = (tasks: readonly TaskView[], type: TaskView["type"], key?: string): string => {
  const task = tasks.find((t) => t.type === type && (key === undefined || t.derivationKey === key));
  if (task === undefined) throw new Error(`no ${type} task`);
  return `task:${task.id}`;
};

function setCourse(fixture: TestWorld, plotted: boolean): void {
  fixture.kernel.enqueueCommand(
    fixture.world,
    cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
  );
  advanceThroughHooks(fixture.kernel, fixture.world, 1);
  const travel = fixture.world.state.travel;
  if (travel.stage !== "docked") throw new Error("left port");
  if (plotted) travel.coursePlotted = true;
  // The watch opens the post, and work derives tasks every `DERIVATION_EVERY_TICKS`.
  advanceThroughHooks(fixture.kernel, fixture.world, DERIVATION_EVERY_TICKS);
}

/** Noor sees Mara idle beside her, just now: what `deferTo` defers to. */
function noorSeesMaraIdle(fixture: TestWorld): void {
  const { world } = fixture;
  const noor = world.state.actors[NOOR];
  if (noor === undefined) throw new Error("no Noor");
  writeFact(
    noor,
    MARA,
    "actorStatus",
    { availability: "available", asleep: false, idle: true, tile: { x: 10, y: 1 } },
    directSight(noor, world.state.tick),
  );
}

describe("the planner's helm rule (D77)", () => {
  it("Noor takes Red's watch rather than defer to an idle, better-qualified Mara; Mara may not take it", () => {
    const fixture = bridgeWorld();
    placeOnBridgeDeck(fixture.world, NOOR, { x: 9, y: 1 });
    placeOnBridgeDeck(fixture.world, MARA, { x: 10, y: 1 });
    setCourse(fixture, true);
    noorSeesMaraIdle(fixture);
    const noor = candidatesOf(fixture, NOOR);
    const watch = refOf(noor.tasks, "staffStation", "staff:watch");
    expect(noor.candidates.map((c) => c.ref)).toContain(watch);
    expect(noor.rejected.filter((r) => r.ref === watch)).toEqual([]);
    const mara = candidatesOf(fixture, MARA);
    expect(mara.rejected).toContainEqual({ ref: watch, reason: "notMyHelm" });
    const jax = candidatesOf(fixture, JAX);
    expect(jax.rejected).toContainEqual({ ref: watch, reason: "notMyHelm" });
  });

  it("the oncoming claims before the bell though off duty", () => {
    const fixture = bridgeWorld();
    const watch = watchTicks(fixture.world.config.values);
    const lead = 30 * fixture.world.config.values.time.tickRate;
    advanceThroughHooks(fixture.kernel, fixture.world, watch - lead + 20);
    setCourse(fixture, true);
    const view = fixture.registry.buildAgentView(fixture.world, JAX);
    expect(view.self.onDuty).toBe(false);
    expect(view.self.watch.helmRole).toBe("oncoming");
    const jax = candidatesOf(fixture, JAX);
    const post = refOf(jax.tasks, "staffStation", "staff:watch");
    expect(jax.candidates.map((c) => c.ref)).toContain(post);
  });

  it("the course plot skips the off-duty rule and deferTo, like the helm", () => {
    const fixture = bridgeWorld();
    placeOnBridgeDeck(fixture.world, NOOR, { x: 9, y: 1 });
    placeOnBridgeDeck(fixture.world, MARA, { x: 10, y: 1 });
    setCourse(fixture, false);
    noorSeesMaraIdle(fixture);
    const noor = candidatesOf(fixture, NOOR);
    const plot = refOf(noor.tasks, "plotCourse");
    expect(noor.candidates.map((c) => c.ref)).toContain(plot);
  });

  it("an off-watch pilot plots when nobody on watch can", () => {
    const fixture = bridgeWorld();
    for (const id of [NOOR, MARA]) {
      const actor = fixture.world.state.actors[id];
      if (actor !== undefined) actor.availability = "offShip";
    }
    setCourse(fixture, false);
    // Jax stands White, the second watch: off duty now, and the only pilot aboard but Dane.
    const view = fixture.registry.buildAgentView(fixture.world, JAX);
    expect(view.self.onDuty).toBe(false);
    const jax = candidatesOf(fixture, JAX);
    const plot = refOf(jax.tasks, "plotCourse");
    expect(jax.rejected.filter((r) => r.ref === plot)).toEqual([]);
    expect(jax.candidates.map((c) => c.ref)).toContain(plot);
  });
});
