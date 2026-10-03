/**
 * D66: dock hands do D63's carting on foot. An offer's crates come out of the warehouse door on a
 * dock hand's trolley and are set down on the staging area; a declined offer's are fetched back
 * in; a delivery's are taken in by the job's receiver, who is on the dock when it comes
 * alongside. A walk that takes too long gives up into the instant behaviour, with an event; the
 * dock being cast off finishes whatever is still open. Departure never waits on any of it.
 */
import { describe, expect, it } from "vitest";
import { createDefLookup } from "../../core/defs";
import type { TestWorld } from "../../core/fixtures/test-world";
import { TINY } from "../../core/fixtures/tiny-content";
import { checkInvariants } from "../../core/invariants";
import { getRenderFrame } from "../../core/render";
import { createRngApi } from "../../core/rng";
import type { ConfigDef } from "../../core/types/content";
import type { EventDraft, SimEvent } from "../../core/types/events";
import type { JobId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { StepCtx } from "../../core/types/pipeline";
import { spatialViolations } from "../spatial/invariants";
import { ackHook, docksideConfig } from "../travel/fixtures-dock";
import { travelViolations } from "../travel/invariants";
import { dismissLocals } from "../travel/locals";
import { workViolations } from "../work/invariants";
import { errandFor } from "./dock-hands";
import { QUAY_WORK, dockWorkWorld, offerFreight, onTile, send, tileAt } from "./fixtures-dock";
import { commerceViolations } from "./invariants";

function hands(travel: Partial<ConfigDef["travel"]> = {}): TestWorld {
  return dockWorkWorld({ dockHands: true }, docksideConfig(travel));
}

function run(test: TestWorld, ticks: number, until?: (world: World) => boolean): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    ackHook(test);
    const result = test.kernel.advance(test.world, 1);
    events.push(...result.events);
    const broken = [
      ...checkInvariants(test.world.state),
      ...spatialViolations(test.world),
      ...workViolations(test.world),
      ...travelViolations(test.world),
      ...commerceViolations(test.world),
    ];
    if (broken.length > 0) throw new Error(`tick ${test.world.state.tick}: ${broken.join("; ")}`);
    if (until?.(test.world)) break;
  }
  return events;
}

const crates = (world: World, id: JobId) => world.state.jobs[id]?.cargoItemIds ?? [];

describe("dock hands (D66)", () => {
  it("cart an offer's crates out of the warehouse door onto the staging area", () => {
    const test = hands();
    const { world } = test;
    const id = offerFreight(test);
    // The offer is up; its crates are on a dock hand's trolley, not yet on the dock.
    expect(crates(world, id)).toEqual([]);
    const hand = errandFor(world, id, "stageOffer");
    expect(hand).toMatchObject({ role: "dock hand", origin: { kind: "dockHand" } });
    expect(hand?.carrying).toHaveLength(3);
    expect(getRenderFrame(world).locals.find((l) => l.id === hand?.id)).toMatchObject({
      carrying: 3,
      label: "bringing out 3 crates",
    });
    const events = run(test, 20 * 20, (w) => crates(w, id).length === 3);
    expect(
      crates(world, id).map((itemId) => tileAt(world.state.items[itemId]?.location)),
    ).toSatisfy((tiles: ReturnType<typeof tileAt>[]) =>
      tiles.every((t) => onTile(QUAY_WORK.staging, t)),
    );
    expect(events.some((e) => e.type === "freightStaged")).toBe(true);
    expect(events.some((e) => e.type === "dockHandGaveUp")).toBe(false);
    // Empty-handed, they go back in through the door and are gone.
    run(test, 20 * 20, (w) => w.state.dockside.locals[hand?.id ?? ("" as never)] === undefined);
    expect(world.state.dockside.locals[hand?.id ?? ("" as never)]).toBeUndefined();
  });

  it("fetch a declined offer's crates back in: on the dock until picked up, then gone", () => {
    const test = hands();
    const { world } = test;
    const id = offerFreight(test);
    run(test, 20 * 20, (w) => crates(w, id).length === 3);
    const staged = [...crates(world, id)];
    send(test, { source: "player", kind: "declineJob", payload: { jobId: id } });
    run(test, 1);
    const hand = errandFor(world, id, "withdrawOffer");
    expect(hand?.errand).toMatchObject({ phase: "fetch", itemIds: staged });
    // Still there, and still nobody's, while the hand walks out.
    expect(staged.every((itemId) => world.state.items[itemId] !== undefined)).toBe(true);
    const frame = getRenderFrame(world).items.filter((i) => i.jobId === id);
    expect(frame.every((i) => i.offered === true)).toBe(true);
    const events = run(test, 20 * 20, () =>
      staged.every((i) => world.state.items[i] === undefined),
    );
    expect(events.some((e) => e.type === "freightWithdrawn")).toBe(true);
    expect(crates(world, id)).toEqual([]);
    const back = hand === undefined ? undefined : world.state.dockside.locals[hand.id];
    expect(back?.carrying).toHaveLength(3);
    expect(back?.errand).toMatchObject({ phase: "return" });
  });

  it("give up a walk that takes too long and do the carting at once, saying so", () => {
    const test = hands({ dockHandGiveUpSeconds: 0.1 });
    const { world } = test;
    const id = offerFreight(test);
    const events = run(test, 10, (w) => crates(w, id).length === 3);
    expect(crates(world, id)).toHaveLength(3);
    const gaveUp = events.find((e) => e.type === "dockHandGaveUp");
    expect(gaveUp).toMatchObject({
      payload: { jobId: id, errand: "stageOffer", reason: "timeout" },
    });
    expect(errandFor(world, id, "stageOffer")).toBeUndefined();
  });

  it("finish an open pickup when the dock is cast off, so nothing is left on it", () => {
    const test = hands();
    const { world } = test;
    const id = offerFreight(test);
    run(test, 20 * 20, (w) => crates(w, id).length === 3);
    send(test, { source: "player", kind: "declineJob", payload: { jobId: id } });
    run(test, 1);
    expect(errandFor(world, id, "withdrawOffer")?.errand).toMatchObject({ phase: "fetch" });
    const drafts: EventDraft[] = [];
    const ctx = {
      state: world.state,
      caches: world.caches,
      content: world.content,
      defs: createDefLookup(world.content, world.state),
      config: world.config.values,
      rng: createRngApi(world.state),
      tick: world.state.tick + 1,
      elapsedTicks: 1,
      dirty: world.caches.dirty,
      emit: (draft: EventDraft) => {
        drafts.push(draft);
      },
    } satisfies StepCtx;
    dismissLocals(ctx, TINY.port);
    expect(crates(world, id)).toEqual([]);
    expect(world.state.dockside).toEqual({ locals: {}, props: [] });
    expect(drafts.map((d) => d.type)).toEqual(["freightWithdrawn", "dockHandGaveUp"]);
  });
});
