import { describe, expect, it } from "vitest";
import type { Actor } from "../../core/types/actor";
import type { SiteCastEntryDef } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { DamageResult, Hit } from "../bodies/damage";
import { CREW } from "../work/fixtures/crew-deck";
import { inFight } from "./actions";
import { testDamage } from "./fixtures/damage";
import { run, runToResolution, startExpedition, violations } from "./fixtures/fight";
import { SITE, SITE_CAST, siteWorld } from "./fixtures/site";

const RATE = 20;
const FOOT = { x: 9, y: 7 };

type Test = ReturnType<typeof siteWorld>;

const party = (test: Test): Actor[] =>
  (test.world.state.expedition?.party ?? []).map((id) => {
    const actor = test.world.state.actors[id];
    if (actor === undefined) throw new Error(`party member ${id} vanished`);
    return actor;
  });

const held = (test: Test, actor: Actor) =>
  Object.values(test.world.state.items)
    .filter((i) => i.location.kind === "carriedBy" && i.location.actorId === actor.id)
    .map((i) => i.defId);

/** The cast with only the target, who wants nothing: nobody fights back and nobody runs. */
const LONE_TARGET: readonly SiteCastEntryDef[] = [
  { ...(SITE_CAST[0] as SiteCastEntryDef), wants: "nothing" },
];

describe("the muster (call 12)", () => {
  it("arms everyone the plan takes, blasters to the best fighters, and walks them to the ramp", () => {
    const test = siteWorld({ scenario: CREW.scenario8 });
    startExpedition(test, "assault-lethal-armed");
    const events = run(test, 120 * RATE, {
      until: () => !["mustering", "walkingOut"].includes(test.world.state.expedition?.phase ?? ""),
      step: 1,
      check: true,
    });
    const mustered = events.find((e) => e.type === "partyMustered");
    expect(mustered).toBeDefined();
    const members = party(test);
    expect(members).toHaveLength(5);
    const blasters = members.filter((a) => held(test, a).includes(SITE.blaster));
    const batons = members.filter((a) => held(test, a).includes(SITE.baton));
    expect(blasters).toHaveLength(3);
    expect(batons).toHaveLength(2);
    const fighting = (a: Actor) => a.skills.fighting ?? 0;
    expect(Math.min(...blasters.map(fighting))).toBeGreaterThanOrEqual(
      Math.max(...batons.map(fighting)),
    );
    const leader = test.world.state.actors[test.world.state.expedition?.leaderId as ActorId];
    expect(leader !== undefined && inFight(leader)).toBe(true);
    const at = leader?.location;
    expect(
      at?.kind === "onDeck" && Math.hypot(at.x - 0.5 - FOOT.x, at.y - 0.5 - FOOT.y),
    ).toBeLessThan(2.5);
  });

  it("sends nobody before a plan is adopted (call 11)", () => {
    const test = siteWorld({ scenario: CREW.scenario8 });
    startExpedition(test, undefined);
    run(test, 30 * RATE);
    expect(test.world.state.expedition?.phase).toBe("mustering");
    for (const actor of Object.values(test.world.state.actors)) {
      if (actor.crew) expect(actor.combatant).toBeUndefined();
    }
  });
});

describe("the fight (§8.1)", () => {
  it.each([
    "assault-lethal-armed",
    "hold-lethal-armed",
    "flank-lethal-armed",
    "creep-lethal-armed",
  ])(
    "%s plays to a resolution with its events in order and the invariants holding",
    (plan) => {
      const test = siteWorld({ scenario: CREW.scenario8, seed: 3 });
      startExpedition(test, plan);
      const events = runToResolution(test, 300, true);
      const order = [
        "expeditionStarted",
        "partyMustered",
        "expeditionContact",
        "expeditionResolved",
      ].map((type) => events.findIndex((e) => e.type === type));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(test.world.state.expedition?.phase).toBe("resolved");
    },
    15_000,
  );

  it("keeps the planner off combatants mid-fight and gives them back after", () => {
    const test = siteWorld({ scenario: CREW.scenario8, seed: 2 });
    startExpedition(test, "hold-lethal-armed", LONE_TARGET);
    run(test, 200 * RATE, {
      until: () => {
        const phase = test.world.state.expedition?.phase;
        if (phase === "approach" || phase === "fight") {
          for (const actor of party(test)) {
            if (actor.combatant !== undefined && actor.availability === "available") {
              const onSite = actor.activity.kind === "personal";
              expect(onSite).toBe(true);
            }
          }
        }
        return phase === "resolved";
      },
      step: 5,
    });
    expect(test.world.state.expedition?.outcome).toBe("targetTaken");
    for (const actor of party(test)) {
      expect(actor.combatant).toBeUndefined();
      expect(inFight(actor)).toBe(false);
    }
    run(test, 30 * RATE);
    expect(party(test).some((a) => a.activity.kind !== "idle")).toBe(true);
  });

  it("raises the alert at contact and stands it down a minute after the fight", () => {
    const test = siteWorld({ scenario: CREW.scenario8, seed: 2 });
    startExpedition(test, "assault-lethal-armed");
    runToResolution(test);
    const expedition = test.world.state.expedition;
    expect(test.world.state.alert?.cause).toBe("fight");
    const resolvedTick = expedition?.resolvedTick ?? 0;
    run(test, 59 * RATE);
    expect(test.world.state.alert).toBeDefined();
    const events = run(test, 3 * RATE);
    expect(test.world.state.alert).toBeUndefined();
    expect(events.find((e) => e.type === "alertCleared")?.tick).toBe(resolvedTick + 60 * RATE);
    expect(Object.values(test.world.state.actors).some((a) => a.combatant !== undefined)).toBe(
      false,
    );
    expect(violations(test)).toEqual([]);
  });

  it("gives the shooter whose hit killed `killedSomeone`", () => {
    const lethal = (ctx: StepCtx, actorId: ActorId, hit: Hit): DamageResult =>
      testDamage(ctx, actorId, { ...hit, part: "head", severity: "grave" });
    const test = siteWorld({ scenario: CREW.scenario8, seed: 1, applyDamage: lethal });
    startExpedition(test, "assault-lethal-armed");
    const events = runToResolution(test);
    const death = events.find((e) => e.type === "shotFired" && e.payload.hit);
    expect(death).toBeDefined();
    if (death?.type !== "shotFired") return;
    const shooter = test.world.state.actors[death.payload.byActorId];
    const victim = test.world.state.actors[death.payload.atActorId];
    expect(victim === undefined || victim.availability === "dead").toBe(true);
    if (shooter?.crew === true) {
      expect(shooter.thoughts.map((t) => t.key)).toContain("killedSomeone");
    }
  });

  it("withdraws the party at the first casualty under firstDown", () => {
    const test = siteWorld({ scenario: CREW.scenario8, seed: 2 });
    startExpedition(test, "hold-lethal-armed", LONE_TARGET);
    run(test, 200 * RATE, { until: () => test.world.state.expedition?.phase === "fight" });
    const expedition = test.world.state.expedition;
    if (expedition?.plan === undefined) throw new Error("no fight");
    expedition.plan = { ...expedition.plan, withdrawWhen: "firstDown" };
    const casualty = party(test).find((a) => a.id !== expedition.leaderId);
    if (casualty === undefined) throw new Error("no second party member");
    casualty.availability = "incapacitated";
    const events = runToResolution(test);
    expect(events.some((e) => e.type === "partyWithdrew")).toBe(true);
    expect(test.world.state.expedition?.outcome).toBe("partyWithdrew");
  });

  it("drags a down ally to the ramp, who remembers who carried them out", () => {
    const test = siteWorld({ scenario: CREW.scenario8, seed: 2 });
    startExpedition(test, "hold-lethal-armed", LONE_TARGET);
    run(test, 200 * RATE, { until: () => test.world.state.expedition?.phase === "fight" });
    const fallen = party(test).find(
      (a) => a.id !== test.world.state.expedition?.leaderId && a.location.kind === "onDeck",
    );
    if (fallen === undefined || fallen.location.kind !== "onDeck") throw new Error("nobody ashore");
    // Down on the far side of the quay from the ramp.
    fallen.location = { ...fallen.location, x: 1.5, y: 9.5 };
    fallen.movement = { kind: "stationary" };
    fallen.availability = "incapacitated";
    runToResolution(test);
    expect(test.world.state.expedition?.outcome).toBe("targetTaken");
    const memories = Object.values(test.world.state.social.relationships[fallen.id] ?? {}).flatMap(
      (r) => r.memories.map((m) => m.key),
    );
    expect(memories).toContain("carriedMeOut");
    const at = fallen.location;
    expect(
      at.kind === "onDeck" && Math.hypot(at.x - 0.5 - FOOT.x, at.y - 0.5 - FOOT.y),
    ).toBeLessThan(3);
  });
});
