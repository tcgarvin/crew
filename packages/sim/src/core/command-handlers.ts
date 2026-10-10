/**
 * Handlers for the kernel-owned command kinds: scenario setup (`scenarioSpawn`,
 * `scenarioInjectFault`, `scenarioSetNeeds`), `acknowledgeHook`, `requestCall`
 * (§requested-call-back), `surfaceDecision` and `resolveDecision`. Other kinds belong to their
 * systems and register through the same `registerCommandHandler` path.
 */
import { commandActor, isFitForCommand } from "./command-actor";
import {
  type AppliedCommand,
  type CommandHandler,
  NO_TEMP_REFS,
  type ValidateCtx,
  type Validation,
  causedBy,
  ok,
  pushCapped,
  reject,
  validateCommand,
} from "./commands";
import { findCrewDef, findItemDef } from "./defs";
import { cardSpeaker, queueOrHold } from "./delivery";
import { allocateId } from "./ids";
import { type Character, generateInterests, interestsFromSeed } from "./interests";
import type { KernelRegistry } from "./registry";
import type { Actor, Needs, WatchSection } from "./types/actor";
import type {
  Command,
  CommandDraft,
  CommandKind,
  CommandOfKind,
  DecisionCardSide,
  ScenarioSpawn,
} from "./types/commands";
import { AUTHORITY } from "./types/commands/authority";
import type { PhysicalLocation } from "./types/common";
import type { CrewDef } from "./types/content";
import {
  CALL_BACK_WHEN,
  CALL_BACK_WHY_MAX,
  type CallBackRequest,
  type Decision,
  type DecisionOption,
} from "./types/decisions";
import type { ActorId, CommandId, DecisionId, EntityId, TempRef } from "./types/ids";
import type { Item } from "./types/ship";

/** W2 decision: how many resolved hook IDs `narrator.recentHookIds` keeps. */
const RECENT_HOOK_IDS_CAP = 16;

const TEMP_REF_PATTERN = /^\$[A-Za-z0-9_]+$/;

type SpawnedKind = "actor" | "item";

function isTempRef(value: string): value is TempRef {
  return value.startsWith("$");
}

// ---------------------------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------------------------

/**
 * Check a spawn location. W2 decision: `carriedBy`/`equippedBy` actor IDs and `inContainer`
 * container IDs may name a temp ref spawned earlier in the same command (cast into the ID
 * field), so a crew member and their starting kit spawn in one atomic command.
 */
function checkLocation(
  ctx: ValidateCtx,
  location: PhysicalLocation,
  refs: ReadonlyMap<TempRef, SpawnedKind>,
): string | null {
  const { state, content } = ctx;
  const holderExists = (id: string, kind: SpawnedKind): boolean =>
    isTempRef(id)
      ? refs.get(id) === kind
      : kind === "actor"
        ? id in state.actors
        : id in state.items;
  switch (location.kind) {
    case "onDeck": {
      const deck = content.decks[location.deckId];
      if (deck === undefined) return `unknown deck "${location.deckId}"`;
      const { x, y } = location;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return "non-finite deck position";
      if (x < 0 || y < 0 || x >= deck.width || y >= deck.height) {
        return `position (${x}, ${y}) is outside deck "${deck.id}"`;
      }
      const symbol = deck.tiles[Math.floor(y)]?.[Math.floor(x)];
      if (symbol === undefined || symbol === " ") return `position (${x}, ${y}) is not floor`;
      return null;
    }
    case "carriedBy":
    case "equippedBy":
      return holderExists(location.actorId, "actor") ? null : `unknown actor "${location.actorId}"`;
    case "inContainer":
      return holderExists(location.containerId, "item")
        ? null
        : `unknown container "${location.containerId}"`;
    case "installedIn": {
      const machine = state.machines[location.machineId];
      if (machine === undefined) return `unknown machine "${location.machineId}"`;
      const def = content.machines[machine.defId];
      if (def === undefined || !def.components.some((c) => c.slot === location.componentSlot)) {
        return `machine "${location.machineId}" has no component slot "${location.componentSlot}"`;
      }
      return null;
    }
    case "inExternalStore": {
      const port = content.ports[location.portId];
      if (port === undefined) return `unknown port "${location.portId}"`;
      if (!port.externalStores.some((store) => store.key === location.storeKey)) {
        return `port "${location.portId}" has no store "${location.storeKey}"`;
      }
      return null;
    }
  }
}

function resolveLocation(
  location: PhysicalLocation,
  resolved: Readonly<Record<TempRef, EntityId>>,
): PhysicalLocation {
  const resolve = <T extends string>(id: T): T =>
    isTempRef(id) ? (resolved[id] as unknown as T) : id;
  switch (location.kind) {
    case "carriedBy":
    case "equippedBy":
      return { ...location, actorId: resolve(location.actorId) };
    case "inContainer":
      return { ...location, containerId: resolve(location.containerId) };
    default:
      return location;
  }
}

// ---------------------------------------------------------------------------------------------
// scenarioSpawn
// ---------------------------------------------------------------------------------------------

function validateSpawn(
  ctx: ValidateCtx,
  spawn: ScenarioSpawn,
  refs: ReadonlyMap<TempRef, SpawnedKind>,
): string | null {
  if (!TEMP_REF_PATTERN.test(spawn.tempRef)) return `bad temp ref "${spawn.tempRef}"`;
  if (refs.has(spawn.tempRef)) return `duplicate temp ref "${spawn.tempRef}"`;
  if (spawn.kind === "actor") {
    if (findCrewDef(ctx.content, ctx.state, spawn.crewDefId) === undefined) {
      return `unknown crew def "${spawn.crewDefId}"`;
    }
    const section = spawn.section;
    if (section !== undefined) {
      const watches = ctx.config.time.watchesPerDay;
      if (section.key.length === 0) return "section key must not be empty";
      if (!Number.isInteger(section.index) || section.index < 0 || section.index >= watches) {
        return `section "${section.key}" index ${section.index} is outside the ${watches} watches of the day`;
      }
    }
  } else {
    const def = findItemDef(ctx.content, ctx.state, spawn.itemDefId);
    if (def === undefined) return `unknown item def "${spawn.itemDefId}"`;
    if (!Number.isInteger(spawn.count) || spawn.count < 1) return "count must be an integer >= 1";
    if (def.stacking === "unique" && spawn.count !== 1) {
      return `unique item "${def.id}" must spawn with count 1`;
    }
    if (spawn.count > def.maxStack) return `count ${spawn.count} exceeds maxStack ${def.maxStack}`;
  }
  return checkLocation(ctx, spawn.location, refs);
}

/**
 * W2 decision: an actor spawned by a scenario is crew unless it spawns in a port external store
 * (a waiting NPC passenger). Absent `CrewDef.traits` spawn as no traits: procedural sampling needs
 * a trait-count knob that `ConfigDef` does not have yet. Exported for `spawnAtBoundary` (commerce),
 * the other command kind that can spawn an actor at a boundary.
 *
 * §sections-and-dayworkers: `section` is their watch section from the scenario's bill; without one
 * they are a dayworker (as is anyone spawned after world creation).
 *
 * Slice 4: `character` is their interests and values; absent, the def's, else a keyed hash of
 * the id (`interestsFromSeed`). The spawn handler passes one drawn on the `setup` stream for a def
 * without them (`characterFor`).
 */
export function newActor(
  id: ActorId,
  def: CrewDef,
  location: PhysicalLocation,
  section?: WatchSection,
  character: Character = defCharacter(def, () => interestsFromSeed(id)),
): Actor {
  return {
    id,
    defId: def.id,
    name: def.name,
    roleTags: [...def.roleTags],
    location,
    movement: { kind: "stationary" },
    facing: 0,
    needs: { hunger: 0, fatigue: 0, comfort: 0, social: 0, recreation: 0 },
    capacities: { movement: 1, manipulation: 1, consciousness: 1 },
    skills: { ...def.skills },
    traits: [...(def.traits ?? [])],
    mood: 0,
    thoughts: [],
    interests: {
      likes: [...character.interests.likes],
      ...(character.interests.strong === undefined ? {} : { strong: character.interests.strong }),
      dislikes: [...character.interests.dislikes],
    },
    values: { ...character.values },
    boots: 0,
    schedule: section === undefined ? {} : { section: { ...section } },
    activity: { kind: "idle" },
    lastPlannedTick: 0,
    knowledge: {},
    navigationKnowledgeRevision: 0,
    availability: "available",
    crew: location.kind !== "inExternalStore",
  };
}

/**
 * Slice 4: the def's interests and values where it has them; what `generate` returns for the
 * rest (called only when the def lacks one of them).
 */
function defCharacter(def: CrewDef, generate: () => Character): Character {
  if (def.interests !== undefined && def.values !== undefined) {
    return { interests: def.interests, values: def.values };
  }
  const generated = generate();
  return {
    interests: def.interests ?? generated.interests,
    values: def.values ?? generated.values,
  };
}

const scenarioSpawn: CommandHandler<"scenarioSpawn", null> = {
  validate(ctx, command) {
    const spawns = command.payload.spawns;
    if (!Array.isArray(spawns) || spawns.length === 0) {
      return reject("invalidPayload", "scenarioSpawn needs at least one spawn");
    }
    const refs = new Map<TempRef, SpawnedKind>();
    for (const spawn of spawns) {
      const problem = validateSpawn(ctx, spawn, refs);
      if (problem !== null) {
        return reject(
          problem.startsWith("unknown") ? "unknownEntity" : "invalidPayload",
          `scenarioSpawn ${spawn.tempRef}: ${problem}`,
        );
      }
      refs.set(spawn.tempRef, spawn.kind);
    }
    return ok(null);
  },
  apply(ctx, command) {
    const { state } = ctx;
    const resolved: Record<TempRef, EntityId> = {};
    for (const spawn of command.payload.spawns) {
      const location = resolveLocation(spawn.location, resolved);
      let entityId: EntityId;
      let defId: string;
      if (spawn.kind === "actor") {
        const id = allocateId(state, "actor");
        const def = ctx.defs.crew(spawn.crewDefId);
        // Slice 4 (call 8): an unauthored person's interests are drawn on the `setup` stream.
        const authored = def.interests !== undefined && def.values !== undefined;
        const character = defCharacter(def, () => generateInterests(ctx.rng, "setup", id));
        state.actors[id] = newActor(id, def, location, spawn.section, character);
        if (!authored) {
          ctx.emit({
            ...causedBy(command),
            type: "interestsAssigned",
            subjectIds: [id],
            payload: { actorId: id },
          });
        }
        entityId = id;
        defId = spawn.crewDefId;
      } else {
        const id = allocateId(state, "item");
        const def = ctx.defs.item(spawn.itemDefId);
        const item: Item =
          def.stacking === "unique"
            ? { id, defId: def.id, stacking: "unique", location, condition: 1 }
            : { id, defId: def.id, stacking: "stack", location, count: spawn.count, reserved: 0 };
        state.items[id] = item;
        ctx.caches.dirty.inventory = true;
        entityId = id;
        defId = spawn.itemDefId;
      }
      resolved[spawn.tempRef] = entityId;
      ctx.emit({
        ...causedBy(command),
        type: "entitySpawned",
        subjectIds: [entityId],
        payload: { entityId, defId },
      });
    }
    return { tempRefs: resolved };
  },
};

// ---------------------------------------------------------------------------------------------
// scenarioInjectFault
// ---------------------------------------------------------------------------------------------

const scenarioInjectFault: CommandHandler<"scenarioInjectFault", null> = {
  validate(ctx, command) {
    const { machineId, faultKey } = command.payload;
    const machine = ctx.state.machines[machineId];
    if (machine === undefined) return reject("unknownEntity", `unknown machine "${machineId}"`);
    const def = ctx.content.machines[machine.defId];
    if (def === undefined || !def.faults.some((f) => f.key === faultKey)) {
      return reject("invalidPayload", `machine "${machineId}" has no fault "${faultKey}"`);
    }
    if (machine.faults.some((f) => f.faultKey === faultKey)) {
      return reject("preconditionFailed", `machine "${machineId}" already has "${faultKey}"`);
    }
    return ok(null);
  },
  apply(ctx, command) {
    const { machineId, faultKey } = command.payload;
    const machine = ctx.state.machines[machineId];
    if (machine === undefined) throw new Error(`validated machine ${machineId} vanished`);
    machine.faults.push({
      faultKey,
      sinceTick: ctx.tick,
      diagnosed: false,
      repairStepIndex: 0,
      repairStepProgress: 0,
      causeCommandId: command.id,
    });
    ctx.caches.dirty.power = true;
    ctx.emit({
      ...causedBy(command),
      type: "faultOccurred",
      subjectIds: [machineId],
      locationRef: { kind: "machine", machineId },
      payload: { machineId, faultKey },
    });
    return NO_TEMP_REFS;
  },
};

// ---------------------------------------------------------------------------------------------
// scenarioSetNeeds
// ---------------------------------------------------------------------------------------------

const NEED_KEYS: readonly (keyof Needs)[] = ["hunger", "fatigue", "comfort", "social"];

const scenarioSetNeeds: CommandHandler<"scenarioSetNeeds", null> = {
  validate(ctx, command) {
    const { actorId, needs } = command.payload;
    if (!(actorId in ctx.state.actors))
      return reject("unknownEntity", `unknown actor "${actorId}"`);
    for (const [key, value] of Object.entries(needs)) {
      if (!(NEED_KEYS as readonly string[]).includes(key)) {
        return reject("invalidPayload", `unknown need "${key}"`);
      }
      if (typeof value !== "number" || !(value >= 0 && value <= 1)) {
        return reject("outOfBounds", `need "${key}" must be in [0, 1], got ${String(value)}`);
      }
    }
    return ok(null);
  },
  apply(ctx, command) {
    const actor = ctx.state.actors[command.payload.actorId];
    if (actor === undefined) throw new Error("validated actor vanished");
    for (const key of NEED_KEYS) {
      const value = command.payload.needs[key];
      if (value !== undefined) actor.needs[key] = value;
    }
    return NO_TEMP_REFS;
  },
};

// ---------------------------------------------------------------------------------------------
// acknowledgeHook
// ---------------------------------------------------------------------------------------------

const acknowledgeHook: CommandHandler<"acknowledgeHook", null> = {
  validate(ctx, command) {
    const pending = ctx.state.narrator.pendingHook;
    if (pending === undefined) return reject("preconditionFailed", "no narrator hook is pending");
    if (pending.id !== command.payload.hookId) {
      return reject(
        "unknownEntity",
        `hook "${command.payload.hookId}" is not the pending hook ("${pending.id}")`,
      );
    }
    return ok(null);
  },
  apply(ctx, command) {
    const narrator = ctx.state.narrator;
    const hookId = command.payload.hookId;
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined` (CONTRACTS rule 2).
    delete narrator.pendingHook;
    // §requested-call-back: the call-back request this hook served is spent. A fresh one applied
    // earlier in the same tick (the plan's `requestCall` runs before the ack) has no
    // `servedByHookId`, so it stands.
    if (narrator.callBack?.servedByHookId === hookId) {
      // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
      delete narrator.callBack;
    }
    pushCapped(narrator.recentHookIds, hookId, RECENT_HOOK_IDS_CAP);
    ctx.emit({
      ...causedBy(command),
      type: "narratorHookResolved",
      subjectIds: [hookId],
      payload: { hookId },
    });
    return NO_TEMP_REFS;
  },
};

// ---------------------------------------------------------------------------------------------
// requestCall (§requested-call-back)
// ---------------------------------------------------------------------------------------------

/** Why `why` is not a private line a call-back request can carry, or undefined. */
function whyProblem(why: unknown): string | undefined {
  if (typeof why !== "string") return "why must be text";
  if (why.length > CALL_BACK_WHY_MAX) return `why is longer than ${CALL_BACK_WHY_MAX} characters`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
  if (/[\u0000-\u001f\u007f]/.test(why)) return "why has control characters";
  return undefined;
}

/**
 * §requested-call-back: replace the narrator's standing call-back request. The whole request is
 * replaced, so a new one is never already served. It remembers the port it was asked at (a
 * `nextPort` request is served elsewhere) and, for `midLeg` asked before a transit's halfway point,
 * that transit.
 */
const requestCall: CommandHandler<"requestCall", null> = {
  validate(ctx, command) {
    const { when, why } = command.payload;
    if (!(CALL_BACK_WHEN as readonly unknown[]).includes(when)) {
      return reject(
        "invalidPayload",
        `requestCall: when must be one of ${CALL_BACK_WHEN.join(", ")}, got "${String(when)}"`,
      );
    }
    const problem = whyProblem(why);
    if (problem !== undefined) return reject("invalidPayload", `requestCall: ${problem}`);
    if (ctx.state.hull.lostAtTick !== undefined) {
      return reject("preconditionFailed", "requestCall: the ship is lost");
    }
    return ok(null);
  },
  apply(ctx, command) {
    const { when, why } = command.payload;
    const travel = ctx.state.travel;
    const request: CallBackRequest = { when, why, requestedTick: ctx.tick };
    if (travel.stage === "docked") {
      request.portId = travel.portId;
    } else if (
      when === "midLeg" &&
      travel.stage === "transit" &&
      travel.routeProgress < travel.routeDistance / 2
    ) {
      request.legStartedTick = travel.stageStartedTick;
    }
    ctx.state.narrator.callBack = request;
    ctx.emit({
      ...causedBy(command),
      type: "callBackRequested",
      subjectIds: [],
      payload: { when },
    });
    return NO_TEMP_REFS;
  },
};

// ---------------------------------------------------------------------------------------------
// surfaceDecision
// ---------------------------------------------------------------------------------------------

/**
 * A card side as a decision option; `aftermath` (§aftermath-caption) only when the side has one
 * (JSON-safe).
 */
function optionFromSide(side: DecisionCardSide): DecisionOption {
  return {
    label: side.label,
    commands: [...side.commands],
    ...(side.aftermath === undefined ? {} : { aftermath: side.aftermath }),
  };
}

/**
 * A card option's command draft as a `player` command with id `id`, or `undefined` when the
 * player may not issue its kind (option commands always run as the player).
 */
function asPlayerCommand(
  id: string,
  draft: DecisionCardSide["commands"][number],
): Command | undefined {
  if (!(AUTHORITY.player as readonly CommandKind[]).includes(draft.kind)) return undefined;
  return {
    id: id as CommandId,
    source: "player",
    kind: draft.kind,
    payload: draft.payload,
  } as Command;
}

interface SurfaceDecisionPlan {
  readonly perspectiveActorId: ActorId;
}

/**
 * Decisions are kernel-owned (CONTRACTS: `Decision`/`NarratorHook` types), so `surfaceDecision`
 * lives here rather than in a system, unlike `resolveDecision`'s option commands which do belong
 * to their owning systems. Each option's commands are checked twice: authorized for `player`
 * here (so a stale queued card cannot smuggle in a command nobody could ever pick), and again,
 * fully, by `resolveDecision` at resolve time against the state as it is then.
 */
function surfaceDecisionHandler(
  registry: KernelRegistry,
): CommandHandler<"surfaceDecision", SurfaceDecisionPlan> {
  return {
    validate(ctx, command): Validation<SurfaceDecisionPlan> {
      const { card } = command.payload;
      for (const [which, side] of [
        ["left", card.left],
        ["right", card.right],
      ] as const) {
        for (const [index, draft] of side.commands.entries()) {
          const sub = asPlayerCommand(`${command.id}#${which}#${index}`, draft);
          if (sub === undefined) {
            return reject(
              "unauthorized",
              `surfaceDecision: ${which} option ${index} ("${draft.kind}") is not a player command`,
            );
          }
          const validation = validateCommand(registry, ctx, sub);
          if (!validation.ok) {
            return reject(
              validation.rejection.code,
              `surfaceDecision: ${which} option ${index} (${draft.kind}): ${validation.rejection.reason}`,
            );
          }
        }
      }
      let perspectiveActorId: ActorId;
      if (card.perspectiveActorId !== undefined) {
        const actor = ctx.state.actors[card.perspectiveActorId];
        if (actor === undefined) {
          return reject(
            "unknownEntity",
            `surfaceDecision: unknown perspective actor "${card.perspectiveActorId}"`,
          );
        }
        if (!isFitForCommand(actor)) {
          return reject(
            "preconditionFailed",
            `surfaceDecision: perspective actor "${card.perspectiveActorId}" is not available`,
          );
        }
        perspectiveActorId = actor.id;
      } else {
        perspectiveActorId = commandActor(ctx.state);
      }
      if (card.jobId !== undefined) {
        const duplicate = Object.values(ctx.state.decisions.records).find(
          (d) => d.status === "pending" && d.jobId === card.jobId,
        );
        if (duplicate !== undefined) {
          return reject(
            "duplicate",
            `surfaceDecision: a decision for job "${card.jobId}" is already queued`,
          );
        }
      }
      return ok({ perspectiveActorId });
    },
    apply(ctx, command, plan): AppliedCommand {
      const { card } = command.payload;
      const decisionId = allocateId(ctx.state, "decision");
      const record: Decision = {
        id: decisionId,
        origin: command.source === "narrator" ? "narrator" : "policy",
        perspectiveActorId: plan.perspectiveActorId,
        prompt: card.prompt,
        left: optionFromSide(card.left),
        right: optionFromSide(card.right),
        status: "pending",
        createdTick: ctx.tick,
        ...(card.jobId !== undefined ? { jobId: card.jobId } : {}),
      };
      ctx.state.decisions.records[decisionId] = record;
      // §delivery: a card from one of the port's people waits to be delivered in person.
      queueOrHold(ctx, decisionId, cardSpeaker(ctx.state, record));
      return NO_TEMP_REFS;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// resolveDecision
// ---------------------------------------------------------------------------------------------

interface ResolvePlan {
  readonly subCommands: readonly { readonly command: Command; readonly plan: unknown }[];
}

/**
 * The chosen side's commands run as source `player` through the same authority check and
 * validators. W2 decision: every option command is validated against the state before any of
 * them applies (a batch against a shared snapshot, SD §5.2); if any is rejected the whole
 * resolution is rejected and the decision stays at the head of the queue.
 */
function resolveDecisionHandler(
  registry: KernelRegistry,
): CommandHandler<"resolveDecision", ResolvePlan> {
  return {
    validate(ctx, command): Validation<ResolvePlan> {
      const { decisionId, side } = command.payload;
      const decision = ctx.state.decisions.records[decisionId];
      if (decision === undefined) {
        return reject("unknownEntity", `unknown decision "${decisionId}"`);
      }
      if (decision.status !== "pending" || ctx.state.decisions.queue[0] !== decisionId) {
        return reject("preconditionFailed", `decision "${decisionId}" is not the one presented`);
      }
      if (side !== "left" && side !== "right") {
        return reject("invalidPayload", `side must be "left" or "right"`);
      }
      const option = decision[side];
      const next = option.nextDecisionId;
      if (next !== undefined && ctx.state.decisions.records[next]?.status !== "pending") {
        return reject("preconditionFailed", `next decision "${next}" is not pending`);
      }
      const subCommands: { command: Command; plan: unknown }[] = [];
      for (const [index, draft] of option.commands.entries()) {
        // The card's drafts are its own `CommandDraft`s read through `DeepReadonly`, which the
        // checker no longer unfolds over the whole union (slice 4 made it one kind longer).
        const sub = asPlayerCommand(`${command.id}#${index}`, draft as CommandDraft);
        if (sub === undefined) {
          return reject("unauthorized", `option command "${draft.kind}" is not a player command`);
        }
        const validation = validateCommand(registry, ctx, sub);
        if (!validation.ok) {
          return reject(
            validation.rejection.code,
            `option command ${index} (${draft.kind}): ${validation.rejection.reason}`,
          );
        }
        subCommands.push({ command: sub, plan: validation.plan });
      }
      return ok({ subCommands });
    },
    apply(ctx, command, plan): AppliedCommand {
      const { decisionId, side } = command.payload;
      const tempRefs: Record<TempRef, EntityId> = {};
      for (const { command: sub, plan: subPlan } of plan.subCommands) {
        const handler = registry.commandHandler(sub.kind) as CommandHandler<CommandKind, unknown>;
        const applied = handler.apply(ctx, sub as CommandOfKind<CommandKind>, subPlan);
        Object.assign(tempRefs, applied.tempRefs);
        ctx.emit({
          type: "commandApplied",
          subjectIds: Object.values(applied.tempRefs),
          causeIds: [command.id],
          source: "player",
          payload: { kind: sub.kind, tempRefs: applied.tempRefs },
        });
      }
      const decisions = ctx.state.decisions;
      const decision = decisions.records[decisionId];
      if (decision === undefined) throw new Error("validated decision vanished");
      decision.status = "resolved";
      decision.resolvedTick = ctx.tick;
      decision.chosen = side;
      const queue = decisions.queue.filter((id) => id !== decisionId);
      const next: DecisionId | undefined = decision[side].nextDecisionId;
      decisions.queue = next === undefined ? queue : [next, ...queue.filter((id) => id !== next)];
      ctx.emit({
        ...causedBy(command),
        type: "decisionResolved",
        subjectIds: [decisionId, decision.perspectiveActorId],
        payload: { decisionId, side },
      });
      return { tempRefs };
    },
  };
}

// ---------------------------------------------------------------------------------------------

export function registerCoreCommandHandlers(registry: KernelRegistry): void {
  registry.registerCommandHandler("scenarioSpawn", scenarioSpawn);
  registry.registerCommandHandler("scenarioInjectFault", scenarioInjectFault);
  registry.registerCommandHandler("scenarioSetNeeds", scenarioSetNeeds);
  registry.registerCommandHandler("acknowledgeHook", acknowledgeHook);
  registry.registerCommandHandler("requestCall", requestCall);
  registry.registerCommandHandler("surfaceDecision", surfaceDecisionHandler(registry));
  registry.registerCommandHandler("resolveDecision", resolveDecisionHandler(registry));
}
