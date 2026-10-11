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
import type { NarratorRequest, NarratorResponse } from "../contract";
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
    `${req.hook.kind}: plan ${planMs} ms (${run.response.usage?.outputTokens} out), notes ${notesMs} ms (${notes.usage.outputTokens} out, ${notes.usage.cacheReadInputTokens}/${notes.usage.inputTokens} cached); summary: ${notes.notes.summary}`,
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
      "quietTooLong: the model answers with a plan",
      async () => {
        expectModelAnswered(await liveRun(quietTooLongRequest(content())));
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
