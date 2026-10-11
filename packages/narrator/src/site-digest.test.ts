import {
  type ActorId,
  type DecisionId,
  type PortDefId,
  type SaveEnvelope,
  planMenu,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorRequest } from "./contract";
import { buildDigest } from "./digest";
import { FIXTURE_ERRAND_TARGET, siteArrivalRequest, siteItemArrivalRequest } from "./fixtures";
import { EMPTY_NOTES } from "./notes";
import { withoutDigits } from "./site-digest";
import { content } from "./test-support";

function digestOf(req: NarratorRequest): string {
  return buildDigest(req.snapshot, req.recentEvents, EMPTY_NOTES, content(), req.hook).text;
}

/** The "At the site" section's text, heading included. */
function siteSection(text: string): string {
  const start = text.indexOf("## At the site (");
  if (start < 0) throw new Error("no At the site section");
  const end = text.indexOf("\n## ", start + 1);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

/** A copy of the arrival fixture to change. */
function arrival(): NarratorRequest & { snapshot: SaveEnvelope } {
  const req = siteArrivalRequest(content());
  return { ...req, snapshot: structuredClone(req.snapshot) as SaveEnvelope };
}

function actorNamed(snapshot: SaveEnvelope, name: string) {
  const actor = Object.values(snapshot.state.actors).find((a) => a.name === name);
  if (actor === undefined) throw new Error(`no actor ${name}`);
  return actor;
}

describe("buildDigest: At the site (expeditions A2, §10.2)", () => {
  it("replaces On the dock while a site map is alongside: the place, the errand, who is there, where and how they stand", () => {
    const req = arrival();
    const text = digestOf(req);
    expect(text).not.toContain("## On the dock");
    const section = siteSection(text);
    expect(section).toContain("## At the site (Harrow End, the silo yard)");
    expect(section).toContain(
      "the errand: bring back Teodor Lusk from Harrow End, alive, for Ysolde Maren, home to Crossroads Hub",
    );
    expect(section).toContain(
      "the expedition: nobody has gone out yet; the crew wait on the captain's plan",
    );
    expect(section).toContain(
      `- ${FIXTURE_ERRAND_TARGET} (co-op steward gone to ground), the one the errand is after, unarmed, at the weigh-house scale: steady`,
    );
    expect(section).toContain(
      "- Rhee Castellan (the buyer's hired gun), one of theirs, with a blaster, behind the bale row: steady",
    );
    expect(section).toContain(
      "- Amos Wray (the old silo keeper), one of theirs, with a club, by the back door:",
    );
    expect(section).toContain("- Wenna Brae (gleaner), a bystander, unarmed, at the spilt grain:");
  });

  it("shows the two plans on the arrival card in the card's order, each with its why in words", () => {
    const section = siteSection(digestOf(arrival()));
    const line = section.split("\n").find((l) => l.startsWith("the arrival card"));
    expect(line).toMatch(
      /^the arrival card \(two plans, waiting on the captain\): left "Hold the ramp from cover": hold the ramp from cover \(\w+ go\); right "Go in and take them": go in and take them \(\w+ go\)$/,
    );
  });

  it("never shows a digit, before or during the fight", () => {
    const req = arrival();
    expect(siteSection(digestOf(req))).not.toMatch(/\d/);
    const fight = inTheFight(req);
    expect(siteSection(digestOf(fight))).not.toMatch(/\d/);
  });

  it("once a plan is chosen: the party and who leads, and each side's bearing as a word", () => {
    const section = siteSection(digestOf(inTheFight(arrival())));
    expect(section).toContain("the expedition: the fight is on");
    expect(section).toMatch(
      /^the party: [A-Z][\w ]+ \(leads, (unarmed|with a blaster|with a club), steady\)/m,
    );
    expect(section).toContain(
      "- Mattie Lusk (the steward's daughter), one of theirs, with a blaster, inside the weigh-house door: breaking",
    );
    expect(section).toContain(
      "- Rhee Castellan (the buyer's hired gun), one of theirs, with a blaster, near the spot behind the bale row: down",
    );
    expect(section).toContain(
      'the captain\'s plan, from the arrival card: "Hold the ramp from cover"',
    );
    expect(section).toContain(
      'the turn card (waiting on the captain): "Press on" or "Pull back to the ship"',
    );
  });

  it("reads the arrival and turn cards under Pending decisions as the captain sees them", () => {
    const text = digestOf(arrival());
    const firstOfficer = Object.values(arrival().snapshot.state.actors).find((a) =>
      a.roleTags.includes("firstOfficer"),
    );
    expect(text).toContain(
      `At Harrow End (brought by ${firstOfficer?.name}): ${FIXTURE_ERRAND_TARGET} is at Harrow End, and not alone. Hold the ramp from cover, or go in and take them? Left: "Hold the ramp from cover". Right: "Go in and take them".`,
    );
    expect(text).toContain(`; ${firstOfficer?.name} brings it: write the card in their voice`);
  });

  it("says set down at a site in the travel line, no offers there, and no NPCs line", () => {
    const text = digestOf(arrival());
    expect(text).toContain(
      "travel: set down at Harrow End (port.harrow_end), a landing site off Green Meridian\n",
    );
    expect(text).toContain(
      "job offers possible now: none (set down at a landing site; offers are made at ports)",
    );
    expect(text).not.toContain("NPCs");
  });

  it("says setting down at a site on the approach", () => {
    const req = arrival();
    req.snapshot.state.travel = {
      stage: "approaching",
      fromPortId: "port.green_meridian" as PortDefId,
      toPortId: "port.harrow_end" as PortDefId,
      routeProgress: 20,
      routeDistance: 20,
      drifting: false,
    } as SaveEnvelope["state"]["travel"];
    // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
    delete req.snapshot.state.deck.dock;
    const text = digestOf(req);
    expect(text).toContain(
      "travel: approaching, setting down at Harrow End (port.harrow_end), a landing site, 100% of route",
    );
    expect(text).not.toContain("## At the site");
  });

  it("gives the errand's job line, and the target taken alive aboard on the way home", () => {
    const req = arrival();
    const state = req.snapshot.state;
    const job = Object.values(state.jobs)[0];
    if (job === undefined) throw new Error("no errand");
    expect(digestOf(req)).toContain(
      `- ${job.id} inTransit (narrator): from Ysolde Maren (grower, Meridian Growers Collective), Crossroads Hub -> Harrow End (2 hops, 65s transit via Green Meridian), errand: bring back Teodor Lusk from Harrow End, alive, home to Crossroads Hub`,
    );
    const target = actorNamed(req.snapshot, FIXTURE_ERRAND_TARGET);
    // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
    delete target.combatant;
    target.crew = true;
    target.passenger = true;
    job.passage = { actorId: target.id, roundTrip: false, leg: "out" };
    job.errand = { ...(job.errand as NonNullable<typeof job.errand>), outcome: "broughtAlive" };
    const text = digestOf(req);
    expect(text).toContain(
      "home to Crossroads Hub; taken alive; Teodor Lusk aboard on a one-way passage (leg out)",
    );
    expect(text).toMatch(
      /- Aboard: Teodor Lusk, taken at Harrow End on the errand for Ysolde Maren, bound for Crossroads Hub; now /,
    );
  });
});

describe("withoutDigits", () => {
  it("writes small counts as words and anything larger as many", () => {
    expect(withoutDigits("hold the ramp from cover (3 go)")).toBe(
      "hold the ramp from cover (three go)",
    );
    expect(withoutDigits("flank needs four fit people: only 12 would go, not 40")).toBe(
      "flank needs four fit people: only twelve would go, not many",
    );
  });
});

/**
 * The arrival fixture moved on: the captain chose the left plan, the party is out and the fight is
 * on; Mattie Lusk is breaking at her post, Rhee Castellan is down a few steps from his, and the
 * turn card is up.
 */
function inTheFight(req: NarratorRequest & { snapshot: SaveEnvelope }) {
  const { snapshot } = req;
  const state = snapshot.state;
  const expedition = state.expedition;
  const arrivalId = expedition?.cards?.arrival;
  if (expedition === undefined || arrivalId === undefined) throw new Error("no expedition");
  const plan = planMenu(state, content(), snapshot.config).find(
    (o) => o.id === "hold-lethal-armed",
  );
  if (plan === undefined) throw new Error("no hold plan");
  const card = state.decisions.records[arrivalId];
  if (card === undefined) throw new Error("no arrival card");
  card.status = "resolved";
  card.chosen = "left";
  state.decisions.queue = state.decisions.queue.filter((id) => id !== arrivalId);
  const party = Object.values(state.actors)
    .filter((a) => a.crew && !a.roleTags.includes("captain"))
    .slice(0, 3)
    .map((a) => a.id);
  const [leaderId] = party;
  if (leaderId === undefined) throw new Error("no party");
  expedition.plan = plan.plan;
  expedition.party = party;
  expedition.leaderId = leaderId as ActorId;
  expedition.phase = "fight";
  for (const id of party) {
    const actor = state.actors[id];
    if (actor === undefined) continue;
    actor.combatant = {
      side: "us",
      disposition: { part: "ally", resolveBase: 0.7, loyalty: 1, wants: "nothing" },
      state: "steady",
      resolve: 0.7,
      lastDecidedTick: state.tick,
    };
  }
  const mattie = actorNamed(snapshot, "Mattie Lusk");
  if (mattie.combatant !== undefined) mattie.combatant.state = "breaking";
  const rhee = actorNamed(snapshot, "Rhee Castellan");
  if (rhee.combatant !== undefined) rhee.combatant.state = "down";
  // Three tiles east of his post (the berth is a translation of the site map): still nearest it.
  if (rhee.location.kind !== "onDeck") throw new Error("Rhee is not on the site floor");
  rhee.location = { ...rhee.location, x: rhee.location.x + 3 };
  const turnId = "d-turn" as DecisionId;
  const key = "expedition.turn";
  state.decisions.records[turnId] = {
    id: turnId,
    origin: "policy",
    perspectiveActorId: card.perspectiveActorId,
    prompt: { key, params: { speaker: "Dane Whitcross", name: "Mattie Lusk", how: "breaking" } },
    left: {
      label: { key: `${key}.press`, params: {} },
      commands: [],
      aftermath: { key: `${key}.press.aftermath`, params: {} },
    },
    right: {
      label: { key: `${key}.withdraw`, params: {} },
      commands: [{ kind: "withdrawParty", payload: {} }],
      aftermath: { key: `${key}.withdraw.aftermath`, params: {} },
    },
    status: "pending",
    createdTick: state.tick,
  };
  state.decisions.queue.push(turnId);
  expedition.cards = { arrival: arrivalId, turn: turnId };
  return req;
}

/** A copy of the item arrival fixture to change. */
function itemArrival(): NarratorRequest & { snapshot: SaveEnvelope } {
  const req = siteItemArrivalRequest(content());
  return { ...req, snapshot: structuredClone(req.snapshot) as SaveEnvelope };
}

/** The item fixture marked for the creep side, `planId` chosen, the party out, `notice` set. */
function chosen(
  req: NarratorRequest & { snapshot: SaveEnvelope },
  planId: string,
  notice: "unseen" | "seen" | undefined,
  roll?: { odds: number; worked: boolean },
) {
  const state = req.snapshot.state;
  const expedition = state.expedition;
  const arrivalId = expedition?.cards?.arrival;
  const card = arrivalId === undefined ? undefined : state.decisions.records[arrivalId];
  const plan = planMenu(state, content(), req.snapshot.config).find((o) => o.id === planId);
  if (expedition === undefined || card === undefined || plan === undefined) {
    throw new Error("no expedition, card or plan");
  }
  card.status = "resolved";
  card.chosen = card.prompt.params.leftPlan === planId ? "left" : "right";
  state.decisions.queue = state.decisions.queue.filter((id) => id !== arrivalId);
  expedition.plan = plan.plan;
  if (notice !== undefined) {
    expedition.unseenPlanId = "creep-holdFire-armed";
    expedition.notice = notice;
  }
  if (roll !== undefined) {
    expedition.unseenOdds = roll.odds;
    expedition.unseenRoll = roll;
  }
  expedition.phase = "approach";
  return req;
}

/** Over: the party took what it went for, with a fight first if `fought`. */
function over(req: NarratorRequest & { snapshot: SaveEnvelope }, fought: boolean) {
  const expedition = req.snapshot.state.expedition;
  if (expedition === undefined) throw new Error("no expedition");
  expedition.phase = "resolved";
  expedition.outcome = "targetTaken";
  expedition.resolvedTick = req.snapshot.state.tick;
  if (fought) expedition.fightStartedTick = req.snapshot.state.tick;
  return req;
}

describe("buildDigest: At the site, the way in unseen (D105)", () => {
  const AFTER = /nobody saw|waiting for the party|unseen/;

  it("an item errand: what it is after and where it lies, and the site's own target not taken for it", () => {
    const section = siteSection(digestOf(itemArrival()));
    expect(section).toContain(
      "the errand: fetch the Collective's seed stock (Perishable Cargo Crate) from Harrow End",
    );
    expect(section).toContain(
      "what the errand is after: the Collective's seed stock: lying at the seed container doors",
    );
    expect(section).toContain(
      `- ${FIXTURE_ERRAND_TARGET} (co-op steward gone to ground), the one at the heart of it here (the errand is after a thing, not them), unarmed`,
    );
    expect(section).not.toContain("the one the errand is after");
  });

  it("never shows the mark while the card is up: the section is the same marked or not", () => {
    const plain = siteSection(digestOf(itemArrival()));
    const req = itemArrival();
    if (req.snapshot.state.expedition === undefined) throw new Error("no expedition");
    req.snapshot.state.expedition.unseenPlanId = "creep-holdFire-armed";
    const marked = digestOf(req);
    expect(siteSection(marked)).toBe(plain);
    expect(marked).not.toContain("creep-holdFire-armed");
    expect(siteSection(marked)).not.toMatch(AFTER);
  });

  it("once the captain chose the other side, says they were waiting, with no number (§unseen-odds)", () => {
    const section = siteSection(digestOf(chosen(itemArrival(), "assault-lethal-armed", "seen")));
    expect(section).toContain("the party is out on the ground, not yet in a fight");
    expect(section).toContain(
      "the way in unseen you named: the captain took the other side; they were waiting for the party",
    );
    expect(section).not.toMatch(/\d/);
  });

  it("once the captain chose the marked side, says the roll at the narrator's own odds (§unseen-odds)", () => {
    const worked = chosen(itemArrival(), "creep-holdFire-armed", "unseen", {
      odds: 70,
      worked: true,
    });
    expect(siteSection(digestOf(worked))).toContain(
      "the way in unseen you named (70%): the captain took it and it worked; the people here did not see the party come",
    );
    const failed = chosen(itemArrival(), "creep-holdFire-armed", "seen", {
      odds: 70,
      worked: false,
    });
    const section = siteSection(digestOf(failed));
    expect(section).toContain(
      "the way in unseen you named (70%): the captain took it and it failed; they were waiting for the party",
    );
    // The odds are the section's only digits: the rest still has none.
    expect(section.replace("(70%)", "")).not.toMatch(/\d/);
  });

  it("says nothing of a marked side taken with no roll (a mark saved before odds) until it is over", () => {
    const section = siteSection(digestOf(chosen(itemArrival(), "creep-holdFire-armed", "unseen")));
    expect(section).toContain("the party is out on the ground, not yet in a fight");
    expect(section).not.toMatch(AFTER);
  });

  it("once it is over: nobody saw them come or go when the marked side went in and no fight started", () => {
    const section = siteSection(
      digestOf(over(chosen(itemArrival(), "creep-holdFire-armed", "unseen"), false)),
    );
    expect(section).toContain(
      "the expedition: it is over; the party took what it went for; nobody saw them come or go",
    );
    expect(section).not.toContain("what the errand is after");
  });

  it("once it is over: nothing said of the notice when the marked side went in but a fight started", () => {
    const req = over(chosen(itemArrival(), "creep-holdFire-armed", "unseen"), true);
    const section = siteSection(digestOf(req));
    expect(section).toContain("the expedition: it is over; the party took what it went for\n");
    expect(section).not.toMatch(AFTER);
  });

  it("once it is over: they were waiting for the party when the other side went in", () => {
    const req = over(chosen(itemArrival(), "assault-lethal-armed", "seen"), true);
    expect(siteSection(digestOf(req))).toContain(
      "the expedition: it is over; the party took what it went for; they were waiting for the party",
    );
  });

  it("once it is over with no side marked: nothing said of the notice", () => {
    const req = over(chosen(itemArrival(), "assault-lethal-armed", undefined), false);
    expect(siteSection(digestOf(req))).not.toMatch(AFTER);
  });
});
