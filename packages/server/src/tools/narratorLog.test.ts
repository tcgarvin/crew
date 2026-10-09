import { loadBundle } from "@crew/content";
import { approachRequest } from "@crew/narrator";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../db/memory";
import type { NarratorCallRow } from "../db/types";
import { fakeEnvelope } from "../test-helpers";
import { NarratorLogError, redactDatabaseUrl, runNarratorLog } from "./narratorLog";

const OK_RESPONSE = {
  commands: [
    {
      id: "cmd:narrator:call-1:0",
      source: "narrator",
      kind: "offerJob",
      payload: {
        job: {
          issuer: { name: "Mara Voss", role: "dock foreman" },
          fromPortId: "port.crossroads_hub",
          toPortId: "port.kessler_drift",
          cargo: [{ itemDefId: "item.ore_crate", count: 3 }],
          pay: 900,
          description: { key: "narrator.job.description", params: {}, prose: "Ore. Quietly." },
        },
        surface: true,
      },
    },
    {
      id: "cmd:narrator:call-1:1",
      source: "narrator",
      kind: "surfaceDecision",
      payload: {
        card: {
          prompt: {
            key: "narrator.card.situation",
            params: { title: "A Quiet Word", speaker: "Jax Oduya" },
            prose: 'Jax leans in. "Captain, the coolant line is leaking again."',
          },
          left: {
            label: { key: "narrator.side", params: {}, prose: "Patch it now" },
            commands: [],
          },
          right: {
            label: { key: "narrator.side", params: {}, prose: "It can wait" },
            commands: [],
          },
        },
      },
    },
    {
      id: "cmd:narrator:call-1:2",
      source: "narrator",
      kind: "scheduleFault",
      payload: { machineId: "m1" },
    },
  ],
  card: {
    decisionId: "dec-1",
    title: "The Foreman's Offer",
    speaker: "Mara Voss",
    situation: 'Mara waves you over. "Got ore that needs moving."',
    leftLabel: "Take the job",
    rightLabel: "Pass",
  },
  notesUpdate: {
    summary: "The crew took a quiet ore run.",
    openThreads: ["Mara owes a favour"],
    cast: [
      {
        name: "Mara Voss",
        note: "dock foreman, blunt",
        portId: "port.crossroads_hub",
        lastSeenTick: 1800,
      },
    ],
    lastUpdatedTick: 1800,
    lastRejections: [],
  },
  callId: "call-1",
  model: "openai/gpt-6-luna",
  promptVersion: "v0.3",
  usage: {
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
  dropped: [{ intentIndex: 2, kind: "spawnAtBoundary", reason: "store not at port" }],
};

async function seed(db: MemoryDb) {
  const user = await db.createUser("hash-1");
  const game = await db.createGame(user.id, "Freighter Run");
  const save = await db.putSave({
    gameId: game.id,
    blob: Buffer.from("x"),
    schemaVersion: 1,
    simVersion: "0.1.0",
    contentHash: "c",
    savedAtTick: 0,
    isMilestone: true,
  });
  const base = { gameId: game.id, basisSaveId: save.id, hookKind: "approachingPort" };
  const ok = await db.logNarratorCall({
    ...base,
    model: OK_RESPONSE.model,
    promptVersion: OK_RESPONSE.promptVersion,
    inputTokens: 1200,
    outputTokens: 300,
    latencyMs: 4200,
    status: "ok",
    request: {
      gameId: game.id,
      hook: { kind: "approachingPort" },
      snapshot: fakeEnvelope(),
      recentEvents: [],
    },
    response: OK_RESPONSE,
    error: null,
  });
  await db.updateNotes(game.id, OK_RESPONSE.notesUpdate);
  const failed = await db.logNarratorCall({
    ...base,
    hookKind: "quietTooLong",
    model: "null-narrator",
    promptVersion: "v0",
    inputTokens: null,
    outputTokens: null,
    latencyMs: 25000,
    status: "error",
    request: {
      gameId: game.id,
      hook: { kind: "quietTooLong" },
      snapshot: fakeEnvelope(),
      recentEvents: [],
    },
    response: null,
    error: "OpenRouter timed out",
  });
  return { game, save, ok, failed };
}

describe("narrator-log", () => {
  it("games: lists games with call counts and the last call's prompt version", async () => {
    const db = new MemoryDb();
    const { game } = await seed(db);
    const out = await runNarratorLog(db, ["games"]);
    expect(out).toContain("game ");
    expect(out).toContain(game.id);
    expect(out).toContain(game.userId.slice(0, 8));
    expect(out).toMatch(/\s2\s+\d{4}-\d\d-\d\dT\S+\s+v0$/m);
  });

  it("calls: renders one lenient block per call, newest first, for the latest game by default", async () => {
    const db = new MemoryDb();
    const { ok, failed } = await seed(db);
    const out = await runNarratorLog(db, ["calls"]);
    const okIndex = out.indexOf(`id: ${ok.id}`);
    const failedIndex = out.indexOf(`id: ${failed.id}`);
    expect(failedIndex).toBeGreaterThan(-1);
    expect(okIndex).toBeGreaterThan(failedIndex);
    expect(out).toContain("quietTooLong  error  null-narrator  v0  25000ms  -/- tokens");
    expect(out).toContain("error: OpenRouter timed out");
    expect(out).toContain("approachingPort  ok  openai/gpt-6-luna  v0.3  4200ms  1200/300 tokens");
    expect(out).toContain(
      'card: "The Foreman\'s Offer" — Mara Voss — Mara waves you over. "Got ore that needs moving." | Take the job / Pass',
    );
    expect(out).toContain(
      "offer: Mara Voss — port.crossroads_hub→port.kessler_drift — cargo 3x item.ore_crate — surfaced yes",
    );
    expect(out).toContain(
      'surfaced: "A Quiet Word" — Jax Oduya — Jax leans in. "Captain, the coolant line is leaking again." | Patch it now / It can wait',
    );
    expect(out).toContain('command: scheduleFault {"machineId":"m1"}');
    expect(out).toContain("dropped: spawnAtBoundary — store not at port");
  });

  it("calls: honours --status, --hook, --last and a --game prefix", async () => {
    const db = new MemoryDb();
    const { game, ok, failed } = await seed(db);
    const errorsOnly = await runNarratorLog(db, ["calls", "--status", "error"]);
    expect(errorsOnly).toContain(failed.id);
    expect(errorsOnly).not.toContain(ok.id);
    const hook = await runNarratorLog(db, [
      "calls",
      "--hook",
      "approachingPort",
      "--game",
      game.id.slice(0, 8),
    ]);
    expect(hook).toContain(ok.id);
    expect(hook).not.toContain(failed.id);
    const last = await runNarratorLog(db, ["calls", "--last", "1"]);
    expect(last).toContain("1 call(s)");
    await expect(runNarratorLog(db, ["calls", "--status", "weird"])).rejects.toThrow(
      NarratorLogError,
    );
  });

  it("call: prints rationale as '-' when unrecorded, the notes update, and raw JSON on --raw", async () => {
    const db = new MemoryDb();
    const { ok } = await seed(db);
    const out = await runNarratorLog(db, ["call", ok.id.slice(0, 8)]);
    expect(out).toContain("rationale: -");
    expect(out).toContain("summary: The crew took a quiet ore run.");
    expect(out).toContain("  - Mara owes a favour");
    expect(out).toContain("  - Mara Voss @ port.crossroads_hub: dock foreman, blunt");
    expect(out).not.toContain('"snapshot"');
    const raw = await runNarratorLog(db, ["call", ok.id, "--raw"]);
    expect(raw).toContain('"snapshot"');
    expect(raw).toContain('"contentHash": "content-hash-1"');
    await expect(runNarratorLog(db, ["call", "ffffffff"])).rejects.toThrow(
      /No narrator call matches/,
    );
  });

  it("notes: prints the game's current narrative notes", async () => {
    const db = new MemoryDb();
    const { game } = await seed(db);
    const out = await runNarratorLog(db, ["notes", "--game", game.id]);
    expect(out).toContain(`game ${game.id} (Freighter Run)`);
    expect(out).toContain("summary: The crew took a quiet ore run.");
    expect(out).toContain("lastUpdatedTick: 1800");
  });

  it("notes: renders D32 structured threads and D31 cardsShown", async () => {
    const db = new MemoryDb();
    const { game } = await seed(db);
    await db.updateNotes(game.id, {
      summary: "Season two.",
      threads: [
        {
          title: "The Coolant Leak",
          scale: "episode",
          people: ["Jax Oduya"],
          arcNotes: "Jax has asked twice.",
          nextBeat: "Once docked, Jax forces the issue.",
          lastBeatTick: 1800,
        },
      ],
      cardsShown: [
        {
          tick: 1800,
          decisionId: null,
          title: "A Quiet Word",
          speaker: "Jax Oduya",
          gist: "Jax leans in about the coolant line.",
          leftLabel: "Patch it now",
          rightLabel: "It can wait",
          chosen: "right",
        },
      ],
      cast: [],
      lastUpdatedTick: 1800,
      lastRejections: ["offerJob: cannot surface a new card while a policy decision is pending"],
    });
    const out = await runNarratorLog(db, ["notes"]);
    expect(out).toContain(
      "  - The Coolant Leak [episode; Jax Oduya]: Jax has asked twice. → Once docked, Jax forces the issue.",
    );
    expect(out).toContain(
      '  - tick 1800 "A Quiet Word" — Jax Oduya — Jax leans in about the coolant line. | Patch it now / It can wait — chose right: It can wait',
    );
    expect(out).toContain("lastRejections (1):");
  });

  it("digest: rebuilds the digest from a real stored request and the previous notes update", async () => {
    const result = loadBundle();
    if (!result.ok) throw new Error("content bundle invalid");
    const request = approachRequest(result.bundle);
    const db = new MemoryDb();
    const { game, save } = await seed(db);
    const call = await db.logNarratorCall({
      gameId: game.id,
      basisSaveId: save.id,
      hookKind: request.hook.kind,
      model: "m",
      promptVersion: "v0.3",
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      status: "ok",
      request: { ...request, gameId: game.id },
      response: { commands: [], callId: "c", model: "m", promptVersion: "v0.3" },
      error: null,
    });
    const out = await runNarratorLog(db, ["digest", call.id]);
    expect(out).toContain("## Why you were called");
    expect(out).toContain("quietTooLong: nothing story-worthy since tick");
    expect(out).toContain("The crew took a quiet ore run.");
    expect(out).toMatch(/notes source: notesUpdate of call /);
  });

  it("digest: fails clearly when the stored request has no snapshot", async () => {
    const db = new MemoryDb();
    const { failed } = await seed(db);
    const call: NarratorCallRow = failed;
    await db.logNarratorCall({ ...call, request: {} });
    const bare = (await db.listNarratorCalls({ limit: 1 }))[0];
    if (bare === undefined) throw new Error("seed failed");
    await expect(runNarratorLog(db, ["digest", bare.id])).rejects.toThrow(/no usable snapshot/);
  });

  it("help and unknown commands", async () => {
    const db = new MemoryDb();
    expect(await runNarratorLog(db, [])).toContain("Usage: narrator-log");
    await expect(runNarratorLog(db, ["nope"])).rejects.toThrow(/Unknown command: nope/);
  });

  it("redactDatabaseUrl scrubs the URL, its user, password and host from a message", () => {
    const url = "postgres://neon_ro:s3cret%21@ep-xyz.neon.tech/crew?sslmode=require";
    const message = `connect ECONNREFUSED for ${url}; password s3cret! rejected at ep-xyz.neon.tech`;
    const scrubbed = redactDatabaseUrl(message, url);
    expect(scrubbed).not.toContain("s3cret");
    expect(scrubbed).not.toContain("neon_ro");
    expect(scrubbed).not.toContain("ep-xyz.neon.tech");
    expect(scrubbed).toContain("[redacted]");
    expect(redactDatabaseUrl("plain", "")).toBe("plain");
  });
});
