import type { DecisionCardText } from "@crew/content";
import type { Decision, Tick } from "@crew/sim";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Log } from "./Log";
import type { CardEntry, EventEntry } from "./log";

const entry: CardEntry = {
  key: "card:1",
  tick: 10 as Tick,
  kind: "card",
  decision: {} as Decision,
  answer: { side: "left", caption: "Dane files it." },
};

const text: DecisionCardText = {
  decisionId: "d1",
  title: "Fenwick's handoff",
  speaker: "Dane Whitcross",
  situation: "Dane signs the manifest.",
  leftLabel: "A clean run.",
  rightLabel: "Good riddance.",
};

function render(card: DecisionCardText): string {
  return renderToStaticMarkup(
    <Log entries={[entry]} cardText={() => card} onOpenDecision={() => undefined} />,
  );
}

describe("Log", () => {
  it("marks a card that closed a story, with the story's name (D56)", () => {
    expect(render({ ...text, closesThread: "Fenwick's manifest" })).toContain(
      "✓ Story closed: Fenwick&#x27;s manifest",
    );
  });

  it("marks an unnamed close without a name, and an ordinary card not at all (D56)", () => {
    expect(render({ ...text, closesThread: "" })).toContain("✓ Story closed</span>");
    expect(render(text)).not.toContain("Story closed");
  });

  it("styles the line that slowed the game down, and no other (D76)", () => {
    const lines: EventEntry[] = [
      {
        key: "e:1",
        tick: 3 as Tick,
        kind: "event",
        text: "Debris field",
        significance: "narrative",
      },
      { key: "e:2", tick: 2 as Tick, kind: "event", text: "Bell.", significance: "notable" },
    ];
    const html = renderToStaticMarkup(
      <Log
        entries={[{ ...lines[0], highlight: true } as EventEntry, lines[1] as EventEntry]}
        cardText={() => text}
        onOpenDecision={() => undefined}
      />,
    );
    expect(html).toContain('class="log-line log-line-narrative log-line-highlight">Debris field<');
    expect(html).toContain('class="log-line log-line-notable">Bell.<');
  });

  it("starts compact, with a toggle to show more (D72: the portrait strip under the canvas)", () => {
    const html = render(text);
    expect(html).toContain('<section class="log-panel">');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Show more of the log"');
  });
});
