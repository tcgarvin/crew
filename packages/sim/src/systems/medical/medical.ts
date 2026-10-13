/**
 * §the-wounded-problem: the medical system, phase `needs` after the bodies system, every tick. For
 * each living crew member aboard (not a passenger, not a site's cast, not in a fight) with an open
 * wound nobody has treated (stun hits aside, `needsTreatment`), `crewWounded` is raised (owner
 * medical, dedupe `wounded:<actorId>`, public, located at the medbay bed's compartment): essential
 * while one of those wounds bleeds, routine after. It is revised when the count or the class
 * changes, resolved once every wound is treated (or closed), and cancelled when the patient dies.
 * Once raised it stays open while the patient is off the ship's floor for a while (on the dock,
 * ashore): the wounds are still there when they come back. A deck with no medbay bed raises
 * nothing (`medBedOf`). Before the sweep, anyone carried aboard outside a carry is set down
 * (§extraction, `carry.ts` `releaseStrayCasualties`). After it, the ship's dead are seen to: laid
 * out aboard or laid to rest ashore (§the-body-aboard, §laid-to-rest, `rest.ts` `sweepBodies`).
 */
import { needsTreatment } from "../../core/body";
import { isOnDock } from "../../core/docks";
import { allocateId } from "../../core/ids";
import type { Actor, Wound } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ActorId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { ProblemOfKind, UrgencyClass } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { emitSim } from "../work/events";
import { type MedBed, medBedOf } from "./bed";
import { releaseStrayCasualties } from "./carry";
import { sweepBodies } from "./rest";

export const woundedKey = (actorId: ActorId): string => `wounded:${actorId}`;

/** A patient the crew treat: crew (not a passenger), alive, on the ship's floor, not fighting. */
export function aboardPatient(ctx: Pick<StepCtx, "state" | "content">, actor: Actor): boolean {
  if (!actor.crew || actor.passenger === true || actor.combatant !== undefined) return false;
  if (actor.availability === "dead" || actor.availability === "offShip") return false;
  const location = actor.location;
  if (location.kind !== "onDeck" || location.deckId !== shipDeckId(ctx.state)) return false;
  return !isOnDock(ctx.content, ctx.state, location);
}

/** The wounds on `actor` that want treating. */
export function untreatedWounds<
  W extends DeepReadonly<Pick<Wound, "type" | "treatedTick">>,
>(actor: {
  readonly body: { readonly wounds: readonly W[] };
}): W[] {
  return actor.body.wounds.filter(needsTreatment);
}

function urgencyOf(actor: Actor): UrgencyClass {
  return untreatedWounds(actor).some((w) => w.bleeding)
    ? "essentialOperation"
    : "routineObligation";
}

function openWounded(ctx: StepCtx): Map<ActorId, ProblemOfKind<"crewWounded">> {
  const out = new Map<ActorId, ProblemOfKind<"crewWounded">>();
  for (const problem of Object.values(ctx.state.work.problems)) {
    if (problem.kind === "crewWounded" && problem.status === "open") {
      out.set(problem.payload.actorId, problem);
    }
  }
  return out;
}

function settle(ctx: StepCtx, problem: ProblemOfKind<"crewWounded">, dead: boolean): void {
  problem.status = dead ? "cancelled" : "resolved";
  if (!dead) {
    emitSim(ctx, "problemResolved", [problem.id], { problemId: problem.id, kind: problem.kind });
  }
}

function raise(ctx: StepCtx, bed: MedBed, actor: Actor, untreated: number): void {
  const id = allocateId(ctx.state, "problem");
  ctx.state.work.problems[id] = {
    id,
    kind: "crewWounded",
    payload: { actorId: actor.id, untreated },
    owner: "medical",
    visibility: "public",
    dedupeKey: woundedKey(actor.id),
    status: "open",
    createdTick: ctx.tick,
    revision: 1,
    baseUrgency: urgencyOf(actor),
    location: { kind: "compartment", compartmentId: bed.compartmentId },
  };
  emitSim(ctx, "problemRaised", [id], { problemId: id, kind: "crewWounded" });
}

function revise(ctx: StepCtx, problem: ProblemOfKind<"crewWounded">, actor: Actor): void {
  const untreated = untreatedWounds(actor).length;
  const urgency = urgencyOf(actor);
  if (problem.payload.untreated === untreated && problem.baseUrgency === urgency) return;
  problem.payload = { ...problem.payload, untreated };
  problem.baseUrgency = urgency;
  problem.revision += 1;
}

export function sweepWounded(ctx: StepCtx): void {
  const open = openWounded(ctx);
  for (const [actorId, problem] of open) {
    const actor = ctx.state.actors[actorId];
    if (actor === undefined || actor.availability === "dead") settle(ctx, problem, true);
    else if (untreatedWounds(actor).length === 0) settle(ctx, problem, false);
    else revise(ctx, problem, actor);
  }
  const patients = Object.values(ctx.state.actors).filter(
    (actor) =>
      !open.has(actor.id) && untreatedWounds(actor).length > 0 && aboardPatient(ctx, actor),
  );
  // The bed is looked up only when someone needs it: most ticks nobody is hurt.
  const bed = patients.length === 0 ? undefined : medBedOf(ctx.state, ctx.content);
  if (bed === undefined) return;
  for (const actor of patients) raise(ctx, bed, actor, untreatedWounds(actor).length);
}

export const medicalSystem: System = {
  name: "medical.wounded",
  phase: "needs",
  run(ctx) {
    // §extraction: after the bodies system, so someone who died or came round in a carrier's arms
    // is on the floor before anyone plans them.
    releaseStrayCasualties(ctx);
    sweepWounded(ctx);
    sweepBodies(ctx);
  },
};
