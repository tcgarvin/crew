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
  approachingPortRequest,
  departureGateRequest,
  jobBoardRequest,
  notableEventRequest,
  quietTooLongRequest,
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
/** One real call can take a while on a cold cache; the transport itself times out at 25 s. */
const LIVE_TIMEOUT_MS = 60_000;

const suite = apiKey === undefined ? describe.skip : describe;
const skipReason =
  apiKey === undefined
    ? " (skipped: no OPENROUTER_API_KEY in the environment or packages/narrator/.env.local)"
    : "";

async function liveRun(req: NarratorRequest): Promise<NarratorRun> {
  if (apiKey === undefined) throw new Error("no API key");
  return runNarratorWithTrace(req, {
    gameId: req.gameId,
    content: content(),
    transport: openRouterTransport({ apiKey, appTitle: "Crew live tests" }),
    model,
    notes: undefined,
  });
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

suite(`live narrator (${model})${skipReason}`, () => {
  it(
    "approachingPort: the model answers with an offer",
    async () => {
      expectWorkOffered(await liveRun(approachingPortRequest(content())));
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
    "prompt caching: a repeated call reads the system prefix from cache",
    async () => {
      const first = await liveRun(approachingPortRequest(content()));
      expectModelAnswered(first);
      const second = await liveRun(approachingPortRequest(content()));
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
