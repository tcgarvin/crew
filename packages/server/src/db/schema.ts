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

/**
 * Raw bytes.
 *
 * `toDriver` sends a `\x`-prefixed hex string. `@neondatabase/serverless`'s `prepareValue` /
 * `encodeBuffersAsBytea` (see `prepareQuery` in the driver's `index.js`) only re-encodes actual
 * `Buffer` instances and passes a `string` param straight through, so this hex literal reaches
 * Postgres unchanged either way.
 *
 * On the way back, `@neondatabase/serverless` 1.x already runs the row through `pg-types`'s
 * default OID-17 (`bytea`) parser before drizzle's `fromDriver` sees it, and that parser returns
 * a `Buffer`, not the `\x`-hex string the old comment here assumed. So `fromDriver` must accept
 * a `Buffer`, a `Uint8Array` (defensively, in case some driver path hands back a typed array
 * that isn't a `Buffer` subclass), or — kept for `MemoryDb`/tests and any driver that skips type
 * parsing — a `\x`-hex or base64 string.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array | string }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Buffer): string {
    return `\\x${value.toString("hex")}`;
  },
  fromDriver(value: Buffer | Uint8Array | string): Buffer {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
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
