/**
 * §decision-queue-and-halts: a rejected player command raises a toast instead of vanishing into the
 * console. The kernel's rejection reasons are written for logs ("acceptContract: not docked at
 * \"port.kessler_drift\""); the known `preconditionFailed` cases get a friendlier line, and
 * anything else shows the raw reason so the player at least sees that nothing happened.
 */
import type { Command, CommandRejection } from "@crew/sim";

const FRIENDLY: ReadonlyArray<{ readonly pattern: RegExp; readonly message: string }> = [
  { pattern: /^acceptContract: not docked at/, message: "Dock at the job's port first." },
  { pattern: /^setCourse: not docked/, message: "A course can only be set while docked." },
  { pattern: /is not offered/, message: "That job is no longer on offer." },
  { pattern: /is not the one presented/, message: "That decision has already been answered." },
  { pattern: /is not pending/, message: "That decision has already been answered." },
];

export function rejectionMessage(kind: Command["kind"], rejection: CommandRejection): string {
  if (rejection.code === "preconditionFailed") {
    const friendly = FRIENDLY.find(({ pattern }) => pattern.test(rejection.reason));
    if (friendly !== undefined) return `Couldn't do that: ${friendly.message}`;
  }
  const reason = rejection.reason.startsWith(`${kind}:`)
    ? rejection.reason
    : `${kind}: ${rejection.reason}`;
  return `Couldn't do that: ${reason}`;
}
