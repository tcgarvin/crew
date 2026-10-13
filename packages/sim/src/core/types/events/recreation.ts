/**
 * Recreation events (slice 4): group sessions opened, joined, started, collapsed, left and ended;
 * a sparring knock; a tray of treats. The ticker says who won and little else: per group session
 * at most `sessionStarted` and `sessionEnded` (and the latter only with something to say).
 */
import type { ActivityOutcome } from "../content";
import type {
  ActivityDefId,
  ActorId,
  CompartmentId,
  DockDefId,
  LocalKey,
  SessionId,
  TopicDefId,
} from "../ids";
import type { SignificanceCatalog } from "./significance";

export interface RecreationEventPayloads {
  /** `hostId` opened a session of `activityId` at its venue, waiting for others. */
  sessionOpened: {
    readonly sessionId: SessionId;
    readonly activityId: ActivityDefId;
    readonly hostId: ActorId;
  };
  /** `actorId` joined the session at its venue. */
  sessionJoined: { readonly sessionId: SessionId; readonly actorId: ActorId };
  /**
   * The session started with `memberIds`: aboard in `compartmentId`, or ashore by the post
   * `postKey` of the dock `dockId` (§shore-leave).
   */
  sessionStarted: {
    readonly sessionId: SessionId;
    readonly activityId: ActivityDefId;
    readonly memberIds: readonly ActorId[];
  } & (
    | { readonly compartmentId: CompartmentId }
    | { readonly ashore: { readonly dockId: DockDefId; readonly postKey: LocalKey } }
  );
  /** Nobody (or too few) came by the gather timer; the host plays alone (`toSolo`) or gives up. */
  sessionCollapsed: {
    readonly sessionId: SessionId;
    readonly activityId: ActivityDefId;
    readonly toSolo: boolean;
  };
  /** `actorId` left the session (a bell, a meal call, an essential task). */
  sessionLeft: { readonly sessionId: SessionId; readonly actorId: ActorId };
  /**
   * The session ended: resolved by its outcome, or `abandoned` (a contest or debate fell under
   * `participants.min`). `winnerId` for a contest; `topicId` and `argued` for a debate.
   * Notable by default; the ticker line is null for `bond`, `none` and `abandoned`.
   */
  sessionEnded: {
    readonly sessionId: SessionId;
    readonly activityId: ActivityDefId;
    readonly outcome: ActivityOutcome | "abandoned";
    readonly memberIds: readonly ActorId[];
    readonly winnerId?: ActorId;
    readonly topicId?: TopicDefId;
    readonly argued?: boolean;
  };
  /** `actorId` took a knock at `activityId` (sparring's `risk`); a thought, no injury state. */
  tookAKnock: { readonly actorId: ActorId; readonly activityId: ActivityDefId };
  /** `cookId` baked `count` treats onto the counter. */
  treatsBaked: { readonly cookId: ActorId; readonly count: number };
}

export const RECREATION_EVENT_SIGNIFICANCE = {
  sessionOpened: "trace",
  sessionJoined: "trace",
  sessionStarted: "notable",
  sessionCollapsed: "trace",
  sessionLeft: "trace",
  sessionEnded: "notable",
  tookAKnock: "notable",
  treatsBaked: "notable",
} as const satisfies SignificanceCatalog<RecreationEventPayloads>;
