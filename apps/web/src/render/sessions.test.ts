import type { RenderFrame, RenderSession } from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  SESSION_PLATE_CHARS,
  activityShortLabel,
  firstName,
  sessionMemberIds,
  sessionPlateText,
} from "./sessions";

const actors = [
  { id: "jax", name: "Jax Okonkwo" },
  { id: "tomas", name: "Tomas Ruiz" },
  { id: "dane", name: "Dane Whitcross" },
  { id: "bettina", name: "Bettina Solheim" },
  { id: "fenwick", name: "Fenwick Adair" },
] as unknown as RenderFrame["actors"];

function session(over: Readonly<Record<string, unknown>>): RenderSession {
  return {
    id: "session:1",
    activityId: "activity.cards",
    label: "playing cards",
    x: 7,
    y: 5,
    memberIds: ["jax", "tomas", "dane"],
    running: true,
    ...over,
  } as unknown as RenderSession;
}

describe("firstName", () => {
  it("takes the first word of a name", () => {
    expect(firstName("Jax Okonkwo")).toBe("Jax");
    expect(firstName("Pell")).toBe("Pell");
  });

  it("skips a leading title or epithet for the name after it", () => {
    expect(firstName("Old Pell")).toBe("Pell");
    expect(firstName("Sister Aurelie Doucet")).toBe("Aurelie");
  });
});

describe("sessionMemberIds", () => {
  it("collects every member of every session", () => {
    const frame = {
      sessions: [session({}), session({ id: "session:2", memberIds: ["bettina"] })],
    } as unknown as RenderFrame;
    expect([...sessionMemberIds(frame)].sort()).toEqual(["bettina", "dane", "jax", "tomas"]);
  });

  it("is empty with no sessions", () => {
    expect(sessionMemberIds({ sessions: [] }).size).toBe(0);
  });
});

describe("activityShortLabel", () => {
  it("names the game without the verb, as the ticker does", () => {
    expect(activityShortLabel("playing cards")).toBe("cards");
    expect(activityShortLabel("playing a board game")).toBe("a board game");
  });

  it("leaves a label without 'playing' as it is", () => {
    expect(activityShortLabel("watching a vid")).toBe("watching a vid");
    expect(activityShortLabel("sparring")).toBe("sparring");
  });
});

describe("sessionPlateText", () => {
  it("names a running game and its players by first name", () => {
    expect(sessionPlateText(session({}), { actors })).toBe("cards — Jax, Tomas, Dane");
  });

  it("uses the waiting label while the game gathers", () => {
    const waiting = session({
      label: "waiting for a game of cards",
      memberIds: ["jax"],
      running: false,
    });
    expect(sessionPlateText(waiting, { actors })).toBe("waiting for a game of cards — Jax");
  });

  it("cuts a long plate at the label length with an ellipsis", () => {
    const four = session({
      memberIds: ["jax", "tomas", "dane", "bettina", "fenwick"],
    });
    const text = sessionPlateText(four, { actors });
    expect(text).toHaveLength(SESSION_PLATE_CHARS);
    expect(text.endsWith("…")).toBe(true);
    expect(text.startsWith("cards — Jax, Tomas, Dane, ")).toBe(true);
  });

  it("leaves out a member the frame no longer has", () => {
    const gone = session({ memberIds: ["jax", "nobody"] });
    expect(sessionPlateText(gone, { actors })).toBe("cards — Jax");
  });
});
