/**
 * Shared test fixtures (not part of the public API — imported only by `*.test.ts` files).
 */
import { gzipSync } from "node:zlib";
import { MemoryDb } from "./db/memory";
import { loadEnv } from "./env";
import { type AppDeps, createApp } from "./index";
import type { RunNarrator } from "./narrator";

export function testEnv(overrides: Partial<ReturnType<typeof loadEnv>> = {}) {
  return { ...loadEnv({ CREW_DB: "memory" }), ...overrides };
}

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  const db = overrides.db ?? new MemoryDb();
  const env = overrides.env ?? testEnv();
  const app = createApp(
    overrides.runNarrator ? { db, env, runNarrator: overrides.runNarrator } : { db, env },
  );
  return { app, db, env };
}

export function fakeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    simVersion: "0.1.0",
    contentHash: "content-hash-1",
    configHash: "config-hash-1",
    savedAtTick: 0,
    config: {},
    state: { schemaVersion: 1 },
    ...overrides,
  };
}

export function gzipEnvelope(envelope: Record<string, unknown>): string {
  return gzipSync(Buffer.from(JSON.stringify(envelope), "utf8")).toString("base64");
}

export async function mintUser(app: ReturnType<typeof buildTestApp>["app"]) {
  const res = await app.request("/api/auth/anon", { method: "POST" });
  const body = (await res.json()) as { userId: string; token: string };
  return body;
}

/** Small typing shim: test assertions read whatever shape they expect from a JSON response. */
// biome-ignore lint/suspicious/noExplicitAny: test helper, callers assert the real shape.
export async function readJson(res: Response): Promise<any> {
  return res.json();
}

export const TEST_NOTES = {
  summary: "updated notes",
  threads: [],
  cardsShown: [],
  cast: [],
  lastUpdatedTick: 0,
  lastRejections: [],
};

export const echoNarrator: RunNarrator = async () => ({
  commands: [],
  callId: "test-call",
  model: "test-model",
  promptVersion: "test",
  notesUpdate: TEST_NOTES,
});
