/**
 * Commerce commands (SD §17.3; review §D.3 `offerJob`).
 */
import type { TextRef } from "../common";
import type { ItemDefId, JobId, PortDefId } from "../ids";
import type { CargoLine, JobErrand, JobIssuer, JobUrgency } from "../travel";

/**
 * A job as proposed by the narrator or the deterministic job source. The kernel rejects it if
 * `pay` falls outside `config.commerce.priceBands` for the cargo class and route distance, so the
 * narrator cannot mint money.
 */
export interface JobDraft {
  /**
   * §issuers-and-pitches: the person offering the job. A bare string is still accepted (commands
   * queued by an older build, hand-written scenarios) and normalised by the handler to `{name,
   * role: "shipper"}`.
   */
  readonly issuer: string | Readonly<JobIssuer>;
  /**
   * §issuers-and-pitches: one line in the issuer's voice; absent = a generic template line. No pay
   * talk (§cards-never-mention-pay).
   */
  readonly pitch?: TextRef;
  /** Absent = `"relaxed"`. */
  readonly urgency?: JobUrgency;
  readonly description: TextRef;
  readonly fromPortId: PortDefId;
  readonly toPortId: PortDefId;
  readonly cargo: readonly CargoLine[];
  readonly pay: number;
  /**
   * Passengers-and-galaxy §3: the issuer travels with the job. `cargo` is then at most one
   * luggage line (its count is ignored beyond one unit) and pay is banded by
   * `priceBands.passenger` over path distance. Absent = `false` (drafts from before passages).
   */
  readonly passenger?: boolean;
  /** There and back (`toPortId`, then home to `fromPortId`). Requires `passenger`. */
  readonly roundTrip?: boolean;
  /**
   * Expeditions A2 (§6): an errand to a landing site. `toPortId` must equal `fromPortId` (the job
   * returns there: `returnToPortId`), `cargo` is empty, and pay is banded by `priceBands.errand`
   * over the path to the site and back. Absent = freight or a passage.
   */
  readonly errand?: Readonly<
    Pick<JobErrand, "kind" | "siteId" | "targetName" | "itemDefId" | "wants">
  >;
  /**
   * §money-levers (D106): the narrator named the sum (`offerJob.payCredits`). The kernel then
   * checks `pay` against `config.narrator.maxOfferPay` instead of the price band, never scales it
   * to the crates it caps, and takes it from the narrator or a scenario only. Absent = banded.
   */
  readonly payNamed?: true;
}

export interface CommerceCommandPayloads {
  /**
   * Post a job. W0 decision: `surface: true` makes the kernel queue an accept/decline decision
   * for it immediately, so the narrator never needs to reference a job ID it has not seen yet.
   */
  offerJob: { readonly job: JobDraft; readonly surface: boolean };
  acceptContract: { readonly jobId: JobId };
  declineJob: { readonly jobId: JobId };
  /**
   * Passengers-and-galaxy §4.2: end a passage early, no fare. A passenger aboard leaves at the
   * next docking (now, if docked) and the passage ends `putOff`; one already ashore is left there
   * and it ends `leftBehind` (the overdue card's "Leave without them"). Either way they stay at
   * that port as an off-ship actor in its lounge store. A player command, so a card side can
   * carry it.
   */
  endPassage: { readonly jobId: JobId };
  /**
   * §market-lever: set what a port's market has of one item: `count` units (0 removes it from sale)
   * at `price` integer credits per unit. The narrator's lever for "the part is here" or "not here";
   * it never moves money or puts anything aboard, so the "narrator cannot mint money" rule holds.
   * Bounded by `config.commerce.market.maxStockPerCommand`.
   */
  stockMarket: {
    readonly portId: PortDefId;
    readonly itemDefId: ItemDefId;
    readonly count: number;
    readonly price: number;
  };
  /**
   * §money-levers, D106 (narrator and scenario): `amount` signed integer credits into (positive)
   * or out of (negative) the ship's money, written to the ledger as a `narrator` transaction with
   * its `memo` (what it was for) and `counterparty` (who paid or was paid), each at most
   * `TRANSACT_TEXT_MAX` characters. Never zero; a debit
   * the balance cannot cover and a credit above `config.narrator.maxWindfall` are refused.
   */
  transact: {
    readonly amount: number;
    readonly memo: string;
    readonly counterparty: string;
  };
}
