import type { AgentViewSnapshot } from "@crew/sim";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Inspector } from "./Inspector";

/** The fields `ActorInspector` reads; a passenger has no skills, tasks or post. */
function snapshot(who: { roleTags: string[]; passenger?: true }): AgentViewSnapshot {
  const self = {
    id: "actor:halla",
    name: "Halla Thorne",
    needs: { hunger: 0.2, fatigue: 0.1, comfort: 0.9, social: 0.5 },
    mood: 0.25,
    activity: { kind: "idle" },
    ...who,
  };
  return {
    tick: 0,
    self,
    facts: [],
    problems: [],
    tasks: [],
    roster: [
      { actorId: "actor:mara", name: "Mara Osei", roleTags: ["pilot"], skills: {} },
      { actorId: "actor:halla", name: "Halla Thorne", roleTags: [], skills: {}, passenger: true },
    ],
  } as unknown as AgentViewSnapshot;
}

describe("Inspector actor sheet", () => {
  it("shows a passenger without crew-only fields and tags them in the roster", () => {
    const html = renderToStaticMarkup(
      <Inspector
        data={{ kind: "actor", view: snapshot({ roleTags: [], passenger: true }) }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("Halla Thorne");
    expect(html).toContain('class="inspector-subtitle">passenger<');
    expect(html).toContain('<span class="inspector-tag">passenger</span>');
    expect(html).toContain("Mara Osei — pilot");
  });

  it("shows crew by their role tags with no tag", () => {
    const html = renderToStaticMarkup(
      <Inspector
        data={{ kind: "actor", view: snapshot({ roleTags: ["pilot"] }) }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('class="inspector-subtitle">pilot<');
    expect(html.match(/inspector-tag/g)).toHaveLength(1);
  });
});
