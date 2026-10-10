import type { AgentViewSnapshot, Machine, WeighingWords } from "@crew/sim";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Inspector } from "./Inspector";
import type { PersonWords } from "./actorWords";

/** The fields `ActorInspector` reads; a passenger has no skills, tasks or post. */
function snapshot(
  who: { roleTags: string[]; passenger?: true },
  problems: readonly { id: string; kind: string }[] = [],
): AgentViewSnapshot {
  const self = {
    id: "actor:halla",
    name: "Halla Thorne",
    needs: { hunger: 0.2, fatigue: 0.1, comfort: 0.9, social: 0.5, recreation: 0.65 },
    mood: 0.25,
    activity: { kind: "idle" },
    onDuty: false,
    watch: { onWatch: false, dayworker: true, helmRole: "none", officerOfTheWatch: false },
    thoughts: [],
    ...who,
  };
  return {
    tick: 0,
    self,
    facts: [],
    problems,
    tasks: [],
    roster: [
      { actorId: "actor:mara", name: "Mara Osei", roleTags: ["pilot"], skills: {} },
      { actorId: "actor:halla", name: "Halla Thorne", roleTags: [], skills: {}, passenger: true },
    ],
  } as unknown as AgentViewSnapshot;
}

const steady: PersonWords = {
  watch: "Dayworker, off duty",
  mood: "steady",
  thoughts: [],
  interests: "likes reading",
  relationships: [],
};

const NOTHING: WeighingWords = { verdict: "nothing to do", options: [], ruledOut: [] };

describe("Inspector actor sheet", () => {
  it("lists what a crew member is weighing, marks the current and next choice, and why others are out", () => {
    const weighing: WeighingWords = {
      verdict: "keeps at what they're doing: nothing else outranks it yet",
      options: [
        { text: "playing cards", urgency: "routineObligation", seconds: 3, mark: "doing" },
        { text: "servicing the coolant pump", urgency: "routineObligation", seconds: 21 },
      ],
      ruledOut: [
        {
          text: "repairing the generator",
          reason: "off watch: routine work waits for their watch",
        },
      ],
    };
    const html = renderToStaticMarkup(
      <Inspector
        data={{
          kind: "actor",
          weighing,
          view: snapshot({ roleTags: ["engineer"] }),
          person: steady,
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("<h3>Weighing</h3>");
    expect(html).toContain("nothing else outranks it yet");
    expect(html).toMatch(/<li class="weighing-marked">playing cards .*routine.*~3s.* · doing/);
    expect(html).toContain("servicing the coolant pump");
    expect(html).toContain("Ruled out (1)");
    expect(html).toContain("repairing the generator: ");
  });

  it("gives a body line when the snapshot had one, marked when they are hurt (§8.6)", () => {
    const sheet = (body?: string) =>
      renderToStaticMarkup(
        <Inspector
          data={{
            kind: "actor",
            weighing: NOTHING,
            view: snapshot({ roleTags: ["engineer"] }),
            person: steady,
            ...(body === undefined ? {} : { body }),
          }}
          onClose={() => {}}
        />,
      );
    expect(sheet("wounded: right leg (serious), bleeding")).toContain(
      '<dt>Body</dt><dd class="inspector-hurt">wounded: right leg (serious), bleeding</dd>',
    );
    expect(sheet("unhurt")).toContain("<dt>Body</dt><dd>unhurt</dd>");
    expect(sheet()).not.toContain("<dt>Body</dt>");
  });

  it("shows no weighing for a passenger, who plans no work", () => {
    const html = renderToStaticMarkup(
      <Inspector
        data={{
          kind: "actor",
          weighing: NOTHING,
          view: snapshot({ roleTags: [], passenger: true }),
          person: steady,
        }}
        onClose={() => {}}
      />,
    );
    expect(html).not.toContain("Weighing");
  });

  it("says roles and known problems in words, each kind once", () => {
    const problems = [
      { id: "p1", kind: "cargoToLoad" },
      { id: "p2", kind: "cargoToLoad" },
      { id: "p3", kind: "stationToStaff" },
    ];
    const html = renderToStaticMarkup(
      <Inspector
        data={{
          kind: "actor",
          weighing: NOTHING,
          view: snapshot({ roleTags: ["firstOfficer"] }, problems),
          person: steady,
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('class="inspector-subtitle">first officer<');
    expect(html).toContain("<li>cargo to load ×2</li>");
    expect(html).toContain("<li>the helm to stand</li>");
    expect(html).not.toContain("cargoToLoad");
    expect(html).not.toContain("firstOfficer");
  });

  it("shows a passenger without crew-only fields and tags them in the roster", () => {
    const html = renderToStaticMarkup(
      <Inspector
        data={{
          kind: "actor",
          weighing: NOTHING,
          view: snapshot({ roleTags: [], passenger: true }),
          person: steady,
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("Halla Thorne");
    expect(html).toContain('class="inspector-subtitle">passenger<');
    expect(html).toContain('<span class="inspector-tag">passenger</span>');
    expect(html).toContain("Mara Osei — pilot");
    // Passengers stand no watch.
    expect(html).not.toContain("<dt>Watch</dt>");
  });

  it("shows crew by their role tags with no tag", () => {
    const html = renderToStaticMarkup(
      <Inspector
        data={{
          kind: "actor",
          weighing: NOTHING,
          view: snapshot({ roleTags: ["pilot"] }),
          person: steady,
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('class="inspector-subtitle">pilot<');
    expect(html.match(/inspector-tag/g)).toHaveLength(1);
  });

  it("shows a crew member's watch, helm role, mood word and top thoughts", () => {
    const person: PersonWords = {
      watch: "Red section, on watch",
      helm: "stands this watch's helm",
      mood: "low",
      thoughts: [
        { key: "doubleWatch", label: "double watch", value: -0.25, count: 1 },
        { key: "helmCleanPass", label: "brought the ship through clean", value: 0.2, count: 2 },
      ],
      interests: "likes reading",
      relationships: [],
    };
    const html = renderToStaticMarkup(
      <Inspector
        data={{ kind: "actor", weighing: NOTHING, view: snapshot({ roleTags: ["pilot"] }), person }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("<dt>Watch</dt><dd>Red section, on watch</dd>");
    expect(html).toContain("<dt>Duty</dt><dd>stands this watch&#x27;s helm</dd>");
    expect(html).toContain('<dd class="inspector-mood inspector-mood-low">low</dd>');
    expect(html).toContain('<li class="thought-down">double watch</li>');
    expect(html).toContain('<li class="thought-up">brought the ship through clean ×2</li>');
  });

  it("leaves out the helm line when the sim has no helm role for them, and says when nothing is on their mind", () => {
    const html = renderToStaticMarkup(
      <Inspector
        data={{
          kind: "actor",
          weighing: NOTHING,
          view: snapshot({ roleTags: ["cook"] }),
          person: steady,
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("<dt>Watch</dt><dd>Dayworker, off duty</dd>");
    expect(html).not.toContain("<dt>Duty</dt>");
    expect(html).toContain('<dd class="inspector-mood inspector-mood-steady">steady</dd>');
    expect(html).toContain("nothing in particular");
  });

  it("shows recreation, what they like off watch and who they are close to (slice 4)", () => {
    const person: PersonWords = {
      ...steady,
      thoughts: [
        { key: "keepsBeatingMe", label: "Jax Okonkwo keeps beating me", value: -0.15, count: 1 },
      ],
      interests: "likes cards (keen), vids; dislikes reading",
      relationships: ["close to Jax Okonkwo (+4)", "at odds with Priya Kessler (−3)"],
    };
    const html = renderToStaticMarkup(
      <Inspector
        data={{
          kind: "actor",
          weighing: NOTHING,
          view: snapshot({ roleTags: ["deckhand"] }),
          person,
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("<dt>Recreation</dt><dd>65%</dd>");
    expect(html).toContain("<dt>Off watch</dt><dd>likes cards (keen), vids; dislikes reading</dd>");
    expect(html).toContain("<dt>People</dt>");
    expect(html).toContain("<li>close to Jax Okonkwo (+4)</li>");
    expect(html).toContain("<li>at odds with Priya Kessler (−3)</li>");
    expect(html).toContain('<li class="thought-down">Jax Okonkwo keeps beating me</li>');
  });

  it("leaves out the people row when nobody stands out", () => {
    const html = renderToStaticMarkup(
      <Inspector
        data={{
          kind: "actor",
          weighing: NOTHING,
          view: snapshot({ roleTags: ["deckhand"] }),
          person: steady,
        }}
        onClose={() => {}}
      />,
    );
    expect(html).not.toContain("<dt>People</dt>");
  });
});

describe("Inspector machine sheet", () => {
  const table = {
    id: "machine:table",
    defId: "machine.games_table",
    actualMode: "off",
    integrity: 1,
    condition: 1,
    temperature: 0,
    faults: [],
  } as unknown as Machine;

  it("shows the game gathered at the machine (slice 4)", () => {
    const html = renderToStaticMarkup(
      <Inspector
        data={{
          kind: "machine",
          machine: table,
          name: "Games table",
          gathering: "cards: Jax, Tomas, Dane, 40 s in",
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("<dt>Gathering</dt><dd>cards: Jax, Tomas, Dane, 40 s in</dd>");
  });

  it("has no gathering line with no session there", () => {
    const html = renderToStaticMarkup(
      <Inspector
        data={{ kind: "machine", machine: table, name: "Games table" }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("<h2>Games table</h2>");
    expect(html).not.toContain("Gathering");
  });
});

describe("Inspector item sheet", () => {
  const crate = (status: string) => ({
    kind: "item" as const,
    item: {
      name: "General freight crate",
      count: 1,
      where: "in the freight staging area on the dock",
      job: { issuer: "Hal Petrosyan", from: "Crossroads Hub", to: "Kessler Drift", status },
    },
  });

  it("says freight on offer is on offer and nobody's until the job is taken", () => {
    const html = renderToStaticMarkup(<Inspector data={crate("offered")} onClose={() => {}} />);
    expect(html).toContain('class="inspector-subtitle">freight on offer<');
    expect(html).toContain("nobody loads it until then");
  });

  it("reads taken freight as plain freight", () => {
    const html = renderToStaticMarkup(<Inspector data={crate("accepted")} onClose={() => {}} />);
    expect(html).toContain('class="inspector-subtitle">freight<');
    expect(html).not.toContain("nobody loads it");
  });
});

describe("Inspector local sheet (§items-places-and-locals)", () => {
  it("shows a regular's name, role and post", () => {
    const html = renderToStaticMarkup(
      <Inspector
        data={{
          kind: "local",
          local: { name: "Hal Petrosyan", role: "berth agent", where: "at the queue-board kiosk" },
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("<h2>Hal Petrosyan</h2>");
    expect(html).toContain('class="inspector-subtitle">berth agent<');
    expect(html).toContain("<dd>at the queue-board kiosk</dd>");
    expect(html).not.toContain("Doing");
    expect(html).not.toContain("Post");
  });

  it("adds what a busy local is doing, and their post when they are away from it", () => {
    const html = renderToStaticMarkup(
      <Inspector
        data={{
          kind: "local",
          local: {
            name: "Ilse Brandt",
            role: "dock hand",
            where: "in the freight staging area on the dock",
            post: "the Co-op dispatch window",
            doing: "bringing out 3 crates",
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("<dt>Doing</dt><dd>bringing out 3 crates</dd>");
    expect(html).toContain("<dt>Post</dt><dd>the Co-op dispatch window</dd>");
  });
});
