import type { RenderExpedition } from "@crew/sim";

export interface HeadlineProps {
  /** `RenderFrame.headline` (§the-ship-headline); empty before the first frame. */
  readonly text: string;
  /** Expeditions A1 (§8.6): `RenderFrame.expedition`, while a site is alongside. */
  readonly expedition?: RenderExpedition;
  /** §sighting-and-the-alert: the ship is on alert; the shore header takes the alert's tint. */
  readonly alert: boolean;
}

/** Expeditions A1 (§8.6): one word a side, "Us: steady · Them: breaking". */
export function shoreHeader(expedition: Pick<RenderExpedition, "us" | "them">): string {
  return `Us: ${expedition.us} · Them: ${expedition.them}`;
}

/**
 * §the-ship-headline: one always-visible line of what the ship is doing, under the top bar. At a
 * site (expeditions A1) the shore header leads it: how each side of the fight is holding.
 */
export function Headline({ text, expedition, alert }: HeadlineProps) {
  const body = text === "" ? " " : text;
  if (expedition === undefined) {
    // Not a live region: in transit the ETA changes every second.
    return <div className="headline">{body}</div>;
  }
  // Once the fight is resolved its people are out of it, so the words would read "steady" again;
  // the line keeps the alert's tint until the alert stands down.
  const shore =
    expedition.phase === "resolved" ? null : (
      <>
        <span className="headline-shore">{shoreHeader(expedition)}</span>{" "}
      </>
    );
  return (
    <div className={alert ? "headline headline-alert" : "headline"}>
      {shore}
      {body}
    </div>
  );
}
