/**
 * §outcome-levers (D106): the translator's impossible-only guards for `strike`, `transact` and
 * `offerJob.payCredits`, the real kernel taking what passes, and the budget as advice in the
 * digest.
 */
import {
  type Actor,
  type ActorId,
  type NarratorCommand,
  type PortDefId,
  type SaveEnvelope,
  createKernel,
  createRegistry,
  registerBodies,
  registerCommerce,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  type NarratorPlan,
  type NarratorRequest,
  type TranslationCtx,
  buildNarratorPlanSchema,
} from "./contract";
import { buildDigest } from "./digest";
import { FIXTURE_SCENARIO, approachRequest, captainAshoreRequest } from "./fixtures";
import { EMPTY_NOTES } from "./notes";
import { content, emptyPlan } from "./test-support";
import { translateIntents } from "./translate";

function ctxOf(req: NarratorRequest, snapshot: SaveEnvelope = req.snapshot): TranslationCtx {
  return { snapshot, content: content(), hookTick: req.hook.tick, callId: "call1", hook: req.hook };
}

const plan = (intents: unknown[]): NarratorPlan =>
  emptyPlan({ intents: intents as NarratorPlan["intents"] });

/** The snapshot's crew, in actor order. */
function crewOf(snapshot: SaveEnvelope): Actor[] {
  return Object.values(snapshot.state.actors).filter((a) => a.crew && a.passenger !== true);
}

function nthCrew(snapshot: SaveEnvelope, n: number): Actor {
  const actor = crewOf(snapshot)[n];
  if (actor === undefined) throw new Error(`no crew member ${n}`);
  return actor;
}

const strikeOf = (who: string, overrides: Record<string, unknown> = {}) => ({
  kind: "strike",
  who,
  severity: "grave",
  type: "blunt",
  part: "head",
  byWho: "",
  how: `${who} falls from the hold ladder`,
  ...overrides,
});

const transactOf = (amount: number, overrides: Record<string, unknown> = {}) => ({
  kind: "transact",
  amount,
  memo: "the gate fine",
  counterparty: "Harbourmaster Osei",
  ...overrides,
});

const reasons = (result: ReturnType<typeof translateIntents>) =>
  result.dropped.map((d) => d.reason);

describe("strike in the plan schema and the translator (§strike-lever)", () => {
  it("parses a strike and a transact, and refuses one without its fields", () => {
    const schema = buildNarratorPlanSchema();
    const valid = {
      rationale: "r",
      intents: [strikeOf("Jax Okonkwo"), transactOf(-200)],
      card: null,
      callBack: { when: "nextPort", why: "" },
    };
    expect(schema.safeParse(valid).success).toBe(true);
    const { how: _how, ...noHow } = strikeOf("Jax Okonkwo");
    expect(schema.safeParse({ ...valid, intents: [noHow] }).success).toBe(false);
    expect(
      schema.safeParse({ ...valid, intents: [strikeOf("Jax", { severity: "fatal" })] }).success,
    ).toBe(false);
  });

  it("turns a strike on a crew member by name into the kernel's strike, the body deciding the rest", () => {
    const req = approachRequest(content());
    const jax = nthCrew(req.snapshot, 0);
    const by = nthCrew(req.snapshot, 1);
    const result = translateIntents(
      plan([strikeOf(jax.name, { byWho: by.name, part: "" })]),
      ctxOf(req),
    );
    expect(result.dropped).toEqual([]);
    expect(result.commands[0]).toMatchObject({
      kind: "strike",
      source: "narrator",
      payload: {
        actorId: jax.id,
        severity: "grave",
        type: "blunt",
        byActorId: by.id,
        how: `${jax.name} falls from the hold ladder`,
      },
    });
    const payload = (result.commands[0] as Extract<NarratorCommand, { kind: "strike" }>).payload;
    expect(payload.part).toBeUndefined();
  });

  it("drops a strike on nobody, on the dead, on someone ashore, and by someone dead", () => {
    const req = approachRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const dead = nthCrew(snapshot, 0);
    const ashore = nthCrew(snapshot, 1);
    const alive = nthCrew(snapshot, 2);
    const deadActor = snapshot.state.actors[dead.id as ActorId];
    const ashoreActor = snapshot.state.actors[ashore.id as ActorId];
    if (deadActor === undefined || ashoreActor === undefined) throw new Error("no actors");
    deadActor.availability = "dead";
    ashoreActor.availability = "offShip";
    ashoreActor.location = {
      kind: "inExternalStore",
      portId: "port.crossroads_hub" as PortDefId,
      storeKey: "lounge",
    };
    const result = translateIntents(
      plan([
        strikeOf("Nobody Atall"),
        strikeOf(dead.name),
        strikeOf(ashore.name),
        strikeOf(alive.name, { byWho: dead.name }),
      ]),
      ctxOf(req, snapshot),
    );
    expect(result.commands).toEqual([]);
    expect(reasons(result)).toEqual([
      'strike: who: nobody called "Nobody Atall"; use a name the digest lists',
      `strike: who: ${dead.name} is already dead`,
      `strike: who: ${ashore.name} is not on the ship or the site (ashore at Crossroads Hub)`,
      `strike: byWho: ${dead.name} is already dead`,
    ]);
  });

  it("strikes the captain like anyone (owner: the captain can die any way a crew member can)", () => {
    const req = approachRequest(content());
    const captain = crewOf(req.snapshot).find((a) => a.roleTags.includes("captain"));
    if (captain === undefined) throw new Error("no captain");
    const result = translateIntents(plan([strikeOf(captain.name)]), ctxOf(req));
    expect(result.dropped).toEqual([]);
    expect(result.commands.map((c) => c.kind)).toEqual(["strike"]);
  });

  it("holds how to the player-facing text checks: no numbers, never empty", () => {
    const req = approachRequest(content());
    const jax = nthCrew(req.snapshot, 0);
    const result = translateIntents(
      plan([
        strikeOf(jax.name, { how: "Jax loses 40% of his blood" }),
        strikeOf(jax.name, { how: " " }),
      ]),
      ctxOf(req),
    );
    expect(reasons(result)).toEqual([
      "strike: how: player-facing text states a numeric consequence",
      "strike: how: empty text",
    ]);
  });
});

describe("transact and payCredits in the translator (§money-levers)", () => {
  it("passes a debit the balance covers and a credit up to maxWindfall, with memo and counterparty", () => {
    const req = captainAshoreRequest(content());
    const max = req.snapshot.config.narrator.maxWindfall;
    const result = translateIntents(
      plan([transactOf(-200), transactOf(max, { memo: "a reward", counterparty: "" })]),
      ctxOf(req),
    );
    expect(result.dropped).toEqual([]);
    expect(result.commands.map((c) => c.payload)).toEqual([
      { amount: -200, memo: "the gate fine", counterparty: "Harbourmaster Osei" },
      { amount: max, memo: "a reward", counterparty: "" },
    ]);
  });

  it("never overdraws, counting this call's earlier debits, and drops a credit over the cap or a zero", () => {
    const req = captainAshoreRequest(content());
    const balance = req.snapshot.state.money.balance;
    const max = req.snapshot.config.narrator.maxWindfall;
    const result = translateIntents(
      plan([
        transactOf(-(balance - 10)),
        transactOf(-11),
        transactOf(max + 1),
        transactOf(0),
        transactOf(2.5),
      ]),
      ctxOf(req),
    );
    expect(result.commands.map((c) => c.kind)).toEqual(["transact"]);
    expect(reasons(result)).toEqual([
      "transact: the ship has 10 credits and cannot pay 11",
      `transact: a credit of ${max + 1} is over the most one sum may be (${max})`,
      "transact: amount must be a non-zero whole number of credits",
      "transact: amount must be a non-zero whole number of credits",
    ]);
  });

  it("drops a memo that leaks a number into the log's words", () => {
    const req = captainAshoreRequest(content());
    const result = translateIntents(
      plan([transactOf(-50, { memo: "a 50 credit fine" })]),
      ctxOf(req),
    );
    expect(reasons(result)).toEqual([
      "transact: memo: player-facing text states a numeric consequence",
    ]);
  });
});

describe("the outcome levers through the real kernel (§outcome-levers)", () => {
  function realWorld() {
    const bundle = content();
    const registry = createRegistry();
    registerCommerce(registry);
    registerBodies(registry);
    const kernel = createKernel(registry);
    const world = kernel.createWorld(FIXTURE_SCENARIO, 7, bundle, {
      values: bundle.config,
      hash: bundle.hash,
    });
    return { bundle, kernel, world };
  }

  it("a translated grave head strike kills by the body rules, and a translated fine leaves the ledger", () => {
    const { bundle, kernel, world } = realWorld();
    const snapshot = kernel.serialize(world);
    const victim = nthCrew(snapshot, 0);
    const ctx: TranslationCtx = {
      snapshot,
      content: bundle,
      hookTick: world.state.tick,
      callId: "call-outcome",
    };
    const { commands, dropped } = translateIntents(
      plan([strikeOf(victim.name), transactOf(-150)]),
      ctx,
    );
    expect(dropped).toEqual([]);
    for (const command of commands) {
      expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
    }
    const before = world.state.money.balance;
    kernel.advance(world, 2);
    expect(world.state.actors[victim.id as ActorId]?.availability).toBe("dead");
    expect(world.state.money.balance).toBe(before - 150);
    expect(Object.values(world.state.money.transactions).some((t) => t.reason === "narrator")).toBe(
      true,
    );
  });

  it("a translated offer with payCredits is accepted at exactly that sum, outside the band", () => {
    const { bundle, kernel, world } = realWorld();
    const travel = world.state.travel;
    if (travel.stage !== "docked") throw new Error("expected a new world to start docked");
    const here = travel.portId;
    const to = bundle.ports[here]?.routes[0]?.toPortId;
    if (to === undefined) throw new Error("no route from the start port");
    const offer = {
      kind: "offerJob",
      issuerName: "Ysolde Maren",
      issuerRole: "grower",
      issuerOrg: "",
      pitch: "Take these and do not ask what is in them.",
      description: "Sealed crates, no questions.",
      fromPort: here,
      toPort: to,
      cargoItem: "item.crate_general",
      quantity: "one",
      payTier: "standard",
      payCredits: 4321,
      urgency: "soon",
      surface: false,
      passenger: false,
      roundTrip: false,
      errandKind: "",
      site: "",
      targetName: "",
      targetItem: "",
      wants: "",
    };
    const ctx: TranslationCtx = {
      snapshot: kernel.serialize(world),
      content: bundle,
      hookTick: world.state.tick,
      callId: "call-pay",
    };
    const max = bundle.config.narrator.maxOfferPay;
    const over = translateIntents(plan([{ ...offer, payCredits: max + 1 }]), ctx);
    expect(reasons(over)).toEqual([
      `offerJob: payCredits: ${max + 1} is over the most an offer pays (${max})`,
    ]);
    const { commands, dropped } = translateIntents(plan([offer]), ctx);
    expect(dropped).toEqual([]);
    const [command] = commands;
    if (command === undefined) throw new Error("no command");
    expect(command.payload).toMatchObject({ job: { pay: 4321, payNamed: true } });
    expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
    kernel.advance(world, 2);
    expect(Object.values(world.state.jobs).find((j) => j.origin === "narrator")?.pay).toBe(4321);
  });
});

describe("the budget as advice in the digest (§narrator-lever-budgets)", () => {
  it("says the counters are advice and shows how far past one the narrator has gone", () => {
    const req = approachRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    snapshot.state.narrator.budget = {
      spawnsRemaining: 2,
      faultsRemaining: -1,
      hazardsRemaining: 0,
    };
    const { text } = buildDigest(snapshot, [], EMPTY_NOTES, content(), req.hook);
    expect(text).toContain("Advice, not a limit");
    expect(text).toContain("spawns remaining: 2");
    expect(text).toContain("faults remaining: 0 (1 past it)");
    expect(text).toContain("hazards remaining: 0");
  });
});
