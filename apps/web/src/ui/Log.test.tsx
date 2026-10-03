import type { DecisionCardText } from "@crew/content";
import type { Decision, Tick } from "@crew/sim";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Log } from "./Log";
import type { CardEntry } from "./log";

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
});
