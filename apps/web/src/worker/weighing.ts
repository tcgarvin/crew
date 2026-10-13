/**
 * §what-a-crew-member-weighs: an actor's `weighOptions` in words for the inspector. Worded here, in
 * the worker, because the names (machines, rooms, items, people, activities) are in the world state
 * and the content bundle, which the main thread does not hold at the tapped tick.
 */
import type {
  ActorId,
  AgentView,
  Candidate,
  CompartmentId,
  ContentBundle,
  DeepReadonly,
  Intent,
  ItemId,
  MachineId,
  ProblemView,
  ReadonlyWorldState,
  TaskView,
  WeighedOptionWords,
  Weighing,
  WeighingWords,
  World,
} from "@crew/sim";
import { roomPhrase, weighOptions } from "@crew/sim";

interface Names {
  readonly state: ReadonlyWorldState;
  readonly content: ContentBundle;
}

function machineName(names: Names, machineId: MachineId): string {
  const machine = names.state.machines[machineId];
  const name = machine === undefined ? undefined : names.content.machines[machine.defId]?.name;
  return `the ${(name ?? "machine").toLowerCase()}`;
}

function itemName(names: Names, itemId: ItemId): string {
  const item = names.state.items[itemId];
  const name = item === undefined ? undefined : names.content.items[item.defId]?.name;
  return (name ?? "cargo").toLowerCase();
}

function roomName(names: Names, compartmentId: CompartmentId): string {
  const compartment = names.state.compartments[compartmentId];
  if (compartment === undefined) return "a room";
  const deck = names.content.decks[compartment.deckId];
  const def = deck?.compartments.find((c) => c.key === compartment.key);
  return def === undefined ? `the ${compartment.key.toLowerCase()}` : roomPhrase(def);
}

function personName(names: Names, actorId: string): string {
  return names.state.actors[actorId as ActorId]?.name ?? "someone";
}

function targetName(names: Names, task: TaskView): string {
  const target = task.target;
  switch (target.kind) {
    case "machine":
      return machineName(names, target.machineId);
    case "item":
      return itemName(names, target.itemId);
    case "compartment":
      return roomName(names, target.compartmentId);
    case "market":
      return "the market";
    case "door":
      return "a door";
    case "scar":
      return "the hull";
    case "actor":
      return personName(names, target.actorId);
  }
}

/** A task as the work it is: "servicing the coolant pump", "repairing the engine". */
export function taskWords(names: Names, task: TaskView, problem: ProblemView | undefined): string {
  const what = targetName(names, task);
  switch (task.type) {
    case "inspect":
      return task.derivationKey === "maintain" ? `servicing ${what}` : `checking ${what}`;
    case "diagnose":
      return `diagnosing ${what}`;
    case "repair":
      return `repairing ${what}`;
    case "haul":
      if (problem?.kind === "cargoToLoad") return `loading ${what}`;
      if (problem?.kind === "cargoToUnload") return `unloading ${what}`;
      return `hauling ${what}`;
    case "staffStation":
      return `manning ${what}`;
    case "buyParts":
      return "buying parts";
    case "plotCourse":
      return "plotting a course";
    case "cookMeal":
      return "cooking";
    case "carryMeal":
      return "taking a plate to the helm";
    case "cleanCompartment":
      return `mopping ${what}`;
    case "repairDamage":
      return `repairing the damage to ${what}`;
    case "patchHull":
      return "patching the hull";
    case "plateHull":
      return "plating the hull";
    case "checkCompartment":
      return `checking ${what} for damage`;
    case "treatWounds":
      return `treating ${what}`;
  }
}

function candidateWords(names: Names, view: AgentView, candidate: Candidate): string {
  const choice = candidate.choice;
  if (choice.kind === "task") {
    const task = view.knownTasks().find((t) => t.id === choice.taskId);
    if (task === undefined) return "a job";
    const problem = view.knownProblems().find((p) => p.id === task.problemId);
    return taskWords(names, task, problem);
  }
  switch (choice.activity) {
    case "eat":
      return "eating";
    case "sleep":
      return "sleeping";
    case "rest":
      return "resting";
    case "socialize":
      return "chatting";
    case "wander":
      // §who-has-the-helm: on duty with nothing to do, the officer goes to the chair and others to
      // their post.
      return candidate.ref === "chair" ? "going to the captain's chair" : "going to their post";
    case "comeAboard":
      return "coming aboard";
    case "lookForWork":
      return "looking for work";
    case "meetSpeaker":
      return "going to meet someone";
    case "rounds":
      return "doing rounds";
    case "standWatch":
      return "standing gangway watch";
    case "recreate": {
      const def =
        choice.activityId === undefined ? undefined : names.content.activities[choice.activityId];
      return def?.label ?? "something off watch";
    }
    case "privateTalk":
      return "a word with the captain";
    case "report":
      return "reporting on the intercom";
    case "holdBridge":
      return "holding the bridge";
    case "muster":
      return "arming for the site";
    case "fight":
      return "in the fight";
    case "convalesce":
      return "going to the medbay";
  }
}

/** A rejection's ref ("task:t4", "sleep", "sleep:m3") in words. */
function refWords(names: Names, view: AgentView, ref: string): string {
  if (ref.startsWith("task:")) {
    const task = view.knownTasks().find((t) => `task:${t.id}` === ref);
    if (task === undefined) return "a job";
    const problem = view.knownProblems().find((p) => p.id === task.problemId);
    return taskWords(names, task, problem);
  }
  const head = ref.split(":")[0] ?? ref;
  const words: Readonly<Record<string, string>> = {
    eat: "eating",
    sleep: "sleeping",
    rest: "resting",
    socialize: "chatting",
    recreate: "something off watch",
    rounds: "doing rounds",
    standWatch: "standing gangway watch",
    post: "going to their post",
    chair: "going to the captain's chair",
    privateTalk: "a word with the captain",
    report: "reporting on the intercom",
    holdBridge: "holding the bridge",
    convalesce: "going to the medbay",
  };
  return words[head] ?? head;
}

const REASON_WORDS: Readonly<Record<string, string>> = {
  offDuty: "off watch: routine work waits for their watch",
  insufficientCompetency: "not skilled enough",
  missingTool: "knows of no tool for it",
  unreachableTarget: "can't get there",
  backoff: "gave up on it for a while",
  dependencyPending: "something else has to be done first",
  unknownProblem: "doesn't know what it's for",
  notMyHelm: "not theirs: the watch decides the helm",
  notMyMeal: "not theirs: the cook's or a dayworker's",
  notMyRoom: "not theirs to clean",
  notMyDamage: "not theirs: the bridge sends the scouts",
  mealCall: "dinner first",
  noFreeBed: "no free bed",
  noKnownFood: "knows of no food",
  noLounge: "nowhere to do it",
  notAboard: "not aboard",
  atTheHelm: "at the helm",
  ownWounds: "can't treat their own wounds",
  noMedicine: "knows of no med kit aboard",
  bedTaken: "someone else is in the medbay bed",
};

/** A rejection reason in words; `claimedBy:<id>` and `deferTo:<id>` name the person. */
export function reasonWords(names: Names, reason: string): string {
  const [head, id] = reason.split(":");
  if (head === "claimedBy" && id !== undefined) return `${personName(names, id)} has it`;
  if (head === "deferTo" && id !== undefined) {
    return `leaving it to ${personName(names, id)}, who is better at it`;
  }
  return REASON_WORDS[reason] ?? reason;
}

function isChoice(candidate: Candidate, intent: Intent): boolean {
  const choice = candidate.choice;
  if (intent.kind === "task") return choice.kind === "task" && choice.taskId === intent.taskId;
  if (intent.kind !== "personal" || choice.kind !== "personal") return false;
  return choice.activity === intent.activity && choice.activityId === intent.activityId;
}

function isCurrent(candidate: Candidate, view: AgentView): boolean {
  const activity: DeepReadonly<AgentView["self"]["activity"]> = view.self.activity;
  const choice = candidate.choice;
  if (activity.kind === "task") return choice.kind === "task" && choice.taskId === activity.taskId;
  return (
    activity.kind === "personal" &&
    choice.kind === "personal" &&
    choice.activity === activity.activity
  );
}

function verdict(view: AgentView, weighing: Weighing, next: string): string {
  const intent = weighing.intent;
  if (intent.kind === "idle") return "nothing to do";
  if (intent.kind === "continue") {
    return view.self.activity.kind === "idle"
      ? "nothing to do"
      : "keeps at what they're doing: nothing else outranks it yet";
  }
  return view.self.activity.kind === "idle" ? `next: ${next}` : `switching to ${next}`;
}

/**
 * §what-a-crew-member-weighs: weigh an actor's options (`weighOptions`) on `world` and word them.
 */
export function weighAgent(view: AgentView, world: World, content: ContentBundle): WeighingWords {
  const config = world.config.values;
  return weighingWords(
    view,
    weighOptions(view, config),
    world.state,
    content,
    config.time.tickRate,
  );
}

export function weighingWords(
  view: AgentView,
  weighing: Weighing,
  state: ReadonlyWorldState,
  content: ContentBundle,
  tickRate: number,
): WeighingWords {
  const names = { state, content };
  let next = "";
  const options = weighing.ranked.map((candidate): WeighedOptionWords => {
    const text = candidateWords(names, view, candidate);
    const chosen = weighing.intent.kind !== "continue" && isChoice(candidate, weighing.intent);
    if (chosen) next = text;
    const mark: WeighedOptionWords["mark"] = isCurrent(candidate, view)
      ? "doing"
      : chosen
        ? "next"
        : undefined;
    return {
      text,
      urgency: candidate.urgency,
      seconds: Math.round(candidate.estimateTicks / tickRate),
      ...(mark === undefined ? {} : { mark }),
    };
  });
  return {
    verdict: verdict(view, weighing, next),
    options,
    ruledOut: weighing.rejected.map((r) => ({
      text: refWords(names, view, r.ref),
      reason: reasonWords(names, r.reason),
    })),
  };
}
