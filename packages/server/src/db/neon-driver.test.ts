/**
 * Regression test for the real `@neondatabase/serverless` HTTP driver, which our other tests
 * never exercise (they run against `MemoryDb`, see module doc on `queries.ts`).
 *
 * `drizzle-orm@0.38.x`'s `neon-http` session called the Neon client as a plain function
 * (`client(sql, params, opts)`). `@neondatabase/serverless@1.x` removed that call form — the
 * client is now only callable via `client.query(...)` — so every real query threw:
 *
 *   "This function can now be called only as a tagged-template function ..."
 *
 * This test builds a `DrizzleDb` against the real neon-http driver, point it at a stub HTTP
 * endpoint (via `neonConfig.fetchFunction`), and proves a query actually round-trips instead of
 * throwing. It would fail against drizzle-orm 0.38.x; see the version check below.
 */
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DrizzleDatabase, DrizzleDb } from "./queries";
import * as schema from "./schema";

interface CapturedRequest {
  url: string;
  body: { query: string; params: unknown[] };
}

describe("DrizzleDb against the real neon-http driver", () => {
  let captured: CapturedRequest[] = [];
  const originalFetchFunction = neonConfig.fetchFunction;

  beforeEach(() => {
    captured = [];
    // Stand in for the Neon HTTP endpoint entirely offline: capture the request and return a
    // minimal, valid Neon HTTP response shape (see `processQueryResult` in
    // @neondatabase/serverless's index.js — `fields`/`rows`/`command`/`rowCount`, with `rows` as
    // arrays of raw values matching `fields` order, since the driver always sends
    // `Neon-Array-Mode: true`).
    neonConfig.fetchFunction = async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { query: string; params: unknown[] };
      captured.push({ url, body });
      const responseBody = {
        fields: [
          { name: "id", dataTypeID: 2950 }, // uuid
          { name: "anon_token_hash", dataTypeID: 25 }, // text
          { name: "created_at", dataTypeID: 1184 }, // timestamptz
        ],
        rows: [],
        command: "SELECT",
        rowCount: 0,
      };
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  });

  afterEach(() => {
    neonConfig.fetchFunction = originalFetchFunction;
  });

  it("executes getUserByTokenHash without throwing, and sends parameterized SQL", async () => {
    const sql = neon("postgres://user:pass@fake-host.neon.tech/db");
    const db: DrizzleDatabase = drizzle(sql, { schema });
    const drizzleDb = new DrizzleDb(db);

    await expect(drizzleDb.getUserByTokenHash("some-hash")).resolves.toBeUndefined();

    expect(captured).toHaveLength(1);
    const request = captured[0];
    if (!request) throw new Error("expected a captured request");
    const { url, body } = request;
    expect(url).toContain("/sql");
    expect(body.query).toMatch(/select .* from "users"/i);
    expect(body.query).toContain("$1");
    expect(body.params).toContain("some-hash");
  });
});

/**
 * Regression test for the `bytea` custom type's `fromDriver` (see `schema.ts`). Real Postgres
 * bytea values travel the wire as `\x`-hex text; `@neondatabase/serverless` 1.x runs that text
 * through `pg-types`'s default OID-17 parser *before* drizzle's `fromDriver` ever sees it, which
 * turns it into a real `Buffer` — not the `\x`-hex string the old `fromDriver` assumed
 * (`value.startsWith is not a function` in production). This fake Postgres exercises both shapes
 * `fromDriver` must accept: a `Buffer` (the default, realistic path — bytea's dataTypeID 17 is
 * always registered) and a raw `\x`-hex string (a driver/config path that skips type parsing,
 * kept as a defensive fallback). It also proves `saved_at_tick`/`seq` (Postgres `bigint`, sent as
 * decimal-string wire text) come back as numbers via drizzle's `bigint({ mode: "number" })`.
 */
describe("DrizzleDb bytea + bigint round trip over the real neon-http driver", () => {
  interface FakeGame {
    id: string;
    userId: string;
    name: string;
    headSaveId: string | null;
    leaseEpoch: number;
    narrativeNotes: unknown;
    createdAt: string;
    updatedAt: string;
  }

  interface FakeSave {
    id: string;
    gameId: string;
    blobHex: string; // as produced by `toDriver`, i.e. `\x`-prefixed hex text
    schemaVersion: number;
    simVersion: string;
    contentHash: string;
    savedAtTick: number;
    isMilestone: boolean;
    createdAt: string;
    seq: number;
  }

  const originalFetchFunction = neonConfig.fetchFunction;
  let game: FakeGame;
  let saves: FakeSave[];
  let nextSeq: number;

  /**
   * @param byteaDataTypeId The wire `dataTypeID` to report for the `blob` column. `17` (the real
   *   bytea OID) makes the driver's own default type parser hand `fromDriver` a `Buffer`, the
   *   realistic production path. Any OID with no registered parser (e.g. `705`, "unknown") makes
   *   it hand `fromDriver` the raw `\x`-hex string unchanged, exercising the string fallback.
   */
  function installFakePostgres(byteaDataTypeId: number): void {
    neonConfig.fetchFunction = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { query: string; params: string[] };
      const { query, params } = body;

      let fields: Array<{ name: string; dataTypeID: number }> = [];
      let rows: unknown[][] = [];
      let command = "SELECT";

      if (/^insert into "saves"/i.test(query)) {
        const [gameId, blobHex, schemaVersion, simVersion, contentHash, savedAtTick, isMilestone] =
          params;
        const save: FakeSave = {
          id: randomUUID(),
          gameId: gameId ?? "",
          blobHex: blobHex ?? "\\x",
          schemaVersion: Number(schemaVersion),
          simVersion: simVersion ?? "",
          contentHash: contentHash ?? "",
          savedAtTick: Number(savedAtTick),
          isMilestone: isMilestone === "true",
          createdAt: new Date().toISOString(),
          seq: nextSeq++,
        };
        saves.push(save);
        fields = [
          { name: "id", dataTypeID: 2950 },
          { name: "game_id", dataTypeID: 2950 },
          { name: "blob", dataTypeID: byteaDataTypeId },
          { name: "schema_version", dataTypeID: 23 },
          { name: "sim_version", dataTypeID: 25 },
          { name: "content_hash", dataTypeID: 25 },
          { name: "saved_at_tick", dataTypeID: 20 },
          { name: "is_milestone", dataTypeID: 16 },
          { name: "created_at", dataTypeID: 1184 },
          { name: "seq", dataTypeID: 20 },
        ];
        rows = [
          [
            save.id,
            save.gameId,
            save.blobHex,
            String(save.schemaVersion),
            save.simVersion,
            save.contentHash,
            String(save.savedAtTick),
            save.isMilestone ? "t" : "f",
            save.createdAt,
            String(save.seq),
          ],
        ];
        command = "INSERT";
      } else if (/^update "games"/i.test(query)) {
        const [headSaveId, updatedAt] = params;
        game = { ...game, headSaveId: headSaveId ?? null, updatedAt: updatedAt ?? game.updatedAt };
        command = "UPDATE";
      } else if (/^select "id" from "saves"/i.test(query)) {
        // pruneSaves: rolling (non-milestone) saves, oldest-first pruning candidates. Our tests
        // only ever create a milestone save, so there's nothing to prune.
        fields = [{ name: "id", dataTypeID: 2950 }];
        rows = [];
      } else if (/from "games"/i.test(query)) {
        fields = [
          { name: "id", dataTypeID: 2950 },
          { name: "user_id", dataTypeID: 2950 },
          { name: "name", dataTypeID: 25 },
          { name: "head_save_id", dataTypeID: 2950 },
          { name: "lease_epoch", dataTypeID: 23 },
          { name: "narrative_notes", dataTypeID: 3802 },
          { name: "created_at", dataTypeID: 1184 },
          { name: "updated_at", dataTypeID: 1184 },
        ];
        rows = [
          [
            game.id,
            game.userId,
            game.name,
            game.headSaveId,
            String(game.leaseEpoch),
            JSON.stringify(game.narrativeNotes),
            game.createdAt,
            game.updatedAt,
          ],
        ];
      } else if (/from "saves"/i.test(query)) {
        const [saveId] = params;
        const save = saves.find((s) => s.id === saveId);
        fields = [
          { name: "id", dataTypeID: 2950 },
          { name: "game_id", dataTypeID: 2950 },
          { name: "blob", dataTypeID: byteaDataTypeId },
          { name: "schema_version", dataTypeID: 23 },
          { name: "sim_version", dataTypeID: 25 },
          { name: "content_hash", dataTypeID: 25 },
          { name: "saved_at_tick", dataTypeID: 20 },
          { name: "is_milestone", dataTypeID: 16 },
          { name: "created_at", dataTypeID: 1184 },
          { name: "seq", dataTypeID: 20 },
        ];
        rows = save
          ? [
              [
                save.id,
                save.gameId,
                save.blobHex,
                String(save.schemaVersion),
                save.simVersion,
                save.contentHash,
                String(save.savedAtTick),
                save.isMilestone ? "t" : "f",
                save.createdAt,
                String(save.seq),
              ],
            ]
          : [];
      } else {
        throw new Error(`fake postgres: unhandled query: ${query}`);
      }

      return new Response(JSON.stringify({ fields, rows, command, rowCount: rows.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }

  beforeEach(() => {
    nextSeq = 1;
    game = {
      id: randomUUID(),
      userId: randomUUID(),
      name: "Test game",
      headSaveId: null,
      leaseEpoch: 0,
      narrativeNotes: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saves = [];
  });

  afterEach(() => {
    neonConfig.fetchFunction = originalFetchFunction;
  });

  it.each([
    ["Buffer (the real driver's default bytea type parser)", 17],
    ["\\x-hex string (a driver path that skips type parsing)", 705],
  ])("round-trips a non-UTF-8 blob delivered as a %s", async (_label, byteaDataTypeId) => {
    installFakePostgres(byteaDataTypeId);
    const sql = neon("postgres://user:pass@fake-host.neon.tech/db");
    const db: DrizzleDatabase = drizzle(sql, { schema });
    const drizzleDb = new DrizzleDb(db);

    // Gzip bytes are a convenient non-UTF-8, non-ASCII blob: they contain the 0x1f 0x8b magic
    // bytes and arbitrary binary content that would mangle round-tripping through anything that
    // assumes text (e.g. naive UTF-8 decoding).
    const blob = gzipSync(Buffer.from("the quick brown fox jumps over the lazy dog"));

    const saved = await drizzleDb.putSave({
      gameId: game.id,
      blob,
      schemaVersion: 3,
      simVersion: "sim-1.2.3",
      contentHash: "deadbeef",
      savedAtTick: 123_456_789,
      isMilestone: true,
    });

    expect(Buffer.isBuffer(saved.blob)).toBe(true);
    expect(saved.blob.equals(blob)).toBe(true);

    const head = await drizzleDb.getHeadSave(game.id);
    if (!head) throw new Error("expected a head save");

    expect(Buffer.isBuffer(head.blob)).toBe(true);
    expect(head.blob.equals(blob)).toBe(true);

    // Postgres bigint columns (`saved_at_tick`, `seq`) travel the wire as decimal-string text;
    // drizzle's `bigint({ mode: "number" })` must convert them back to numbers.
    expect(head.savedAtTick).toBe(123_456_789);
    expect(typeof head.savedAtTick).toBe("number");
    expect(typeof head.seq).toBe("number");
    expect(head.seq).toBeGreaterThan(0);
  });
});
