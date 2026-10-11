/**
 * D105 W1: the fight once the narrator has marked a way in (`Expedition.notice`) and a fetchItem
 * fight that goes for the item. On the kernel's test site (`fixtures/sneak.ts`), driven by the
 * arrival card's menu, every invariant checked at every tick.
 */
import { describe, expect, it } from "vitest";
import { isOnDock } from "../../core/docks";
import type { Actor } from "../../core/types/actor";
import type { SimEvent } from "../../core/types/events";
import { stepCtxOf } from "../commerce/fixtures-errand";
import { inFight } from "./actions";
import { fightOf } from "./combat";
import { pickUpLoot } from "./errand";
import { testDamage } from "./fixtures/damage";
import { sendAs, step } from "./fixtures/landing";
import { SITE } from "./fixtures/site";
import { ITEM_DEF, ITEM_NAME, arrivalCard, landedFor, runSneak, sneakIn } from "./fixtures/sneak";
import { groundOf } from "./ground";

const ofType = <T extends SimEvent["type"]>(events: readonly SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

const targetOf = (test: ReturnType<typeof landedFor>): Actor | undefined =>
  Object.values(test.world.state.actors).find((a) => a.combatant?.disposition.part === "target");

const theItem = (test: ReturnType<typeof landedFor>) => {
  const items = Object.values(test.world.state.items).filter((i) => i.defId === ITEM_DEF);
  if (items.length !== 1) throw new Error(`${items.length} of the errand's item`);
  return items[0] as (typeof items)[number];
};

describe("the item errand's arrival card (D105)", () => {
  it("says it, not them, and gives no numbers", () => {
    const params = arrivalCard(landedFor("fetchItem")).prompt.params;
    expect(params).toMatchObject({
      kind: "fetchItem",
      target: ITEM_NAME,
      leftPlan: "creep-holdFire-armed",
      rightPlan: "assault-lethal-armed",
      leftLabel: "Creep in quietly, holding fire",
      rightLabel: "Go in and take it",
      leftWhy: "We slip in, take it and get out. Nobody fires first.",
      rightWhy: "We go in hard and bring it out.",
    });
    for (const key of ["leftLabel", "rightLabel", "leftWhy", "rightWhy"]) {
      expect(String(params[key])).not.toMatch(/\d/);
    }
  });
});

describe("getting in unseen (D105)", () => {
  it("creeping in holding fire takes the item with no shot, no contact and no alert", () => {
    const { test } = sneakIn({ kind: "fetchItem", mark: "left", choose: "left" });
    const expedition = test.world.state.expedition;
    expect(expedition?.plan).toMatchObject({ id: "creep-holdFire-armed", objective: "takeItem" });
    expect(expedition?.notice).toBe("unseen");
    const target = targetOf(test);
    if (target === undefined) throw new Error("no target in the cast");
    const lying = theItem(test);
    expect(isOnDock(test.world.content, test.world.state, lying.location)).toBe(true);

    // Taken from beside the loot post (the test site's is two tiles from the ramp foot, so the
    // party is home the tick it is held) and stowed as the job's cargo.
    const events = runSneak(test, 300);
    const resolved = test.world.state.expedition;
    expect(resolved).toMatchObject({ phase: "resolved", outcome: "targetTaken", shots: 0 });
    expect(resolved?.objectiveTick).toBeDefined();
    expect(resolved?.fightStartedTick).toBeUndefined();
    const job = test.world.state.jobs[test.jobId];
    expect(job?.errand?.outcome).toBe("broughtItem");
    const item = theItem(test);
    expect(item.id).toBe(lying.id);
    expect(job?.cargoItemIds).toEqual([item.id]);
    expect(item.jobId).toBe(test.jobId);
    expect(isOnDock(test.world.content, test.world.state, item.location)).toBe(false);
    expect(ofType(events, "expeditionResolved").map((e) => e.payload)).toEqual([
      expect.objectContaining({ outcome: "targetTaken", targetName: ITEM_NAME, notice: "unseen" }),
    ]);

    // Nobody saw them: no shot, no contact, no alert, nobody broke or gave up.
    expect(ofType(events, "shotFired")).toEqual([]);
    expect(ofType(events, "expeditionContact")).toEqual([]);
    expect(ofType(events, "alertRaised")).toEqual([]);
    expect(ofType(events, "combatantBroke")).toEqual([]);
    expect(test.world.state.alert).toBeUndefined();

    // The person is never taken: untouched, he walks off with the rest of the cast.
    const after = test.world.state.actors[target.id];
    expect(after?.body.wounds).toEqual([]);
    expect(after?.combatant?.state).toBe("fled");
    const gone = () => test.world.state.actors[target.id] === undefined;
    const later = step(test, 60 * test.world.config.values.time.tickRate, gone);
    expect(ofType(later, "alertCleared")).toEqual([]);
    expect(test.world.state.actors[target.id]).toBeUndefined();
  }, 60_000);

  it("going in unseen for a person, contact comes with the party's own first shot", () => {
    const { test } = sneakIn({ kind: "fetchPerson", mark: "right", choose: "right" });
    expect(test.world.state.expedition?.notice).toBe("unseen");
    const events = runSneak(test, 300, () => test.world.state.expedition?.phase === "fight");
    const [contact] = ofType(events, "expeditionContact");
    const [first] = ofType(events, "shotFired");
    expect(contact).toBeDefined();
    expect(first?.tick).toBe(contact?.tick);
    const shooter = test.world.state.actors[first?.payload.byActorId ?? ("" as never)];
    expect(shooter?.combatant?.side).toBe("us");
  }, 60_000);
});

describe("they were waiting (D105)", () => {
  /** Seen: the narrator marked the assault and the captain chose to creep. */
  function waitedFor() {
    const { test } = sneakIn({ kind: "fetchItem", mark: "right", choose: "left" });
    const expedition = test.world.state.expedition;
    expect(expedition?.plan?.id).toBe("creep-holdFire-armed");
    expect(expedition?.notice).toBe("seen");
    const party = () =>
      (test.world.state.expedition?.party ?? []).map((id) => test.world.state.actors[id]);
    const ashore = () =>
      party().some(
        (a) => a !== undefined && isOnDock(test.world.content, test.world.state, a.location),
      );
    const events: SimEvent[] = [];
    const limit = 120 * test.world.config.values.time.tickRate;
    for (let i = 0; i < limit && !ashore(); i++) events.push(...step(test, 1));
    expect(ashore()).toBe(true);
    return { test, events, party };
  }

  it("contact comes the first tick any party member stands on the site floor, still mustering", () => {
    const { test, events, party } = waitedFor();
    // The first tick one stands there (the state's tick is the last one run).
    const tick = test.world.state.tick;
    expect(ofType(events, "expeditionContact").map((e) => e.tick)).toEqual([tick]);
    expect(ofType(events, "alertRaised").map((e) => e.tick)).toEqual([tick]);
    expect(test.world.state.expedition).toMatchObject({ phase: "fight", fightStartedTick: tick });
    expect(test.world.state.expedition?.approachTick).toBeUndefined();
    // On the test site the first are ashore while the last are still at the locker: they arm and
    // walk out into the fight.
    expect(party().some((a) => a?.combatant === undefined)).toBe(true);
    runSneak(test, 60, () => party().every((a) => a?.combatant !== undefined && inFight(a)));
    expect(party().every((a) => a !== undefined && inFight(a))).toBe(true);
  }, 60_000);

  it("called back while some are still at the locker, those not yet armed stay aboard", () => {
    const { test, party } = waitedFor();
    const unarmed = party()
      .filter((a) => a?.combatant === undefined)
      .map((a) => a?.id);
    expect(unarmed.length).toBeGreaterThan(0);
    const back = sendAs(test, { source: "player", kind: "withdrawParty", payload: {} });
    expect(back.status).toBe("accepted");
    const events = runSneak(test, 300);
    expect(test.world.state.expedition?.outcome).toBe("partyWithdrew");
    expect(ofType(events, "partyWithdrew")).toHaveLength(1);
    for (const id of unarmed) {
      const actor = id === undefined ? undefined : test.world.state.actors[id];
      expect(actor?.combatant).toBeUndefined();
      expect(
        actor !== undefined && isOnDock(test.world.content, test.world.state, actor.location),
      ).toBe(false);
    }
  }, 60_000);
});

describe("a fetchItem fight goes for the item", () => {
  it("the one pressing beside the loot post takes the item in hand, if it is within reach", () => {
    const { test } = sneakIn({ kind: "fetchItem", mark: "left", choose: "left" });
    runSneak(test, 120, () => test.world.state.expedition?.phase === "approach");
    const { ctx } = stepCtxOf(test);
    const ground = groundOf(ctx);
    const loot = ground?.posts.loot;
    if (ground === undefined || loot === undefined) throw new Error("no loot post");
    const fight = fightOf(ctx, { applyDamage: testDamage }, ground);
    const presser = fight?.people.find((p) => p.combatant?.side === "us" && inFight(p));
    if (fight === undefined || presser === undefined) throw new Error("nobody ashore");
    presser.location = { kind: "onDeck", deckId: ground.deckId, x: loot.x + 0.5, y: loot.y - 0.5 };
    presser.movement = { kind: "stationary" };
    const item = theItem(test);
    const atPost = item.location;
    // Three tiles off the post it is beyond their reach, and stays where it lies.
    item.location = { kind: "onDeck", deckId: ground.deckId, x: loot.x + 3.5, y: loot.y + 0.5 };
    pickUpLoot(fight);
    expect(item.location.kind).toBe("onDeck");
    item.location = atPost;
    pickUpLoot(fight);
    expect(item.location).toEqual({ kind: "carriedBy", actorId: presser.id });
  }, 60_000);

  it("the target getting away by the exit leaves the fight running", () => {
    const { test } = sneakIn({ kind: "fetchItem", choose: "left" });
    expect(test.world.state.expedition?.notice).toBeUndefined();
    const target = targetOf(test);
    if (target === undefined) throw new Error("no target in the cast");
    // Out by the exit the moment the party is ashore.
    const phase = () => test.world.state.expedition?.phase;
    runSneak(test, 120, () => phase() === "approach" || phase() === "fight");
    const exit = test.world.content.docks?.[SITE.dock]?.posts.find((p) => p.kind === "exit")?.tile;
    const at = target.location;
    if (exit === undefined || at.kind !== "onDeck") throw new Error("no exit, or no target on it");
    // The post is in the dock frame; the quay berths the deck at (2, 1).
    target.location = { ...at, x: exit.x - 2 + 0.5, y: exit.y - 1 + 0.5 };
    target.movement = { kind: "stationary" };
    const events = step(test, 2);
    expect(test.world.state.actors[target.id]).toBeUndefined();
    expect(test.world.state.expedition?.phase).not.toBe("resolved");
    events.push(...runSneak(test, 300));
    const resolved = ofType(events, "expeditionResolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.payload.outcome).not.toBe("targetFled");
    expect(resolved[0]?.payload.targetName).toBe(ITEM_NAME);
  }, 60_000);
});
