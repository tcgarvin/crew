/**
 * Generic render projection (D7: the map shows truth). Fills `RenderFrame` from state: actor
 * positions and action labels, machine and door states, travel progress, money, and the ticker.
 */
import type { Actor } from "./types/actor";
import type { DeepReadonly } from "./types/common";
import type { ContentBundle } from "./types/content";
import type { SimEvent } from "./types/events";
import type { World } from "./types/kernel";
import type { ReadonlyWorldState } from "./types/pipeline";
import type { Machine } from "./types/ship";
import type {
  RenderActor,
  RenderFrame,
  RenderMachine,
  RenderMachineState,
  TickerEntry,
} from "./types/view";
import type { ActionKind } from "./types/work";

const ACTION_VERBS: Readonly<Record<ActionKind, string>> = {
  walk: "walking",
  operateDoor: "working a door",
  pickUp: "picking up",
  putDown: "putting down",
  inspect: "inspecting",
  diagnose: "diagnosing",
  repair: "repairing",
  removeComponent: "removing a part from",
  installComponent: "installing a part in",
  test: "testing",
  eat: "eating",
  sleep: "sleeping",
  operateStation: "operating",
  chat: "chatting",
  wait: "waiting",
};

/** Short present-tense label for an actor: "repairing coolant pump", "sleeping", "walking". */
export function actionLabel(
  actor: DeepReadonly<Actor>,
  state: ReadonlyWorldState,
  content: ContentBundle,
): string {
  if (actor.availability === "dead") return "dead";
  if (actor.availability === "incapacitated") return "incapacitated";
  const activity = actor.activity;
  if (activity.kind === "idle") {
    return actor.movement.kind === "moving" ? "walking" : "idle";
  }
  // W4a: the work system keeps a ready-made label on the activity (systems/work/labels.ts).
  if (activity.label !== undefined) return activity.label;
  const action = activity.action;
  if (action.kind === "sleep" && action.stage !== "asleep") {
    return action.stage === "waking" ? "waking up" : "lying down";
  }
  const verb = ACTION_VERBS[action.kind];
  const targetId = action.targetId;
  if (targetId === undefined || action.kind === "walk") return verb;
  const machine = state.machines[targetId as Machine["id"]];
  if (machine !== undefined) {
    const name = content.machines[machine.defId]?.name;
    return name === undefined ? verb : `${verb} ${name.toLowerCase()}`;
  }
  const other = state.actors[targetId as Actor["id"]];
  if (other !== undefined && action.kind === "chat") return `chatting with ${other.name}`;
  return verb;
}

function machineState(machine: DeepReadonly<Machine>, content: ContentBundle): RenderMachineState {
  if (machine.actualMode === "off") return "off";
  const faultDefs = content.machines[machine.defId]?.faults ?? [];
  const inoperable = machine.faults.some(
    (fault) => faultDefs.find((def) => def.key === fault.faultKey)?.effect.kind === "inoperable",
  );
  if (inoperable || machine.integrity <= 0) return "failed";
  if (machine.faults.length > 0 || machine.output < 1) return "degraded";
  return "ok";
}

function renderActor(
  actor: DeepReadonly<Actor>,
  state: ReadonlyWorldState,
  content: ContentBundle,
): RenderActor | null {
  let location = actor.location;
  if (location.kind === "carriedBy") {
    location = state.actors[location.actorId]?.location ?? location;
  }
  if (location.kind !== "onDeck") return null;
  return {
    id: actor.id,
    name: actor.name,
    deckId: location.deckId,
    x: location.x,
    y: location.y,
    facing: actor.facing,
    actionLabel: actionLabel(actor, state, content),
  };
}

function humanize(type: string): string {
  const words = type.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Generic one-line ticker text: the event type plus its named subjects. */
export function describeEvent(
  event: SimEvent,
  state: ReadonlyWorldState,
  content: ContentBundle,
): string {
  // W4a: a conversation carries its own rendered line.
  if (event.type === "conversation") return event.payload.line;
  const names = event.subjectIds
    .map((id) => {
      const actor = state.actors[id as Actor["id"]];
      if (actor !== undefined) return actor.name;
      const machine = state.machines[id as Machine["id"]];
      if (machine !== undefined) return content.machines[machine.defId]?.name ?? id;
      return null;
    })
    .filter((name): name is string => name !== null);
  const head = humanize(event.type);
  return names.length === 0 ? head : `${head}: ${names.join(", ")}`;
}

export function getRenderFrame(world: World): RenderFrame {
  const { state, content } = world;
  const actors: RenderActor[] = [];
  for (const actor of Object.values(state.actors)) {
    const rendered = renderActor(actor, state, content);
    if (rendered !== null) actors.push(rendered);
  }
  const machines: RenderMachine[] = Object.values(state.machines).map((machine) => ({
    id: machine.id,
    state: machineState(machine, content),
    temperatureNorm: machine.temperature,
    deckId: machine.deckId,
    placementKey: machine.placementKey,
  }));
  const travel = state.travel;
  const progress =
    travel.stage === "docked"
      ? 0
      : travel.stage === "transit"
        ? travel.routeDistance > 0
          ? travel.routeProgress / travel.routeDistance
          : 0
        : travel.stageProgress;
  const tickerEvents: TickerEntry[] = world.caches.diagnostics.lastEvents.map((event) => ({
    tick: event.tick,
    text: describeEvent(event, state, content),
    significance: event.significance,
  }));
  return {
    tick: state.tick,
    actors,
    machines,
    doors: Object.values(state.doors).map((door) => ({
      id: door.id,
      physicalState: door.physicalState,
      deckId: door.deckId,
      placementKey: door.placementKey,
    })),
    travel: { state: travel.stage, progress },
    tickerEvents,
    money: state.money.balance,
  };
}
