/**
 * Intent → command translation (W0 `TranslateIntents`). Pure.
 *
 * Every intent becomes exactly one allow-listed `NarratorCommand` with `source: "narrator"`, or
 * is dropped with a reason. The translator pre-validates with the same rules the kernel enforces
 * (price bands, fault catalogs, window bounds, known ports and stores, boundary-only spawns,
 * budgets) plus the narrator's own presentation rules (one card per call, no numbers or
 * undiscovered facts in player-facing text), so a rejection is explained to the model in the
 * next call's notes instead of disappearing in the kernel. The kernel still revalidates on apply.
 */
import {
  AUTHORITY,
  type CommandDraft,
  type CommandId,
  type ContentBundle,
  type DecisionId,
  type DeepReadonly,
  type ItemDef,
  type ItemDefId,
  type MachineId,
  NARRATOR_COMMAND_KINDS,
  type NarratorCommand,
  type NarratorHook,
  type PortDef,
  type PortDefId,
  type TempRef,
  configTicks,
} from "@crew/sim";
import {
  AFTERMATH_MAX_WORDS,
  CARD_SITUATION_MAX_WORDS,
  type DecisionCardProse,
  type DroppedIntent,
  type NarratorIntent,
  type NarratorPlan,
  PITCH_MAX_WORDS,
  type TranslateIntents,
  type TranslationCtx,
  type TranslationResult,
  buildNarratorPlanSchema,
} from "./contract";
import {
  JOB_QUANTITY_UNITS,
  SPAWN_QUANTITY_UNITS,
  type Snapshot,
  faultDiscovery,
  faultWindowTicks,
  offerPortNow,
  payFor,
  portName,
  routeDistance,
} from "./lookups";
import { NARRATOR_TEXT_KEYS, templateCard } from "./templates";

const LABEL_MAX_CHARS = 48;
const TITLE_MAX_CHARS = 60;
const ISSUER_MAX_CHARS = 80;
const DESCRIPTION_MAX_CHARS = 300;

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = (reason: string): Outcome<never> => ({ ok: false, reason });

/** D45: an id the model wrote that nothing in the game matches. */
const unknownId = (what: string, id: string) =>
  `unknown ${what} "${id}"; use one listed under What you can do`;

function knownPort(content: ContentBundle, id: string): Outcome<PortDef> {
  const port = content.ports[id as PortDefId];
  return port === undefined ? no(unknownId("port", id)) : ok(port);
}

/** A cargo item: an existing item def that has a cargo class (freight, not a tool or a meal). */
type CargoItemDef = ItemDef & { readonly cargoClass: NonNullable<ItemDef["cargoClass"]> };

function cargoItem(content: ContentBundle, id: string): Outcome<CargoItemDef> {
  const item = content.items[id as ItemDefId];
  if (item === undefined) return no(unknownId("item", id));
  const cargoClass = item.cargoClass;
  if (cargoClass === undefined) return no(`${id} is not a cargo item`);
  return ok({ ...item, cargoClass });
}

type NarratorDraft = {
  [K in NarratorCommand["kind"]]: Extract<CommandDraft, { kind: K }>;
}[NarratorCommand["kind"]];

// ---------------------------------------------------------------------------------------------
// Player-facing text rules
// ---------------------------------------------------------------------------------------------

/** GDD §22: no numeric consequences on cards (credits, percentages, +/- deltas). */
const NUMERIC_CONSEQUENCE = /[+-]\s?\d|\d[\d,.]*\s*(credits?\b|cr\b|%|percent\b)/i;

function clipChars(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function clipWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

/**
 * Phrases that would reveal something nobody aboard knows (N1): names and symptoms of active
 * faults nobody has noticed, and of scheduled faults. A substring heuristic, deliberately
 * conservative; the prompt carries the real instruction.
 */
export function secretPhrases(snapshot: Snapshot, content: ContentBundle): readonly string[] {
  const state = snapshot.state;
  const phrases = new Set<string>();
  for (const machine of Object.values(state.machines)) {
    const def = content.machines[machine.defId];
    const add = (faultKey: string) => {
      const fault = def?.faults.find((f) => f.key === faultKey);
      if (fault === undefined) return;
      phrases.add(fault.name.toLowerCase());
      phrases.add(fault.symptom.key.replace(/_/g, " ").toLowerCase());
    };
    for (const fault of machine.faults) {
      if (faultDiscovery(state, machine, fault) === "undiscovered") add(fault.faultKey);
    }
    for (const scheduled of machine.scheduledFaults) add(scheduled.faultKey);
  }
  return [...phrases].sort();
}

function textProblem(text: string, secrets: readonly string[]): string | undefined {
  if (text.trim() === "") return "empty text";
  if (NUMERIC_CONSEQUENCE.test(text)) return "player-facing text states a numeric consequence";
  const lower = text.toLowerCase();
  const leak = secrets.find((s) => lower.includes(s));
  if (leak !== undefined)
    return `player-facing text reveals something nobody aboard knows ("${leak}")`;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Per-intent translation
// ---------------------------------------------------------------------------------------------

interface Tally {
  spawns: number;
  faults: number;
  cardUsed: boolean;
  /** D39: the thread this call's beat card was attributed to. */
  beatCardThread: string | undefined;
}

/** D39: what the translator needs to know about a thread to accept a beat card for it. */
interface KnownThread {
  readonly title: string;
  readonly beatCardShown: boolean;
}

interface Env {
  readonly snapshot: Snapshot;
  readonly content: ContentBundle;
  readonly hook: DeepReadonly<NarratorHook> | undefined;
  readonly secrets: readonly string[];
  /** Stored threads first, then any the plan's notes introduce this call. */
  readonly threads: readonly KnownThread[];
  /** D41: the player's avatar; never a card speaker. Undefined when nobody is tagged captain. */
  readonly captainName: string | undefined;
  readonly tally: Tally;
  /** D41: non-fatal corrections, reported back to the model next call. */
  readonly notes: string[];
}

/**
 * D41: the captain's name, from the crew member tagged `captain` in the snapshot, or failing
 * that from the content crew defs (a scenario that has not spawned its crew yet).
 */
export function captainName(snapshot: Snapshot, content: ContentBundle): string | undefined {
  const actor = Object.values(snapshot.state.actors).find(
    (a) => a.crew && a.roleTags.includes("captain"),
  );
  if (actor !== undefined) return actor.name;
  return Object.values(content.crew).find((def) => def.roleTags.includes("captain"))?.name;
}

type Intent<K extends NarratorIntent["kind"]> = Extract<NarratorIntent, { kind: K }>;

function translateOfferJob(env: Env, intent: Intent<"offerJob">): Outcome<NarratorDraft> {
  const { snapshot, content } = env;
  const config = snapshot.config;
  const here = offerPortNow(snapshot.state);
  if (here === undefined) return no("offerJob: the ship is not at or approaching a port");
  const fromPort = knownPort(content, intent.fromPort);
  if (!fromPort.ok) return no(`offerJob: fromPort: ${fromPort.reason}`);
  const toPort = knownPort(content, intent.toPort);
  if (!toPort.ok) return no(`offerJob: toPort: ${toPort.reason}`);
  if (intent.fromPort !== here) {
    return no(
      `offerJob: fromPort must be ${here} (${portName(content, here)}), the port the ship is at or approaching`,
    );
  }
  if (intent.toPort === intent.fromPort) return no("offerJob: toPort equals fromPort");
  const distance = routeDistance(content, intent.fromPort, intent.toPort);
  if (distance === undefined)
    return no(`offerJob: no route from ${intent.fromPort} to ${intent.toPort}`);
  const cargo = cargoItem(content, intent.cargoItem);
  if (!cargo.ok) return no(`offerJob: cargoItem: ${cargo.reason}`);
  const item = cargo.value;
  if (intent.surface && env.hook?.kind === "policyDecision") {
    return no("offerJob: cannot surface a new card while a policy decision is pending");
  }
  if (intent.surface && env.tally.cardUsed) return no("offerJob: only one card per call");
  const name = clipChars(intent.issuerName, ISSUER_MAX_CHARS);
  const role = clipChars(intent.issuerRole, ISSUER_MAX_CHARS).toLowerCase();
  const org = clipChars(intent.issuerOrg, ISSUER_MAX_CHARS);
  const pitch = clipWords(intent.pitch, PITCH_MAX_WORDS);
  const description = clipChars(intent.description, DESCRIPTION_MAX_CHARS);
  const texts: [string, string][] = [
    ["issuerName", name],
    ["issuerRole", role],
    ["pitch", pitch],
    ["description", description],
  ];
  if (org !== "") texts.push(["issuerOrg", org]);
  for (const [field, text] of texts) {
    const problem = textProblem(text, env.secrets);
    if (problem !== undefined) return no(`offerJob: ${field}: ${problem}`);
  }
  const units = JOB_QUANTITY_UNITS[intent.quantity];
  const { pay } = payFor(config, item.cargoClass, distance, units, intent.payTier);
  if (intent.surface) env.tally.cardUsed = true;
  return ok({
    kind: "offerJob",
    payload: {
      job: {
        issuer: { name, role, ...(org === "" ? {} : { org }) },
        pitch: { key: NARRATOR_TEXT_KEYS.jobPitch, params: {}, prose: pitch },
        urgency: intent.urgency,
        description: { key: NARRATOR_TEXT_KEYS.jobDescription, params: {}, prose: description },
        fromPortId: intent.fromPort as PortDefId,
        toPortId: intent.toPort as PortDefId,
        cargo: [{ itemDefId: item.id, count: units }],
        pay,
      },
      surface: intent.surface,
    },
  });
}

function translateSpawn(env: Env, intent: Intent<"spawnAtBoundary">): Outcome<NarratorDraft> {
  const { snapshot, content } = env;
  const config = snapshot.config;
  const budget = snapshot.state.narrator.budget.spawnsRemaining - env.tally.spawns;
  if (budget <= 0) return no("spawnAtBoundary: spawn budget exhausted");
  const known = knownPort(content, intent.port);
  if (!known.ok) return no(`spawnAtBoundary: port: ${known.reason}`);
  const port = known.value;
  if (!port.externalStores.some((s) => s.key === intent.store)) {
    return no(
      `spawnAtBoundary: port ${intent.port} has no store "${intent.store}"; use one listed under What you can do`,
    );
  }
  const cargo = cargoItem(content, intent.cargoItem);
  if (!cargo.ok) return no(`spawnAtBoundary: cargoItem: ${cargo.reason}`);
  const item = cargo.value;
  const wanted = SPAWN_QUANTITY_UNITS[intent.quantity];
  const count =
    item.stacking === "unique"
      ? 1
      : Math.max(1, Math.min(wanted, config.narrator.maxSpawnsPerCommand, item.maxStack));
  env.tally.spawns += 1;
  return ok({
    kind: "spawnAtBoundary",
    payload: {
      defs: { items: [], crew: [] },
      spawns: [{ kind: "item", tempRef: "$spawn0" as TempRef, itemDefId: item.id, count }],
      location: { kind: "portStore", portId: port.id, storeKey: intent.store },
    },
  });
}

function translateFault(env: Env, intent: Intent<"scheduleFault">): Outcome<NarratorDraft> {
  const { snapshot, content } = env;
  const config = snapshot.config;
  const machine = snapshot.state.machines[intent.machine as MachineId];
  if (machine === undefined) {
    return no(`scheduleFault: machine: ${unknownId("machine", intent.machine)}`);
  }
  const def = content.machines[machine.defId];
  if (def === undefined || !def.faults.some((f) => f.key === intent.faultKey)) {
    return no(
      `scheduleFault: machine ${intent.machine} has no fault "${intent.faultKey}"; use a faultKey listed under it in What you can do`,
    );
  }
  if (
    machine.faults.some((f) => f.faultKey === intent.faultKey) ||
    machine.scheduledFaults.some((f) => f.faultKey === intent.faultKey)
  ) {
    return no(`scheduleFault: ${intent.machine} already has or awaits "${intent.faultKey}"`);
  }
  const budget = snapshot.state.narrator.budget.faultsRemaining - env.tally.faults;
  if (budget <= 0) return no("scheduleFault: fault budget exhausted");
  const windowTicks = faultWindowTicks(config, intent.window);
  const maxWindow = configTicks(config, config.narrator.maxFaultWindowSeconds);
  if (windowTicks[1] - windowTicks[0] > maxWindow || windowTicks[0] < 0) {
    return no("scheduleFault: window outside config bounds");
  }
  env.tally.faults += 1;
  return ok({
    kind: "scheduleFault",
    payload: {
      machineId: machine.id,
      faultKey: intent.faultKey,
      windowTicks: [windowTicks[0], windowTicks[1]],
    },
  });
}

type Side = Intent<"surfaceDecision">["left"];

function translateSide(
  env: Env,
  side: Side,
  which: string,
): Outcome<{ label: string; commands: CommandDraft[] }> {
  const label = clipChars(side.label, LABEL_MAX_CHARS);
  const problem = textProblem(label, env.secrets);
  if (problem !== undefined) return no(`${which} label: ${problem}`);
  if (side.effect === "none") return ok({ label, commands: [] });
  const travel = env.snapshot.state.travel;
  if (travel.stage !== "docked") return no(`${which}: setCourse is only possible while docked`);
  if (side.coursePort.trim() === "") return no(`${which}: setCourse needs coursePort`);
  const course = knownPort(env.content, side.coursePort);
  if (!course.ok) return no(`${which}: coursePort: ${course.reason}`);
  if (side.coursePort === travel.portId)
    return no(`${which}: already docked at ${side.coursePort}`);
  if (routeDistance(env.content, travel.portId, side.coursePort) === undefined) {
    return no(`${which}: no route from ${travel.portId} to ${side.coursePort}`);
  }
  const command: CommandDraft = {
    kind: "setCourse",
    payload: { destinationPortId: side.coursePort as PortDefId },
  };
  // Option commands run as `player` when chosen; never offer one the player could not issue.
  if (!(AUTHORITY.player as readonly string[]).includes(command.kind)) {
    return no(`${which}: ${command.kind} is not a player command`);
  }
  return ok({ label, commands: [command] });
}

/**
 * D26: an aftermath caption, clipped to `AFTERMATH_MAX_WORDS`. Blank means "none" (the card
 * closes without one) rather than a reason to drop the whole card; numbers or secrets do drop it.
 */
function aftermathText(env: Env, text: string, which: string): Outcome<string> {
  if (text.trim() === "") return ok("");
  const clipped = clipWords(text, AFTERMATH_MAX_WORDS);
  const problem = textProblem(clipped, env.secrets);
  return problem === undefined ? ok(clipped) : no(`${which}: ${problem}`);
}

/**
 * D29: the speaker's name, clipped; blank means an observed scene (no speaker). Numbers or
 * secrets in the name are a problem like in any other player-facing text.
 */
function speakerName(env: Env, raw: string): Outcome<string | undefined> {
  if (raw.trim() === "") return ok(undefined);
  const name = clipChars(raw, ISSUER_MAX_CHARS);
  const problem = textProblem(name, env.secrets);
  if (problem !== undefined) return no(`speaker: ${problem}`);
  // D41: the captain is the player; cards are brought to them. The card survives as an observed
  // scene and the model is told why next call.
  if (env.captainName !== undefined && name.toLowerCase() === env.captainName.toLowerCase()) {
    env.notes.push(
      `speaker: "${name}" is the captain and cannot bring a card; name the crew member who does`,
    );
    return ok(undefined);
  }
  return ok(name);
}

/**
 * D39: a beat card must name a thread the model has (stored, or written this call) that has not
 * had its beat card yet, and both sides must be effect none: the card records the captain's
 * attitude, it does not set a course.
 */
function beatThread(env: Env, intent: Intent<"surfaceDecision">): Outcome<string | undefined> {
  const raw = intent.beatOfThread;
  if (raw.trim() === "") return ok(undefined);
  const wanted = raw.trim().toLowerCase();
  const thread = env.threads.find((t) => t.title.trim().toLowerCase() === wanted);
  if (thread === undefined) {
    return no(`beatOfThread "${raw.trim()}" matches no thread in your notes; name one exactly`);
  }
  if (thread.beatCardShown) {
    return no(
      `thread "${thread.title}" already had its beat card; its next card must pay it off (nextBeat)`,
    );
  }
  if (intent.left.effect !== "none" || intent.right.effect !== "none") {
    return no("a beat card's sides are the captain's attitude; both must be effect none");
  }
  return ok(thread.title);
}

function translateDecision(env: Env, intent: Intent<"surfaceDecision">): Outcome<NarratorDraft> {
  if (env.hook?.kind === "policyDecision") {
    return no("surfaceDecision: a policy decision is pending; dress it with `card` instead");
  }
  if (env.tally.cardUsed) return no("surfaceDecision: only one card per call");
  const beat = beatThread(env, intent);
  if (!beat.ok) return no(`surfaceDecision: ${beat.reason}`);
  const title = clipChars(intent.title, TITLE_MAX_CHARS);
  const situation = clipWords(intent.situation, CARD_SITUATION_MAX_WORDS);
  const problem = textProblem(title, env.secrets) ?? textProblem(situation, env.secrets);
  if (problem !== undefined) return no(`surfaceDecision: ${problem}`);
  const speaker = speakerName(env, intent.speaker);
  if (!speaker.ok) return no(`surfaceDecision: ${speaker.reason}`);
  const left = translateSide(env, intent.left, "left");
  if (!left.ok) return no(`surfaceDecision: ${left.reason}`);
  const right = translateSide(env, intent.right, "right");
  if (!right.ok) return no(`surfaceDecision: ${right.reason}`);
  const leftAftermath = aftermathText(env, intent.leftAftermath, "leftAftermath");
  if (!leftAftermath.ok) return no(`surfaceDecision: ${leftAftermath.reason}`);
  const rightAftermath = aftermathText(env, intent.rightAftermath, "rightAftermath");
  if (!rightAftermath.ok) return no(`surfaceDecision: ${rightAftermath.reason}`);
  if (left.value.label.toLowerCase() === right.value.label.toLowerCase()) {
    return no("surfaceDecision: both sides have the same label");
  }
  env.tally.cardUsed = true;
  env.tally.beatCardThread = beat.value;
  const sideSpec = (s: { label: string; commands: CommandDraft[] }, aftermath: string) => ({
    label: { key: NARRATOR_TEXT_KEYS.side, params: {}, prose: s.label },
    commands: s.commands,
    ...(aftermath === ""
      ? {}
      : { aftermath: { key: NARRATOR_TEXT_KEYS.aftermath, params: {}, prose: aftermath } }),
  });
  return ok({
    kind: "surfaceDecision",
    payload: {
      card: {
        // W9 decision: `DecisionCardSpec` has no title field; it and the D29 speaker travel in
        // the prompt params, where `templateCard` picks them up.
        prompt: {
          key: NARRATOR_TEXT_KEYS.situation,
          params: { title, ...(speaker.value === undefined ? {} : { speaker: speaker.value }) },
          prose: situation,
        },
        left: sideSpec(left.value, leftAftermath.value),
        right: sideSpec(right.value, rightAftermath.value),
      },
    },
  });
}

function translateOne(env: Env, intent: NarratorIntent): Outcome<NarratorDraft> {
  switch (intent.kind) {
    case "offerJob":
      return translateOfferJob(env, intent);
    case "spawnAtBoundary":
      return translateSpawn(env, intent);
    case "scheduleFault":
      return translateFault(env, intent);
    case "surfaceDecision":
      return translateDecision(env, intent);
  }
}

// ---------------------------------------------------------------------------------------------
// Policy card
// ---------------------------------------------------------------------------------------------

/** `{[key]: value}` when the card has that optional field, else `{}` (JSON-safe spreading). */
function pick<K extends "leftAftermath" | "rightAftermath">(
  card: DecisionCardProse,
  key: K,
): Partial<Pick<DecisionCardProse, K>> {
  const value = card[key];
  return value === undefined ? {} : ({ [key]: value } as Pick<DecisionCardProse, K>);
}

function policyCard(
  env: Env,
  plan: NarratorPlan,
  dropped: DroppedIntent[],
): DecisionCardProse | undefined {
  const hook = env.hook;
  if (hook?.kind !== "policyDecision") return undefined;
  const decision = env.snapshot.state.decisions.records[hook.context.decisionId as DecisionId];
  if (decision === undefined || decision.status !== "pending") return undefined;
  const fallback = templateCard(decision, env.content);
  if (plan.card === null) return fallback;
  const leftAftermath = plan.card.leftAftermath.trim();
  const rightAftermath = plan.card.rightAftermath.trim();
  const speaker = speakerName(env, plan.card.speaker);
  if (!speaker.ok) {
    dropped.push({ intentIndex: -1, kind: "card", reason: `card: ${speaker.reason}` });
    return fallback;
  }
  const card: DecisionCardProse = {
    decisionId: decision.id,
    title: clipChars(plan.card.title, TITLE_MAX_CHARS),
    ...(speaker.value === undefined ? {} : { speaker: speaker.value }),
    situation: clipWords(plan.card.situation, CARD_SITUATION_MAX_WORDS),
    leftLabel: clipChars(plan.card.leftLabel, LABEL_MAX_CHARS),
    rightLabel: clipChars(plan.card.rightLabel, LABEL_MAX_CHARS),
    // D26: a blank aftermath falls back to the decision's template one, if it has one.
    ...(leftAftermath === ""
      ? pick(fallback, "leftAftermath")
      : { leftAftermath: clipWords(leftAftermath, AFTERMATH_MAX_WORDS) }),
    ...(rightAftermath === ""
      ? pick(fallback, "rightAftermath")
      : { rightAftermath: clipWords(rightAftermath, AFTERMATH_MAX_WORDS) }),
  };
  const problem = [
    card.title,
    card.situation,
    card.leftLabel,
    card.rightLabel,
    ...(card.leftAftermath === undefined ? [] : [card.leftAftermath]),
    ...(card.rightAftermath === undefined ? [] : [card.rightAftermath]),
  ]
    .map((t) => textProblem(t, env.secrets))
    .find((p) => p !== undefined);
  if (problem !== undefined) {
    dropped.push({ intentIndex: -1, kind: "card", reason: `card: ${problem}` });
    return fallback;
  }
  return card;
}

// ---------------------------------------------------------------------------------------------

function kindOf(raw: unknown): string {
  if (raw !== null && typeof raw === "object" && "kind" in raw) {
    const kind = (raw as { kind: unknown }).kind;
    if (typeof kind === "string") return kind.slice(0, 40);
  }
  return "unknown";
}

function isNarratorKind(kind: string): kind is NarratorCommand["kind"] {
  return (NARRATOR_COMMAND_KINDS as readonly string[]).includes(kind);
}

export function commandIdFor(callId: string, n: number): CommandId {
  return `cmd:narrator:${callId}:${n}` as CommandId;
}

/**
 * Translate a plan. The plan is treated as untrusted even though it passed the schema: each
 * intent is re-parsed against the intent schema, so a hand-built or partially valid plan cannot
 * smuggle through an unknown kind or an extra field; every id is then checked against the
 * snapshot and content (D45).
 */
export const translateIntents: TranslateIntents = (
  plan: NarratorPlan,
  ctx: TranslationCtx,
): TranslationResult => {
  const snapshot = ctx.snapshot;
  const hook = ctx.hook ?? snapshot.state.narrator.pendingHook;
  const intentSchema = buildNarratorPlanSchema().shape.intents.element;
  const written: readonly { readonly title?: unknown }[] = Array.isArray(plan.notes?.threads)
    ? plan.notes.threads
    : [];
  const env: Env = {
    snapshot,
    content: ctx.content,
    hook,
    secrets: secretPhrases(snapshot, ctx.content),
    // D39: a thread the plan starts this call can be foreshadowed, but only stored threads can
    // already have had their beat card.
    threads: [
      ...(ctx.threads ?? []),
      ...written.flatMap((t) =>
        typeof t.title === "string" ? [{ title: t.title, beatCardShown: false }] : [],
      ),
    ],
    captainName: captainName(snapshot, ctx.content),
    tally: {
      spawns: 0,
      faults: 0,
      cardUsed: snapshot.state.decisions.queue.length > 0,
      beatCardThread: undefined,
    },
    notes: [],
  };
  const commands: NarratorCommand[] = [];
  const dropped: DroppedIntent[] = [];
  const rawIntents: readonly unknown[] = Array.isArray(plan.intents) ? plan.intents : [];

  rawIntents.forEach((raw, intentIndex) => {
    const kind = kindOf(raw);
    if (!isNarratorKind(kind)) {
      dropped.push({ intentIndex, kind, reason: `"${kind}" is not something you can do` });
      return;
    }
    const parsed = intentSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join(".") ?? "";
      dropped.push({
        intentIndex,
        kind,
        reason: `${kind}: invalid ${where} (${issue?.message ?? "bad shape"})`,
      });
      return;
    }
    const outcome = translateOne(env, parsed.data);
    if (!outcome.ok) {
      dropped.push({ intentIndex, kind, reason: outcome.reason });
      return;
    }
    const draft = outcome.value;
    // Defense in depth: the switch above can only build narrator kinds, but check anyway.
    if (!isNarratorKind(draft.kind)) {
      dropped.push({ intentIndex, kind: draft.kind, reason: "not an allow-listed command" });
      return;
    }
    commands.push({
      id: commandIdFor(ctx.callId, commands.length),
      source: "narrator",
      // The hook tick is already committed; the earliest a command can apply is the next one.
      targetTick: ctx.hookTick + 1,
      ...draft,
    } as NarratorCommand);
  });

  const card = policyCard(env, plan, dropped);
  const beat = env.tally.beatCardThread;
  return {
    commands,
    dropped,
    notes: env.notes,
    ...(card === undefined ? {} : { card }),
    ...(beat === undefined ? {} : { beatCardThread: beat }),
  };
};
