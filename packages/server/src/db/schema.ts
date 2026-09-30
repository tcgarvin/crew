/**
 * Drizzle schema (W8). See `../contract.ts` for the wire contract and the doc comment there for
 * the table sketch this file implements (extended per the W8 task brief — differences are listed
 * in that file's changelog comment).
 */
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Raw bytes. `bytea` over the Neon HTTP driver round-trips as base64 text; queries.ts handles the encode/decode. */
const bytea = customType<{ data: Buffer; driverData: string }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Buffer): string {
    return `\\x${value.toString("hex")}`;
  },
  fromDriver(value: string): Buffer {
    // neon-http returns bytea as a `\x`-prefixed hex string.
    if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
    return Buffer.from(value, "base64");
  },
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  anonTokenHash: text("anon_token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    // References `saves.id`; no FK constraint (would create a cycle with saves.game_id).
    headSaveId: uuid("head_save_id"),
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    narrativeNotes: jsonb("narrative_notes").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("games_user_id_idx").on(table.userId)],
);

export const saves = pgTable(
  "saves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id),
    blob: bytea("blob").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    simVersion: text("sim_version").notNull(),
    contentHash: text("content_hash").notNull(),
    savedAtTick: bigint("saved_at_tick", { mode: "number" }).notNull(),
    isMilestone: boolean("is_milestone").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Monotonic tie-breaker for `created_at`, which can collide under fast/batched inserts
    // (multiple saves land in the same millisecond). Ordering by (created_at desc, seq desc)
    // gives a deterministic, insertion-order-correct "last N" for pruning. Not exposed on the
    // wire; `MemoryDb` maintains the equivalent with an in-process counter.
    seq: bigserial("seq", { mode: "number" }).notNull(),
  },
  (table) => [index("saves_game_id_created_at_idx").on(table.gameId, table.createdAt.desc())],
);

export const narratorCalls = pgTable("narrator_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id")
    .notNull()
    .references(() => games.id),
  hookKind: text("hook_kind").notNull(),
  basisSaveId: uuid("basis_save_id")
    .notNull()
    .references(() => saves.id),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  latencyMs: integer("latency_ms"),
  status: text("status").notNull(),
  request: jsonb("request").notNull(),
  response: jsonb("response"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Same tie-break purpose as `saves.seq`, for `getLastNarratorCall`.
  seq: bigserial("seq", { mode: "number" }).notNull(),
});
