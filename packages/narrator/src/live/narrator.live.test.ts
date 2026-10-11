/**
 * Live narrator tests (§live-narrator-tests): one real OpenRouter call per hook kind, through the
 * production transport, prompt and schema. The unit suite never touches the network, so it cannot
 * see a provider rejecting the request; this one does. Run by hand before deploying prompt, schema
 * or transport changes:
 *
 *   pnpm test:live
 *
 * Excluded from `pnpm test` (see `vitest.config.ts` here and `vitest.live.config.ts` at the
 * root). Skipped entirely without an `OPENROUTER_API_KEY` in the environment or in
 * `packages/narrator/.env.local` (gitignored). The key is never printed.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DecisionId } from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorIntent, NarratorRequest, NarratorResponse } from "../contract";
import {
  approachRequest,
  captainAshoreRequest,
  departureGateRequest,
  farCaptainAshoreRequest,
  notableEventRequest,
  passengerOverdueRequest,
  quietTooLongRequest,
  requestedCallRequest,
  siteArrivalRequest,
  siteItemArrivalRequest,
  siteTurnRequest,
  stageDockRequest,
} from "../fixtures";
import { NULL_NARRATOR_MODEL } from "../null";
import { openRouterTransport } from "../openrouter";
import {
  DEFAULT_NARRATOR_MODEL,
  DEFAULT_NARRATOR_REASONING_EFFORT,
  type NarratorRun,
  runNarratorWithTrace,
} from "../run";
import { content } from "../test-support";
import { captainName } from "../translate";
import { REASONING_EFFORTS } from "../transport";

const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env.local");

function loadApiKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY === undefined && existsSync(ENV_FILE)) {
    process.loadEnvFile(ENV_FILE);
  }
  const key = process.env.OPENROUTER_API_KEY;
  return key === undefined || key === "" ? undefined : key;
}

const apiKey = loadApiKey();
const model = process.env.CREW_NARRATOR_MODEL ?? DEFAULT_NARRATOR_MODEL;
/**
 * §staging-call-on-the-server: the staging call can run on its own (cheaper) model, as the server's
 * `CREW_STAGING_MODEL`.
 */
const stagingModel = process.env.CREW_STAGING_MODEL ?? model;
/**
 * §models-and-reasoning-effort: as the server's `CREW_NARRATOR_REASONING_EFFORT` (staging uses the
 * same here).
 */
const reasoningEffort = REASONING_EFFORTS.find(
  (e) => e === (process.env.CREW_NARRATOR_REASONING_EFFORT ?? DEFAULT_NARRATOR_REASONING_EFFORT),
);
if (reasoningEffort === undefined) {
  throw new Error(
    `Invalid CREW_NARRATOR_REASONING_EFFORT: ${process.env.CREW_NARRATOR_REASONING_EFFORT}`,
  );
}
/** One real call can take a while on a cold cache; the transport itself times out at 25 s. */
const LIVE_TIMEOUT_MS = 60_000;

const suite = apiKey === undefined ? describe.skip : describe;
const skipReason =
  apiKey === undefined
    ? " (skipped: no OPENROUTER_API_KEY in the environment or packages/narrator/.env.local)"
    : "";

/**
 * One live call. §notes-turn: a story call the model answered is followed by its notes turn, as the
 * server runs it; the notes it writes replace the response's, and both latencies are logged.
 */
async function liveRun(
  req: NarratorRequest,
  options: { readonly model?: string; readonly notes?: unknown } = {},
): Promise<NarratorRun> {
  if (apiKey === undefined) throw new Error("no API key");
  const started = Date.now();
  const run = await runNarratorWithTrace(req, {
    gameId: req.gameId,
    content: content(),
    transport: openRouterTransport({ apiKey, appTitle: "Crew live tests" }),
    model: options.model ?? model,
    notes: options.notes,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  });
  const planMs = Date.now() - started;
  if (run.notesTurn === undefined) return run;
  const notes = await run.notesTurn();
  const notesMs = Date.now() - started - planMs;
  expect(notes.ok, notes.ok ? "" : `notes turn failed (${notes.reason}): ${notes.error}`).toBe(
    true,
  );
  if (!notes.ok) return run;
  console.log(
    `${req.hook.kind}: plan ${planMs} ms (${run.response.usage?.outputTokens} out), notes ${notesMs} ms (${notes.usage.outputTokens} out, ${notes.usage.cacheReadInputTokens}/${notes.usage.inputTokens} cached); repairs (§repair-turn) plan ${run.repairs.length}, notes ${notes.repairs.length}; summary: ${notes.notes.summary}`,
  );
  return { ...run, response: { ...run.response, notesUpdate: notes.notes } };
}

/**
 * §staging-call-on-the-server: notes for the staging case, so the story gives the set dresser
 * something to stage for: a thread due at Kessler Drift and a cast member placed there.
 */
const STAGING_NOTES = {
  summary:
    "The crew took a rush ore-sample run from the Drift last time and jumped Greta Lindholm's loading queue to make it.",
  threads: [
    {
      title: "Greta's queue",
      scale: "episode",
      people: ["Greta Lindholm", "Ilse Brandt"],
      arcNotes: "Greta thinks the ship jumped her queue on the last visit, and has not forgotten.",
      nextBeat:
        "Next time the ship is at Kessler Drift, Greta makes them wait, and Ilse offers a way round her.",
      lastBeatTick: 600,
      beatCardShown: false,
    },
  ],
  cardsShown: [],
  cast: [
    {
      name: "Ilse Brandt",
      note: "ore buyer at the Drift; owes the captain a favour and hates Greta's queue",
      portId: "port.kessler_drift",
      lastSeenTick: 600,
    },
  ],
  lastUpdatedTick: 600,
  lastRejections: [],
};

/**
 * §requested-call-back: notes for the requested departure call: the Meridian run taken at the Hub,
 * and the leg the model meant to test the junior pilot on.
 */
const REQUESTED_CALL_NOTES = {
  summary:
    "The crew took Tobiah Rask's crates for the Meridian growers at Crossroads Hub. Noor Haddad, the junior pilot, has the helm for the run.",
  threads: [
    {
      title: "Noor's first hard leg",
      scale: "episode",
      people: ["Noor Haddad", "Jax Okonkwo"],
      stage:
        "Noor has the helm on the Meridian run; Jax thinks she is not ready for anything rough.",
      nextBeat: "Once the ship is under way to Green Meridian, the leg tests Noor at the helm.",
      lastBeatTick: null,
      beatCardShown: false,
    },
  ],
  cardsShown: [],
  cast: [
    {
      name: "Tobiah Rask",
      note: "freight broker, Meridian Trading House; gave us the growers' crates",
      portId: "port.crossroads_hub",
      lastSeenTick: 2_600,
    },
  ],
  lastUpdatedTick: 2_900,
  lastRejections: [],
};

/** §the-plan: a stored beat as the server keeps it. */
function plannedBeat(
  name: string,
  what: string,
  tension: string,
  thread: string,
  decided: boolean,
) {
  return {
    name,
    what,
    tension,
    thread,
    decided,
    status: "planned",
    landedTick: null,
    inMotion: [],
  };
}

function plannedSketch(premise: string, beats: unknown[], until: string, tempo: string) {
  return {
    premise,
    beats,
    until,
    tempo,
    revised: "",
    revisions: 0,
    previousPremise: "",
    openedTick: 2_600,
  };
}

/**
 * §the-plan, §beat-attribution: the departure call's notes with a plan standing, whose episode's
 * next beat is the leg's test of Noor at the helm, so the model has a beat to name.
 */
const PLANNED_NOTES = {
  ...REQUESTED_CALL_NOTES,
  plan: {
    season: plannedSketch(
      "Can a crew this green earn the Meridian growers' trust before the Trading House squeezes them out?",
      [
        plannedBeat("Plain runs", "A few clean runs for the growers.", "setup", "", false),
        plannedBeat("The House leans in", "Rask's people make their move.", "rising", "", false),
      ],
      "The growers sign with us or with the House.",
      "slowBurn",
    ),
    arc: plannedSketch(
      "Noor learns the helm the hard way on the Meridian runs.",
      [
        plannedBeat(
          "Noor's first hard leg",
          "This run tests her.",
          "rising",
          "Noor's first hard leg",
          false,
        ),
      ],
      "Noor flies a hard leg clean, or Jax takes the helm from her.",
      "steady",
    ),
    episode: {
      ...plannedSketch(
        "Rask's crates to Green Meridian with Noor at the helm.",
        [
          {
            ...plannedBeat("Rask's crates", "The offer at the Hub.", "setup", "", false),
            status: "landed",
            landedTick: 2_600,
          },
          plannedBeat(
            "Noor at the helm",
            "A hard stretch on the leg, with Noor at the helm.",
            "rising",
            "Noor's first hard leg",
            true,
          ),
          plannedBeat(
            "Jax's doubt",
            "Jax brings his worry to the captain.",
            "turn",
            "Noor's first hard leg",
            false,
          ),
          plannedBeat("Delivered", "The growers take the crates.", "release", "", false),
        ],
        "",
        "steady",
      ),
    },
    episodesSinceArcBeat: 0,
  },
};

/**
 * Expeditions A2: notes for the errand case, at the Hub: a thread whose next beat is an errand, so
 * the model has a reason to reach for one (and the test sees whether it translates).
 */
const ERRAND_NOTES = {
  summary:
    "The crew have run two plain cargo jobs out of the Hub. At Green Meridian the growers talk of a co-op steward who ran with the seed money.",
  threads: [
    {
      title: "The steward who ran",
      scale: "episode",
      people: ["Ysolde Maren", "Teodor Lusk"],
      arcNotes:
        "Teodor Lusk, steward of the Meridian Growers Collective, vanished with the seed fund; word is he is holed up at the old silo yard at Harrow End with people of his own.",
      nextBeat:
        "When the captain is next looking for work at the Hub, Ysolde Maren asks the ship to bring Teodor back from Harrow End, alive.",
      lastBeatTick: 1_200,
      beatCardShown: false,
    },
  ],
  cardsShown: [],
  cast: [
    {
      name: "Ysolde Maren",
      note: "grower with the Meridian Growers Collective; wants the steward brought home",
      portId: "port.crossroads_hub",
      lastSeenTick: 1_200,
    },
  ],
  lastUpdatedTick: 1_200,
  lastRejections: [],
};

/**
 * D105: notes for the item errand's arrival card: the story has set up a quiet way in (the gleaner
 * Wenna Brae told Ysolde of the back lane to the seed container doors, and that old Amos at the back
 * door is deaf on that side), so the model has a reason to name the creep side unseen.
 */
const ITEM_ERRAND_NOTES = {
  summary:
    "Ysolde Maren of the Meridian Growers Collective sent the ship from the Hub to Harrow End for the Collective's seed stock, which Teodor Lusk sold to an off-world buyer. The ship has just set down at the silo yard.",
  threads: [
    {
      title: "The Collective's seed",
      scale: "episode",
      people: ["Ysolde Maren", "Teodor Lusk", "Wenna Brae"],
      arcNotes:
        "Teodor sold the Collective's seed stock to an off-world buyer; it sits crated at the seed container doors at Harrow End, watched by the buyer's hired gun Rhee Castellan. Wenna Brae, who gleans the yard, told Ysolde the back lane runs behind the weigh-house to the container doors, and that old Amos Wray at the back door is deaf on that side.",
      nextBeat:
        "At Harrow End the crew choose how to go in; Wenna's back lane is the quiet way to the seed.",
      lastBeatTick: 0,
      beatCardShown: false,
    },
  ],
  cardsShown: [],
  cast: [
    {
      name: "Ysolde Maren",
      note: "grower with the Meridian Growers Collective; wants the seed stock home",
      portId: "port.crossroads_hub",
      lastSeenTick: 0,
    },
    {
      name: "Wenna Brae",
      note: "gleaner at Harrow End; told Ysolde of the back lane behind the weigh-house",
      portId: "",
      lastSeenTick: 0,
    },
  ],
  lastUpdatedTick: 0,
  lastRejections: [],
};

/**
 * §outcome-levers (D106): notes for a quiet leg whose thread is due a falling-out: Tomas found the
 * marked deck Jax won his share with, and the beat is the two falling out over it, so the model has
 * a reason to reach for fallOut or plantMemory (the test only sees whether what it sends translates).
 */
const FALLING_OUT_NOTES = {
  summary:
    "The crew are on the Meridian run with the growers' crates. At the Hub Jax Okonkwo won most of Tomas Ruiz's share of the last run at cards.",
  threads: [
    {
      title: "The marked deck",
      scale: "episode",
      people: ["Tomas Ruiz", "Jax Okonkwo"],
      arcNotes:
        "Jax took Tomas's share at cards at the Hub. Tomas has since found the deck Jax brought aboard, and the corners are nicked. He has told nobody yet.",
      nextBeat:
        "On this leg it comes out: Tomas confronts Jax over the marked deck, and the two fall out for good. The crew will feel it at dinner; the decision is not the captain's to make, it is the story's.",
      lastBeatTick: 3_000,
      beatCardShown: true,
    },
  ],
  cardsShown: [],
  cast: [],
  lastUpdatedTick: 3_000,
  lastRejections: [],
};

/**
 * §tried-sides, §follow-up-cards: a thread whose next beat is the captain's gamble, with a chance
 * the story has set up and a consequence if it fails, so a try (and a follow-up) is the natural card.
 */
const GAMBLE_NOTES = {
  summary:
    "The crew are on the Meridian run. Tomas Ruiz stowed a few crates of undeclared ore in the aft hold at Kessler, and the captain does not know yet.",
  threads: [
    {
      title: "The customs launch",
      scale: "episode",
      people: ["Tomas Ruiz", "Dane Whitcross", "Ines Varga"],
      arcNotes:
        "A customs launch out of Kessler has been shadowing the ship. Its officer, Ines Varga, is by the book but tired and near the end of her shift. Dane Whitcross has seen the ore and thinks a bluff about a sealed medical cargo might work, maybe half the time.",
      nextBeat:
        "Now: Varga hails and asks to board and inspect the aft hold. The first officer brings it to the captain: open the hold, or bluff her off. The bluff is a real gamble the captain chooses; if it fails, she fines the ship and her report follows them, and what Varga says next is its own decision.",
      lastBeatTick: 3_000,
      beatCardShown: false,
    },
  ],
  cardsShown: [],
  cast: [
    {
      name: "Ines Varga",
      note: "Kessler customs officer on the launch; by the book, tired.",
      portId: "port.kessler_drift",
    },
  ],
  lastUpdatedTick: 3_000,
  lastRejections: [],
};

/** §tried-sides, §follow-up-cards: what a written card used of the slice-6 fields, for the log. */
function cardShape(intent: unknown): string {
  const card = intent as {
    left?: { odds?: string; failLevers?: number[] };
    right?: { odds?: string; failLevers?: number[] };
    followUps?: { on: string }[];
    beatOfThread?: string;
    closesThread?: string;
  };
  const odds = [card.left?.odds, card.right?.odds].map((o) =>
    o === undefined || o === "" ? "-" : o,
  );
  const levers = [...(card.left?.failLevers ?? []), ...(card.right?.failLevers ?? [])];
  const followUps = (card.followUps ?? []).map((f) => f.on);
  const thread = `beatOfThread "${card.beatOfThread ?? ""}", closesThread "${card.closesThread ?? ""}"`;
  return `odds ${odds.join("/")}, failLevers ${JSON.stringify(levers)}, followUps ${JSON.stringify(followUps)}, ${thread}`;
}

/** §outcome-levers: the kinds that decide an outcome outright. */
const OUTCOME_KINDS: readonly string[] = [
  "strike",
  "transact",
  "plantMemory",
  "fallOut",
  "giveThought",
  "reveal",
  "injectFault",
];

/** §requested-call-back: the call-back request the model wrote, for the run log. */
function callBackOf(run: NarratorRun): string {
  const plan = run.trace.plan;
  if (plan === undefined || !("callBack" in plan)) return "none";
  return JSON.stringify(plan.callBack);
}

/** A dressed card's player-facing text, every field, for the no-numbers check. */
function playerText(card: NarratorResponse["card"]): string {
  if (card === undefined) return "";
  return [
    card.title,
    card.situation,
    card.leftLabel,
    card.rightLabel,
    card.leftAftermath,
    card.rightAftermath,
  ].join("\n");
}

/** The checks every hook shares: the model answered, the plan parsed, nothing fell back. */
function expectModelAnswered(run: NarratorRun): NarratorResponse {
  const { response } = run;
  if (response.fallback !== undefined) {
    console.log(`raw reply that fell back for ${req(run)}:`, run.trace.rawContent ?? "(none)");
  }
  expect(
    response.fallback,
    `narrator fell back (${response.fallback ?? "?"}): ${run.error ?? "no error recorded"}`,
  ).toBeUndefined();
  expect(response.model).not.toBe(NULL_NARRATOR_MODEL);
  expect(response.usage?.outputTokens ?? 0).toBeGreaterThan(0);
  expect(Array.isArray(response.notesUpdate?.threads)).toBe(true);
  if (response.dropped !== undefined && response.dropped.length > 0) {
    console.log(`dropped intents for ${req(run)}:`, JSON.stringify(response.dropped, null, 2));
  }
  return response;
}

function req(run: NarratorRun): string {
  return run.trace.digest.split("\n")[0] ?? "call";
}

suite(
  `live narrator (${model}; staging ${stagingModel}; effort ${reasoningEffort})${skipReason}`,
  () => {
    it(
      "stageDock: a staging-only plan that names a real post of the dock (§staging-call-on-the-server)",
      async () => {
        const request = stageDockRequest(content());
        if (request.hook.kind !== "stageDock") throw new Error("fixture hook kind");
        const started = Date.now();
        const run = await liveRun(request, { model: stagingModel, notes: STAGING_NOTES });
        const { response } = run;
        expect(
          response.fallback,
          `staging fell back (${response.fallback ?? "?"}): ${run.error ?? "no error recorded"}`,
        ).toBeUndefined();
        console.log(
          `staging (${response.model}, ${Date.now() - started} ms, usage ${JSON.stringify(response.usage)}):`,
          JSON.stringify(run.trace.plan, null, 2),
        );
        if (response.dropped !== undefined && response.dropped.length > 0) {
          console.log("staging dropped:", JSON.stringify(response.dropped, null, 2));
        }
        // Staging only: at most one command, and it is stageDock; no notes, no card.
        expect(response.notesUpdate).toBeUndefined();
        expect(response.card).toBeUndefined();
        expect(response.commands.length).toBeLessThanOrEqual(1);
        const command = response.commands[0];
        expect(command?.kind, "no stageDock command").toBe("stageDock");
        if (command?.kind !== "stageDock") return;
        const dock = content().docks?.[request.hook.context.dockId];
        const posts = new Set(dock?.posts.map((p) => p.key));
        const named = [
          ...command.payload.place.map((p) => p.postKey),
          ...command.payload.props.flatMap((p) => (p.at.kind === "post" ? [p.at.postKey] : [])),
        ];
        expect(named.length, "the plan names no post").toBeGreaterThan(0);
        for (const key of named) expect(posts.has(key), `"${key}" is not a post`).toBe(true);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "captainAshore: the captain on the dock gets an offer, or the model says why not (§captain-ashore-ask)",
      async () => {
        const request = captainAshoreRequest(content());
        const run = await liveRun(request);
        const response = expectModelAnswered(run);
        const offer = response.commands.find((c) => c.kind === "offerJob");
        const rationale = run.trace.plan?.rationale?.trim() ?? "";
        console.log(`captainAshore callBack: ${callBackOf(run)}`);
        expect(
          offer !== undefined || rationale.length > 0,
          `no offer and no stated reason (dropped: ${JSON.stringify(response.dropped)})`,
        ).toBe(true);
        if (offer?.kind !== "offerJob") {
          console.log(`no offer for ${req(run)}; rationale: ${rationale}`);
          return;
        }
        // The issuer is who the captain meets: someone on the dock, or someone beyond the gate.
        const issuer = offer.payload.job.issuer;
        const name = typeof issuer === "string" ? issuer : issuer.name;
        const locals = Object.values(request.snapshot.state.dockside.locals).map((l) => l.name);
        console.log(
          `offer from ${name} (${locals.includes(name) ? "on the dock" : "beyond the gate"})`,
        );
        if (request.hook.kind !== "captainAshore") throw new Error("fixture hook kind");
        expect(offer.payload.job.fromPortId).toBe(request.hook.context.portId);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "requestedCall at departure: the model carries out its plan for the leg, or says why not, and asks again (§requested-call-back)",
      async () => {
        const request = requestedCallRequest(content());
        const run = await liveRun(request, { notes: REQUESTED_CALL_NOTES });
        const response = expectModelAnswered(run);
        const kinds = response.commands.map((c) => c.kind);
        const rationale = run.trace.plan?.rationale?.trim() ?? "";
        console.log(
          `requestedCall: commands ${JSON.stringify(kinds)}, callBack ${callBackOf(run)}; rationale: ${rationale}`,
        );
        const setPiece = kinds.some(
          (k) => k === "scheduleHazard" || k === "scheduleField" || k === "surfaceDecision",
        );
        expect(
          setPiece || rationale.length > 0,
          `no hazard, field or card and no stated reason (dropped: ${JSON.stringify(response.dropped)})`,
        ).toBe(true);
        expect(kinds, "no requestCall emitted").toContain("requestCall");
        expect(kinds, "an offer in flight").not.toContain("offerJob");
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "captainAshore with no plan: the notes turn sketches a season, an arc and the episode the offer opens (§the-plan)",
      async () => {
        const run = await liveRun(captainAshoreRequest(content()));
        const response = expectModelAnswered(run);
        const plan = response.notesUpdate?.plan;
        console.log("plan written at captainAshore:", JSON.stringify(plan, null, 2));
        console.log("corrections:", JSON.stringify(response.notesUpdate?.lastRejections));
        expect(plan?.season.premise, "no season sketched").not.toBe("");
        expect(plan?.arc.premise, "no arc sketched").not.toBe("");
        expect(plan?.episode.premise, "no episode sketched").not.toBe("");
        expect(plan?.episode.beats.length ?? 0).toBeGreaterThanOrEqual(3);
      },
      LIVE_TIMEOUT_MS * 2,
    );

    it(
      "requestedCall at departure with a plan standing: any beat it names is an episode beat (§beat-attribution)",
      async () => {
        const run = await liveRun(requestedCallRequest(content()), { notes: PLANNED_NOTES });
        const response = expectModelAnswered(run);
        const plan = run.trace.plan;
        const intents: readonly NarratorIntent[] =
          plan !== undefined && "callBack" in plan ? plan.intents : [];
        const named = intents.flatMap((i) => (i.beat !== "" ? [`${i.kind}: ${i.beat}`] : []));
        console.log(`beats named: ${JSON.stringify(named)}`);
        console.log("episode after:", JSON.stringify(response.notesUpdate?.plan.episode, null, 2));
        const misnamed = (response.notesUpdate?.lastRejections ?? []).filter((r) =>
          r.includes("is not a beat of your episode plan"),
        );
        expect(misnamed, "a beat name that is not in the episode").toEqual([]);
      },
      LIVE_TIMEOUT_MS * 2,
    );

    it(
      "quietTooLong: the model answers with a plan",
      async () => {
        expectModelAnswered(await liveRun(quietTooLongRequest(content())));
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "quietTooLong with a falling-out due: the plan parses and any outcome lever it sends translates (§outcome-levers, D106)",
      async () => {
        const run = await liveRun(quietTooLongRequest(content()), { notes: FALLING_OUT_NOTES });
        const response = expectModelAnswered(run);
        const plan = run.trace.plan;
        const story = plan !== undefined && "intents" in plan ? plan : undefined;
        const written = (story?.intents ?? []).map((i) => (i as { kind: string }).kind);
        const outcome = written.filter((kind) => OUTCOME_KINDS.includes(kind));
        console.log(
          `falling-out call: wrote ${JSON.stringify(written)}; outcome levers ${JSON.stringify(outcome)}; rationale: ${story?.rationale ?? ""}`,
        );
        const droppedOutcome = (response.dropped ?? []).filter((d) =>
          OUTCOME_KINDS.includes(d.kind),
        );
        expect(droppedOutcome, JSON.stringify(droppedOutcome)).toEqual([]);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "quietTooLong with the captain's gamble due: a tried side or a follow-up, if written, translates (§tried-sides, §follow-up-cards)",
      async () => {
        const run = await liveRun(quietTooLongRequest(content()), { notes: GAMBLE_NOTES });
        const response = expectModelAnswered(run);
        const plan = run.trace.plan;
        const story = plan !== undefined && "intents" in plan ? plan : undefined;
        const cards = (story?.intents ?? []).filter(
          (i) => (i as { kind: string }).kind === "surfaceDecision",
        );
        console.log(
          `gamble call: wrote ${JSON.stringify((story?.intents ?? []).map((i) => (i as { kind: string }).kind))}; cards: ${cards.map(cardShape).join(" | ") || "none"}; callBack ${callBackOf(run)}; rationale: ${story?.rationale ?? ""}`,
        );
        const surfaced = response.commands.find((c) => c.kind === "surfaceDecision");
        if (surfaced?.kind === "surfaceDecision") {
          console.log("gamble card as sent:", JSON.stringify(surfaced.payload.card, null, 2));
        }
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "notableEvent: the model answers with a plan",
      async () => {
        expectModelAnswered(await liveRun(notableEventRequest(content())));
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "policyDecision: the engineer brings the departure-gate card",
      async () => {
        const request = departureGateRequest(content());
        const run = await liveRun(request);
        const response = expectModelAnswered(run);
        if (request.hook.kind !== "policyDecision") throw new Error("fixture hook kind");
        expect(
          response.card,
          `no card translated (rejections: ${JSON.stringify(response.notesUpdate?.lastRejections)})`,
        ).toBeDefined();
        expect(response.card?.decisionId).toBe(request.hook.context.decisionId);
        expect(response.card?.speaker, "card has no speaker").toBeDefined();
        const captain = captainName(request.snapshot, content());
        expect(response.card?.speaker?.toLowerCase()).not.toBe(captain?.toLowerCase());
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "captainAshore at the hub with a far port two hops away: a passenger offer, or a rationale (passengers §9)",
      async () => {
        const run = await liveRun(farCaptainAshoreRequest(content()));
        const response = expectModelAnswered(run);
        const offers = response.commands.filter((c) => c.kind === "offerJob");
        const passage = offers.find((c) => c.payload.job.passenger === true);
        const rationale = run.trace.plan?.rationale ?? "";
        console.log(`far captainAshore callBack: ${callBackOf(run)}`);
        expect(
          passage !== undefined || rationale.length > 0,
          `no passenger offer and no rationale explaining the choice (dropped: ${JSON.stringify(response.dropped)})`,
        ).toBe(true);
        if (passage === undefined) {
          console.log(`no passenger offered for ${req(run)}; rationale: ${rationale}`);
        } else {
          // §4.1: a passenger offer is always the surfaced card.
          expect(passage.payload.surface).toBe(true);
        }
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "policyDecision: the first officer brings the overdue-passenger card (passengers §3.3)",
      async () => {
        const request = passengerOverdueRequest(content());
        const run = await liveRun(request);
        const response = expectModelAnswered(run);
        if (request.hook.kind !== "policyDecision") throw new Error("fixture hook kind");
        expect(
          response.card,
          `no card translated (rejections: ${JSON.stringify(response.notesUpdate?.lastRejections)})`,
        ).toBeDefined();
        expect(response.card?.decisionId).toBe(request.hook.context.decisionId);
        const firstOfficer = Object.values(request.snapshot.state.actors).find(
          (a) => a.passenger !== true && a.roleTags.includes("firstOfficer"),
        );
        expect(firstOfficer, "fixture has no first officer").toBeDefined();
        expect(response.card?.speaker?.toLowerCase()).toBe(firstOfficer?.name.toLowerCase());
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "captainAshore at the hub with an errand thread due: an errand offer that translates, or a rationale (expeditions A2)",
      async () => {
        const run = await liveRun(farCaptainAshoreRequest(content()), { notes: ERRAND_NOTES });
        const response = expectModelAnswered(run);
        const errand = response.commands.find(
          (c) => c.kind === "offerJob" && c.payload.job.errand !== undefined,
        );
        const rationale = run.trace.plan?.rationale ?? "";
        const droppedOffers = (response.dropped ?? []).filter((d) => d.kind === "offerJob");
        console.log(
          `errand captainAshore: ${errand === undefined ? "no errand" : JSON.stringify(errand.kind === "offerJob" ? errand.payload.job.errand : undefined)}; dropped ${JSON.stringify(droppedOffers)}; rationale: ${rationale}`,
        );
        expect(droppedOffers, "an offer was dropped by the translator").toEqual([]);
        expect(
          errand !== undefined || rationale.length > 0,
          "no errand offered and no rationale explaining the choice",
        ).toBe(true);
        if (errand?.kind === "offerJob") {
          expect(errand.payload.job.toPortId).toBe(errand.payload.job.fromPortId);
          expect(errand.payload.job.cargo).toEqual([]);
        }
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "policyDecision: the first officer brings the arrival card at a site, the two plans in order (expeditions A2)",
      async () => {
        const request = siteArrivalRequest(content());
        const run = await liveRun(request);
        const response = expectModelAnswered(run);
        if (request.hook.kind !== "policyDecision") throw new Error("fixture hook kind");
        expect(
          response.card,
          `no card translated (rejections: ${JSON.stringify(response.notesUpdate?.lastRejections)})`,
        ).toBeDefined();
        expect(response.card?.decisionId).toBe(request.hook.context.decisionId);
        console.log("arrival card:", JSON.stringify(response.card, null, 2));
        const firstOfficer = Object.values(request.snapshot.state.actors).find(
          (a) => a.passenger !== true && a.roleTags.includes("firstOfficer"),
        );
        expect(response.card?.speaker?.toLowerCase()).toBe(firstOfficer?.name.toLowerCase());
        expect(response.commands.filter((c) => c.kind === "surfaceDecision")).toEqual([]);
        expect(playerText(response.card), "a digit on the card").not.toMatch(/\d/);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "policyDecision: the item errand's arrival card with a back way set up: the way in unseen translates, the sides are the sim's (D105)",
      async () => {
        const request = siteItemArrivalRequest(content());
        const run = await liveRun(request, { notes: ITEM_ERRAND_NOTES });
        const response = expectModelAnswered(run);
        if (request.hook.kind !== "policyDecision") throw new Error("fixture hook kind");
        const decisionId = request.hook.context.decisionId;
        expect(
          response.card,
          `no card translated (rejections: ${JSON.stringify(response.notesUpdate?.lastRejections)})`,
        ).toBeDefined();
        expect(response.card?.decisionId).toBe(decisionId);
        const plan = run.trace.plan;
        const unseen = plan !== undefined && "card" in plan ? plan.card?.unseen : undefined;
        const unseenOdds = plan !== undefined && "card" in plan ? plan.card?.unseenOdds : undefined;
        console.log(
          `item arrival card (unseen ${JSON.stringify(unseen)}, odds ${JSON.stringify(unseenOdds)}; rationale: ${plan?.rationale}):`,
          JSON.stringify(response.card, null, 2),
        );
        const decision = request.snapshot.state.decisions.records[decisionId as DecisionId];
        const marks = response.commands.filter((c) => c.kind === "markUnseen");
        const unseenDrops = (response.dropped ?? []).filter((d) =>
          d.reason.startsWith("card.unseen"),
        );
        expect(unseenDrops, "the way in unseen was dropped").toEqual([]);
        if (unseen === "left" || unseen === "right") {
          expect(marks).toHaveLength(1);
          const planId = decision?.prompt.params[`${unseen}Plan`];
          // §unseen-odds: the narrator's chance, "" read as certain.
          const odds =
            unseenOdds === undefined || unseenOdds.trim() === "" ? 100 : Number(unseenOdds);
          expect(marks[0]?.payload).toEqual({ decisionId, planId, odds });
        } else {
          expect(marks).toEqual([]);
        }
        // The card is dressed, never replaced: no new card, and each side keeps its adoptPlan.
        expect(response.commands.filter((c) => c.kind === "surfaceDecision")).toEqual([]);
        expect(decision?.left.commands).toEqual([
          { kind: "adoptPlan", payload: { planId: decision?.prompt.params.leftPlan } },
        ]);
        expect(decision?.right.commands).toEqual([
          { kind: "adoptPlan", payload: { planId: decision?.prompt.params.rightPlan } },
        ]);
        // §unseen-odds: the one number a card may carry is the stated chance on the way in.
        const odds = marks[0]?.payload.odds;
        const stated = new RegExp(`(?<![\\d.,+-])${odds}\\s*(?:%|per\\s?cent\\b)`, "gi");
        const text = playerText(response.card);
        expect(
          odds === undefined ? text : text.replace(stated, ""),
          "a digit on the card",
        ).not.toMatch(/\d/);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "policyDecision: the turn card when one of ours is down, brought by the first officer, sides kept (expeditions A2)",
      async () => {
        const request = siteTurnRequest(content());
        const run = await liveRun(request);
        const response = expectModelAnswered(run);
        if (request.hook.kind !== "policyDecision") throw new Error("fixture hook kind");
        const decisionId = request.hook.context.decisionId;
        expect(
          response.card,
          `no card translated (rejections: ${JSON.stringify(response.notesUpdate?.lastRejections)})`,
        ).toBeDefined();
        expect(response.card?.decisionId).toBe(decisionId);
        console.log("turn card:", JSON.stringify(response.card, null, 2));
        const captain = captainName(request.snapshot, content());
        expect(response.card?.speaker, "card has no speaker").toBeDefined();
        expect(response.card?.speaker?.toLowerCase()).not.toBe(captain?.toLowerCase());
        const decision = request.snapshot.state.decisions.records[decisionId as DecisionId];
        expect(response.card?.speaker?.toLowerCase()).toBe(
          String(decision?.prompt.params.speaker).toLowerCase(),
        );
        // The card is dressed, never replaced: no new card, and the sides' commands are the sim's.
        expect(response.commands.filter((c) => c.kind === "surfaceDecision")).toEqual([]);
        expect(decision?.left.commands).toEqual([]);
        expect(decision?.right.commands).toEqual([{ kind: "withdrawParty", payload: {} }]);
        expect(playerText(response.card), "a digit on the card").not.toMatch(/\d/);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "prompt caching: a repeated call reads the system prefix from cache",
      async () => {
        const first = await liveRun(approachRequest(content()));
        expectModelAnswered(first);
        const second = await liveRun(approachRequest(content()));
        const response = expectModelAnswered(second);
        console.log("usage, first call:", JSON.stringify(first.response.usage));
        console.log("usage, second call:", JSON.stringify(response.usage));
        expect(
          response.usage?.cacheReadInputTokens ?? 0,
          "second call read nothing from the prompt cache (prefix below the model's minimum cacheable length, or routed to a different provider?)",
        ).toBeGreaterThan(0);
      },
      LIVE_TIMEOUT_MS * 2,
    );
  },
);
