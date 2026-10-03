/**
 * Dockside commands (D66). `stageDock` is the kernel side of the staging call (Dockside §6.1):
 * the narrator's answer to a `stageDock` hook, and nothing else. It is valid only while that hook
 * is pending, and while it is, no other narrator command is (`STAGING_COMMAND_KINDS`).
 */
import type { StagingPlan } from "../dockside";

export interface DocksideCommandPayloads {
  /**
   * Dress the dock the ship is about to come alongside: up to three people at posts, up to three
   * unowned props, one ambience line. Stored with the staging record and placed, with the floor
   * set, when the dock attaches at the start of `docking`.
   */
  stageDock: StagingPlan;
}
