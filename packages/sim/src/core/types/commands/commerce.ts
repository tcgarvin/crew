/**
 * Commerce commands (SD §17.3; review §D.3 `offerJob`).
 */
import type { TextRef } from "../common";
import type { JobId, PortDefId } from "../ids";
import type { CargoLine, JobIssuer, JobUrgency } from "../travel";

/**
 * A job as proposed by the narrator or the deterministic job source. The kernel rejects it if
 * `pay` falls outside `config.commerce.priceBands` for the cargo class and route distance, so the
 * narrator cannot mint money.
 */
export interface JobDraft {
  /**
   * D25: the person offering the job. A bare string is still accepted (commands queued by an
   * older build, hand-written scenarios) and normalised by the handler to `{name, role: "shipper"}`.
   */
  readonly issuer: string | Readonly<JobIssuer>;
  /** D25: one line in the issuer's voice; absent = a generic template line. No pay talk (D24). */
  readonly pitch?: TextRef;
  /** Absent = `"relaxed"`. */
  readonly urgency?: JobUrgency;
  readonly description: TextRef;
  readonly fromPortId: PortDefId;
  readonly toPortId: PortDefId;
  readonly cargo: readonly CargoLine[];
  readonly pay: number;
}

export interface CommerceCommandPayloads {
  /**
   * Post a job. W0 decision: `surface: true` makes the kernel queue an accept/decline decision
   * for it immediately, so the narrator never needs to reference a job ID it has not seen yet.
   */
  offerJob: { readonly job: JobDraft; readonly surface: boolean };
  acceptContract: { readonly jobId: JobId };
  declineJob: { readonly jobId: JobId };
}
