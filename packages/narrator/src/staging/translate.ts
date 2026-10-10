/**
 * The staging call's translator (Dockside §6.1, §staging-prompt). Pure.
 *
 * It turns the staging plan's intents into at most one `stageDock` command, and nothing else: an
 * intent of any other kind (a story lever, or anything made up) is dropped with a reason, and the
 * narrator's notes are only read (a `cast` placement must name someone in the cast), never
 * written. Every part of the plan is checked against the rules the kernel enforces on the whole
 * plan (`systems/travel/staging.ts`: posts of this dock, the port's seeds, nobody aboard, no name
 * twice, catalogue items, the `STAGING_LIMITS` caps and text rules), so one bad placement is
 * dropped here instead of the kernel refusing the plan, plus the story translator's player-text
 * checks (no numeric consequences, nothing nobody aboard knows).
 */
import {
  type ContentBundle,
  type DeepReadonly,
  type DockDef,
  type ItemDefId,
  type LocalKey,
  NARRATOR_COMMAND_KINDS,
  type NarratorCommand,
  type NarratorHook,
  STAGING_LIMITS,
  type StagedPersonSpec,
  type StagedPlacement,
  type StagedProp,
  type StagingPlan,
  findItemDef,
} from "@crew/sim";
import type { DroppedIntent } from "../contract";
import {
  type Outcome,
  collapseWhitespace,
  invalidIntentReason,
  kindOf,
  no,
  ok,
} from "../intent-outcome";
import { type Snapshot, portName } from "../lookups";
import type { NarratorNotes } from "../notes";
import { clipChars, commandIdFor, secretPhrases, textProblem } from "../translate";
import {
  STAGING_AREA_SPOT,
  STAGING_INTENT_KINDS,
  type StagingEnvelope,
  type StagingIntent,
  type StagingIntentKind,
  buildStagingIntentSchemas,
} from "./plan";

export type StageDockHook = Extract<NarratorHook, { kind: "stageDock" }>;

export interface StagingTranslationCtx {
  readonly snapshot: Snapshot;
  readonly content: ContentBundle;
  readonly hook: DeepReadonly<StageDockHook>;
  readonly callId: string;
  /** The stored notes, read only: a `cast` placement must name someone in `cast`. */
  readonly notes: NarratorNotes;
}

export interface StagingTranslation {
  /** At most one `stageDock` command; empty means the floor set alone. */
  readonly commands: readonly NarratorCommand[];
  readonly dropped: readonly DroppedIntent[];
}

interface Env {
  readonly ctx: StagingTranslationCtx;
  readonly dock: DockDef;
  readonly secrets: readonly string[];
  /** Lower-cased names of everyone aboard (crew and passengers not off the ship). */
  readonly aboard: ReadonlySet<string>;
  readonly place: StagedPlacement[];
  readonly props: StagedProp[];
  /** Lower-cased names placed so far this call. */
  readonly placed: Set<string>;
  ambience: string | undefined;
}

/**
 * The kernel's text rule (non-blank, no control characters, no template braces, at most `max`
 * characters) plus the player-text checks. `text` is already collapsed (and clipped where
 * clipping is allowed).
 */
function stagingTextProblem(env: Env, text: string, what: string, max: number): string | undefined {
  if (text === "") return `${what} is empty`;
  if (text.length > max) return `${what} is longer than ${max} characters`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
  if (/[\u0000-\u001f\u007f]/.test(text)) return `${what} has control characters`;
  if (/[{}]/.test(text)) return `${what} has template braces`;
  const problem = textProblem(text, env.secrets);
  return problem === undefined ? undefined : `${what}: ${problem}`;
}

/** Free text that may be clipped to its cap (a label, a look, the ambience line). */
function softText(env: Env, raw: string, what: string, max: number): Outcome<string> {
  const text = clipChars(raw, max);
  const problem = stagingTextProblem(env, text, what, max);
  return problem === undefined ? ok(text) : no(problem);
}

/** Text that is someone's identity (a name, a role): never clipped, refused when too long. */
function hardText(env: Env, raw: string, what: string, max: number): Outcome<string> {
  const text = collapseWhitespace(raw);
  const problem = stagingTextProblem(env, text, what, max);
  return problem === undefined ? ok(text) : no(problem);
}

function postOf(env: Env, raw: string): Outcome<LocalKey> {
  const key = raw.trim();
  const post = env.dock.posts.find((p) => p.key === key);
  if (post !== undefined) return ok(post.key);
  return no(
    `unknown post "${raw}" on ${env.dock.name}; use a post key listed under The dock you are dressing`,
  );
}

function personOf(
  env: Env,
  intent: Extract<StagingIntent, { kind: "placePerson" }>,
  name: string,
): Outcome<StagedPersonSpec> {
  const { content, hook, notes } = env.ctx;
  const lower = name.toLowerCase();
  const port = portName(content, hook.context.portId);
  const seed = content.ports[hook.context.portId]?.castSeed.find(
    (s) => s.name.toLowerCase() === lower,
  );
  const cast = notes.cast.find((c) => c.name.trim().toLowerCase() === lower);
  const role = () => hardText(env, intent.role, "role", STAGING_LIMITS.roleChars);
  switch (intent.who) {
    case "seed":
      if (seed === undefined) {
        return no(
          `"${name}" is not one of ${port}'s people; use a name under People you know here, or a newFace`,
        );
      }
      return ok({ kind: "seed", name: seed.name });
    case "cast": {
      if (cast === undefined) return no(`"${name}" is not in your cast; use a seed or a newFace`);
      const r = role();
      if (!r.ok) return r;
      return ok({ kind: "cast", name: cast.name.trim(), role: r.value.toLowerCase() });
    }
    case "newFace": {
      if (seed !== undefined) return no(`"${name}" is one of ${port}'s people; place them as seed`);
      if (cast !== undefined) return no(`"${name}" is in your cast; place them as cast`);
      const r = role();
      if (!r.ok) return r;
      const look = softText(env, intent.look, "look", STAGING_LIMITS.lookChars);
      if (!look.ok) return look;
      return ok({ kind: "newFace", name, role: r.value.toLowerCase(), look: look.value });
    }
  }
}

function placePerson(
  env: Env,
  intent: Extract<StagingIntent, { kind: "placePerson" }>,
): Outcome<StagedPlacement> {
  if (env.place.length >= STAGING_LIMITS.people) {
    return no(`at most ${STAGING_LIMITS.people} people per docking`);
  }
  const post = postOf(env, intent.post);
  if (!post.ok) return post;
  const name = hardText(env, intent.name, "name", STAGING_LIMITS.nameChars);
  if (!name.ok) return name;
  const lower = name.value.toLowerCase();
  if (env.aboard.has(lower)) return no(`${name.value} is aboard the ship, not on the dock`);
  if (env.placed.has(lower)) return no(`${name.value} is already placed this call`);
  const who = personOf(env, intent, name.value);
  if (!who.ok) return who;
  if (intent.label.trim() === "") return ok({ who: who.value, postKey: post.value });
  const label = softText(env, intent.label, "label", STAGING_LIMITS.labelChars);
  if (!label.ok) return label;
  return ok({ who: who.value, postKey: post.value, label: label.value });
}

function placeProp(
  env: Env,
  intent: Extract<StagingIntent, { kind: "placeProp" }>,
): Outcome<StagedProp> {
  if (env.props.length >= STAGING_LIMITS.props) {
    return no(`at most ${STAGING_LIMITS.props} props per docking`);
  }
  const { content, snapshot } = env.ctx;
  const itemDefId = intent.item.trim() as ItemDefId;
  if (findItemDef(content, snapshot.state as never, itemDefId) === undefined) {
    return no(`unknown item "${intent.item}"; use an item id from the catalogue`);
  }
  const count = Number(intent.count);
  if (intent.at.trim() === STAGING_AREA_SPOT)
    return ok({ itemDefId, count, at: { kind: "staging" } });
  const post = postOf(env, intent.at);
  if (!post.ok) return post;
  return ok({ itemDefId, count, at: { kind: "post", postKey: post.value } });
}

function setAmbience(
  env: Env,
  intent: Extract<StagingIntent, { kind: "setAmbience" }>,
): Outcome<string> {
  if (env.ambience !== undefined) return no("one ambience line per docking");
  return softText(env, intent.line, "ambience line", STAGING_LIMITS.ambienceChars);
}

/** Apply one parsed intent to the plan being built, or say why it cannot be. */
function applyIntent(env: Env, intent: StagingIntent): string | undefined {
  switch (intent.kind) {
    case "placePerson": {
      const outcome = placePerson(env, intent);
      if (!outcome.ok) return outcome.reason;
      env.place.push(outcome.value);
      env.placed.add(outcome.value.who.name.toLowerCase());
      return undefined;
    }
    case "placeProp": {
      const outcome = placeProp(env, intent);
      if (!outcome.ok) return outcome.reason;
      env.props.push(outcome.value);
      return undefined;
    }
    case "setAmbience": {
      const outcome = setAmbience(env, intent);
      if (!outcome.ok) return outcome.reason;
      env.ambience = outcome.value;
      return undefined;
    }
  }
}

function isStagingKind(kind: string): kind is StagingIntentKind {
  return (STAGING_INTENT_KINDS as readonly string[]).includes(kind);
}

/** Why an intent of another kind is dropped: a story lever, or nothing at all. */
function notStagingReason(kind: string): string {
  const levers = STAGING_INTENT_KINDS.join(", ");
  if ((NARRATOR_COMMAND_KINDS as readonly string[]).includes(kind)) {
    return `"${kind}" moves the plot, and the staging call only sets the stage (${levers})`;
  }
  return `"${kind}" is not something the staging call can do (${levers})`;
}

function aboardNames(snapshot: Snapshot): Set<string> {
  return new Set(
    Object.values(snapshot.state.actors)
      .filter((a) => a.availability !== "offShip")
      .map((a) => a.name.trim().toLowerCase()),
  );
}

/**
 * Translate a staging reply. Throws if the hook's dock is not in content: the sim raised the
 * hook from that content, so a mismatch is a bug, not a model failure.
 */
export function translateStaging(
  plan: StagingEnvelope,
  ctx: StagingTranslationCtx,
): StagingTranslation {
  const dock = ctx.content.docks?.[ctx.hook.context.dockId];
  if (dock === undefined) {
    throw new Error(`staging: no dock "${ctx.hook.context.dockId}" in content`);
  }
  const intentSchemas = buildStagingIntentSchemas();
  const env: Env = {
    ctx,
    dock,
    secrets: secretPhrases(ctx.snapshot, ctx.content),
    aboard: aboardNames(ctx.snapshot),
    place: [],
    props: [],
    placed: new Set(),
    ambience: undefined,
  };
  const dropped: DroppedIntent[] = [];
  plan.intents.forEach((raw, intentIndex) => {
    const kind = kindOf(raw);
    if (!isStagingKind(kind)) {
      dropped.push({ intentIndex, kind, reason: notStagingReason(kind) });
      return;
    }
    const parsed = intentSchemas[kind].safeParse(raw);
    if (!parsed.success) {
      dropped.push({ intentIndex, kind, reason: invalidIntentReason(kind, parsed.error.issues) });
      return;
    }
    const problem = applyIntent(env, parsed.data);
    if (problem !== undefined) dropped.push({ intentIndex, kind, reason: `${kind}: ${problem}` });
  });

  if (env.place.length === 0 && env.props.length === 0 && env.ambience === undefined) {
    return { commands: [], dropped };
  }
  const payload: StagingPlan = {
    place: env.place,
    props: env.props,
    ...(env.ambience === undefined ? {} : { ambience: env.ambience }),
  };
  const command: NarratorCommand = {
    id: commandIdFor(ctx.callId, 0),
    source: "narrator",
    // The hook tick is already committed; the earliest a command can apply is the next one.
    targetTick: ctx.hook.tick + 1,
    kind: "stageDock",
    payload,
  };
  return { commands: [command], dropped };
}
