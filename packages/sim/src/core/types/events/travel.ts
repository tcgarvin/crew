/** Travel events (W6). */
import type { HazardKind } from "../content";
import type {
  ActorId,
  DockDefId,
  HazardId,
  ItemDefId,
  ItemId,
  LocalId,
  LocalKey,
  MachineId,
  PortDefId,
} from "../ids";
import type { TravelStage } from "../travel";
import type { SignificanceCatalog } from "./significance";

export interface TravelEventPayloads {
  travelStageChanged: { readonly from: TravelStage; readonly to: TravelStage };
  departed: { readonly fromPortId: PortDefId; readonly toPortId: PortDefId };
  arrived: { readonly portId: PortDefId };
  driftingChanged: { readonly drifting: boolean };
  /**
   * §limping: in transit the engines are below `travel.limpSpeedFraction` and no repair can bring
   * them back with what is aboard: `machineId`'s `faultKey` repair is short of `itemDefId` (a
   * `tool` nothing aboard provides, or `part`s), so the ship limps on at `speedFraction` of
   * nominal. Raised the tick the limp begins; it ends unannounced when the engine is repaired (with
   * `driftingChanged`) or the leg ends.
   */
  shipLimping: {
    readonly machineId: MachineId;
    readonly faultKey: LocalKey;
    readonly itemDefId: ItemDefId;
    readonly need: "tool" | "part";
    readonly speedFraction: number;
  };
  /** §departure-gate: the captain chose to wait for repairs to `machineId` before departing. */
  departureHeld: { readonly machineId: MachineId };
  /** §departure-gate: the captain chose to depart with `machineId` impaired. */
  departureRiskAccepted: { readonly machineId: MachineId };
  /**
   * §departure-gate: a hold ended because no engine/generator is impaired any more; departure
   * proceeds.
   */
  departureHoldLifted: { readonly toPortId: PortDefId };
  /**
   * §repairs-out-of-reach: the departure goes ahead with `machineId` impaired because its
   * `faultKey` repair is short of `itemDefId` (a `tool` nothing aboard provides, or `part`s) and
   * the market at `portId` cannot supply it. Raised instead of the gate card when no other repair
   * is worth waiting for, or when it ends a hold for repairs that could no longer finish. §limping:
   * one per fault; a machine impaired only by another's (an engine starved by the generator) is
   * told through the other's.
   */
  departureRepairOutOfReach: {
    readonly machineId: MachineId;
    readonly faultKey: LocalKey;
    readonly itemDefId: ItemDefId;
    readonly need: "tool" | "part";
    readonly portId: PortDefId;
    readonly toPortId: PortDefId;
    readonly heldForRepairs: boolean;
  };
  /**
   * §ramps-and-cast-off: someone on the dock could not walk back aboard while the ship was leaving
   * (they cannot move, or their walk failed), so the dock crew brought them up the ramp. The
   * departure is never held forever, and never silently.
   */
  broughtAboard: { readonly actorId: ActorId; readonly name: string; readonly portId: PortDefId };
  /**
   * §ramps-and-cast-off: an item was still on the dock when it slid away; it stays at the port's
   * warehouse.
   */
  leftOnDock: { readonly itemId: ItemId; readonly defId: ItemDefId; readonly portId: PortDefId };
  /**
   * §ramps-and-cast-off: a piece of the ship's own gear (the hand truck) was still on the dock when
   * it went, so the dock crew handed it up the cargo ramp instead of leaving it at the warehouse.
   */
  gearBroughtAboard: { readonly itemId: ItemId; readonly portId: PortDefId };
  /**
   * §staging-plan-dressing: the dock alongside was dressed: the floor set and the staging plan's
   * people (`localIds`) and props. `unplaced` names anyone the dock had no room for near their
   * post. `staged` is whether a staging plan was applied (false: the floor set alone).
   */
  dockDressed: {
    readonly portId: PortDefId;
    readonly dockId: DockDefId;
    readonly localIds: readonly LocalId[];
    readonly props: number;
    readonly staged: boolean;
    readonly unplaced: readonly string[];
  };
  /**
   * §staging-plan-dressing: the staging plan's one line for the log as the dock comes alongside.
   */
  dockAmbience: { readonly portId: PortDefId; readonly line: string };
  /** §course-plotting: `actorId` plotted the course to `toPortId` at the nav terminal. */
  coursePlotted: { readonly toPortId: PortDefId; readonly actorId: ActorId };
  /** §debris-fields-and-ion-storms: a `scheduleHazard` placed hazard `hazardId` on the leg. */
  hazardScheduled: { readonly hazardId: HazardId; readonly kind: HazardKind };
  /**
   * §hazard-roll: a navigation hazard fired in transit and the helm rolled against it: `standerId`
   * (absent: nobody at the helm) at piloting `skill` against `difficulty`. `unattended` is a scrape
   * and a delay both. `scrapedMachineId` is the machine a scrape put a fault on (absent: no scrape,
   * or no machine with a fault catalog to take it); `lostSeconds` is the delay (0 without one).
   */
  navHazard: {
    readonly hazardId: HazardId;
    readonly kind: HazardKind;
    readonly difficulty: number;
    readonly standerId?: ActorId;
    readonly skill: number;
    readonly outcome: "clean" | "scrape" | "delay" | "unattended";
    readonly scrapedMachineId?: MachineId;
    readonly lostSeconds: number;
    /** §forced-faults-and-hazards: the narrator decided the outcome; nothing was rolled. */
    readonly forced?: true;
  };
  /**
   * §debris-fields-and-ion-storms: hazard `hazardId` never fired and is dropped with its leg,
   * `fromPortId` → `toPortId`: transit ended before it fell due, or (absent `toPortId`) the course
   * was given up in port before the leg began. A hazard lies on the leg it was placed on and never
   * carries to another.
   */
  navHazardMissed: {
    readonly hazardId: HazardId;
    readonly kind: HazardKind;
    readonly difficulty: number;
    readonly fromPortId: PortDefId;
    readonly toPortId?: PortDefId;
  };
}

export const TRAVEL_EVENT_SIGNIFICANCE = {
  travelStageChanged: "trace",
  departed: "narrative",
  arrived: "narrative",
  driftingChanged: "narrative",
  shipLimping: "narrative",
  departureHeld: "narrative",
  departureRiskAccepted: "narrative",
  departureHoldLifted: "narrative",
  departureRepairOutOfReach: "narrative",
  broughtAboard: "notable",
  leftOnDock: "notable",
  gearBroughtAboard: "notable",
  dockDressed: "trace",
  // The staging call sets the stage and never moves the plot (D57): shown, never narrative.
  dockAmbience: "notable",
  coursePlotted: "notable",
  hazardScheduled: "trace",
  // The helm's stakes: in the digest and the ticker, but not hooked (§hazard-roll).
  navHazard: "narrative",
  // A fact for the narrator's digest that its hazard came to nothing; no story, no ticker line.
  navHazardMissed: "notable",
} as const satisfies SignificanceCatalog<TravelEventPayloads>;
