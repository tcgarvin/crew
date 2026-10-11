import { NARRATOR_TEXT_KEYS, templateCard } from "@crew/content";
/**
 * Intent → command translation (W0 `TranslateIntents`). Pure.
 *
 * Every intent becomes exactly one allow-listed `NarratorCommand` with `source: "narrator"`, or
 * is dropped with a reason. The translator pre-validates with the same rules the kernel enforces
 * (price bands, fault catalogs, window bounds, known ports and stores, boundary-only spawns, the
 * living and the balance) plus the narrator's own presentation rules (one card per call, no numbers or
 * undiscovered facts in player-facing text), so a rejection is explained to the model in the
 * next call's notes instead of disappearing in the kernel. The kernel still revalidates on apply.
 */
import {
  AUTHORITY,
  type Actor,
  type ActorId,
  CALL_BACK_WHY_MAX,
  type CommandDraft,
  type CommandId,
  type ContentBundle,
  type DecisionId,
  type DeepReadonly,
  FALL_OUT_OVER_MAX,
  type ImpactTarget,
  type ItemDef,
  type ItemDefId,
  type Job,
  type JobDraft,
  type LocalKey,
  type MachineId,
  NARRATOR_COMMAND_KINDS,
  type NarratorCommand,
  type NarratorHook,
  type PortDef,
  type PortDefId,
  STAGING_COMMAND_KINDS,
  STAGING_LIMITS,
  STRIKE_HOW_MAX,
  type ScriptedImpactDraft,
  TRANSACT_TEXT_MAX,
  type TempRef,
  type ThoughtKey,
  UNSEEN_ODDS_CERTAIN,
  basePriceFor,
  configTicks,
  errandPay,
  isOnDock,
  isSite,
  jobBlockingAcceptance,
  planMenu,
  scriptedHullDamage,
} from "@crew/sim";
import {
  AFTERMATH_MAX_WORDS,
  CARD_SITUATION_MAX_WORDS,
  type DecisionCardProse,
  type DroppedIntent,
  type FaultWindow,
  type FieldMoment,
  type NarratorIntent,
  type NarratorPlan,
  PITCH_MAX_WORDS,
  type TranslateIntents,
  type TranslationCtx,
  type TranslationResult,
  UNSEEN_ODDS_PATTERN,
  buildNarratorPlanSchema,
} from "./contract";
import {
  type Outcome,
  collapseWhitespace,
  invalidIntentReason,
  kindOf,
  no,
  ok,
} from "./intent-outcome";
import {
  JOB_QUANTITY_UNITS,
  SPAWN_QUANTITY_UNITS,
  type Snapshot,
  type State,
  compartmentName,
  errandDistance,
  fareFor,
  faultDiscovery,
  faultWindowSeconds,
  faultWindowTicks,
  isArmsLocker,
  livePassage,
  machineName,
  offerPortNow,
  pathBetween,
  payFor,
  portName,
  shipDeckOf,
  transitSecondsLeft,
} from "./lookups";
import { clipWords } from "./notes";
import { EXPEDITION_ARRIVAL_KEY } from "./site-digest";
import { type BeatAttribution, LANDS_WHEN_MADE } from "./story-plan";

const LABEL_MAX_CHARS = 48;
const TITLE_MAX_CHARS = 60;
const ISSUER_MAX_CHARS = 80;
const DESCRIPTION_MAX_CHARS = 300;

/** §narrator-authority: an id the model wrote that nothing in the game matches. */
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

/** Whitespace collapsed, and clipped to `max` characters with an ellipsis. */
export function clipChars(text: string, max: number): string {
  const t = collapseWhitespace(text);
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Phrases that would reveal something nobody aboard knows (N1): names and symptoms of active
 * faults nobody has noticed, and of scheduled faults. A substring heuristic, deliberately
 * conservative; the prompt carries the real instruction.
 */
export function secretPhrases(
  snapshot: Snapshot,
  content: ContentBundle,
  planned: PlannedFaults = NO_PLANNED_FAULTS,
): readonly string[] {
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
      if (planned.revealed.has(faultRef(machine.id, fault.faultKey))) continue;
      if (faultDiscovery(state, machine, fault) === "undiscovered") add(fault.faultKey);
    }
    for (const scheduled of machine.scheduledFaults) add(scheduled.faultKey);
    for (const injected of planned.injected) {
      if (injected.startsWith(`${machine.id}/`)) add(injected.slice(machine.id.length + 1));
    }
  }
  return [...phrases].sort();
}

/**
 * §thought-and-reveal-levers: the faults this plan reveals (no longer secret on its cards) and
 * injects (secret from the start), as `machineId/faultKey`.
 */
export interface PlannedFaults {
  readonly revealed: ReadonlySet<string>;
  readonly injected: readonly string[];
}

const NO_PLANNED_FAULTS: PlannedFaults = { revealed: new Set(), injected: [] };

const faultRef = (machineId: string, faultKey: string) => `${machineId}/${faultKey}`;

/**
 * Why player-facing text cannot go out (empty, a numeric consequence, a secret), or undefined.
 * Shared with the staging translator (§staging-prompt).
 */
export function textProblem(text: string, secrets: readonly string[]): string | undefined {
  if (text.trim() === "") return "empty text";
  if (NUMERIC_CONSEQUENCE.test(text)) return "player-facing text states a numeric consequence";
  const lower = text.toLowerCase();
  const leak = secrets.find((s) => lower.includes(s));
  if (leak !== undefined)
    return `player-facing text reveals something nobody aboard knows ("${leak}")`;
  return undefined;
}

/**
 * §unseen-odds: a percentage the narrator wrote that is the very chance it set on the way in
 * unseen ("I make it 20%", "20 percent"), unsigned and whole; any other number is left for
 * `textProblem`.
 */
const STATED_PERCENT = /(?<![\d.,+-])(\d+)\s*(?:%|per\s?cent\b)/gi;

/**
 * `textProblem` for a text that may state `odds`, the marked side's chance: a percentage equal to
 * it is exempt, and every other number is still refused (§player-facing-text-checks).
 */
function textProblemStating(
  text: string,
  secrets: readonly string[],
  odds: number,
): string | undefined {
  const exempt = text.replace(STATED_PERCENT, (match, digits: string) =>
    Number(digits) === odds ? "" : match,
  );
  return exempt.trim() === "" ? textProblem(text, secrets) : textProblem(exempt, secrets);
}

// ---------------------------------------------------------------------------------------------
// Per-intent translation
// ---------------------------------------------------------------------------------------------

interface Tally {
  /** §hazard-and-field-levers: hazards placed this call (one waits at a time). */
  hazards: number;
  /** §money-levers: this call's `transact` sums so far, so two debits cannot overdraw together. */
  money: number;
  /** §scheduling-a-field: fields placed this call (one per leg). */
  fields: number;
  cardUsed: boolean;
  /** §beat-cards: the thread this call's beat card was attributed to. */
  beatCardThread: string | undefined;
  /** §closing-cards: the stored thread this call's closing card ends. */
  closedThread: string | undefined;
}

/** §beat-cards: what the translator needs to know about a thread to accept a beat card for it. */
interface KnownThread {
  readonly title: string;
  readonly beatCardShown: boolean;
  /** §closing-cards: in the stored notes (not started by this plan), so it can be closed. */
  readonly stored: boolean;
}

interface Env {
  readonly snapshot: Snapshot;
  readonly content: ContentBundle;
  readonly hook: DeepReadonly<NarratorHook> | undefined;
  readonly secrets: readonly string[];
  /** The stored threads (§notes-turn: the notes for this call are written after the plan). */
  readonly threads: readonly KnownThread[];
  /** §closing-cards: titles of threads a shown card already closed, lowercased and trimmed. */
  readonly closedThreads: readonly string[];
  /**
   * §captain-never-speaks: the player's avatar; never a card speaker. Undefined when nobody is
   * tagged captain.
   */
  readonly captainName: string | undefined;
  readonly tally: Tally;
  /** §captain-never-speaks: non-fatal corrections, reported back to the model next call. */
  readonly notes: string[];
}

/**
 * §captain-never-speaks: the captain's name, from the crew member tagged `captain` in the snapshot,
 * or failing that from the content crew defs (a scenario that has not spawned its crew yet).
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
  if (here === undefined) {
    return no("the ship is not docked; offers are made in person at the dock");
  }
  // §one-job-in-hand, D50: one job at a time. The kernel rejects `acceptContract` while a job is in
  // hand, so an offer made now could only be declined; drop it here with the job it would collide
  // with. The kernel's own rule, so a job being finished at this port (freight unloading at its
  // destination, a passenger walking off) does not drop an offer made on the docked tick.
  const inHand = jobBlockingAcceptance(snapshot.state);
  if (inHand !== undefined) {
    return no(`a job is already in hand: ${inHand.id} to ${portName(content, inHand.toPortId)}`);
  }
  // Expeditions A2: nobody at a landing site offers work; the ship is there for an errand.
  if (isSite(content, here)) {
    return no(
      `the ship is set down at ${portName(content, here)}, a landing site; offers are made at ports`,
    );
  }
  const fromPort = knownPort(content, intent.fromPort);
  if (!fromPort.ok) return no(`fromPort: ${fromPort.reason}`);
  // §6: an errand's toPort is fromPort (it comes home), so it is checked on its own branch.
  const errand = intent.errandKind !== "";
  if (!errand) {
    const toPort = knownPort(content, intent.toPort);
    if (!toPort.ok) return no(`toPort: ${toPort.reason}`);
  }
  if (intent.fromPort !== here) {
    return no(
      `fromPort must be ${here} (${portName(content, here)}), the port the ship is docked at`,
    );
  }
  const route = errand ? errandRoute(env, intent, here) : freightRoute(env, intent);
  if (!route.ok) return route;
  // §4.1: a passenger offer is a person at the ramp, so it is always surfaced (§offer-lever: the
  // card comes up when the captain meets them).
  const surface = intent.passenger || intent.surface;
  if (surface && env.hook?.kind === "policyDecision") {
    return no("cannot surface a new card while a policy decision is pending");
  }
  if (surface && env.tally.cardUsed) {
    // A quiet offer never reaches the captain (nothing surfaces a board offer later), so a
    // passenger offer cannot fall back to the board the way freight can.
    return no(
      intent.passenger
        ? "a passenger offer must be surfaced and this call's card is taken"
        : "only one card per call",
    );
  }
  // §6: an errand carries nothing out; cargoItem and quantity are not its fields.
  const cargo = route.value.errand === undefined ? offerCargo(env, intent) : ok(NO_CARGO);
  if (!cargo.ok) return no(`cargoItem: ${cargo.reason}`);
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
    if (problem !== undefined) return no(`${field}: ${problem}`);
  }
  // §3.4: a passage is priced by the passenger band over path distance (doubled for a round
  // trip), luggage adding nothing; freight by its class band per unit. §6, plan call 6: an errand
  // by the sim's own `errandPay` over the path there and back, as `checkErrandBand` bands it.
  const { distance } = route.value;
  const named = namedPay(env, intent.payCredits);
  if (!named.ok) return no(`payCredits: ${named.reason}`);
  const { pay: banded } =
    route.value.errand !== undefined
      ? errandPay(config, distance, intent.payTier)
      : intent.passenger
        ? fareFor(config, distance, intent.roundTrip, intent.payTier)
        : payFor(config, cargo.value.cargoClass, distance, cargo.value.units, intent.payTier);
  const pay = named.value ?? banded;
  if (surface) env.tally.cardUsed = true;
  const shape =
    route.value.errand !== undefined
      ? { errand: route.value.errand }
      : intent.passenger
        ? { passenger: true, roundTrip: intent.roundTrip }
        : {};
  return ok({
    kind: "offerJob",
    payload: {
      job: {
        issuer: { name, role, ...(org === "" ? {} : { org }) },
        pitch: { key: NARRATOR_TEXT_KEYS.jobPitch, params: {}, prose: pitch },
        urgency: intent.urgency,
        description: { key: NARRATOR_TEXT_KEYS.jobDescription, params: {}, prose: description },
        fromPortId: intent.fromPort as PortDefId,
        toPortId: route.value.toPortId,
        cargo: cargo.value.lines,
        pay,
        ...(named.value === undefined ? {} : { payNamed: true as const }),
        ...shape,
      },
      surface,
    },
  });
}

/**
 * §money-levers: `offerJob.payCredits` as the kernel takes it: undefined (0, the tier's pay), or a
 * positive whole number of credits at most `config.narrator.maxOfferPay`.
 */
function namedPay(env: Env, credits: number): Outcome<number | undefined> {
  if (credits === 0) return ok(undefined);
  if (!Number.isInteger(credits) || credits < 0) {
    return no("a positive whole number of credits, or 0 for the tier's pay");
  }
  const max = env.snapshot.config.narrator.maxOfferPay;
  if (credits > max) return no(`${credits} is over the most an offer pays (${max})`);
  return ok(credits);
}

/** Where an offer goes and the distance it is paid over; an errand's own fields when it is one. */
interface OfferRoute {
  readonly toPortId: PortDefId;
  readonly distance: number;
  readonly errand?: NonNullable<JobDraft["errand"]>;
}

/** An errand's cargo: none (its pay is not per unit). */
const NO_CARGO: OfferCargo = { lines: [], cargoClass: "general", units: 0 };

/**
 * Freight and passages: any reachable port but the one the ship is at (§2.3: a far one becomes a
 * voyage when accepted, and the kernel prices it over the same path distance), never a landing
 * site (the kernel bands freight and passages over the ports alone, so one there could never be
 * flown); `roundTrip` only with `passenger` (§4.1).
 */
function freightRoute(env: Env, intent: Intent<"offerJob">): Outcome<OfferRoute> {
  const { content, snapshot } = env;
  if (intent.toPort === intent.fromPort) return no("toPort equals fromPort");
  if (isSite(content, intent.toPort as PortDefId)) {
    return no(
      `toPort ${intent.toPort} is a landing site: only an errand goes there (errandKind, with the site in site)`,
    );
  }
  const path = pathBetween(content, snapshot.state, intent.fromPort, intent.toPort);
  if (path === undefined) return no(`no route from ${intent.fromPort} to ${intent.toPort}`);
  if (intent.roundTrip && !intent.passenger) {
    return no("roundTrip needs passenger (freight has no return)");
  }
  return ok({ toPortId: intent.toPort as PortDefId, distance: path.distance });
}

/**
 * Expeditions A2 (§6): an errand, mirroring the kernel's `offerJob` errand checks so nothing passed
 * here is refused there. `site` is an authored landing site reachable from `here` and back over the
 * `"all"` graph; the job comes home, so `toPortId` is `here` (the site written in `toPort` is
 * corrected, with a note); nobody rides and nothing is carried. A `fetchPerson` names its target
 * (clipped to a cast name's length: it becomes the target's name at the site) and wants them
 * `alive` (when `wants` is empty, with a note), `either` or `dead`; a `fetchItem` names an existing
 * item, is called by `targetName` or else the item's name, and wants it `either` way.
 */
function errandRoute(env: Env, intent: Intent<"offerJob">, here: PortDefId): Outcome<OfferRoute> {
  const { content, snapshot } = env;
  const kind = intent.errandKind;
  if (kind === "") throw new Error("errandRoute: not an errand");
  const site = content.ports[intent.site as PortDefId];
  if (site === undefined) {
    return no(`site: unknown site "${intent.site}"; use one listed under Sites`);
  }
  if (!isSite(content, site.id)) {
    return no(`site: ${site.id} is a port, not a landing site; use one listed under Sites`);
  }
  if (intent.toPort === site.id) {
    env.notes.push(
      `offerJob: an errand's toPort is the port it is offered at (${here}), where it comes home; the site goes in site only`,
    );
  } else if (intent.toPort !== here) {
    return no(`toPort must be ${here}, the port the ship is docked at: an errand comes home`);
  }
  if (intent.passenger || intent.roundTrip) {
    return no("an errand is no passage: passenger and roundTrip are false");
  }
  const distance = errandDistance(content, snapshot.state, here, site.id);
  if (distance === undefined) return no(`no route from ${here} to ${site.id} and back`);
  const target = errandTarget(env, intent);
  if (!target.ok) return target;
  return ok({
    toPortId: here,
    distance,
    errand: { kind, siteId: site.id, ...target.value },
  });
}

type ErrandTarget = Pick<NonNullable<JobDraft["errand"]>, "targetName" | "itemDefId" | "wants">;

/** §6: who or what the errand is after, and how they are wanted. */
function errandTarget(env: Env, intent: Intent<"offerJob">): Outcome<ErrandTarget> {
  const written = clipChars(intent.targetName, STAGING_LIMITS.nameChars);
  if (intent.errandKind === "fetchItem") {
    const item = env.content.items[intent.targetItem as ItemDefId];
    if (item === undefined) return no(`targetItem: ${unknownId("item", intent.targetItem)}`);
    if (intent.wants !== "" && intent.wants !== "either") {
      return no(`wants: a fetchItem wants its item "either" way (or empty), not "${intent.wants}"`);
    }
    const targetName = written === "" ? clipChars(item.name, STAGING_LIMITS.nameChars) : written;
    const problem = textProblem(targetName, env.secrets);
    if (problem !== undefined) return no(`targetName: ${problem}`);
    return ok({ targetName, itemDefId: item.id, wants: "either" });
  }
  if (written === "") return no("targetName: a fetchPerson names who is to be brought back");
  const problem = textProblem(written, env.secrets);
  if (problem !== undefined) return no(`targetName: ${problem}`);
  if (intent.targetItem.trim() !== "") {
    env.notes.push("offerJob: targetItem is for a fetchItem only; it was left off this errand");
  }
  if (intent.wants === "") {
    env.notes.push(`offerJob: the errand for ${written} had no wants; it was offered as alive`);
    return ok({ targetName: written, wants: "alive" });
  }
  return ok({ targetName: written, wants: intent.wants });
}

/** The cargo lines of an offer with the class and unit count the pay is figured from. */
interface OfferCargo {
  readonly lines: { readonly itemDefId: ItemDefId; readonly count: number }[];
  readonly cargoClass: CargoItemDef["cargoClass"];
  readonly units: number;
}

/**
 * Freight: one cargo line at the quantity tier's unit count. Passage (§4.1): `cargoItem` is the
 * passenger's luggage, one unit of an existing cargo item, or empty for none; quantity is
 * ignored. The kernel keeps the same one-unit rule.
 */
function offerCargo(env: Env, intent: Intent<"offerJob">): Outcome<OfferCargo> {
  if (intent.passenger && intent.cargoItem.trim() === "") {
    return ok({ lines: [], cargoClass: "general", units: 0 });
  }
  const cargo = cargoItem(env.content, intent.cargoItem);
  if (!cargo.ok) return cargo;
  const units = intent.passenger ? 1 : JOB_QUANTITY_UNITS[intent.quantity];
  return ok({
    lines: [{ itemDefId: cargo.value.id, count: units }],
    cargoClass: cargo.value.cargoClass,
    units,
  });
}

function translateSpawn(env: Env, intent: Intent<"spawnAtBoundary">): Outcome<NarratorDraft> {
  const { snapshot, content } = env;
  const config = snapshot.config;
  // §narrator-lever-budgets: the spawn budget is advice the digest shows, never a refusal.
  const known = knownPort(content, intent.port);
  if (!known.ok) return no(`port: ${known.reason}`);
  const port = known.value;
  if (!port.externalStores.some((s) => s.key === intent.store)) {
    return no(
      `port ${intent.port} has no store "${intent.store}"; use one listed under What you can do`,
    );
  }
  const cargo = cargoItem(content, intent.cargoItem);
  if (!cargo.ok) return no(`cargoItem: ${cargo.reason}`);
  const item = cargo.value;
  const wanted = SPAWN_QUANTITY_UNITS[intent.quantity];
  const count =
    item.stacking === "unique"
      ? 1
      : Math.max(1, Math.min(wanted, config.narrator.maxSpawnsPerCommand, item.maxStack));
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
    return no(`machine: ${unknownId("machine", intent.machine)}`);
  }
  const def = content.machines[machine.defId];
  if (def === undefined || !def.faults.some((f) => f.key === intent.faultKey)) {
    return no(
      `machine ${intent.machine} has no fault "${intent.faultKey}"; use a faultKey listed under it in What you can do`,
    );
  }
  if (
    machine.faults.some((f) => f.faultKey === intent.faultKey) ||
    machine.scheduledFaults.some((f) => f.faultKey === intent.faultKey)
  ) {
    return no(`${intent.machine} already has or awaits "${intent.faultKey}"`);
  }
  // §narrator-lever-budgets: the fault budget is advice the digest shows, never a refusal.
  const windowTicks = faultWindowTicks(config, intent.window);
  const maxWindow = configTicks(config, config.narrator.maxFaultWindowSeconds);
  if (windowTicks[1] - windowTicks[0] > maxWindow || windowTicks[0] < 0) {
    return no("window outside config bounds");
  }
  return ok({
    kind: "scheduleFault",
    payload: {
      machineId: machine.id,
      faultKey: intent.faultKey,
      windowTicks: [windowTicks[0], windowTicks[1]],
    },
  });
}

/**
 * §hazard-and-field-levers: why a hazard or a field has no leg to lie on, or undefined. The kernel
 * accepts one while a course is planned or the ship is underway; it fires at the first `transit`
 * tick at or after its moment, so one placed after this leg's transit would wait for some later leg
 * the story did not choose (a field is dropped with its leg instead). The translator therefore also
 * refuses the end of a leg (approach, docking) and a window that opens after the transit left at
 * nominal speed (a drift only lengthens it).
 */
function legProblem(env: Env, window: FaultWindow, what: "hazard" | "field"): string | undefined {
  const travel = env.snapshot.state.travel;
  if (travel.stage === "docked") {
    return travel.plannedDestinationId === undefined
      ? `the ship is docked with no course set; a ${what} needs a leg to lie on`
      : undefined;
  }
  if (travel.stage === "approaching" || travel.stage === "docking") {
    return `the ship is ${travel.stage}: this leg's transit is over; place it on the next leg once a course is set`;
  }
  if (travel.stage !== "transit") return undefined;
  const config = env.snapshot.config;
  const left = transitSecondsLeft(env.snapshot.state, config);
  const [opens] = faultWindowSeconds(config)[window];
  if (opens < left) return undefined;
  return `window ${window} opens after this leg's transit ends (~${Math.round(left)}s left); use soon, or place it on the next leg`;
}

/**
 * §hazard-and-field-levers: `scheduleHazard`, the sixth lever. The tier becomes
 * `config.hazards.difficulty`, the window is the fault windows' (same kernel bound), it spends the
 * hazard budget (advice, §narrator-lever-budgets), and one hazard waits at a time: a second on top of one not yet fired is the "never
 * twice in a row" rule made firm.
 */
function translateHazard(env: Env, intent: Intent<"scheduleHazard">): Outcome<NarratorDraft> {
  const { snapshot } = env;
  const config = snapshot.config;
  if (snapshot.state.hazards.length > 0 || env.tally.hazards > 0) {
    return no("a hazard is already waiting on the ship's path; let it fire first");
  }
  // §narrator-lever-budgets: the hazard budget is advice the digest shows, never a refusal.
  const leg = legProblem(env, intent.window, "hazard");
  if (leg !== undefined) return no(leg);
  const windowTicks = faultWindowTicks(config, intent.window);
  const maxWindow = configTicks(config, config.narrator.maxFaultWindowSeconds);
  if (windowTicks[1] - windowTicks[0] > maxWindow || windowTicks[0] < 0) {
    return no("window outside config bounds");
  }
  env.tally.hazards += 1;
  return ok({
    kind: "scheduleHazard",
    payload: {
      kind: intent.hazard,
      difficulty: config.hazards.difficulty[intent.difficulty],
      windowTicks: [windowTicks[0], windowTicks[1]],
      // §forced-faults-and-hazards: a decided outcome skips the helm's roll.
      ...(intent.outcome === "" ? {} : { outcome: intent.outcome }),
    },
  });
}

/** §scheduling-a-field: a scripted moment as a share of the severity's length. */
export const FIELD_MOMENT_SHARE: Readonly<Record<FieldMoment, number>> = {
  early: 0.15,
  middle: 0.5,
  late: 0.85,
};
/** §scheduling-a-field: scripted impacts at the same moment land this many seconds apart. */
export const FIELD_MOMENT_SPACING_SECONDS = 4;

/**
 * §scheduling-a-field: is someone aboard (crew or passenger) called this? For the "not a target
 * yet" drop.
 */
function personNamed(env: Env, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.values(env.snapshot.state.actors).some((a) => a.name.toLowerCase() === wanted);
}

/**
 * §scheduling-a-field: a scripted impact's target by what the model wrote: a machine id aboard, a
 * room's name, or a machine's name when only one machine aboard has it. A person is refused by name
 * (§strike-lever is how a rock hurts someone), anything else as unknown.
 */
function fieldTarget(env: Env, written: string): Outcome<ImpactTarget> {
  const { snapshot, content } = env;
  const state = snapshot.state;
  const deckId = shipDeckOf(state);
  const name = written.trim();
  const machine = state.machines[name as MachineId];
  if (machine !== undefined && machine.deckId === deckId) {
    return ok({ kind: "machine", machineId: machine.id });
  }
  const wanted = name.toLowerCase();
  const room = Object.values(state.compartments).find(
    (c) =>
      c.deckId === deckId &&
      (c.id === name || compartmentName(content, state, c.id).toLowerCase() === wanted),
  );
  if (room !== undefined) return ok({ kind: "compartment", compartmentId: room.id });
  const named = Object.values(state.machines).filter(
    (m) => m.deckId === deckId && machineName(content, m).toLowerCase() === wanted,
  );
  const [only] = named;
  if (only !== undefined && named.length === 1) {
    return ok({ kind: "machine", machineId: only.id });
  }
  if (named.length > 1) {
    return no(
      `${named.length} machines aboard are called "${name}"; use the machine id (${named.map((m) => m.id).join(", ")})`,
    );
  }
  if (personNamed(env, name)) {
    return no(
      `"${name}" is a person: a scripted hit aims at a machine or a room; to hurt them, strike them too`,
    );
  }
  return no(`no machine or room "${name}" aboard; use an id or room name from What you can do`);
}

type ScriptedIntent = Intent<"scheduleField">["scripted"][number];

/**
 * §scheduling-a-field: the scripted impacts as the kernel takes them, moments turned into seconds.
 */
function scriptedDrafts(
  env: Env,
  scripted: readonly ScriptedIntent[],
  lengthSeconds: number,
): Outcome<ScriptedImpactDraft[]> {
  const drafts: ScriptedImpactDraft[] = [];
  const atMoment: Partial<Record<FieldMoment, number>> = {};
  for (const [index, impact] of scripted.entries()) {
    const target = fieldTarget(env, impact.target);
    if (!target.ok) return no(`scripted[${index}]: ${target.reason}`);
    const earlier = atMoment[impact.at] ?? 0;
    atMoment[impact.at] = earlier + 1;
    const atSeconds = Math.min(
      lengthSeconds - 1,
      Math.round(lengthSeconds * FIELD_MOMENT_SHARE[impact.at]) +
        earlier * FIELD_MOMENT_SPACING_SECONDS,
    );
    drafts.push({
      atSeconds,
      target: target.value,
      ...(impact.rock === "" ? {} : { rock: impact.rock }),
      ...(impact.effect === "" ? {} : { effect: impact.effect }),
    });
  }
  return ok(drafts);
}

/**
 * §scheduling-a-field: `scheduleField`, the seventh lever. No budget: one field per leg is the
 * limit, as the kernel rules it. The window is the fault windows'; scripted hits are resolved by
 * name and capped at `field.maxScripted`; the guard is the kernel's (scripted hits alone, an
 * unsized rock priced large, must leave the hull above zero).
 */
function translateField(env: Env, intent: Intent<"scheduleField">): Outcome<NarratorDraft> {
  const { snapshot } = env;
  const config = snapshot.config;
  const state = snapshot.state;
  if (state.hull.lostAtTick !== undefined) return no("the ship is lost");
  if (state.field !== undefined || env.tally.fields > 0) {
    return no("this leg already has its field (one per leg); place the next on a later leg");
  }
  const leg = legProblem(env, intent.window, "field");
  if (leg !== undefined) return no(leg);
  const max = config.field.maxScripted;
  if (intent.scripted.length > max) {
    return no(`at most ${max} scripted impacts, got ${intent.scripted.length}`);
  }
  const lengthSeconds = config.field.severities[intent.severity].lengthSeconds;
  const scripted = scriptedDrafts(env, intent.scripted, lengthSeconds);
  if (!scripted.ok) return scripted;
  const cost = scriptedHullDamage(config, scripted.value);
  if (cost >= state.hull.integrity) {
    return no(
      `scripted impacts alone would sink the ship (${cost} hull points against ${state.hull.integrity} left); script fewer or smaller rocks`,
    );
  }
  const windowTicks = faultWindowTicks(config, intent.window);
  const maxWindow = configTicks(config, config.narrator.maxFaultWindowSeconds);
  if (windowTicks[1] - windowTicks[0] > maxWindow || windowTicks[0] < 0) {
    return no("window outside config bounds");
  }
  env.tally.fields += 1;
  return ok({
    kind: "scheduleField",
    payload: {
      severity: intent.severity,
      detection: intent.detection,
      windowTicks: [windowTicks[0], windowTicks[1]],
      scripted: scripted.value,
    },
  });
}

/**
 * §strike-lever: the person a strike names, by full name as the digest lists them (crew,
 * passengers, the dock's and the site's people) or by actor id; a name two people share is
 * ambiguous.
 */
function personByName(env: Env, written: string): Outcome<DeepReadonly<Actor>> {
  const state = env.snapshot.state;
  const name = written.trim();
  const byId = state.actors[name as ActorId];
  if (byId !== undefined) return ok(byId);
  const wanted = name.toLowerCase();
  const named = Object.values(state.actors).filter((a) => a.name.toLowerCase() === wanted);
  const [only] = named;
  if (only === undefined) return no(`nobody called "${name}"; use a name the digest lists`);
  if (named.length > 1) return no(`${named.length} people are called "${name}"`);
  return ok(only);
}

/**
 * §strike-lever: why `actor` cannot be struck or strike now, or undefined: the dead, and anyone not
 * on the ship's floor or the site's (a passenger ashore, someone in a port's lounge).
 */
function strikeProblem(env: Env, actor: DeepReadonly<Actor>): string | undefined {
  if (actor.availability === "dead") return `${actor.name} is already dead`;
  const location = actor.location;
  const onFloor = location.kind === "onDeck" || location.kind === "carriedBy";
  if (actor.availability === "offShip" || !onFloor) {
    const where =
      location.kind === "inExternalStore"
        ? ` (ashore at ${portName(env.content, location.portId)})`
        : "";
    return `${actor.name} is not on the ship or the site${where}`;
  }
  return undefined;
}

/**
 * §strike-lever: `strike`, a wound through the body rules. Guards are the impossible only: the
 * person exists, is alive and is on the ship's floor or the site's; so is whoever did it. `how` is
 * the log's line for it off the fight, so it takes the player-facing text checks.
 */
function translateStrike(env: Env, intent: Intent<"strike">): Outcome<NarratorDraft> {
  const target = personByName(env, intent.who);
  if (!target.ok) return no(`who: ${target.reason}`);
  const problem = strikeProblem(env, target.value);
  if (problem !== undefined) return no(`who: ${problem}`);
  let byActorId: ActorId | undefined;
  if (intent.byWho.trim() !== "") {
    const by = personByName(env, intent.byWho);
    if (!by.ok) return no(`byWho: ${by.reason}`);
    const byProblem = strikeProblem(env, by.value);
    if (byProblem !== undefined) return no(`byWho: ${byProblem}`);
    byActorId = by.value.id;
  }
  const how = clipChars(intent.how, STRIKE_HOW_MAX);
  const text = textProblem(how, env.secrets);
  if (text !== undefined) return no(`how: ${text}`);
  return ok({
    kind: "strike",
    payload: {
      actorId: target.value.id,
      severity: intent.severity,
      type: intent.type,
      ...(intent.part === "" ? {} : { part: intent.part }),
      ...(byActorId === undefined ? {} : { byActorId }),
      how,
    },
  });
}

/**
 * §money-levers: `transact`, a sum into or out of the ship's money. Guards are the impossible only:
 * a non-zero whole number of credits, a debit the balance covers (with this call's earlier sums), a
 * credit at most `config.narrator.maxWindfall`. The memo and counterparty are the log's words, so
 * they take the player-facing text checks.
 */
function translateTransact(env: Env, intent: Intent<"transact">): Outcome<NarratorDraft> {
  const { amount } = intent;
  if (!Number.isInteger(amount) || amount === 0) {
    return no("amount must be a non-zero whole number of credits");
  }
  const balance = env.snapshot.state.money.balance + env.tally.money;
  if (amount < 0 && balance + amount < 0) {
    return no(`the ship has ${balance} credits and cannot pay ${-amount}`);
  }
  const max = env.snapshot.config.narrator.maxWindfall;
  if (amount > max) return no(`a credit of ${amount} is over the most one sum may be (${max})`);
  const memo = clipChars(intent.memo, TRANSACT_TEXT_MAX);
  const memoProblem = textProblem(memo, env.secrets);
  if (memoProblem !== undefined) return no(`memo: ${memoProblem}`);
  const counterparty = clipChars(intent.counterparty, TRANSACT_TEXT_MAX);
  if (counterparty !== "") {
    const problem = textProblem(counterparty, env.secrets);
    if (problem !== undefined) return no(`counterparty: ${problem}`);
  }
  env.tally.money += amount;
  return ok({ kind: "transact", payload: { amount, memo, counterparty } });
}

/**
 * §memory-levers: someone a memory or a thought can be about or held by: a living crew member or
 * passenger aboard, by full name or id.
 */
function aboardPerson(env: Env, written: string): Outcome<DeepReadonly<Actor>> {
  const person = personByName(env, written);
  if (!person.ok) return person;
  const actor = person.value;
  if (actor.availability === "dead") return no(`${actor.name} is dead`);
  if (!actor.crew) return no(`${actor.name} is not crew or a passenger; only they remember`);
  if (actor.availability === "offShip") return no(`${actor.name} is not aboard`);
  return ok(actor);
}

/** §memory-levers: two different people aboard, by the roles the intent names them in. */
function aboardPair(
  env: Env,
  a: string,
  b: string,
  roles: readonly [string, string],
): Outcome<readonly [DeepReadonly<Actor>, DeepReadonly<Actor>]> {
  const first = aboardPerson(env, a);
  if (!first.ok) return no(`${roles[0]}: ${first.reason}`);
  const second = aboardPerson(env, b);
  if (!second.ok) return no(`${roles[1]}: ${second.reason}`);
  if (first.value.id === second.value.id) {
    return no(`${roles[0]} and ${roles[1]} are the same person`);
  }
  return ok([first.value, second.value] as const);
}

/**
 * §memory-levers: `plantMemory`, a story-sized memory in what `from` holds about `to`. Guards are
 * the impossible only: two different people, alive and aboard; the key is the schema's.
 */
function translatePlantMemory(env: Env, intent: Intent<"plantMemory">): Outcome<NarratorDraft> {
  const pair = aboardPair(env, intent.from, intent.to, ["from", "to"]);
  if (!pair.ok) return pair;
  const [from, to] = pair.value;
  return ok({
    kind: "plantMemory",
    payload: { fromActorId: from.id, toActorId: to.id, key: intent.key, lasting: intent.lasting },
  });
}

/**
 * §memory-levers: `fallOut`, a falling-out between two people aboard; `over` is the log's words, so
 * it takes the player-facing text checks.
 */
function translateFallOut(env: Env, intent: Intent<"fallOut">): Outcome<NarratorDraft> {
  const pair = aboardPair(env, intent.a, intent.b, ["a", "b"]);
  if (!pair.ok) return pair;
  const [a, b] = pair.value;
  const over = clipChars(intent.over, FALL_OUT_OVER_MAX);
  const text = textProblem(over, env.secrets);
  if (text !== undefined) return no(`over: ${text}`);
  return ok({ kind: "fallOut", payload: { aId: a.id, bId: b.id, over } });
}

/**
 * §thought-and-reveal-levers: `giveThought`, a thought from the content's set. A thought whose
 * label names someone (`{ref}`) needs `ref`; `ref` is anyone the digest names.
 */
function translateGiveThought(env: Env, intent: Intent<"giveThought">): Outcome<NarratorDraft> {
  const who = aboardPerson(env, intent.who);
  if (!who.ok) return no(`who: ${who.reason}`);
  const key = intent.key.trim();
  const def = env.content.thoughts[key as ThoughtKey];
  if (def === undefined) return no(unknownId("thought key", key));
  let refId: ActorId | undefined;
  if (intent.ref.trim() !== "") {
    const ref = personByName(env, intent.ref);
    if (!ref.ok) return no(`ref: ${ref.reason}`);
    refId = ref.value.id;
  } else if (def.label.includes("{ref}")) {
    return no(`${key} is about someone: name them in ref`);
  }
  return ok({
    kind: "giveThought",
    payload: { actorId: who.value.id, key: def.key, ...(refId === undefined ? {} : { refId }) },
  });
}

/** A machine aboard the plan names, and the fault in its catalogue, or why not. */
function catalogueFault(
  env: Pick<Env, "snapshot" | "content">,
  intent: { readonly machine: string; readonly faultKey: string },
): Outcome<{ machineId: MachineId; faultKey: LocalKey }> {
  const machine = env.snapshot.state.machines[intent.machine as MachineId];
  if (machine === undefined || isArmsLocker(env.content, machine)) {
    return no(`machine: ${unknownId("machine", intent.machine)}`);
  }
  const def = env.content.machines[machine.defId];
  if (def === undefined || !def.faults.some((f) => f.key === intent.faultKey)) {
    return no(
      `machine ${intent.machine} has no fault "${intent.faultKey}"; use a faultKey listed under it in What you can do`,
    );
  }
  return ok({ machineId: machine.id, faultKey: intent.faultKey as LocalKey });
}

/**
 * §forced-faults-and-hazards: `injectFault`, a catalogued fault now. Impossible: no such machine or
 * fault, or the machine already has or awaits it. Spends the fault budget (advice).
 */
function translateInjectFault(env: Env, intent: Intent<"injectFault">): Outcome<NarratorDraft> {
  const found = catalogueFault(env, intent);
  if (!found.ok) return found;
  const machine = env.snapshot.state.machines[found.value.machineId];
  if (
    machine?.faults.some((f) => f.faultKey === intent.faultKey) === true ||
    machine?.scheduledFaults.some((f) => f.faultKey === intent.faultKey) === true
  ) {
    return no(`${intent.machine} already has or awaits "${intent.faultKey}"`);
  }
  return ok({ kind: "injectFault", payload: found.value });
}

/**
 * §thought-and-reveal-levers: why `reveal` cannot let the crew notice this fault, or the command: no
 * such machine or fault, the machine does not have it now (a fault injected in this plan is there
 * only once applied: reveal it next call), it is diagnosed, or the crew already noticed it.
 */
function revealOutcome(
  env: Pick<Env, "snapshot" | "content">,
  intent: Intent<"reveal">,
): Outcome<NarratorDraft> {
  const found = catalogueFault(env, intent);
  if (!found.ok) return found;
  const state = env.snapshot.state;
  const machine = state.machines[found.value.machineId];
  const fault = machine?.faults.find((f) => f.faultKey === intent.faultKey);
  if (machine === undefined || fault === undefined) {
    return no(
      `${intent.machine} does not have "${intent.faultKey}" now; a fault scheduled or injected this call can be revealed once it has happened`,
    );
  }
  const discovery = faultDiscovery(state, machine, fault);
  if (discovery === "diagnosed") return no(`"${intent.faultKey}" is already diagnosed`);
  if (discovery === "symptomNoticed") return no(`the crew already noticed "${intent.faultKey}"`);
  return ok({ kind: "reveal", payload: found.value });
}

type Side = Intent<"surfaceDecision">["left"];

type SideCommands = { label: string; commands: CommandDraft[] };

/** Option commands run as `player` when chosen; never offer one the player could not issue. */
function playerSide(label: string, command: CommandDraft, which: string): Outcome<SideCommands> {
  if (!(AUTHORITY.player as readonly string[]).includes(command.kind)) {
    return no(`${which}: ${command.kind} is not a player command`);
  }
  return ok({ label, commands: [command] });
}

function setCourseSide(env: Env, side: Side, label: string, which: string): Outcome<SideCommands> {
  const travel = env.snapshot.state.travel;
  if (travel.stage !== "docked") return no(`${which}: setCourse is only possible while docked`);
  const expedition = env.snapshot.state.expedition;
  if (expedition !== undefined && expedition.phase !== "resolved") {
    return no(
      `${which}: setCourse waits until the expedition is over; the sim sets the course home`,
    );
  }
  if (side.coursePort.trim() === "") return no(`${which}: setCourse needs coursePort`);
  const course = knownPort(env.content, side.coursePort);
  if (!course.ok) return no(`${which}: coursePort: ${course.reason}`);
  if (side.coursePort === travel.portId)
    return no(`${which}: already docked at ${side.coursePort}`);
  // Expeditions A2 (§3.2): a site is on the ship's graph only while an errand names it; a card's
  // course never makes one known, so it never names one.
  if (isSite(env.content, course.value.id)) {
    return no(
      `${which}: coursePort ${side.coursePort} is a landing site; only an errand goes there`,
    );
  }
  // §2.3: any reachable port. Beyond one hop the kernel makes it a voyage; a neighbour while a
  // voyage is already set is a detour the kernel routes on from. Nothing more to do here.
  if (pathBetween(env.content, env.snapshot.state, travel.portId, side.coursePort) === undefined) {
    return no(`${which}: no route from ${travel.portId} to ${side.coursePort}`);
  }
  return playerSide(
    label,
    { kind: "setCourse", payload: { destinationPortId: side.coursePort as PortDefId } },
    which,
  );
}

/**
 * Passengers-and-galaxy §4.2: `endPassage` is only a real side while a passenger is actually
 * aboard or ashore on an unended passage; the kernel ends it `putOff` (or `leftBehind`) with no
 * fare when the captain picks it.
 */
function endPassageSide(env: Env, label: string, which: string): Outcome<SideCommands> {
  const job = livePassage(env.snapshot.state);
  if (job === undefined) {
    return no(`${which}: endPassage needs a passenger aboard or ashore on a live passage`);
  }
  return playerSide(label, { kind: "endPassage", payload: { jobId: job.id } }, which);
}

/**
 * §private-talk: `privateTalk` calls a crew member to the captain's cabin for a word, warm or
 * stern. The name must be crew aboard (not a passenger, not ashore or on the dock), never the
 * captain, and no talk may be pending; the kernel checks the same again (and the cabin) when it is
 * chosen.
 */
function privateTalkSide(
  env: Env,
  side: Side,
  label: string,
  which: string,
): Outcome<SideCommands> {
  const state = env.snapshot.state;
  const wanted = side.talkWith.trim();
  if (wanted === "") return no(`${which}: privateTalk needs talkWith (a crew member's name)`);
  if (side.tone === "") return no(`${which}: privateTalk needs tone warm or stern`);
  const actor = Object.values(state.actors).find(
    (a) => a.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (actor === undefined) {
    return no(`${which}: talkWith "${wanted}" is nobody aboard; use a name listed under Crew`);
  }
  if (!actor.crew || actor.passenger === true) {
    return no(`${which}: ${actor.name} is not crew; only crew are called in for a word`);
  }
  if (actor.roleTags.includes("captain")) {
    return no(`${which}: ${actor.name} is the captain, who does the calling in`);
  }
  if (
    actor.availability !== "available" ||
    actor.location.kind !== "onDeck" ||
    isOnDock(env.content, state, actor.location)
  ) {
    return no(`${which}: ${actor.name} is not aboard to be called in`);
  }
  if (state.social.privateTalk !== undefined) {
    return no(`${which}: a private word is already pending; wait for it to be held or missed`);
  }
  return playerSide(
    label,
    { kind: "privateTalk", payload: { actorId: actor.id, tone: side.tone } },
    which,
  );
}

function translateSide(env: Env, side: Side, which: string): Outcome<SideCommands> {
  const label = clipChars(side.label, LABEL_MAX_CHARS);
  const problem = textProblem(label, env.secrets);
  if (problem !== undefined) return no(`${which} label: ${problem}`);
  switch (side.effect) {
    case "none":
      return ok({ label, commands: [] });
    case "setCourse":
      return setCourseSide(env, side, label, which);
    case "endPassage":
      return endPassageSide(env, label, which);
    case "privateTalk":
      return privateTalkSide(env, side, label, which);
  }
}

/**
 * §aftermath-caption: an aftermath caption, clipped to `AFTERMATH_MAX_WORDS`. Blank means "none"
 * (the card closes without one) rather than a reason to drop the whole card; numbers or secrets do
 * drop it.
 */
function aftermathText(env: Env, text: string, which: string): Outcome<string> {
  if (text.trim() === "") return ok("");
  const clipped = clipWords(text, AFTERMATH_MAX_WORDS);
  const problem = textProblem(clipped, env.secrets);
  return problem === undefined ? ok(clipped) : no(`${which}: ${problem}`);
}

/**
 * §spoken-cards: the speaker's name, clipped; blank means an observed scene (no speaker). Numbers
 * or secrets in the name are a problem like in any other player-facing text.
 */
function speakerName(env: Env, raw: string): Outcome<string | undefined> {
  if (raw.trim() === "") return ok(undefined);
  const name = clipChars(raw, ISSUER_MAX_CHARS);
  const problem = textProblem(name, env.secrets);
  if (problem !== undefined) return no(`speaker: ${problem}`);
  // §captain-never-speaks: the captain is the player; cards are brought to them. The card survives
  // as an observed scene and the model is told why next call.
  if (env.captainName !== undefined && name.toLowerCase() === env.captainName.toLowerCase()) {
    env.notes.push(
      `speaker: "${name}" is the captain and cannot bring a card; name the crew member who does`,
    );
    return ok(undefined);
  }
  return ok(name);
}

/**
 * §beat-cards: a beat card must name a thread that has not had its beat card yet, and both sides
 * must be effect none: the card records the captain's attitude, it does not set a course.
 * §notes-turn: the notes are written after the plan, so a title that matches no stored thread
 * starts a new one; the notes turn is told to write it.
 */
function beatThread(env: Env, intent: Intent<"surfaceDecision">): Outcome<string | undefined> {
  const raw = intent.beatOfThread;
  if (raw.trim() === "") return ok(undefined);
  const wanted = raw.trim().toLowerCase();
  const thread = env.threads.find((t) => t.title.trim().toLowerCase() === wanted);
  if (intent.left.effect !== "none" || intent.right.effect !== "none") {
    return no("a beat card's sides are the captain's attitude; both must be effect none");
  }
  if (thread === undefined) return ok(raw.trim());
  if (thread.beatCardShown) {
    return no(
      `thread "${thread.title}" already had its beat card; its next card must pay it off (nextBeat)`,
    );
  }
  return ok(thread.title);
}

/**
 * §closing-cards: what a card's closesThread named: nothing, a stored thread, or a title matching
 * none.
 */
type ClosingThread =
  | { readonly kind: "none" }
  | { readonly kind: "closes"; readonly title: string }
  | { readonly kind: "unmatched"; readonly written: string };

/**
 * §closing-cards: a closing card names a stored thread (one the digest showed); the server retires
 * it once the card goes up. A second closing card for a thread a card already closed is dropped. A
 * title that matches neither (the model named the offer or the issuer, or the thread was lost in
 * a notes rewrite) no longer costs the captain the ending: the card goes up closing nothing, and
 * the model is told so next call. A card cannot both foreshadow and close.
 */
function closingThread(env: Env, intent: Intent<"surfaceDecision">): Outcome<ClosingThread> {
  const raw = intent.closesThread.trim();
  if (raw === "") return ok({ kind: "none" });
  if (intent.beatOfThread.trim() !== "") {
    return no("a card cannot both foreshadow a thread (beatOfThread) and close one (closesThread)");
  }
  const wanted = raw.toLowerCase();
  const thread = env.threads.find((t) => t.stored && t.title.trim().toLowerCase() === wanted);
  if (thread !== undefined) return ok({ kind: "closes", title: thread.title });
  if (env.closedThreads.includes(wanted)) {
    return no(`closesThread "${raw}" was already closed by an earlier card; a thread closes once`);
  }
  return ok({ kind: "unmatched", written: raw });
}

/**
 * §closing-cards: the closed thread's title as the card shows it. Thread titles are private notes,
 * so one that would give something away shows as a bare "story closed" (an empty label).
 */
function closedLabel(env: Env, title: string): string {
  return textProblem(title, env.secrets) === undefined ? title : "";
}

function translateDecision(env: Env, intent: Intent<"surfaceDecision">): Outcome<NarratorDraft> {
  if (env.hook?.kind === "policyDecision") {
    return no("a policy decision is pending; dress it with `card` instead");
  }
  if (env.tally.cardUsed) return no("only one card per call");
  const beat = beatThread(env, intent);
  if (!beat.ok) return beat;
  const closing = closingThread(env, intent);
  if (!closing.ok) return closing;
  const title = clipChars(intent.title, TITLE_MAX_CHARS);
  const situation = clipWords(intent.situation, CARD_SITUATION_MAX_WORDS);
  const problem = textProblem(title, env.secrets) ?? textProblem(situation, env.secrets);
  if (problem !== undefined) return no(problem);
  const speaker = speakerName(env, intent.speaker);
  if (!speaker.ok) return speaker;
  const left = translateSide(env, intent.left, "left");
  if (!left.ok) return left;
  const right = translateSide(env, intent.right, "right");
  if (!right.ok) return right;
  const leftAftermath = aftermathText(env, intent.leftAftermath, "leftAftermath");
  if (!leftAftermath.ok) return leftAftermath;
  const rightAftermath = aftermathText(env, intent.rightAftermath, "rightAftermath");
  if (!rightAftermath.ok) return rightAftermath;
  if (left.value.label.toLowerCase() === right.value.label.toLowerCase()) {
    return no("both sides have the same label");
  }
  env.tally.cardUsed = true;
  env.tally.beatCardThread = beat.value;
  const closed = closing.value.kind === "closes" ? closing.value.title : undefined;
  env.tally.closedThread = closed;
  if (closing.value.kind === "unmatched") {
    env.notes.push(
      `closesThread: "${closing.value.written}" matches no title under "Open threads", so the card went up closing nothing; copy the title exactly`,
    );
  }
  const sideSpec = (s: SideCommands, aftermath: string) => ({
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
        // W9 decision: `DecisionCardSpec` has no title field; it and the §spoken-cards speaker
        // travel in the prompt params, where `templateCard` picks them up.
        prompt: {
          key: NARRATOR_TEXT_KEYS.situation,
          params: {
            title,
            ...(speaker.value === undefined ? {} : { speaker: speaker.value }),
            ...(closed === undefined ? {} : { closesThread: closedLabel(env, closed) }),
          },
          prose: situation,
        },
        left: sideSpec(left.value, leftAftermath.value),
        right: sideSpec(right.value, rightAftermath.value),
      },
    },
  });
}

/**
 * §market-lever: `stockMarket`. Any existing item def (not only freight: spare parts are the
 * point); count clamped to `config.commerce.market.maxStockPerCommand`; the price is the content
 * price for that item at that port (or the dearest anywhere, or the config default) times the tier.
 */
function translateStock(env: Env, intent: Intent<"stockMarket">): Outcome<NarratorDraft> {
  const { snapshot, content } = env;
  const config = snapshot.config;
  const known = knownPort(content, intent.port);
  if (!known.ok) return no(`port: ${known.reason}`);
  const item = content.items[intent.cargoItem as ItemDefId];
  if (item === undefined) return no(`cargoItem: ${unknownId("item", intent.cargoItem)}`);
  const max = config.commerce.market.maxStockPerCommand;
  const count = Math.max(0, Math.min(max, Number.parseInt(intent.count, 10)));
  const base = basePriceFor(content, config, known.value.id, item.id);
  const price = Math.max(1, Math.round(base * config.commerce.market.priceTiers[intent.priceTier]));
  return ok({
    kind: "stockMarket",
    payload: { portId: known.value.id, itemDefId: item.id, count, price },
  });
}

/** Every reason a translation gives is prefixed with the intent's kind. */
function translateOne(env: Env, intent: NarratorIntent): Outcome<NarratorDraft> {
  const outcome = translateByKind(env, intent);
  return outcome.ok ? outcome : no(`${intent.kind}: ${outcome.reason}`);
}

function translateByKind(env: Env, intent: NarratorIntent): Outcome<NarratorDraft> {
  switch (intent.kind) {
    case "offerJob":
      return translateOfferJob(env, intent);
    case "spawnAtBoundary":
      return translateSpawn(env, intent);
    case "scheduleFault":
      return translateFault(env, intent);
    case "surfaceDecision":
      return translateDecision(env, intent);
    case "stockMarket":
      return translateStock(env, intent);
    case "scheduleHazard":
      return translateHazard(env, intent);
    case "scheduleField":
      return translateField(env, intent);
    case "strike":
      return translateStrike(env, intent);
    case "transact":
      return translateTransact(env, intent);
    case "plantMemory":
      return translatePlantMemory(env, intent);
    case "fallOut":
      return translateFallOut(env, intent);
    case "giveThought":
      return translateGiveThought(env, intent);
    case "reveal":
      return revealOutcome(env, intent);
    case "injectFault":
      return translateInjectFault(env, intent);
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

/** §unseen-odds: the side marked unseen this call and the chance it was given. */
interface StatedOdds {
  readonly side: "left" | "right";
  readonly odds: number;
}

function policyCard(
  env: Env,
  plan: NarratorPlan,
  dropped: DroppedIntent[],
  stated: StatedOdds | undefined,
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
    // §aftermath-caption: a blank aftermath falls back to the decision's template one, if it has
    // one.
    ...(leftAftermath === ""
      ? pick(fallback, "leftAftermath")
      : { leftAftermath: clipWords(leftAftermath, AFTERMATH_MAX_WORDS) }),
    ...(rightAftermath === ""
      ? pick(fallback, "rightAftermath")
      : { rightAftermath: clipWords(rightAftermath, AFTERMATH_MAX_WORDS) }),
  };
  // §unseen-odds: the situation and the marked side's label may say the chance the narrator set.
  const mayState = (text: string) =>
    stated === undefined
      ? textProblem(text, env.secrets)
      : textProblemStating(text, env.secrets, stated.odds);
  const markedLabel = (side: "left" | "right", text: string) =>
    stated?.side === side ? mayState(text) : textProblem(text, env.secrets);
  const problem = [
    textProblem(card.title, env.secrets),
    mayState(card.situation),
    markedLabel("left", card.leftLabel),
    markedLabel("right", card.rightLabel),
    ...(card.leftAftermath === undefined ? [] : [textProblem(card.leftAftermath, env.secrets)]),
    ...(card.rightAftermath === undefined ? [] : [textProblem(card.rightAftermath, env.secrets)]),
  ].find((p) => p !== undefined);
  if (problem !== undefined) {
    dropped.push({ intentIndex: -1, kind: "card", reason: `card: ${problem}` });
    return fallback;
  }
  return card;
}

/**
 * D105: the card's `unseen` side as `markUnseen` with that side's plan, checked by the kernel's own
 * rules (`markUnseen` in `systems/expedition/command.ts`) so the kernel never refuses what passes
 * here. `ok(undefined)` when nothing is marked; a side on anything but the pending arrival card of
 * the expedition under way, before its plan, is dropped, as is one whose plan holds the ramp. The
 * card's prose is `policyCard`'s and does not depend on this.
 */
function unseenCommand(env: Env, plan: NarratorPlan): Outcome<UnseenDraft | undefined> {
  const side = plan.card?.unseen ?? "";
  const written = (plan.card?.unseenOdds ?? "").trim();
  if (side === "") {
    return written === ""
      ? ok(undefined)
      : no(`card.unseenOdds "${written}": no side is marked unseen (card.unseen is empty)`);
  }
  const notHere = (why: string) => no(`card.unseen "${side}": ${why}`);
  if (written !== "" && !UNSEEN_ODDS_PATTERN.test(written)) {
    return notHere(`unseenOdds "${written}" is not a whole percent from 0 to 100`);
  }
  const odds = written === "" ? UNSEEN_ODDS_CERTAIN : Number(written);
  const hook = env.hook;
  if (hook?.kind !== "policyDecision") {
    return notHere("only the arrival card at a site has a way in unseen");
  }
  const decisionId = hook.context.decisionId as DecisionId;
  const decision = env.snapshot.state.decisions.records[decisionId];
  if (decision?.prompt.key !== EXPEDITION_ARRIVAL_KEY) {
    return notHere("only the arrival card at a site has a way in unseen");
  }
  if (decision.status !== "pending") return notHere("the arrival card is no longer pending");
  const expedition = env.snapshot.state.expedition;
  if (expedition === undefined || expedition.phase === "resolved") {
    return notHere("no expedition is under way");
  }
  if (expedition.cards?.arrival !== decisionId) {
    return notHere("this is not the expedition's arrival card");
  }
  if (expedition.plan !== undefined) return notHere("the captain has already chosen the plan");
  if (expedition.unseenPlanId !== undefined) return notHere("a side is already marked unseen");
  const planId = decision.prompt.params[`${side}Plan`];
  if (typeof planId !== "string" || planId === "") {
    return notHere(`the card names no plan for its ${side} side`);
  }
  const menu = planMenu(env.snapshot.state, env.content, env.snapshot.config, expedition.siteId);
  const option = menu.find((o) => o.id === planId);
  if (option === undefined) return notHere(`"${planId}" is not on the plan menu`);
  if (option.plan.posture === "hold") {
    return notHere("that side holds the ramp; holding the ramp never goes unseen");
  }
  return ok({ side, draft: { kind: "markUnseen", payload: { decisionId, planId, odds } } });
}

/** A mark that passed: the side it is on, for the card's text checks, and its command. */
interface UnseenDraft {
  readonly side: "left" | "right";
  readonly draft: Extract<NarratorDraft, { kind: "markUnseen" }>;
}

// ---------------------------------------------------------------------------------------------

/**
 * A story kind: the narrator vocabulary minus the staging call's (§staging-hook-and-the-hold),
 * which this never emits.
 */
function isNarratorKind(kind: string): kind is NarratorCommand["kind"] {
  return (
    (NARRATOR_COMMAND_KINDS as readonly string[]).includes(kind) &&
    !(STAGING_COMMAND_KINDS as readonly string[]).includes(kind)
  );
}

export function commandIdFor(callId: string, n: number): CommandId {
  return `cmd:narrator:${callId}:${n}` as CommandId;
}

// ---------------------------------------------------------------------------------------------
// Call-back request (§requested-call-back)
// ---------------------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to strip them.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * §requested-call-back: the plan's `callBack` as a `requestCall` command, after the intents. Absent
 * (a plan built in code) asks for nothing and leaves the standing request. `why` is private, so it
 * has no player-facing text rules; it is only made fit for the kernel's (control characters out,
 * clipped to `CALL_BACK_WHY_MAX`).
 */
function translateCallBack(
  ctx: TranslationCtx,
  raw: NarratorPlan["callBack"],
  index: number,
  dropped: DroppedIntent[],
): NarratorCommand | undefined {
  if (raw === undefined) return undefined;
  const parsed = buildNarratorPlanSchema().shape.callBack.safeParse(raw);
  if (!parsed.success) {
    dropped.push({
      intentIndex: -1,
      kind: "callBack",
      reason: invalidIntentReason("callBack", parsed.error.issues),
    });
    return undefined;
  }
  const why = clipChars(parsed.data.why.replace(CONTROL_CHARACTERS, " "), CALL_BACK_WHY_MAX);
  return {
    id: commandIdFor(ctx.callId, index),
    source: "narrator",
    targetTick: ctx.hookTick + 1,
    kind: "requestCall",
    payload: { when: parsed.data.when, why },
  };
}

/**
 * §thought-and-reveal-levers: what this plan's `reveal`s and `injectFault`s will do to what the
 * crew know, for this call's text checks: a fault the plan reveals may be on its card (what you
 * decide, you show), one it injects may not.
 */
function plannedFaults(
  snapshot: Snapshot,
  content: ContentBundle,
  rawIntents: readonly unknown[],
  intentSchema: ReturnType<typeof buildNarratorPlanSchema>["shape"]["intents"]["element"],
): PlannedFaults {
  const revealed = new Set<string>();
  const injected: string[] = [];
  for (const raw of rawIntents) {
    const parsed = intentSchema.safeParse(withBeat(raw));
    if (!parsed.success) continue;
    const intent = parsed.data;
    if (intent.kind === "reveal" && revealOutcome({ snapshot, content }, intent).ok) {
      revealed.add(faultRef(intent.machine, intent.faultKey));
    }
    if (intent.kind === "injectFault") injected.push(faultRef(intent.machine, intent.faultKey));
  }
  return { revealed, injected };
}

/**
 * §beat-attribution: the model always writes `beat` (the schema requires it); a plan built in code
 * (the null narrator, a scenario, a test) may leave it out, and then the intent serves no beat, as
 * a plan without `callBack` asks for no call.
 */
function withBeat(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || "beat" in raw) return raw;
  return { ...raw, beat: "" };
}

/**
 * Translate a plan. The plan is treated as untrusted even though it passed the schema: each
 * intent is re-parsed against the intent schema, so a hand-built or partially valid plan cannot
 * smuggle through an unknown kind or an extra field; every id is then checked against the
 * snapshot and content (§narrator-authority).
 */
export const translateIntents: TranslateIntents = (
  plan: NarratorPlan,
  ctx: TranslationCtx,
): TranslationResult => {
  const snapshot = ctx.snapshot;
  const hook = ctx.hook ?? snapshot.state.narrator.pendingHook;
  const intentSchema = buildNarratorPlanSchema().shape.intents.element;
  const rawIntents: readonly unknown[] = Array.isArray(plan.intents) ? plan.intents : [];
  const env: Env = {
    snapshot,
    content: ctx.content,
    hook,
    secrets: secretPhrases(
      snapshot,
      ctx.content,
      plannedFaults(snapshot, ctx.content, rawIntents, intentSchema),
    ),
    threads: (ctx.threads ?? []).map((t) => ({ ...t, stored: true })),
    closedThreads: (ctx.closedThreads ?? []).map((t) => t.trim().toLowerCase()),
    captainName: captainName(snapshot, ctx.content),
    tally: {
      hazards: 0,
      money: 0,
      fields: 0,
      // §offer-lever: a card on its way to the captain in person is as good as on screen.
      cardUsed:
        snapshot.state.decisions.queue.length > 0 || snapshot.state.decisions.held.length > 0,
      beatCardThread: undefined,
      closedThread: undefined,
    },
    notes: [],
  };
  const commands: NarratorCommand[] = [];
  const dropped: DroppedIntent[] = [];
  const beats: BeatAttribution[] = [];

  rawIntents.forEach((raw, intentIndex) => {
    const kind = kindOf(raw);
    if (!isNarratorKind(kind)) {
      dropped.push({ intentIndex, kind, reason: `"${kind}" is not something you can do` });
      return;
    }
    const parsed = intentSchema.safeParse(withBeat(raw));
    if (!parsed.success) {
      dropped.push({ intentIndex, kind, reason: invalidIntentReason(kind, parsed.error.issues) });
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
    const id = commandIdFor(ctx.callId, commands.length);
    commands.push({
      id,
      source: "narrator",
      // The hook tick is already committed; the earliest a command can apply is the next one.
      targetTick: ctx.hookTick + 1,
      ...draft,
    } as NarratorCommand);
    // §beat-attribution: the name is checked against the plan by the notes merge, which knows the
    // episode the notes turn writes; a name that matches nothing is a correction, never a drop.
    const beat = parsed.data.beat.trim();
    if (beat !== "") {
      const lands = LANDS_WHEN_MADE.has(parsed.data.kind) ? "now" : "onFire";
      beats.push({ beat, kind: parsed.data.kind, commandId: id, lands });
    }
  });

  const unseen = unseenCommand(env, plan);
  if (!unseen.ok) {
    dropped.push({ intentIndex: -1, kind: "card", reason: unseen.reason });
  } else if (unseen.value !== undefined) {
    commands.push({
      id: commandIdFor(ctx.callId, commands.length),
      source: "narrator",
      targetTick: ctx.hookTick + 1,
      ...unseen.value.draft,
    } as NarratorCommand);
  }
  const stated =
    unseen.ok && unseen.value !== undefined
      ? { side: unseen.value.side, odds: unseen.value.draft.payload.odds }
      : undefined;

  const callBack = translateCallBack(ctx, plan.callBack, commands.length, dropped);
  if (callBack !== undefined) commands.push(callBack);

  const card = policyCard(env, plan, dropped, stated);
  const beat = env.tally.beatCardThread;
  const closed = env.tally.closedThread;
  return {
    commands,
    dropped,
    notes: env.notes,
    beats,
    ...(card === undefined ? {} : { card }),
    ...(beat === undefined ? {} : { beatCardThread: beat }),
    ...(closed === undefined ? {} : { closedThread: closed }),
  };
};
