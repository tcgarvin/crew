import { describe, expect, it } from "vitest";
import { rejectionMessage } from "./rejectionMessage";

describe("rejectionMessage (§decision-queue-and-halts)", () => {
  it("maps the known preconditionFailed reasons to a friendly line", () => {
    expect(
      rejectionMessage("acceptContract", {
        code: "preconditionFailed",
        reason: 'acceptContract: not docked at "port.kessler_drift"',
      }),
    ).toBe("Couldn't do that: Dock at the job's port first.");
    expect(
      rejectionMessage("setCourse", {
        code: "preconditionFailed",
        reason: 'setCourse: not docked (stage "transit")',
      }),
    ).toBe("Couldn't do that: A course can only be set while docked.");
    expect(
      rejectionMessage("declineJob", {
        code: "preconditionFailed",
        reason: 'job "job:3" is not offered (status "expired")',
      }),
    ).toBe("Couldn't do that: That job is no longer on offer.");
    expect(
      rejectionMessage("resolveDecision", {
        code: "preconditionFailed",
        reason: 'decision "decision:2" is not the one presented',
      }),
    ).toBe("Couldn't do that: That decision has already been answered.");
  });

  it("falls back to the raw reason, prefixed with the command kind when it is not already", () => {
    expect(
      rejectionMessage("setCourse", {
        code: "unknownEntity",
        reason: 'setCourse: unknown port "port.nowhere"',
      }),
    ).toBe('Couldn\'t do that: setCourse: unknown port "port.nowhere"');
    expect(
      rejectionMessage("resolveDecision", {
        code: "unknownEntity",
        reason: 'unknown decision "decision:9"',
      }),
    ).toBe('Couldn\'t do that: resolveDecision: unknown decision "decision:9"');
  });
});
