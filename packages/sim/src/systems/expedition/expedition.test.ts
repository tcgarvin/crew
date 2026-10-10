import { describe, expect, it } from "vitest";
import { renderExpedition } from "../../core/render";
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
import { leaderNow } from "./plans";

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

/** Tiles where two upright, standing-still combatants of one side share a tile, as "side@x,y". */
function stackedTiles(test: Test): string[] {
  const seen = new Map<string, number>();
  for (const actor of Object.values(test.world.state.actors)) {
    const c = actor.combatant;
    const at = actor.location;
    if (c === undefined || at.kind !== "onDeck" || actor.movement.kind === "moving") continue;
    if (!["steady", "wavering"].includes(c.state)) continue;
    const key = `${c.side}@${Math.floor(at.x)},${Math.floor(at.y)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

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

  it.each(["hold-lethal-armed", "assault-lethal-armed"])(
    "%s: no two of a side stand still on one tile while the fight is on",
    (plan) => {
      for (const seed of [1, 2, 3]) {
        const test = siteWorld({ scenario: CREW.scenario8, seed });
        startExpedition(test, plan);
        // A tile shared for a whole second (four samples): an arrival takes a decision to step off.
        const streak = new Map<string, number>();
        const stacked = new Set<string>();
        run(test, 300 * RATE, {
          step: 5,
          until: () => {
            const expedition = test.world.state.expedition;
            const now =
              expedition?.phase === "fight" && expedition.objectiveTick === undefined
                ? stackedTiles(test)
                : [];
            for (const key of [...streak.keys()]) if (!now.includes(key)) streak.delete(key);
            for (const key of now) {
              streak.set(key, (streak.get(key) ?? 0) + 1);
              if ((streak.get(key) ?? 0) >= 4) stacked.add(key);
            }
            return expedition?.phase === "resolved";
          },
        });
        expect([...stacked], `seed ${seed}`).toEqual([]);
      }
    },
    30_000,
  );

  it("words the shore header from those who fight: a shaky bystander does not make them shaky", () => {
    const test = siteWorld({ scenario: CREW.scenario8 });
    startExpedition(
      test,
      "hold-lethal-armed",
      SITE_CAST.map((e) => ({ ...e, resolve: "steady" })),
    );
    run(test, 120 * RATE, {
      until: () => ["approach", "fight"].includes(test.world.state.expedition?.phase ?? ""),
      step: 1,
    });
    const state = test.world.state;
    const bystander = Object.values(state.actors).find(
      (a) => a.combatant?.disposition.part === "bystander",
    );
    if (bystander?.combatant === undefined) throw new Error("no bystander");
    expect(renderExpedition(state, test.world.content)?.them).toBe("steady");
    bystander.combatant.state = "wavering";
    expect(renderExpedition(state, test.world.content)?.them).toBe("steady");
    // With every guard gone, a target and a bystander left standing are not a side still in it.
    for (const actor of Object.values(state.actors)) {
      const part = actor.combatant?.disposition.part;
      if (part === "guard" || part === "ally") delete state.actors[actor.id];
    }
    expect(renderExpedition(state, test.world.content)?.them).toBe("done");
  });

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

  it("outflanks both guards once flank's small group is at the flank post (§8.3)", () => {
    // Hard, devoted guards with blasters, so both are still in it to see the pincer close.
    const cast = SITE_CAST.map((e) =>
      e.part === "guard"
        ? { ...e, resolve: "hard" as const, tie: "devoted" as const, arms: "blaster" as const }
        : e,
    );
    const bySeed: string[][] = [];
    for (const seed of [1, 2, 3]) {
      const test = siteWorld({ scenario: CREW.scenario8, seed });
      startExpedition(test, "flank-lethal-armed", cast);
      const outflanked = new Set<string>();
      let early = 0;
      run(test, 300 * RATE, {
        step: 1,
        until: () => {
          const expedition = test.world.state.expedition;
          for (const actor of Object.values(test.world.state.actors)) {
            if (actor.combatant?.outflanked !== true) continue;
            if (expedition?.flankTick === undefined) early += 1;
            outflanked.add(actor.name);
          }
          return expedition?.phase === "resolved";
        },
      });
      expect(early, `seed ${seed}: outflanked before the flank post`).toBe(0);
      bySeed.push([...outflanked].sort());
    }
    expect(bySeed).toContainEqual(["Darrow Finch", "Hesk Marrow"]);
  }, 30_000);

  it("passes the lead to the next fit party member when the leader goes down (§8.5)", () => {
    const test = siteWorld({ scenario: CREW.scenario8, seed: 2 });
    startExpedition(test, "hold-lethal-armed", LONE_TARGET);
    run(test, 200 * RATE, { until: () => test.world.state.expedition?.phase === "fight" });
    const expedition = test.world.state.expedition;
    if (expedition === undefined) throw new Error("no fight");
    const [first, second, third] = expedition.party;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("party too small");
    }
    const state = test.world.state;
    expect(first).toBe(expedition.leaderId);
    expect(leaderNow(state, expedition)).toBe(first);
    const combatant = (id: ActorId) => {
      const c = state.actors[id]?.combatant;
      if (c === undefined) throw new Error(`${id} is not in the fight`);
      return c;
    };
    combatant(first).state = "down";
    expect(leaderNow(state, expedition)).toBe(second);
    combatant(second).state = "dead";
    expect(leaderNow(state, expedition)).toBe(third);
    combatant(first).state = "wavering";
    expect(leaderNow(state, expedition)).toBe(first);
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
