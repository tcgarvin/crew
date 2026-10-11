/**
 * Plan-quality harness (§the-plan, §live-narrator-tests): samples the notes turn's season, arc and
 * episode sketches on a few digests, so a prompt change to "Your plan" can be judged by reading
 * them side by side. It asserts only that the notes parse; the judging is by hand. Opt-in, because
 * each sample is a real plan call and notes turn:
 *
 *   CREW_PLAN_SAMPLES=3 pnpm exec vitest run --config vitest.live.config.ts plan-quality
 *
 * Without `CREW_PLAN_SAMPLES` (or without an `OPENROUTER_API_KEY`) the suite is skipped, so the
 * ordinary `pnpm test:live` is unchanged. `CREW_PLAN_OUT` names a file to write the samples to as
 * JSON, beside the console log.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NarratorRequest } from "../contract";
import { captainAshoreRequest, farCaptainAshoreRequest } from "../fixtures";
import { openRouterTransport } from "../openrouter";
import {
  DEFAULT_NARRATOR_MODEL,
  DEFAULT_NARRATOR_REASONING_EFFORT,
  runNarratorWithTrace,
} from "../run";
import { content } from "../test-support";

const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env.local");
if (process.env.OPENROUTER_API_KEY === undefined && existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}
const apiKey = process.env.OPENROUTER_API_KEY ?? "";
const samples = Number.parseInt(process.env.CREW_PLAN_SAMPLES ?? "0", 10);
if (Number.isNaN(samples) || samples < 0) {
  throw new Error(`Invalid CREW_PLAN_SAMPLES: ${process.env.CREW_PLAN_SAMPLES}`);
}
const model = process.env.CREW_NARRATOR_MODEL ?? DEFAULT_NARRATOR_MODEL;

function beat(name: string, what: string, tension: string, decided: boolean, status = "planned") {
  return {
    name,
    what,
    tension,
    thread: "",
    decided,
    status,
    landedTick: status === "landed" ? 1_800 : null,
    inMotion: [],
  };
}

function sketch(premise: string, beats: unknown[], until: string, tempo: string) {
  return {
    premise,
    beats,
    until,
    tempo,
    revised: "",
    revisions: 0,
    previousPremise: "",
    openedTick: 600,
  };
}

const EMPTY_SKETCH = sketch("", [], "", "steady");

/**
 * An episode opening at Kessler Drift with a season and an arc standing, two plain runs behind
 * it and a cast at this port: the notes turn should sketch an episode of a different kind that
 * serves the arc.
 */
const EPISODE_OPEN_NOTES = {
  summary:
    "Two plain runs for the Meridian growers. Ilse Brandt at the Drift's assay window has started asking the captain to carry things off the books, and Greta Lindholm, who runs the loading queue, has noticed.",
  threads: [
    {
      title: "Ilse's side trade",
      scale: "season",
      people: ["Ilse Brandt", "Greta Lindholm"],
      arcNotes:
        "Ilse buys ore off the scale and wants a ship that will not ask. The captain carried one sealed case for her last visit without looking inside; Greta saw it go aboard.",
      nextBeat:
        "Next time the ship is at the Drift, Ilse has a bigger favour, and Greta has a price for her silence.",
      lastBeatTick: 1_800,
      beatCardShown: false,
    },
  ],
  pastArcs: [
    {
      title: "Crates for the growers",
      scale: "episode",
      people: ["Ysolde Maren"],
      openedTick: 200,
      closedTick: 900,
      ending: "closingCard",
      shape: "cargo run, no trouble",
      summary:
        "Four crates of seed stock to Green Meridian, delivered on time. Ysolde Maren was pleased.",
    },
    {
      title: "Ilse's sealed case",
      scale: "episode",
      people: ["Ilse Brandt"],
      openedTick: 1_000,
      closedTick: 1_800,
      ending: "closingCard",
      shape: "cargo run, a favour",
      summary:
        "Ore to the Hub with one sealed case of Ilse's riding along. Nobody opened it; it was collected at the Hub without a word.",
    },
  ],
  cardsShown: [],
  cast: [
    {
      name: "Ilse Brandt",
      note: "assay clerk at the Drift; buys ore off the scale",
      portId: "port.kessler_drift",
      lastSeenTick: 1_800,
    },
    {
      name: "Greta Lindholm",
      note: "runs the Drift's loading queue; misses nothing",
      portId: "port.kessler_drift",
      lastSeenTick: 1_800,
    },
    {
      name: "Ysolde Maren",
      note: "grower, Meridian Growers Collective",
      portId: "port.green_meridian",
      lastSeenTick: 900,
    },
  ],
  lastUpdatedTick: 1_900,
  lastRejections: [],
  plan: {
    season: sketch(
      "Will the captain become Ilse Brandt's smuggler, and what does it cost the crew when Greta Lindholm calls it in?",
      [
        beat("The sealed case", "One quiet favour for Ilse.", "setup", false, "landed"),
        beat("Greta's price", "Greta wants paying for what she saw.", "rising", false),
        beat("The case is opened", "Someone aboard finds out what Ilse ships.", "turn", true),
        beat(
          "Ilse or the crew",
          "The captain chooses between the money and the crew.",
          "peak",
          false,
        ),
      ],
      "The captain breaks with Ilse or carries for her for good.",
      "slowBurn",
    ),
    arc: sketch(
      "Greta makes the ship pay for her silence while Ilse raises her ask.",
      [beat("Greta's price", "Greta's first demand at the queue.", "rising", false)],
      "Greta is paid off, crossed or turned.",
      "steady",
    ),
    episode: EMPTY_SKETCH,
    episodesSinceArcBeat: 0,
  },
};

/** Thin notes at the Hub, as the live suite's tool case: a season to sketch, one past arc. */
const THIN_NOTES = {
  summary:
    "Three plain cargo runs out of the Hub. The captain has promised to go back to Kessler Drift for the ledger someone at the assay window keeps; the notes never named who.",
  threads: [
    {
      title: "The assay ledger",
      scale: "season",
      people: [],
      arcNotes:
        "Someone at Kessler Drift keeps a private ledger of who shorted whom on ore weights. The captain wants it; nobody aboard knows who keeps it or what they want for it.",
      nextBeat:
        "When the season turns to the Drift, the ledger's keeper comes into it, by name, with a price.",
      lastBeatTick: 900,
      beatCardShown: false,
    },
  ],
  pastArcs: [
    {
      title: "The shorted ore",
      scale: "episode",
      people: ["Greta Lindholm"],
      openedTick: 200,
      closedTick: 800,
      ending: "closingCard",
      shape: "short weight, a grudge",
      summary:
        "The Drift's assay came in light on the ship's ore; Greta Lindholm blamed the ship. The captain paid the difference and left owing nobody, but not forgiven.",
    },
  ],
  cardsShown: [],
  cast: [],
  lastUpdatedTick: 900,
  lastRejections: [],
};

interface Case {
  readonly name: string;
  readonly request: () => NarratorRequest;
  readonly notes?: unknown;
}

const CASES: readonly Case[] = [
  { name: "game start (Drift, no notes)", request: () => captainAshoreRequest(content()) },
  {
    name: "episode open (Drift, season and arc standing)",
    request: () => captainAshoreRequest(content()),
    notes: EPISODE_OPEN_NOTES,
  },
  {
    name: "thin notes (Hub, season to sketch)",
    request: () => farCaptainAshoreRequest(content()),
    notes: THIN_NOTES,
  },
];

interface StoredBeat {
  readonly name: string;
  readonly what: string;
  readonly tension: string;
  readonly decided: boolean;
  readonly status: string;
}
interface StoredSketch {
  readonly premise: string;
  readonly beats: readonly StoredBeat[];
  readonly until: string;
  readonly tempo: string;
}

function renderSketch(tier: string, s: StoredSketch | undefined): string[] {
  if (s === undefined || s.premise === "") return [`${tier}: (none)`];
  return [
    `${tier} [${s.tempo}]: ${s.premise}${s.until === "" ? "" : ` | until: ${s.until}`}`,
    ...s.beats.map(
      (b) =>
        `  - ${b.tension}${b.decided ? " DECIDED" : ""}${b.status === "planned" ? "" : ` (${b.status})`}: "${b.name}": ${b.what}`,
    ),
  ];
}

/** The plan call's intents in short: kind, beat, and the levers and odds on any card. */
function renderIntents(plan: unknown): string[] {
  if (typeof plan !== "object" || plan === null || !("intents" in plan)) return ["(no plan)"];
  const intents = (plan as { intents: readonly Record<string, unknown>[] }).intents;
  return intents.map((i) => {
    const extra: string[] = [];
    if (i.kind === "offerJob") {
      extra.push(`${String(i.issuerName)} → ${String(i.toPort)}, pay ${String(i.payCredits)}`);
      extra.push(`"${String(i.description)}"`);
    }
    if (i.kind === "surfaceDecision") {
      const side = (s: unknown) => {
        const o = s as { label?: string; odds?: string; failLevers?: unknown[] } | undefined;
        return `${o?.label ?? "?"}${o?.odds ? ` (${o.odds}%, failLevers ${JSON.stringify(o.failLevers)})` : ""}`;
      };
      extra.push(`"${String(i.title)}": ${side(i.left)} / ${side(i.right)}`);
    }
    return `  * ${String(i.kind)} [beat "${String(i.beat ?? "")}"] ${extra.join(" ")}`;
  });
}

const suite = apiKey === "" || samples === 0 ? describe.skip : describe;

suite(`plan quality (${model}, ${samples} samples a case)`, () => {
  it("samples the notes turn's sketches on each case", async () => {
    const transport = openRouterTransport({ apiKey, appTitle: "Crew plan-quality harness" });
    const jobs = CASES.flatMap((c) => Array.from({ length: samples }, (_, n) => ({ c, n }))).map(
      async ({ c, n }) => {
        const req = c.request();
        const run = await runNarratorWithTrace(req, {
          gameId: req.gameId,
          content: content(),
          transport,
          model,
          notes: c.notes,
          reasoningEffort: DEFAULT_NARRATOR_REASONING_EFFORT,
        });
        if (run.notesTurn === undefined) {
          return { case: c.name, n, error: `no notes turn: ${run.error ?? run.response.fallback}` };
        }
        const notes = await run.notesTurn();
        if (!notes.ok) return { case: c.name, n, error: `${notes.reason}: ${notes.error}` };
        const plan = notes.notes.plan as unknown as Record<string, StoredSketch>;
        const text = [
          `=== ${c.name} #${n + 1}`,
          `rationale: ${run.trace.plan?.rationale ?? ""}`,
          ...renderIntents(run.trace.plan),
          ...renderSketch("SEASON", plan.season),
          ...renderSketch("ARC", plan.arc),
          ...renderSketch("EPISODE", plan.episode),
        ].join("\n");
        return { case: c.name, n, text, intents: run.trace.plan, plan: notes.notes.plan };
      },
    );
    const results = await Promise.all(jobs);
    for (const r of results)
      console.log("text" in r ? r.text : `=== ${r.case} #${r.n + 1}: ${r.error}`);
    const out = process.env.CREW_PLAN_OUT;
    if (out !== undefined) writeFileSync(out, JSON.stringify(results, null, 2));
    expect(results.filter((r) => "error" in r)).toEqual([]);
  }, 300_000);
});
