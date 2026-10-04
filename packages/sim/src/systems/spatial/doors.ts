/**
 * Door state machine (SD §7.5): closed → opening → open → closing → closed, with `jammed`
 * ignoring every request. Phase 3, every tick, registered before movement so movement sees this
 * tick's physical state.
 *
 * W3 decisions:
 * - A door can move under power when its placement names a power domain, that domain exists in
 *   `state.power.domains` and is not `tripped`, and the door has no `actuatorFault`. (Power (W5)
 *   can refine liveness by editing `isPowerDomainLive` only.)
 * - Without power a door holds its physical state, including mid-transition. A
 *   `manualOperationSupported` door can still be opened (not closed) by hand while an actor waits
 *   in its aperture; that takes `config.doors.manualOpenSeconds`. The request itself is
 *   instantaneous (no `operateDoor` action in V1).
 * - Only doors that reached `open` under power get `closeAfterTick`; authored-open doors and
 *   hand-opened doors stay open, and so do ramps, which only travel closes. The timer restarts
 *   while anyone is in the aperture.
 * - Closing reverses to opening when an actor enters the aperture or re-requests `open`; closure
 *   never pushes or crushes anyone.
 */
import { configTicks } from "../../core/clock";
import type { ConfigDef } from "../../core/types/content";
import type { LocalKey } from "../../core/types/ids";
import type { NavDoor } from "../../core/types/nav";
import type { ReadonlyWorldState, StepCtx, System } from "../../core/types/pipeline";
import type { Door, DoorPhysicalState } from "../../core/types/ship";
import { deckGeometry, syncRampPassability } from "./geometry";

export function isPowerDomainLive(state: ReadonlyWorldState, key: LocalKey): boolean {
  const domain = state.power.domains[key];
  return domain !== undefined && !domain.tripped;
}

/** Can the actuator move this door right now? */
export function doorHasPower(
  state: ReadonlyWorldState,
  door: Pick<Door, "actuatorFault">,
  nav: NavDoor,
): boolean {
  const domain = nav.placement.powerDomain;
  return domain !== undefined && !door.actuatorFault && isPowerDomainLive(state, domain);
}

/**
 * Will this door move toward `open` for an actor waiting at it? Used by movement to decide
 * whether waiting is still worthwhile. Actors never ask a ramp to open (travel owns ramps), so a
 * ramp will open only if travel has already asked for it.
 */
export function doorWillOpen(state: ReadonlyWorldState, door: Door, nav: NavDoor): boolean {
  if (door.physicalState === "open") return true;
  if (door.physicalState === "jammed") return false;
  if (door.kind === "ramp" && door.requestedState !== "open") return false;
  return doorHasPower(state, door, nav) || door.manualOperationSupported;
}

/**
 * Seconds the schematic says a door costs to get through when closed: powered doors open in
 * `openSeconds`, manual-only doors in `manualOpenSeconds`; an unpowered door without manual
 * operation is passable only if authored open. Used for planning and estimates.
 */
export function schematicDoorSeconds(nav: NavDoor, config: ConfigDef): number | null {
  if (nav.placement.powerDomain !== undefined) return poweredTravelSeconds(nav, config, "open");
  if (nav.placement.manualOperationSupported) return config.doors.manualOpenSeconds;
  return nav.placement.initialState === "open" ? 0 : null;
}

/**
 * D58: seconds a powered leaf takes to travel. A ramp is a heavy plate and takes
 * `rampOpenSeconds` either way; other doors use `openSeconds`/`closeSeconds`.
 */
function poweredTravelSeconds(
  nav: NavDoor,
  config: ConfigDef,
  direction: "open" | "close",
): number {
  if (nav.placement.kind === "ramp") return config.doors.rampOpenSeconds;
  return direction === "open" ? config.doors.openSeconds : config.doors.closeSeconds;
}

function transition(ctx: StepCtx, door: Door, to: DoorPhysicalState, progress: number): void {
  const from = door.physicalState;
  door.physicalState = to;
  door.transitionProgress = progress;
  if (from !== to) {
    ctx.emit({
      type: "doorStateChanged",
      subjectIds: [door.id],
      causeIds: [],
      source: "sim",
      payload: { doorId: door.id, from, to },
    });
  }
}

/** Advance `transitionProgress` by this run's elapsed ticks over `seconds`; true when complete. */
function step(ctx: StepCtx, door: Door, seconds: number): boolean {
  const duration = Math.max(1, configTicks(ctx.config, seconds));
  door.transitionProgress = Math.min(1, door.transitionProgress + ctx.elapsedTicks / duration);
  return door.transitionProgress >= 1 - 1e-9;
}

function updateDoor(ctx: StepCtx, door: Door, nav: NavDoor): void {
  const { config } = ctx;
  const powered = doorHasPower(ctx.state, door, nav);
  const occupied = door.occupants.length > 0;
  const byHand = door.manualOperationSupported && occupied;
  const autoCloseTicks = configTicks(config, config.doors.autoCloseAfterSeconds);

  switch (door.physicalState) {
    case "jammed":
      // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
      delete door.closeAfterTick;
      return;
    case "closed":
      if (door.requestedState === "open" && (powered || byHand)) {
        transition(ctx, door, "opening", 0);
      }
      return;
    case "opening": {
      if (door.requestedState === "closed" && !occupied && powered) {
        transition(ctx, door, "closing", 1 - door.transitionProgress);
        return;
      }
      if (!powered && !byHand) return; // Holds mid-transition.
      const seconds = powered
        ? poweredTravelSeconds(nav, config, "open")
        : config.doors.manualOpenSeconds;
      if (step(ctx, door, seconds)) {
        transition(ctx, door, "open", 0);
        // Ramps never close themselves: travel lowers and raises them (Dockside spike).
        if (powered && door.kind !== "ramp") door.closeAfterTick = ctx.tick + autoCloseTicks;
      }
      return;
    }
    case "open":
      if (door.kind === "ramp" && door.closeAfterTick !== undefined) {
        // A save from before ramps stopped auto-closing may still carry the timer.
        // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
        delete door.closeAfterTick;
      }
      if (door.closeAfterTick !== undefined && occupied) {
        door.closeAfterTick = ctx.tick + autoCloseTicks;
      } else if (door.closeAfterTick !== undefined && ctx.tick >= door.closeAfterTick && powered) {
        door.requestedState = "closed";
        // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
        delete door.closeAfterTick;
      }
      if (door.requestedState === "closed" && !occupied && powered) {
        transition(ctx, door, "closing", 0);
      }
      return;
    case "closing":
      if (door.requestedState === "open" || occupied) {
        if (powered || byHand) {
          door.requestedState = "open";
          transition(ctx, door, "opening", 1 - door.transitionProgress);
        }
        return;
      }
      if (powered && step(ctx, door, poweredTravelSeconds(nav, config, "close"))) {
        transition(ctx, door, "closed", 0);
      }
      return;
  }
}

export const doorsSystem: System = {
  name: "spatial.doors",
  phase: "actions",
  run(ctx) {
    for (const door of Object.values(ctx.state.doors)) {
      const nav = deckGeometry(ctx.caches, door.deckId).doors.get(door.id);
      if (nav === undefined) throw new Error(`Door ${door.id} is missing from the nav cache`);
      updateDoor(ctx, door, nav);
    }
    // Dockside spike: a ramp opening, closing or being asked up connects or cuts off the dock.
    syncRampPassability(ctx.state, ctx.caches);
  },
};
