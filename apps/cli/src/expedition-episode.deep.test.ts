/**
 * Expeditions A2, the deep episode (plan W4): one errand end to end on the real content with every
 * system, the null narrator answering every hook and `episodeChoice` every card. An errand at the
 * Hub for Harrow End is taken; the ship flies the leg through Green Meridian (a waypoint docking),
 * sets down at the site with no fee and no staging call, the arrival card's hold plan is adopted,
 * the party fights, the fight resolves, the ship lifts off and flies home, and the job is closed:
 * paid, or failed with nothing paid. Two seeds; invariants are checked every step.
 */
import type { PortDefId, SimEvent } from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  EPISODE_MILESTONES,
  type EpisodeResult,
  formatEpisodeTranscript,
  runEpisodeAsync,
} from "./episode";

const HUB = "port.crossroads_hub" as PortDefId;
const HARROW_END = "port.harrow_end" as PortDefId;
const GREEN_MERIDIAN = "port.green_meridian" as PortDefId;

/** The plan's bound: the ticker tells the episode in under thirty notable-or-narrative lines. */
const MAX_EPISODE_TICKER_LINES = 30;

type Payload = Record<string, unknown>;
const payload = (event: SimEvent): Payload => event.payload as Payload;

/** The index of the first event after `from` passing `test`; -1 when there is none. */
function nextIndex(events: readonly SimEvent[], from: number, test: (e: SimEvent) => boolean) {
  const found = events.slice(from + 1).findIndex(test);
  return found === -1 ? -1 : from + 1 + found;
}

/** Each test in turn must match an event after the last one's; the indices, in order. */
function inOrder(
  events: readonly SimEvent[],
  tests: readonly (readonly [string, (e: SimEvent) => boolean])[],
): Record<string, number> {
  const at: Record<string, number> = {};
  let last = -1;
  for (const [name, test] of tests) {
    last = nextIndex(events, last, test);
    at[name] = last;
    if (last === -1) return at;
  }
  return at;
}

const departed = (from: PortDefId, to: PortDefId) => (e: SimEvent) =>
  e.type === "departed" && payload(e).fromPortId === from && payload(e).toPortId === to;
const arrived = (port: PortDefId) => (e: SimEvent) =>
  e.type === "arrived" && payload(e).portId === port;

function expectTheVoyage(r: EpisodeResult): void {
  const ours = (e: SimEvent) => payload(e).jobId === r.jobId;
  const at = inOrder(r.events, [
    ["offered", (e) => e.type === "jobOffered" && ours(e)],
    ["accepted", (e) => e.type === "jobAccepted" && ours(e)],
    ["leftHub", departed(HUB, GREEN_MERIDIAN)],
    ["waypoint", arrived(GREEN_MERIDIAN)],
    ["leg", departed(GREEN_MERIDIAN, HARROW_END)],
    ["landed", arrived(HARROW_END)],
    ["started", (e) => e.type === "expeditionStarted" && payload(e).siteId === HARROW_END],
    ["contact", (e) => e.type === "expeditionContact"],
    ["resolved", (e) => e.type === "expeditionResolved"],
    ["liftOff", departed(HARROW_END, GREEN_MERIDIAN)],
    ["waypointHome", arrived(GREEN_MERIDIAN)],
    ["leftForHome", departed(GREEN_MERIDIAN, HUB)],
    ["home", arrived(HUB)],
  ]);
  expect(Object.values(at), JSON.stringify(at)).not.toContain(-1);
}

function expectTheLanding(r: EpisodeResult): void {
  const tickOf = (name: string) => r.milestones.find((m) => m.name === name)?.tick;
  const landed = tickOf("landed");
  const liftedOff = tickOf("liftedOff");
  if (landed === undefined || liftedOff === undefined) throw new Error("never landed or left");
  // §3.3: setting down at a site costs nothing and raises no staging call; the captain stays aboard.
  const atSite = r.transactions.filter((t) => t.tick >= landed && t.tick <= liftedOff);
  expect(atSite.filter((t) => t.reason === "fee")).toEqual([]);
  const siteHooks = r.hooks.filter((h) => h.dockedAt === HARROW_END).map((h) => h.kind);
  expect(siteHooks).not.toContain("stageDock");
  expect(siteHooks).not.toContain("captainAshore");
}

function expectTheCards(r: EpisodeResult): void {
  const [offer] = r.cards;
  expect(offer).toMatchObject({ key: "job.offer", title: "A job: Corran Vale" });
  expect(offer?.situation).not.toMatch(/\d/);
  const arrivals = r.cards.filter((c) => c.key === "expedition.arrival");
  expect(arrivals).toHaveLength(1);
  expect(arrivals[0]?.narrated).toBe(true);
  expect(arrivals[0]?.chosenPlanId).toMatch(/^hold-/);
  expect(r.planAdopted).toBe(arrivals[0]?.chosenPlanId);
  // Call 15: once a fight at most, and the episode presses on.
  const turns = r.cards.filter((c) => c.key === "expedition.turn");
  expect(turns.length).toBeLessThanOrEqual(1);
  for (const turn of turns) expect(turn.chosenWithdraws).toBe(false);
}

function expectTheSettlement(r: EpisodeResult): void {
  const payments = r.transactions.filter((t) => t.jobId === r.jobId && t.reason === "jobPayment");
  const closing = r.events.filter(
    (e) =>
      (e.type === "contractCompleted" || e.type === "jobFailed") && payload(e).jobId === r.jobId,
  );
  expect(closing).toHaveLength(1);
  if (r.ending === "paid") {
    expect(r.errandOutcome).toMatch(/^brought(Alive|Dead)$/);
    expect(closing[0]?.type).toBe("contractCompleted");
    expect(payments.map((t) => t.amount)).toEqual([r.pay]);
    expect(r.moneyEnd).toBeGreaterThan(r.moneyStart);
  } else {
    expect(closing[0]?.type).toBe("jobFailed");
    expect(payments).toEqual([]);
  }
}

describe("one errand, end to end (expeditions A2, the deep episode)", () => {
  for (const seed of [1, 2]) {
    it(`seed ${seed}: offer, the leg via Green Meridian, landing, the card, the fight, home, closed`, async () => {
      const r = await runEpisodeAsync({ seed });
      const transcript = formatEpisodeTranscript(r);
      expect(r.siteId).toBe(HARROW_END);
      expect(r.nearPortId).toBe(GREEN_MERIDIAN);
      expect(r.ending, transcript).toMatch(/^(paid|failed)$/);
      expect(r.violations, transcript).toEqual([]);
      expect(r.narratorRejections).toEqual([]);
      expect(r.milestones.map((m) => m.name)).toEqual([...EPISODE_MILESTONES]);
      const ticks = r.milestones.map((m) => m.tick);
      expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
      expectTheVoyage(r);
      expectTheLanding(r);
      expectTheCards(r);
      expectTheSettlement(r);
      expect(r.episodeTickerLines, transcript).toBeLessThan(MAX_EPISODE_TICKER_LINES);
    }, 240_000);
  }
});
