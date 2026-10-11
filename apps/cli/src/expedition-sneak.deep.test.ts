/**
 * D105, getting in unseen (§getting-in-unseen, §unseen-lever), deep: a `fetchItem` errand from the
 * Hub to Harrow End on the real content with every system, the null narrator answering every hook
 * and `episodeChoice` every card, as `expedition-errands.deep.test.ts` plays its item errand. On
 * the arrival card's `policyDecision` hook the harness has the narrator mark the creep side unseen
 * (`markUnseen`), and the captain then picks:
 *
 * - A: the marked creep side: nobody fires, there is no contact and no alert, the item is carried
 *   aboard (`broughtItem`, the job's one cargo line) and nobody is taken, the ship flies home by
 *   Green Meridian and the job is paid the offer;
 * - B: the assault side: they were waiting, so contact comes within a tick of the first of the
 *   party standing on the site floor;
 * - C, nothing marked, the creep side: the sim's own noticing, so contact (if it comes) comes
 *   later than B's, never the moment they step down.
 *
 * Every run advances a tick at a time from the plan's adoption to the expedition's end, so the
 * floor and contact ticks are exact, and invariants are checked every step. Two seeds.
 */
import {
  type ItemDefId,
  type Kernel,
  type PortDefId,
  type Posture,
  type SimEvent,
  type World,
  createKernel,
  isOnDock,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  type EpisodeOptions,
  type EpisodeResult,
  createEpisodeWorld,
  formatEpisodeTranscript,
  runEpisodeAsync,
} from "./episode";
import { createPacingRegistry } from "./pacing";

const HARROW_END = "port.harrow_end" as PortDefId;
const GREEN_MERIDIAN = "port.green_meridian" as PortDefId;
const HUB = "port.crossroads_hub" as PortDefId;
const CRATE = "item.crate_general" as ItemDefId;
const CREEP_PLAN = "creep-holdFire-armed";
const ASSAULT_PLAN = "assault-lethal-armed";
const SEEDS = [1, 2] as const;

type Payload = Record<string, unknown>;
const payload = (event: SimEvent): Payload => event.payload as Payload;

/** What the run saw at the site, every tick of the expedition. */
interface SiteWatch {
  /** The first tick any party member stood on the site floor. */
  firstOnFloorTick?: number;
  /** The fight's alert was up at some point. */
  alert: boolean;
  /** The most shots the expedition counted. */
  shots: number;
}

/** An expedition with a plan that has not resolved: the stretch played a tick at a time. */
function planned(world: World): boolean {
  const expedition = world.state.expedition;
  return expedition?.plan !== undefined && expedition.phase !== "resolved";
}

/** The episode, with the arrival card answered by `arrival` and `unseen` marked, if given. */
async function sneak(
  seed: number,
  arrival: Posture,
  unseen: Posture | undefined,
  unseenOdds?: number,
): Promise<{ r: EpisodeResult; watch: SiteWatch; world: World; transcript: string }> {
  const kernel: Kernel = createKernel(createPacingRegistry());
  const world = createEpisodeWorld(kernel, seed);
  const watch: SiteWatch = { alert: false, shots: 0 };
  const options: EpisodeOptions = {
    seed,
    world,
    fetchItem: CRATE,
    arrivalCard: arrival,
    ...(unseen === undefined ? {} : { markUnseen: unseen }),
    ...(unseenOdds === undefined ? {} : { unseenOdds }),
    ticksPerAdvance: (w) => (planned(w) ? 1 : 10),
    afterStep: (w) => {
      const expedition = w.state.expedition;
      if (expedition === undefined) return;
      if (w.state.alert?.cause === "fight") watch.alert = true;
      watch.shots = Math.max(watch.shots, expedition.shots);
      if (watch.firstOnFloorTick !== undefined) return;
      const ashore = expedition.party.some((id) => {
        const actor = w.state.actors[id];
        return actor !== undefined && isOnDock(w.content, w.state, actor.location);
      });
      if (ashore) watch.firstOnFloorTick = w.state.tick;
    },
  };
  const r = await runEpisodeAsync(options, kernel);
  return { r, watch, world, transcript: formatEpisodeTranscript(r) };
}

function resolvedOf(r: EpisodeResult, transcript: string): Payload {
  const resolved = r.events.find((e) => e.type === "expeditionResolved");
  expect(resolved, transcript).toBeDefined();
  return payload(resolved as SimEvent);
}

/** The tick of the first `expeditionContact`, if any. */
function contactTick(r: EpisodeResult): number | undefined {
  return r.events.find((e) => e.type === "expeditionContact")?.tick;
}

/** The ports the ship arrived at after lifting off from the site, in order. */
function wayHome(r: EpisodeResult): PortDefId[] {
  const liftedOff = r.milestones.find((m) => m.name === "liftedOff")?.tick;
  if (liftedOff === undefined) return [];
  return r.events
    .filter((e) => e.type === "arrived" && e.tick >= liftedOff)
    .map((e) => payload(e).portId as PortDefId);
}

/** Every run: the arrival card answered as asked, no violation, no narrator command refused. */
function expectHealthy(r: EpisodeResult, transcript: string, plan: string): void {
  expect(r.siteId).toBe(HARROW_END);
  expect(r.violations, transcript).toEqual([]);
  expect(r.narratorRejections, transcript).toEqual([]);
  const arrival = r.cards.find((c) => c.key === "expedition.arrival");
  expect(arrival?.chosenPlanId, transcript).toBe(plan);
}

for (const seed of SEEDS) {
  describe(`getting in unseen at Harrow End (D105, deep), seed ${seed}`, () => {
    it("A: the marked creep side gets in and out unseen, with the item, and is paid home", async () => {
      const { r, watch, world, transcript } = await sneak(seed, "creep", "creep");
      expectHealthy(r, transcript, CREEP_PLAN);
      expect(r.unseenPlanId, transcript).toBe(CREEP_PLAN);
      expect(r.unseenRoll, transcript).toEqual({ odds: 100, worked: true });
      expect(watch.firstOnFloorTick, transcript).toBeDefined();
      const resolved = resolvedOf(r, transcript);
      expect(resolved.notice, transcript).toBe("unseen");
      expect(resolved.outcome, transcript).toBe("targetTaken");
      expect(resolved.shots, transcript).toBe(0);
      expect(watch.shots, transcript).toBe(0);
      expect(contactTick(r), transcript).toBeUndefined();
      expect(watch.alert, transcript).toBe(false);
      // The item comes aboard, nobody is taken: no captive boards.
      expect(r.errandOutcome, transcript).toBe("broughtItem");
      expect(
        r.events.filter((e) => e.type === "passengerBoarded"),
        transcript,
      ).toEqual([]);
      const job = r.jobId === undefined ? undefined : world.state.jobs[r.jobId];
      expect(job?.cargo).toEqual([{ itemDefId: CRATE, count: 1 }]);
      // Home by Green Meridian, closed once and paid the offer.
      expect(wayHome(r), transcript).toEqual([GREEN_MERIDIAN, HUB]);
      expect(world.state.travel).toMatchObject({ stage: "docked", portId: HUB });
      expect(r.ending, transcript).toBe("paid");
      const closing = r.events.filter(
        (e) =>
          (e.type === "contractCompleted" || e.type === "jobFailed") &&
          payload(e).jobId === r.jobId,
      );
      expect(closing.map((e) => e.type)).toEqual(["contractCompleted"]);
      const payments = r.transactions.filter(
        (t) => t.jobId === r.jobId && t.reason === "jobPayment",
      );
      expect(payments.map((t) => t.amount)).toEqual([r.pay]);
    }, 300_000);

    it("A2: marked creep at no chance, the captain picks it: the roll fails, they were waiting (§unseen-odds)", async () => {
      const { r, watch, transcript } = await sneak(seed, "creep", "creep", 0);
      expectHealthy(r, transcript, CREEP_PLAN);
      expect(r.unseenRoll, transcript).toEqual({ odds: 0, worked: false });
      expect(resolvedOf(r, transcript).notice, transcript).toBe("seen");
      const floor = watch.firstOnFloorTick;
      const contact = contactTick(r);
      expect(contact, transcript).toBeDefined();
      expect((contact as number) - (floor as number), transcript).toBeLessThanOrEqual(1);
      expect(transcript).toContain("unseen (0%): they were waiting.");
    }, 300_000);

    it("B: marked creep, the captain picks assault: they were waiting, contact on the floor", async () => {
      const { r, watch, transcript } = await sneak(seed, "assault", "creep");
      expectHealthy(r, transcript, ASSAULT_PLAN);
      expect(r.unseenPlanId, transcript).toBe(CREEP_PLAN);
      expect(resolvedOf(r, transcript).notice, transcript).toBe("seen");
      const floor = watch.firstOnFloorTick;
      const contact = contactTick(r);
      expect(floor, transcript).toBeDefined();
      expect(contact, transcript).toBeDefined();
      const lag = (contact as number) - (floor as number);
      expect(lag, transcript).toBeGreaterThanOrEqual(0);
      expect(lag, transcript).toBeLessThanOrEqual(1);
      expect(r.ending, transcript).toMatch(/^(paid|failed)$/);
    }, 300_000);

    it("C: nothing marked, creep: the sim's own noticing, never contact the moment they land", async () => {
      const { r, watch, transcript } = await sneak(seed, "creep", undefined);
      expectHealthy(r, transcript, CREEP_PLAN);
      expect(r.unseenPlanId).toBeUndefined();
      expect(resolvedOf(r, transcript).notice, transcript).toBeUndefined();
      const floor = watch.firstOnFloorTick;
      expect(floor, transcript).toBeDefined();
      const contact = contactTick(r);
      if (contact !== undefined) expect(contact - (floor as number), transcript).toBeGreaterThan(1);
      expect(r.ending, transcript).toMatch(/^(paid|failed)$/);
    }, 300_000);
  });
}
