/** §toasts: a toast never covers a decision card; a slowdown's clears when the player sets a speed. */
import { describe, expect, it } from "vitest";
import { type ToastNote, afterPlayerSpeedChange, toastOnScreen } from "./Toast";

const SLOWDOWN: ToastNote = { message: "Slowed to 1×: Shots at Harrow End", kind: "slowdown" };
const NOTICE: ToastNote = { message: "The ramp is jammed", kind: "notice" };

describe("toastOnScreen", () => {
  it("shows the toast while no card is up", () => {
    expect(toastOnScreen(SLOWDOWN, false)).toBe(SLOWDOWN.message);
  });

  it("shows no toast of either kind while a decision card is up", () => {
    expect(toastOnScreen(SLOWDOWN, true)).toBeUndefined();
    expect(toastOnScreen(NOTICE, true)).toBeUndefined();
  });

  it("shows nothing with no toast", () => {
    expect(toastOnScreen(undefined, false)).toBeUndefined();
  });
});

describe("afterPlayerSpeedChange", () => {
  it("drops an auto-slowdown's toast once the player picks a speed", () => {
    expect(afterPlayerSpeedChange(SLOWDOWN)).toBeUndefined();
  });

  it("keeps any other toast to its timer", () => {
    expect(afterPlayerSpeedChange(NOTICE)).toBe(NOTICE);
    expect(afterPlayerSpeedChange(undefined)).toBeUndefined();
  });
});
