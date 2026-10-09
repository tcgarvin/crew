/**
 * Read-only narrator log viewer, the logic behind `pnpm --filter @crew/server narrator-log`
 * (`./narratorLogCli.ts` is the thin shell around it). Everything here takes a `Db` so it runs
 * against `MemoryDb` in tests and `DrizzleDb` in the terminal, and returns plain text.
 *
 * `narrator_calls.request` / `.response` are jsonb written by several prompt versions, so every
 * reader here is lenient: a missing or oddly shaped field prints as `-` instead of throwing.
 */
import { loadBundle } from "@crew/content";
import { buildDigest, parseNotes } from "@crew/narrator";
import {
  type NarratorHook,
  SCHEMA_VERSION,
  type SaveEnvelope,
  type SimEvent,
  fillConfig,
  migrateState,
} from "@crew/sim";
import {
  type Db,
  type GameRow,
  NOTES_HOOK_KIND,
  type NarratorCallFilter,
  type NarratorCallRow,
  type NarratorCallStatus,
} from "../db/types";

const DEFAULT_CALL_LIMIT = 10;
/** Calls fetched per game when rebuilding the notes a call saw; a game never has this many. */
const NOTES_HISTORY_LIMIT = 1000;
const STATUSES: readonly NarratorCallStatus[] = ["ok", "error", "budgetExceeded", "pending"];
const MISSING = "-";

export const USAGE = `Usage: narrator-log <command> [options]

  games                                   list games with narrator-call counts
  calls [--game <id|prefix>] [--last N] [--hook <kind>] [--status ok|error|budgetExceeded]
                                          newest calls first (default: last ${DEFAULT_CALL_LIMIT}, most recently updated game)
  call <id|prefix> [--raw]                one call in full (--raw also dumps request and response JSON)
  notes [--game <id|prefix>]              the game's current narrative notes
  digest <callId|prefix>                  rebuild the digest the model saw for a call`;

export class NarratorLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarratorLogError";
  }
}

// ---------------------------------------------------------------------------------------------
// Lenient readers over jsonb
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function text(value: unknown): string {
  if (typeof value === "string") return value === "" ? MISSING : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return MISSING;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Prose of a sim `TextRef`, else its template key, else `-`. */
function textRef(value: unknown): string {
  if (typeof value === "string") return text(value);
  const prose = field(value, "prose");
  if (typeof prose === "string" && prose !== "") return prose;
  return text(field(value, "key"));
}

function iso(date: Date | null | undefined): string {
  return date === null || date === undefined ? MISSING : date.toISOString();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "undefined";
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function cardLine(card: unknown): string {
  const speaker = text(field(card, "speaker"));
  return `card: "${text(field(card, "title"))}" — ${speaker} — ${text(field(card, "situation"))} | ${text(field(card, "leftLabel"))} / ${text(field(card, "rightLabel"))}`;
}

function surfacedLine(command: unknown): string {
  const card = field(command, "payload", "card");
  const prompt = field(card, "prompt");
  const speaker = text(field(prompt, "params", "speaker"));
  return `surfaced: "${text(field(prompt, "params", "title"))}" — ${speaker} — ${textRef(prompt)} | ${textRef(field(card, "left", "label"))} / ${textRef(field(card, "right", "label"))}`;
}

function offerLine(command: unknown): string {
  const job = field(command, "payload", "job");
  const issuer = field(job, "issuer");
  const issuerName = typeof issuer === "string" ? issuer : text(field(issuer, "name"));
  const cargo = list(field(job, "cargo"))
    .map((line) => `${text(field(line, "count"))}x ${text(field(line, "itemDefId"))}`)
    .join(", ");
  const surfaced = field(command, "payload", "surface");
  return `offer: ${issuerName} — ${text(field(job, "fromPortId"))}→${text(field(job, "toPortId"))} — cargo ${cargo === "" ? MISSING : cargo} — surfaced ${typeof surfaced === "boolean" ? (surfaced ? "yes" : "no") : MISSING}`;
}

function otherCommandLine(command: unknown): string {
  const summary = JSON.stringify(field(command, "payload")) ?? MISSING;
  return `command: ${text(field(command, "kind"))} ${clip(summary, 160)}`;
}

function commandLines(response: unknown): string[] {
  const lines: string[] = [];
  for (const command of list(field(response, "commands"))) {
    const kind = field(command, "kind");
    if (kind === "surfaceDecision") lines.push(surfacedLine(command));
    else if (kind === "offerJob") lines.push(offerLine(command));
    else lines.push(otherCommandLine(command));
  }
  return lines;
}

function headerLine(call: NarratorCallRow): string {
  const tokens = `${call.inputTokens ?? MISSING}/${call.outputTokens ?? MISSING} tokens`;
  const latency = call.latencyMs === null ? MISSING : `${call.latencyMs}ms`;
  return [
    iso(call.createdAt),
    call.hookKind,
    call.status,
    call.model,
    call.promptVersion,
    latency,
    tokens,
  ].join("  ");
}

/** The block `calls` prints for one call; `call` and `digest` build on it. */
function renderCallSummary(call: NarratorCallRow): string {
  const response = call.response;
  const lines = [
    headerLine(call),
    `id: ${call.id}  game: ${call.gameId}  basis save: ${call.basisSaveId}`,
  ];
  const card = field(response, "card");
  if (card !== undefined && card !== null) lines.push(cardLine(card));
  lines.push(...commandLines(response));
  for (const dropped of list(field(response, "dropped"))) {
    lines.push(`dropped: ${text(field(dropped, "kind"))} — ${text(field(dropped, "reason"))}`);
  }
  const fallback = field(response, "fallback");
  if (typeof fallback === "string") lines.push(`fallback: ${fallback}`);
  if (call.error !== null) lines.push(`error: ${call.error}`);
  return lines.join("\n");
}

/**
 * A D32 thread (`{title, scale, people, arcNotes, nextBeat}`; `stage` before D103), or a pre-D32
 * plain string.
 */
function threadLine(thread: unknown): string {
  if (typeof thread === "string") return text(thread);
  const people = list(field(thread, "people")).map(text).join(", ");
  const scale = text(field(thread, "scale"));
  const header = `${text(field(thread, "title"))} [${scale}${people === "" ? "" : `; ${people}`}]`;
  const nextBeat = field(thread, "nextBeat");
  const next = typeof nextBeat === "string" && nextBeat !== "" ? ` → ${nextBeat}` : "";
  const arcNotes = field(thread, "arcNotes");
  return `${header}: ${text(arcNotes === undefined ? field(thread, "stage") : arcNotes)}${next}`;
}

/** A D31 `CardShown` entry, or whatever older notes stored. */
function cardShownLine(card: unknown): string {
  if (!isRecord(card)) return typeof card === "string" ? card : (JSON.stringify(card) ?? MISSING);
  const chosen = card.chosen;
  const outcome =
    chosen === "left" || chosen === "right"
      ? `chose ${chosen}: ${text(card[`${chosen}Label`])}`
      : "undecided";
  return `tick ${text(card.tick)} "${text(card.title)}" — ${text(card.speaker)} — ${text(card.gist)} | ${text(card.leftLabel)} / ${text(card.rightLabel)} — ${outcome}`;
}

function renderNotes(notes: unknown): string {
  if (typeof notes === "string") return `summary: ${text(notes)}`;
  if (!isRecord(notes) || Object.keys(notes).length === 0) return "(empty)";
  const lines = [`summary: ${text(notes.summary)}`];
  // Pre-D32 notes carry `openThreads: string[]`; D32 notes carry structured `threads`.
  const threads = list(notes.threads ?? notes.openThreads);
  lines.push(`threads (${threads.length}):`);
  for (const thread of threads) lines.push(`  - ${threadLine(thread)}`);
  const cast = list(notes.cast);
  lines.push(`cast (${cast.length}):`);
  for (const entry of cast) {
    const port = field(entry, "portId");
    const where = typeof port === "string" ? ` @ ${port}` : "";
    lines.push(`  - ${text(field(entry, "name"))}${where}: ${text(field(entry, "note"))}`);
  }
  if (notes.cardsShown !== undefined) {
    const shown = list(notes.cardsShown);
    lines.push(`cardsShown (${shown.length}):`);
    for (const card of shown) lines.push(`  - ${cardShownLine(card)}`);
  }
  if (notes.pastArcs !== undefined) {
    const arcs = list(notes.pastArcs);
    lines.push(`pastArcs (${arcs.length}):`);
    for (const arc of arcs) {
      lines.push(
        `  - t${text(field(arc, "openedTick"))}-t${text(field(arc, "closedTick"))} ${text(field(arc, "title"))} [${text(field(arc, "scale"))}; ${text(field(arc, "ending"))}] ${text(field(arc, "shape"))}: ${text(field(arc, "summary"))}`,
      );
    }
  }
  const rejections = list(notes.lastRejections);
  if (rejections.length > 0) {
    lines.push(`lastRejections (${rejections.length}):`);
    for (const rejection of rejections) lines.push(`  - ${text(rejection)}`);
  }
  if (notes.lastUpdatedTick !== undefined)
    lines.push(`lastUpdatedTick: ${text(notes.lastUpdatedTick)}`);
  return lines.join("\n");
}

function rationaleOf(response: unknown): string {
  const direct = field(response, "rationale");
  if (typeof direct === "string") return direct;
  return text(field(response, "trace", "plan", "rationale"));
}

/** `call`: the summary block plus rationale and the full notes update. */
function renderCallDetail(call: NarratorCallRow, raw: boolean): string {
  const parts = [renderCallSummary(call), `rationale: ${rationaleOf(call.response)}`];
  const notesUpdate = field(call.response, "notesUpdate");
  parts.push(
    notesUpdate === undefined ? "notes update: -" : `notes update:\n${renderNotes(notesUpdate)}`,
  );
  if (raw) {
    parts.push(`request:\n${pretty(call.request)}`, `response:\n${pretty(call.response)}`);
  }
  return parts.join("\n");
}

/** Column widths of the `games` table; the last column (prompt) is unpadded. */
const GAME_COLUMN_WIDTHS = [36, 8, 24, 24, 5, 24] as const;

function gameTableRow(cells: readonly string[]): string {
  return cells.map((cell, i) => pad(cell, GAME_COLUMN_WIDTHS[i] ?? 0)).join("  ");
}

async function renderGames(db: Db): Promise<string> {
  const summaries = await db.listGamesWithNarratorStats();
  if (summaries.length === 0) return "(no games)";
  const header = gameTableRow([
    "game",
    "user",
    "created",
    "updated",
    "calls",
    "last call",
    "prompt",
  ]);
  const rows = summaries.map(({ game, callCount, lastCallAt, lastPromptVersion }) =>
    gameTableRow([
      game.id,
      game.userId.slice(0, 8),
      iso(game.createdAt),
      iso(game.updatedAt),
      String(callCount),
      iso(lastCallAt),
      lastPromptVersion ?? MISSING,
    ]),
  );
  return [header, ...rows].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

/** The one row an id prefix matched; none or several is an error naming `noun` / `plural`. */
function uniqueMatch<T extends { readonly id: string }>(
  matches: readonly T[],
  idOrPrefix: string,
  noun: string,
  plural: string,
): T {
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return only;
  if (matches.length === 0) throw new NarratorLogError(`No ${noun} matches ${idOrPrefix}.`);
  throw new NarratorLogError(
    `${matches.length} ${plural} match ${idOrPrefix}: ${matches.map((m) => m.id).join(", ")}`,
  );
}

async function resolveGame(db: Db, idOrPrefix: string | undefined): Promise<GameRow> {
  if (idOrPrefix === undefined) {
    const [latest] = await db.listGamesWithNarratorStats();
    if (latest === undefined) throw new NarratorLogError("No games in the database.");
    return latest.game;
  }
  return uniqueMatch(await db.findGamesByIdPrefix(idOrPrefix), idOrPrefix, "game", "games");
}

async function resolveCall(db: Db, idOrPrefix: string): Promise<NarratorCallRow> {
  const matches = await db.findNarratorCallsByIdPrefix(idOrPrefix);
  return uniqueMatch(matches, idOrPrefix, "narrator call", "calls");
}

/** `calls` flags; an absent flag is `undefined`. */
interface CallsOptions {
  readonly game: string | undefined;
  readonly last: number | undefined;
  readonly hook: string | undefined;
  readonly status: NarratorCallStatus | undefined;
}

async function renderCalls(db: Db, options: CallsOptions): Promise<string> {
  const game = await resolveGame(db, options.game);
  const filter: NarratorCallFilter = {
    gameId: game.id,
    limit: options.last ?? DEFAULT_CALL_LIMIT,
    ...(options.hook === undefined ? {} : { hookKind: options.hook }),
    ...(options.status === undefined ? {} : { status: options.status }),
  };
  const calls = await db.listNarratorCalls(filter);
  const heading = `game ${game.id} (${game.name}) — ${calls.length} call(s)`;
  if (calls.length === 0) return heading;
  return [heading, ...calls.map(renderCallSummary)].join("\n\n");
}

async function renderGameNotes(db: Db, idOrPrefix: string | undefined): Promise<string> {
  const game = await resolveGame(db, idOrPrefix);
  return `game ${game.id} (${game.name}) — narrative notes\n${renderNotes(game.narrativeNotes)}`;
}

// ---------------------------------------------------------------------------------------------
// Digest rebuild
// ---------------------------------------------------------------------------------------------

function isOlder(a: NarratorCallRow, b: NarratorCallRow): boolean {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime !== 0 ? byTime < 0 : a.seq < b.seq;
}

/**
 * The route reads `games.narrative_notes` before each call and writes `notesUpdate` after an ok
 * one, and the request row doesn't carry the notes it saw; so the notes a call saw are the
 * `notesUpdate` of the newest earlier ok call that had one (empty before the first). D97: or the
 * `notes` of the newest earlier ok notes turn, which the route waits for before a call.
 */
async function notesSeenBy(
  db: Db,
  call: NarratorCallRow,
): Promise<{ notes: unknown; source: string }> {
  const history = await db.listNarratorCalls({ gameId: call.gameId, limit: NOTES_HISTORY_LIMIT });
  for (const earlier of history) {
    if (!isOlder(earlier, call) || earlier.status !== "ok") continue;
    const notesTurn = earlier.hookKind === NOTES_HOOK_KIND;
    const update = field(earlier.response, notesTurn ? "notes" : "notesUpdate");
    if (update !== undefined && update !== null) {
      const what = notesTurn ? "notes turn" : "notesUpdate of call";
      return { notes: update, source: `${what} ${earlier.id}` };
    }
  }
  return { notes: {}, source: "no earlier call with a notes update; empty notes" };
}

function snapshotOf(request: unknown): SaveEnvelope {
  const snapshot = field(request, "snapshot");
  const schemaVersion = field(snapshot, "schemaVersion");
  if (
    !isRecord(snapshot) ||
    typeof schemaVersion !== "number" ||
    !isRecord(snapshot.state) ||
    !isRecord(snapshot.config)
  ) {
    throw new NarratorLogError(
      "This call's request has no usable snapshot; cannot rebuild the digest.",
    );
  }
  // Same upgrade `runNarrator` applies, so an old request still renders through today's digest:
  // config keys added or renamed since (D76's day units) come from the loaded content.
  const content = contentBundle();
  const saved = snapshot as unknown as SaveEnvelope;
  const config = fillConfig(saved.config, content.config).values;
  if (schemaVersion === SCHEMA_VERSION) return { ...saved, config };
  const state = migrateState(JSON.parse(JSON.stringify(snapshot.state)), schemaVersion, {
    content,
    config,
  });
  return { ...saved, schemaVersion: SCHEMA_VERSION, state, config } as SaveEnvelope;
}

function contentBundle() {
  const result = loadBundle();
  if (!result.ok) {
    throw new NarratorLogError(
      `Content bundle failed validation (${result.issues.length} issues).`,
    );
  }
  return result.bundle;
}

async function renderDigest(db: Db, idOrPrefix: string): Promise<string> {
  const call = await resolveCall(db, idOrPrefix);
  const snapshot = snapshotOf(call.request);
  const hook = field(call.request, "hook");
  const events = list(field(call.request, "recentEvents")) as readonly SimEvent[];
  const { notes, source } = await notesSeenBy(db, call);
  const digest = buildDigest(
    snapshot,
    events,
    parseNotes(notes),
    contentBundle(),
    isRecord(hook) ? (hook as unknown as NarratorHook) : undefined,
  );
  const header = [
    headerLine(call),
    `id: ${call.id}  game: ${call.gameId}`,
    `notes source: ${source}`,
    `digest: ~${digest.approxTokens} tokens${digest.truncated ? " (truncated)" : ""}; rebuilt with the current digest code, which may differ from prompt ${call.promptVersion}`,
  ];
  return `${header.join("\n")}\n\n${digest.text}`;
}

// ---------------------------------------------------------------------------------------------
// Credential hygiene
// ---------------------------------------------------------------------------------------------

/**
 * Removes the connection string, and separately its user, password and host, from `message`,
 * so a driver error can be shown without leaking what `DATABASE_URL` contained.
 */
export function redactDatabaseUrl(message: string, databaseUrl: string): string {
  if (databaseUrl === "") return message;
  const secrets = new Set<string>([databaseUrl]);
  try {
    const url = new URL(databaseUrl);
    for (const part of [url.username, url.password, url.hostname]) {
      if (part !== "") secrets.add(decodeURIComponent(part));
    }
  } catch {
    // Not a parseable URL; the whole string is still redacted below.
  }
  let scrubbed = message;
  for (const secret of secrets) scrubbed = scrubbed.split(secret).join("[redacted]");
  return scrubbed;
}

// ---------------------------------------------------------------------------------------------
// Argument parsing and dispatch
// ---------------------------------------------------------------------------------------------

interface ParsedArgs {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (name === "raw" || next === undefined || next.startsWith("--")) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      i += 1;
    }
  }
  return { positional, flags };
}

function stringFlag(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new NarratorLogError(`--${name} needs a value.`);
  return value;
}

function statusFlag(flags: ParsedArgs["flags"]): NarratorCallStatus | undefined {
  const value = stringFlag(flags, "status");
  if (value === undefined) return undefined;
  if (!STATUSES.includes(value as NarratorCallStatus)) {
    throw new NarratorLogError(`--status must be one of ${STATUSES.join(", ")}.`);
  }
  return value as NarratorCallStatus;
}

function lastFlag(flags: ParsedArgs["flags"]): number | undefined {
  const value = stringFlag(flags, "last");
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0)
    throw new NarratorLogError("--last must be a positive integer.");
  return n;
}

function requirePositional(args: ParsedArgs, index: number, what: string): string {
  const value = args.positional[index];
  if (value === undefined) throw new NarratorLogError(`Missing ${what}.\n\n${USAGE}`);
  return value;
}

/** Runs one CLI invocation against `db` and returns the text to print. */
export async function runNarratorLog(db: Db, argv: readonly string[]): Promise<string> {
  const args = parseArgs(argv);
  const command = args.positional[0];
  switch (command) {
    case "games":
      return renderGames(db);
    case "calls":
      return renderCalls(db, {
        game: stringFlag(args.flags, "game"),
        last: lastFlag(args.flags),
        hook: stringFlag(args.flags, "hook"),
        status: statusFlag(args.flags),
      });
    case "call": {
      const call = await resolveCall(db, requirePositional(args, 1, "call id"));
      return renderCallDetail(call, args.flags.get("raw") === true);
    }
    case "notes":
      return renderGameNotes(db, stringFlag(args.flags, "game"));
    case "digest":
      return renderDigest(db, requirePositional(args, 1, "call id"));
    case undefined:
    case "help":
    case "--help":
      return USAGE;
    default:
      throw new NarratorLogError(`Unknown command: ${command}\n\n${USAGE}`);
  }
}
