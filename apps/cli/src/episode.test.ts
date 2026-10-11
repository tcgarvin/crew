/**
 * `crew episode`'s pieces that run no sim: the decision policy, the site it picks, the errand it
 * offers, argument parsing and the transcript. The episode itself is
 * `expedition-episode.deep.test.ts`.
 */
import {
  type Decision,
  type DecisionId,
  type JobId,
  type PortDefId,
  createKernel,
  errandPay,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  type EpisodeResult,
  clockOf,
  episodeChoice,
  episodeErrand,
  formatEpisodeTranscript,
  nearestSite,
  parseEpisodeArgs,
} from "./episode";
import { crew } from "./index";
import { createPacingRegistry, loadPacingContent } from "./pacing";

const JOB = "job:1" as JobId;

function card(
  key: string,
  left: Decision["left"]["commands"],
  right: Decision["right"]["commands"],
  jobId?: JobId,
): Decision {
  return {
    id: "decision:1" as DecisionId,
    origin: "policy",
    perspectiveActorId: "actor:1" as never,
    prompt: { key, params: {} },
    left: { label: { key: `${key}.left`, params: {} }, commands: left },
    right: { label: { key: `${key}.right`, params: {} }, commands: right },
    status: "pending",
    createdTick: 0,
    ...(jobId === undefined ? {} : { jobId }),
  };
}

const adopt = (planId: string) => ({ kind: "adoptPlan", payload: { planId } }) as never;
const accept = (jobId: JobId) => ({ kind: "acceptContract", payload: { jobId } }) as never;
const decline = (jobId: JobId) => ({ kind: "declineJob", payload: { jobId } }) as never;
const withdraw = { kind: "withdrawParty", payload: {} } as never;

describe("episodeChoice: how the episode answers each card", () => {
  it("takes the errand's offer by its accept side, wherever that side is", () => {
    expect(episodeChoice(card("job.offer", [accept(JOB)], [decline(JOB)], JOB), JOB)).toBe("left");
    expect(episodeChoice(card("job.offer", [decline(JOB)], [accept(JOB)], JOB), JOB)).toBe("right");
  });

  it("passes on any other offer", () => {
    const other = "job:2" as JobId;
    expect(episodeChoice(card("job.offer", [accept(other)], [decline(other)], other), JOB)).toBe(
      "right",
    );
    // Before the errand's own offer has been seen, every offer is passed.
    expect(episodeChoice(card("job.offer", [accept(JOB)], [decline(JOB)], JOB), undefined)).toBe(
      "right",
    );
  });

  it("adopts the hold plan on the arrival card", () => {
    const hold = adopt("hold-lethal-armed");
    const assault = adopt("assault-lethal-armed");
    expect(episodeChoice(card("expedition.arrival", [assault], [hold]), JOB)).toBe("right");
    expect(episodeChoice(card("expedition.arrival", [hold], [assault]), JOB)).toBe("left");
    // No hold plan on the menu: the left plan, as any other card.
    expect(episodeChoice(card("expedition.arrival", [assault], [adopt("creep-x")]), JOB)).toBe(
      "left",
    );
  });

  it("adopts the creep or the assault side of an item errand's arrival card when told to", () => {
    const creep = adopt("creep-holdFire-armed");
    const assault = adopt("assault-lethal-armed");
    const arrival = card("expedition.arrival", [creep], [assault]);
    expect(episodeChoice(arrival, JOB, "pressOn", "creep")).toBe("left");
    expect(episodeChoice(arrival, JOB, "pressOn", "assault")).toBe("right");
    // Untold, the item card has no hold side: its left side.
    expect(episodeChoice(arrival, JOB)).toBe("left");
    // A posture the card does not offer is a harness error, not a quiet left side.
    expect(() => episodeChoice(arrival, JOB, "pressOn", "flank")).toThrow(/no "flank" side/);
  });

  it("presses on at the turn card", () => {
    expect(episodeChoice(card("expedition.turn", [], [withdraw]), JOB)).toBe("left");
    expect(episodeChoice(card("expedition.turn", [withdraw], []), JOB)).toBe("right");
  });

  it("pulls back at the turn card when told to", () => {
    expect(episodeChoice(card("expedition.turn", [], [withdraw]), JOB, "pullBack")).toBe("right");
    expect(episodeChoice(card("expedition.turn", [withdraw], []), JOB, "pullBack")).toBe("left");
  });

  it("answers anything else by its left side", () => {
    expect(episodeChoice(card("travel.departureGate", [], []), JOB)).toBe("left");
  });
});

describe("the errand the episode offers", () => {
  const { bundle, config, scenarioId } = loadPacingContent();
  const world = createKernel(createPacingRegistry()).createWorld(scenarioId, 1, bundle, config);
  const hub = "port.crossroads_hub" as PortDefId;

  it("goes to the authored site nearest the Hub: Harrow End, through Green Meridian", () => {
    expect(nearestSite(world, hub)).toEqual({
      siteId: "port.harrow_end",
      nearPortId: "port.green_meridian",
      distance: 45 + 20,
    });
  });

  it("is a fetchPerson errand home to the Hub, paid at the standard tier for there and back", () => {
    const draft = episodeErrand(world, hub, "port.harrow_end" as PortDefId);
    expect(draft).toMatchObject({
      fromPortId: hub,
      toPortId: hub,
      cargo: [],
      errand: { kind: "fetchPerson", siteId: "port.harrow_end", wants: "alive" },
    });
    expect(draft.pay).toBe(errandPay(world.config.values, 2 * (45 + 20), "standard").pay);
    expect(draft.pitch?.prose).not.toMatch(/\d/);
  });
});

describe("crew episode: arguments", () => {
  it("defaults to seed 1 and the nearest site", () => {
    expect(parseEpisodeArgs([])).toEqual({ seed: 1, all: false });
  });

  it("reads --seed, --site and --all", () => {
    expect(parseEpisodeArgs(["--seed", "3", "--site", "port.boathouse", "--all"])).toEqual({
      seed: 3,
      siteId: "port.boathouse",
      all: true,
    });
  });

  it("reads --item, --arrival and --unseen for an item errand and the narrator's mark", () => {
    expect(
      parseEpisodeArgs([
        "--item",
        "item.crate_general",
        "--arrival",
        "assault",
        "--unseen",
        "creep",
      ]),
    ).toEqual({
      seed: 1,
      all: false,
      fetchItem: "item.crate_general",
      arrivalCard: "assault",
      markUnseen: "creep",
    });
  });

  it("refuses a bad seed, an unknown argument and a port that is not a site", () => {
    expect(parseEpisodeArgs(["--seed", "x"])).toMatchObject({ error: expect.any(String) });
    expect(parseEpisodeArgs(["--fast"])).toMatchObject({ error: expect.any(String) });
    expect(parseEpisodeArgs(["--unseen", "sneak"])).toMatchObject({
      error: expect.stringContaining("needs a posture"),
    });
    expect(parseEpisodeArgs(["--item"])).toMatchObject({ error: expect.any(String) });
    const noItem = crew(["episode", "--item", "item.nothing"]);
    expect(noItem.exitCode).toBe(1);
    expect(noItem.output).toContain('no item "item.nothing"');
    const notSite = crew(["episode", "--site", "port.crossroads_hub"]);
    expect(notSite.exitCode).toBe(1);
    expect(notSite.output).toContain("is not a landing site");
  });
});

describe("the episode transcript", () => {
  it("reads sim time as minutes and seconds", () => {
    expect(clockOf(0)).toBe("00:00");
    expect(clockOf(725.9)).toBe("12:05");
  });

  const result: EpisodeResult = {
    seed: 1,
    startPortId: "port.crossroads_hub" as PortDefId,
    siteId: "port.harrow_end" as PortDefId,
    nearPortId: "port.green_meridian" as PortDefId,
    jobId: JOB,
    pay: 1170,
    ending: "stopped",
    stoppedBecause: 'no progress for 900 s after "landed"',
    milestones: [{ name: "offered", tick: 20 }],
    events: [],
    transcript: [
      { tick: 60, seconds: 3, kind: "card", text: "A job: Corran Vale — …", episode: true },
      { tick: 60, seconds: 3, kind: "choice", text: "→ Take the job", episode: true },
      { tick: 840, seconds: 42, kind: "ticker", text: "Left Crossroads Hub", episode: true },
      { tick: 900, seconds: 45, kind: "ticker", text: "The bell rings", episode: false },
    ],
    cards: [],
    hooksByKind: { stageDock: 1 },
    hooks: [],
    transactions: [],
    narratorRejections: [],
    moneyStart: 5000,
    moneyEnd: 4850,
    jobStatus: "inTransit",
    errandOutcome: undefined,
    simSeconds: 1101,
    tickRate: 20,
    violations: [],
    tickerLines: 2,
    episodeTickerLines: 1,
  };

  it("leads with how it ended and the milestones, then the cards and the episode's lines", () => {
    const text = formatEpisodeTranscript(result);
    expect(text).toContain('Ending: stopped — no progress for 900 s after "landed".');
    expect(text).toContain("Milestones: offered 00:01.");
    expect(text).toContain("00:03 ▣ A job: Corran Vale — …");
    expect(text).toContain("00:03   → Take the job");
    expect(text).toContain("00:42   Left Crossroads Hub");
    expect(text).not.toContain("The bell rings");
  });

  it("shows ship life too, marked, with --all", () => {
    expect(formatEpisodeTranscript(result, { all: true })).toContain("00:45 · The bell rings");
  });

  it("names the plan the narrator marked unseen, only when one was", () => {
    expect(formatEpisodeTranscript(result)).not.toContain("unseen");
    expect(formatEpisodeTranscript({ ...result, unseenPlanId: "creep-holdFire-armed" })).toContain(
      "The narrator marked creep-holdFire-armed unseen.",
    );
  });
});
