export interface HeadlineProps {
  /** `RenderFrame.headline` (§the-ship-headline); empty before the first frame. */
  readonly text: string;
}

/** §the-ship-headline: one always-visible line of what the ship is doing, under the top bar. */
export function Headline({ text }: HeadlineProps) {
  return (
    // Not a live region: in transit the ETA changes every second.
    <div className="headline">{text === "" ? "\u00a0" : text}</div>
  );
}
