import { describe, expect, it } from "vitest";
import { roomPhrase } from "./rooms";

describe("roomPhrase (D94): a room as a sentence names it", () => {
  it("takes the article and lower case by default", () => {
    expect(roomPhrase({ name: "Cargo Hold" })).toBe("the cargo hold");
    expect(roomPhrase({ name: "Captain's Cabin" })).toBe("the captain's cabin");
  });

  it("uses the room's own phrase where the article would read wrong", () => {
    expect(roomPhrase({ name: "Engineering", phrase: "engineering" })).toBe("engineering");
  });
});
