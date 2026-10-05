import type { ContentBundle } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { rawBundle } from "../loader";
import { activityVenueNotes, validateBundle } from "./validate";

type RawActivity = Record<string, unknown> & {
  venue: Record<string, unknown>[];
  participants: { min: number; max: number };
};
type Raw = {
  activities: Record<string, RawActivity>;
  thoughts: Record<string, { label: string }>;
};

const MK1 = "deck.freighter_mk1";
const MK2 = "deck.freighter_mk2";

/** The authored bundle with `edit` applied; every issue as `path: message`. */
function messagesAfter(edit: (raw: Raw) => void): string[] {
  const raw = structuredClone(rawBundle()) as unknown as Raw;
  edit(raw);
  const result = validateBundle(raw);
  return result.ok ? [] : result.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

function activityOf(raw: Raw, id: string): RawActivity {
  const found = raw.activities[id];
  if (found === undefined) throw new Error(`authored bundle has no ${id}`);
  return found;
}

function authored(): ContentBundle {
  const result = validateBundle(rawBundle());
  if (!result.ok) throw new Error(`authored bundle invalid: ${result.issues[0]?.message}`);
  return result.bundle;
}

describe("activity rules (D84)", () => {
  it("accepts the authored activities, thoughts and decks", () => {
    expect(messagesAfter(() => {})).toEqual([]);
  });

  it("notes each activity Mk1 cannot host and nothing on Mk2, which the scenario sails", () => {
    const notes = activityVenueNotes(authored());
    expect(notes.every((n) => n.path.join(".") === `decks.${MK1}`)).toBe(true);
    const missing = notes.map((n) => /"(activity\.[a-z_]+)"/.exec(n.message)?.[1]).sort();
    expect(missing).toEqual([
      "activity.board_game",
      "activity.cards",
      "activity.exercise",
      "activity.reading",
      "activity.sparring",
      "activity.stargazing",
      "activity.tinkering",
      "activity.video_game",
      "activity.vids",
    ]);
    expect(notes[0]?.message).toBe(
      'no venue for "activity.cards": the deck has no gamesTable machine or lounge compartment',
    );
  });

  it("rejects more than four participants", () => {
    const messages = messagesAfter((raw) => {
      activityOf(raw, "activity.vids").participants.max = 5;
    });
    expect(messages).toContain(
      "activities.activity.vids.participants.max: 5 participants; one session's plate names at most 4",
    );
  });

  it("rejects a group debate with no solo variant, and lets a contest go without one", () => {
    const messages = messagesAfter((raw) => {
      const { solo: _dropped, ...sololess } = activityOf(raw, "activity.debate");
      raw.activities["activity.debate"] = sololess as RawActivity;
    });
    expect(messages).toEqual([
      "activities.activity.debate.solo: a debate for 2 or more needs a solo variant for when nobody joins",
    ]);
    expect(activityOf(rawBundle() as unknown as Raw, "activity.board_game").solo).toBeUndefined();
  });

  it("rejects an own item whose tag no personal item carries", () => {
    const messages = messagesAfter((raw) => {
      activityOf(raw, "activity.reading").requires = { itemTag: "book", own: true };
    });
    expect(messages).toContain(
      'activities.activity.reading.requires.own: no "personal" item def carries the tag "book", so nobody owns one',
    );
  });

  it("rejects {ref} in the label of a thought the sim gives no refId", () => {
    const messages = messagesAfter((raw) => {
      const thought = raw.thoughts.wonContest;
      if (thought === undefined) throw new Error("no wonContest thought");
      thought.label = "beat {ref}";
    });
    expect(messages).toEqual([
      'thoughts.wonContest.label: "{ref}" in the label of "wonContest", which the sim never gives a refId',
    ]);
  });

  it("rejects a machine venue with fewer use positions than participants", () => {
    const messages = messagesAfter((raw) => {
      activityOf(raw, "activity.board_game").venue = [{ machineTag: "exerciseRig" }];
    });
    expect(messages).toEqual([
      `activities.activity.board_game.venue.0: on "${MK2}", the largest exerciseRig machine holds 1 use positions; "activity.board_game" seats up to 2`,
    ]);
  });

  it("rejects a zone venue with fewer tiles than participants", () => {
    const messages = messagesAfter((raw) => {
      activityOf(raw, "activity.stargazing").participants.max = 3;
    });
    expect(messages).toEqual([
      `activities.activity.stargazing.venue.0: on "${MK2}", the largest viewport zone holds 2 tiles; "activity.stargazing" seats up to 3`,
    ]);
  });

  it("rejects a product with no zone to set it on, on every deck that hosts the activity", () => {
    const messages = messagesAfter((raw) => {
      activityOf(raw, "activity.baking").produces = {
        itemDefId: "item.treat",
        count: 4,
        zoneTag: "trayRack",
      };
    });
    expect(messages).toEqual(
      [MK2, MK1].map(
        (deck) =>
          `activities.activity.baking.produces.zoneTag: "${deck}" has no "trayRack" zone to set "activity.baking"'s product on`,
      ),
    );
  });

  it("rejects an activity with no venue on a scenario's deck", () => {
    const messages = messagesAfter((raw) => {
      activityOf(raw, "activity.stargazing").venue = [{ zoneTag: "observatory" }];
    });
    expect(messages).toEqual([
      `decks.${MK2}: no venue for "activity.stargazing": the deck has no observatory zone`,
    ]);
  });

  it("counts an own machine only where it stands in a berth compartment", () => {
    const messages = messagesAfter((raw) => {
      activityOf(raw, "activity.reading").venue = [{ machineTag: "workbench", own: true }];
    });
    expect(messages).toEqual([
      `decks.${MK2}: no venue for "activity.reading": the deck has no own workbench machine`,
    ]);
  });
});
