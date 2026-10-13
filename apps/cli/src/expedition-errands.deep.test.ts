/**
 * Expeditions A2, the deep errands past the first (W4 hardening): on the real content with every
 * system, the null narrator answering every hook and `episodeChoice` every card, as the deep
 * episode (`expedition-episode.deep.test.ts`) plays its one errand. Here:
 *
 * - two errands in a row on one world: the second, offered once the first is paid and the ship is
 *   home, sets down at the site again with the arms back in the locker (both default plans on its
 *   arrival card), a fresh cast and the site known again, and is closed cleanly;
 * - a failed errand: the turn card's "Pull back to the ship", `partyWithdrew`, `jobFailed` once and
 *   nothing paid, and the ship still flies home with the site no longer known;
 * - a `fetchItem` errand: the item lies at the site's loot post, the expedition ends `targetTaken`,
 *   the item is stowed as the job's one cargo line and paid as freight at home.
 *
 * Invariants are checked every step of every run.
 */
import {
  type ItemDefId,
  type Kernel,
  type PortDefId,
  type SimEvent,
  type World,
  createKernel,
  isOnDock,
  knownSites,
  lockerWeapons,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  type EpisodeResult,
  createEpisodeWorld,
  formatEpisodeTranscript,
  runEpisodeAsync,
} from "./episode";
import { createPacingRegistry } from "./pacing";

const HARROW_END = "port.harrow_end" as PortDefId;
const HUB = "port.crossroads_hub" as PortDefId;
const CRATE = "item.crate_general" as ItemDefId;

type Payload = Record<string, unknown>;
const payload = (event: SimEvent): Payload => event.payload as Payload;

/** The job's closing events (`contractCompleted` or `jobFailed`) and its payments. */
function settlement(r: EpisodeResult) {
  const closing = r.events.filter(
    (e) =>
      (e.type === "contractCompleted" || e.type === "jobFailed") && payload(e).jobId === r.jobId,
  );
  const payments = r.transactions.filter((t) => t.jobId === r.jobId && t.reason === "jobPayment");
  return { closing, payments };
}

/** Closed cleanly: one closing event, paid exactly the offer when paid, nothing when failed. */
function expectClosedCleanly(r: EpisodeResult): void {
  const transcript = formatEpisodeTranscript(r);
  expect(r.ending, transcript).toMatch(/^(paid|failed)$/);
  expect(r.violations, transcript).toEqual([]);
  expect(r.narratorRejections, transcript).toEqual([]);
  const { closing, payments } = settlement(r);
  expect(closing, transcript).toHaveLength(1);
  if (r.ending === "paid") {
    expect(closing[0]?.type).toBe("contractCompleted");
    expect(payments.map((t) => t.amount)).toEqual([r.pay]);
  } else {
    expect(closing[0]?.type).toBe("jobFailed");
    expect(payments).toEqual([]);
  }
}

/** The cast the expedition started with: its `expeditionStarted` subjects that are not the party. */
function castOf(r: EpisodeResult): string[] {
  const started = r.events.find((e) => e.type === "expeditionStarted");
  if (started === undefined) throw new Error("no expedition started");
  const party = new Set(payload(started).party as string[]);
  return started.subjectIds.filter((id) => !party.has(id));
}

/** The plan ids the arrival card's two sides adopt. */
function arrivalPlans(world: World, r: EpisodeResult): string[] {
  const card = r.cards.find((c) => c.key === "expedition.arrival");
  const record = card === undefined ? undefined : world.state.decisions.records[card.decisionId];
  if (record === undefined) throw new Error("no arrival card");
  return [record.left, record.right].flatMap((side) =>
    side.commands
      .filter((c) => c.kind === "adoptPlan")
      .map((c) => String((c.payload as { planId: unknown }).planId)),
  );
}

function newWorld(seed: number): { kernel: Kernel; world: World } {
  const kernel = createKernel(createPacingRegistry());
  return { kernel, world: createEpisodeWorld(kernel, seed) };
}

describe("two errands in a row (expeditions A2, deep)", () => {
  it("seed 1: the second sets down with the arms back, a fresh cast and the site known again", async () => {
    const { kernel, world } = newWorld(1);
    const lockerAtStart = lockerWeapons(world.state, world.content).length;
    expect(lockerAtStart).toBeGreaterThan(0);
    const first = await runEpisodeAsync({ seed: 1, world }, kernel);
    expectClosedCleanly(first);
    expect(first.ending, formatEpisodeTranscript(first)).toBe("paid");
    // Home, the job closed: the site is off the graph and every arm is back in the locker.
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: HUB });
    expect(knownSites(world.content, world.state)).not.toContain(HARROW_END);
    expect(lockerWeapons(world.state, world.content)).toHaveLength(lockerAtStart);
    const firstCast = castOf(first);
    for (const id of firstCast) expect(world.state.actors[id as never]).toBeUndefined();

    const second = await runEpisodeAsync({ seed: 1, world }, kernel);
    const transcript = formatEpisodeTranscript(second);
    expectClosedCleanly(second);
    expect(second.jobId).not.toBe(first.jobId);
    expect(
      second.milestones.map((m) => m.name),
      transcript,
    ).toContain("landed");
    expect(arrivalPlans(world, second)).toEqual(["hold-lethal-armed", "assault-lethal-armed"]);
    const secondCast = castOf(second);
    expect(secondCast).toHaveLength(firstCast.length);
    expect(secondCast.filter((id) => firstCast.includes(id))).toEqual([]);
    expect(knownSites(world.content, world.state)).not.toContain(HARROW_END);
    expect(lockerWeapons(world.state, world.content)).toHaveLength(lockerAtStart);
  }, 240_000);
});

describe("a failed errand: the turn card's pull back (expeditions A2, deep)", () => {
  it("seed 27: the party pulls back, the job fails once unpaid, and the ship still flies home", async () => {
    // The turn card comes only when one of ours goes down in the fight: a seed where someone does.
    const { kernel, world } = newWorld(27);
    const r = await runEpisodeAsync({ seed: 27, world, turnCard: "pullBack" }, kernel);
    const transcript = formatEpisodeTranscript(r);
    const turn = r.cards.filter((c) => c.key === "expedition.turn");
    expect(turn, transcript).toHaveLength(1);
    expect(turn[0]?.chosenWithdraws).toBe(true);
    expect(
      r.events.filter((e) => e.type === "partyWithdrew"),
      transcript,
    ).toHaveLength(1);
    const resolved = r.events.find((e) => e.type === "expeditionResolved");
    expect(payload(resolved as SimEvent).outcome, transcript).toBe("partyWithdrew");
    expect(r.ending, transcript).toBe("failed");
    expect(r.errandOutcome).toBe("failed");
    expectClosedCleanly(r);
    expect(r.milestones.map((m) => m.name)).toContain("home");
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: HUB });
    expect(knownSites(world.content, world.state)).not.toContain(HARROW_END);
    // Whoever went down out there came home aboard: nobody of the crew is left at the site.
    const card =
      turn[0] === undefined ? undefined : world.state.decisions.records[turn[0].decisionId];
    const downed = world.state.actors[card?.prompt.params.actorId as never];
    expect(downed?.crew).toBe(true);
    expect(downed?.availability).not.toBe("dead");
    expect(downed?.location.kind).toBe("onDeck");
  }, 240_000);
});

describe("a fetchItem errand (expeditions A2, deep)", () => {
  it("seed 1: the crate lies at the loot post, is taken, stowed as the job's cargo and paid home", async () => {
    const { kernel, world } = newWorld(1);
    const crates = () =>
      Object.values(world.state.items).filter((i) => i.defId === CRATE && i.jobId === undefined);
    const before = crates().length;
    let atTheSite: number | undefined;
    const r = await runEpisodeAsync(
      {
        seed: 1,
        world,
        fetchItem: CRATE,
        afterStep: (w) => {
          if (atTheSite !== undefined || w.state.expedition === undefined) return;
          atTheSite = crates().filter((i) => isOnDock(w.content, w.state, i.location)).length;
        },
      },
      kernel,
    );
    const transcript = formatEpisodeTranscript(r);
    expect(atTheSite, transcript).toBe(1);
    expect(crates().length).toBeLessThanOrEqual(before);
    const resolved = r.events.find((e) => e.type === "expeditionResolved");
    expect(payload(resolved as SimEvent).outcome, transcript).toBe("targetTaken");
    expect(r.errandOutcome, transcript).toBe("broughtItem");
    expect(r.ending, transcript).toBe("paid");
    expectClosedCleanly(r);
    const job = r.jobId === undefined ? undefined : world.state.jobs[r.jobId];
    expect(job?.cargo).toEqual([{ itemDefId: CRATE, count: 1 }]);
    expect(job?.cargoItemIds).toHaveLength(1);
  }, 240_000);
});
