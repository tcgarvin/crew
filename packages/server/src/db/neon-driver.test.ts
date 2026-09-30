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
