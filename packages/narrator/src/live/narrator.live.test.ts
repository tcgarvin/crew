/**
 * Live narrator tests (D44): one real OpenRouter call per hook kind, through the production
 * transport, prompt and schema. The unit suite never touches the network, so it cannot see a
 * provider rejecting the request; this one does. Run by hand before deploying prompt, schema or
 * transport changes:
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
import { describe, expect, it } from "vitest";
import type { NarratorRequest, NarratorResponse } from "../contract";
import {
  approachRequest,
  departureGateRequest,
  farJobBoardRequest,
  jobBoardRequest,
  notableEventRequest,
  passengerOverdueRequest,
  quietTooLongRequest,
  stageDockRequest,
} from "../fixtures";
import { NULL_NARRATOR_MODEL } from "../null";
import { openRouterTransport } from "../openrouter";
import { DEFAULT_NARRATOR_MODEL, type NarratorRun, runNarratorWithTrace } from "../run";
import { content } from "../test-support";
import { captainName } from "../translate";

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
/** D67: the staging call can run on its own (cheaper) model, as the server's `CREW_STAGING_MODEL`. */
const stagingModel = process.env.CREW_STAGING_MODEL ?? model;
/** One real call can take a while on a cold cache; the transport itself times out at 25 s. */
const LIVE_TIMEOUT_MS = 60_000;

const suite = apiKey === undefined ? describe.skip : describe;
const skipReason =
  apiKey === undefined
    ? " (skipped: no OPENROUTER_API_KEY in the environment or packages/narrator/.env.local)"
    : "";

async function liveRun(
  req: NarratorRequest,
  options: { readonly model?: string; readonly notes?: unknown } = {},
): Promise<NarratorRun> {
  if (apiKey === undefined) throw new Error("no API key");
  return runNarratorWithTrace(req, {
    gameId: req.gameId,
    content: content(),
    transport: openRouterTransport({ apiKey, appTitle: "Crew live tests" }),
    model: options.model ?? model,
    notes: options.notes,
  });
}

/**
 * D67: notes for the staging case, so the story gives the set dresser something to stage for: a
 * thread due at Kessler Drift and a cast member placed there.
 */
const STAGING_NOTES = {
  summary:
    "The crew took a rush ore-sample run from the Drift last time and jumped Greta Lindholm's loading queue to make it.",
  threads: [
    {
      title: "Greta's queue",
      scale: "episode",
      people: ["Greta Lindholm", "Ilse Brandt"],
      stage: "Greta thinks the ship jumped her queue on the last visit, and has not forgotten.",
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

/** D40: on arrival and at the board the narrator hands out work unless it says why not. */
function expectWorkOffered(run: NarratorRun): void {
  const response = expectModelAnswered(run);
  const offers = response.commands.filter((c) => c.kind === "offerJob");
  const rationale = run.trace.plan?.rationale ?? "";
  expect(
    offers.length > 0 || rationale.length > 0,
    `no offerJob command and no rationale explaining why (dropped: ${JSON.stringify(response.dropped)})`,
  ).toBe(true);
  if (offers.length === 0) {
    console.log(`no offer made for ${req(run)}; rationale: ${rationale}`);
  }
}

suite(`live narrator (${model}; staging ${stagingModel})${skipReason}`, () => {
  it(
    "stageDock: a staging-only plan that names a real post of the dock (D67)",
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
    "jobBoard: the model answers with an offer",
    async () => {
      expectWorkOffered(await liveRun(jobBoardRequest(content())));
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
    "jobBoard at the hub with a far port two hops away: a passenger offer, or a rationale (passengers §9)",
    async () => {
      const run = await liveRun(farJobBoardRequest(content()));
      const response = expectModelAnswered(run);
      const offers = response.commands.filter((c) => c.kind === "offerJob");
      const passage = offers.find((c) => c.payload.job.passenger === true);
      const rationale = run.trace.plan?.rationale ?? "";
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
});
