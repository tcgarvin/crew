/**
 * Group sessions (slice 4, call 4): opening, joining and leaving the row in `social.sessions`.
 *
 * - `openSession`: allocates `nextId.session`; a session already open for the activity at the
 *   venue is joined instead; `sessionOpened`.
 * - `joinSession`: room left, and not running past `recreation.lateJoinSeconds`; `sessionJoined`.
 * - `leaveRecreation` (called from `abortActivity` before the activity is cleared, so a bell, a
 *   meal call or an essential task takes the member out the tick they leave): removes them from
 *   `members` (`sessionLeft`); sets a carried `book` or `instrument` down where they stand (and
 *   `seeItem`); a contest or debate left under `min` ends `abandoned`. A completed `recreate`
 *   step leaves its session itself (`finishActivity` does not call `abortActivity`).
 *
 * Owner: W1 of ship life slice 4. Gate stubs: open and join throw (nothing reaches them),
 * `leaveRecreation` is a no-op.
 */
import { NotImplementedError } from "../../core/registry";
import type { Actor } from "../../core/types/actor";
import type { ActivityDef } from "../../core/types/content";
import type { SessionId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { SessionVenue } from "../../core/types/state";

/** Open a session of `def` at `venue` hosted by `actor` (or join the one open there). */
export function openSession(
  _ctx: StepCtx,
  _actor: Actor,
  _def: ActivityDef,
  _venue: SessionVenue,
): SessionId {
  throw new NotImplementedError("openSession (slice 4 W1)");
}

/** Join `sessionId`: true when joined, false when full, gone or running too long. */
export function joinSession(_ctx: StepCtx, _actor: Actor, _sessionId: SessionId): boolean {
  throw new NotImplementedError("joinSession (slice 4 W1)");
}

/** Take `actor` out of any session and set down what they carried for it. Gate stub: no-op. */
export function leaveRecreation(_ctx: StepCtx, _actor: Actor): void {}
